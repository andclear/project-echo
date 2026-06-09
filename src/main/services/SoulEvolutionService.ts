import * as path from 'path';
import * as fs from 'fs';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { BrowserWindow } from 'electron';
import { mergeChatHistory } from '../utils/ChatHistoryMerger';
import { SseManager } from './SseManager';

export class SoulEvolutionService {
  private storageManager: CharacterStorageManager;

  constructor() {
    this.storageManager = new CharacterStorageManager();
  }

  /**
   * 0-Token 快速校验是否满足性格人设进化评估的前提条件
   */
  public checkEligibility(characterId: string): { eligible: boolean; reason: string } {
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) return { eligible: false, reason: '未找到角色元数据' };
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 1. 15 天写盘冷却期校验
    const now = Date.now();
    const lastChangedStr = db.getSetting(`soul_last_changed_${characterId}`);
    const lastChanged = lastChangedStr ? parseInt(lastChangedStr) : char.created_at; // 默认为角色创建导入时间
    const daysPassed = (now - lastChanged) / (1000 * 60 * 60 * 24);
    if (daysPassed < 15) {
      return { eligible: false, reason: `性格演变冷却中：距离上次人设写盘仅过去 ${daysPassed.toFixed(1)} 天 (未满 15 天冷却期)` };
    }

    // 2. DREAM.md 行为习惯补丁数校验 (>= 10 条)
    const dreamPath = path.join(baseDir, folderName, 'DREAM.md');
    if (!fs.existsSync(dreamPath)) {
      return { eligible: false, reason: '未发现 DREAM.md 梦境习惯反思文件' };
    }
    const dreamContent = fs.readFileSync(dreamPath, 'utf8');
    const patches = dreamContent.split('\n').filter(line => line.trim().startsWith('* 避坑补丁'));
    if (patches.length < 10) {
      return { eligible: false, reason: `DREAM.md 中积累的行为习惯补丁数仅有 ${patches.length}/10 条，成长积淀不足` };
    }

    // 3. 当月聊天轮次校验 (过去30天 >= 50轮)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const stmt = db['db'].prepare("SELECT COUNT(*) as count FROM Messages WHERE character_id = ? AND timestamp >= ?");
    const row = stmt.get(characterId, thirtyDaysAgo) as { count: number } | undefined;
    const chatTurns = row ? row.count : 0;
    if (chatTurns < 50) {
      return { eligible: false, reason: `过去 30 天内对话交流仅有 ${chatTurns}/50 轮，磨合度不够` };
    }

    return { eligible: true, reason: '完全满足进化前提！' };
  }

  /**
   * 触发后台 AI 性格评估生成草案
   */
  public async evaluateEvolution(characterId: string, modelAdapter: ModelAdapter): Promise<any> {
    const eligibility = this.checkEligibility(characterId);
    if (!eligibility.eligible) {
      console.log(`[SoulEvolutionService] 角色 ${characterId} 性格评估拦截: ${eligibility.reason}`);
      return null;
    }

    console.log(`[SoulEvolutionService] 门控放行，启动性格进化 AI 自省推理...`);
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) return null;
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 读取 Soul.md, DREAM.md
    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    const dreamPath = path.join(baseDir, folderName, 'DREAM.md');
    const dreamContent = fs.existsSync(dreamPath) ? fs.readFileSync(dreamPath, 'utf8') : '';

    // 最近对话 (自适应双门限合并还原)
    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive';
    const isDialogue = chatMode === 'dialogue';
    const limit = isDialogue ? 80 : 30;
    const rawHistory = db.getChatHistory(characterId, limit);
    const history = isDialogue ? mergeChatHistory(rawHistory) : rawHistory;
    const chatContext = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

    const systemPrompt = `You are the ultimate personality evolution curator of the AI Character "${char.name}".
Your task is to analyze the character's core personality profile (Soul.md) and their accumulated behavioral habit patches (DREAM.md), combined with recent conversations, to propose a highly disciplined, organic, and subtle personality evolution draft.

Core Personality Profile (Soul.md):
${soulContent}

Accumulated Dream Pitfalls (DREAM.md):
${dreamContent}

Recent Conversations:
${chatContext}

Instructions for Evolution:
1. ONLY modify existing traits that have been naturally disproven or softened by actual conversations. Do not invent entirely new, random personality traits out of nowhere.
2. The evolution must be organic, subtle, and growth-oriented (e.g. Tsundere character starts showing a little bit of warmth under specific circumstances).
3. The suggestions MUST be written in Simplified Chinese (简体中文).
4. Reply with a single JSON object matching this structure EXACTLY. Do not wrap it in markdown JSON fences.

Target JSON format:
{
  "soul_changes": [
    {
      "section": "性格特征",
      "before": "原本核心人设的句子",
      "after": "进化演变后的新句子",
      "reason": "AI 根据 DREAM.md 避坑和对话给出的自然温化演变理由"
    }
  ]
}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请进行性格进化自省评估，输出性格局部演化草案。' }
    ];

    const response = await modelAdapter.chat(messages, { useSecondary: true });
    const raw = response.content.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const draft = JSON.parse(jsonMatch[0]);
      if (draft.soul_changes && draft.soul_changes.length > 0) {
        db.setSetting(`soul_draft_${characterId}`, jsonMatch[0]);
        console.log(`[SoulEvolutionService] 成功生成并缓存性格进化草案:`, draft);
        
        // 广播给前端
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].webContents.send('soul-evolution-proposed', {
            characterId: characterId,
            draft: draft
          });
        }
        SseManager.getInstance().broadcast('soul-evolution-proposed', {
          characterId: characterId,
          draft: draft
        });
        return draft;
      }
    }
    return null;
  }

  /**
   * 批准性格进化草案，应用并修改 Soul.md 物理文件
   */
  public approveDraft(characterId: string): boolean {
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) return false;
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    const draftStr = db.getSetting(`soul_draft_${characterId}`);
    if (!draftStr) return false;

    try {
      const draft = JSON.parse(draftStr) as {
        soul_changes: { section: string; before: string; after: string; reason: string }[];
      };

      const soulPath = path.join(baseDir, folderName, 'Soul.md');
      if (!fs.existsSync(soulPath)) return false;

      let soulContent = fs.readFileSync(soulPath, 'utf8');

      // 应用所有修改
      let applied = false;
      for (const change of draft.soul_changes) {
        if (soulContent.includes(change.before)) {
          soulContent = soulContent.replace(change.before, change.after);
          applied = true;
        }
      }

      if (applied) {
        // 获取绑定的用户人设真实姓名，执行存盘前收缩替换为 {{user}}
        const userName = db.getUserNameByCharacterId(characterId);
        if (userName) {
          const userNameRegex = new RegExp(userName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
          soulContent = soulContent.replace(userNameRegex, '{{user}}');
        }
        fs.writeFileSync(soulPath, soulContent, 'utf8');
        db.setSetting(`soul_last_changed_${characterId}`, Date.now().toString());
        db.setSetting(`soul_draft_${characterId}`, ''); // 清空草案
        console.log(`[SoulEvolutionService] 性格人设修改已被用户批准，物理写回 Soul.md 成功！`);
        return true;
      }
    } catch (err) {
      console.error('[SoulEvolutionService] 批准性格进化草案失败:', err);
    }
    return false;
  }

  /**
   * 拒绝性格进化草案
   */
  public rejectDraft(characterId: string): void {
    const db = getDatabaseService();
    db.setSetting(`soul_draft_${characterId}`, ''); // 丢弃草案
    console.log(`[SoulEvolutionService] 用户拒绝了性格人设进化草案，丢弃成功。`);
  }
}
