import * as path from 'path';
import * as fs from 'fs';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';

/**
 * BackgroundReviewService
 * 静默睡眠进化反思服务，负责在后台通过辅助大模型深度剖析聊天快照，
 * 寻找用户的 Frustration 挫败纠错信号，并物理 Patch 写回 Soul.md 和技能的 SKILL.md。
 */
export class BackgroundReviewService {
  private storageManager: CharacterStorageManager;

  constructor() {
    this.storageManager = new CharacterStorageManager();
  }

  /**
   * 执行后台睡眠反思与技能 Patch 打补丁进化
   * @param folderName 角色专属文件夹名称
   * @param charId 角色 ID
   * @param chatTurns 最近的几回合聊天快照数据
   * @param modelAdapter 大模型适配器
   */
  public async reviewAndPatch(
    folderName: string,
    charId: string,
    chatTurns: { role: string; content: string }[],
    modelAdapter: ModelAdapter
  ): Promise<void> {
    if (chatTurns.length === 0) {
      console.log('[BackgroundReviewService] 对话快照为空，睡眠反思跳过。');
      return;
    }

    console.log(`[BackgroundReviewService] 开始执行角色 ${folderName} 的后台做梦睡眠自省进化...`);

    const charDir = path.join(this.storageManager.getBaseDir(), folderName);
    if (!fs.existsSync(charDir)) {
      console.warn(`[BackgroundReviewService] 未找到角色主目录: ${charDir}`);
      return;
    }

    // 1. 组装对话简报上下文
    const chatTranscript = chatTurns
      .map(t => `[${t.role === 'user' ? 'User' : 'Character'}]: ${t.content}`)
      .join('\n');

    // 读取已有的 DREAM.md 内容作为语义排重的比对上下文
    const dreamMdPath = path.join(charDir, 'DREAM.md');
    let existingDreamContent = '*None*';
    if (fs.existsSync(dreamMdPath)) {
      const rawDream = fs.readFileSync(dreamMdPath, 'utf8').trim();
      if (rawDream) {
        existingDreamContent = rawDream;
      }
    }

    // 2. 组装睡眠自省专用 Prompt (挫败信号捕获与技能 Patch 指令)
    const systemPrompt = `You are the sleeping inner-subconscious curator of the AI Character "${folderName}".
Your task is to analyze the recent conversation transcript for any "User Frustration Signals" (e.g., user correcting style, complaints like "别给我放这种歌", "不要这样称呼我", "少说废话", or "Don't do X").

Below is the existing DREAM.md patch guidelines for this character:
[EXISTING DREAM.MD GUIDELINES]
${existingDreamContent}
[END OF EXISTING GUIDELINES]

CRITICAL DEDUPLICATION & COMBINING RULE:
Compare any potential new patches with the EXISTING DREAM.MD GUIDELINES above. If a potential patch has the same meaning, targets the same behavior, or addresses the same pitfall as an existing rule (even if described using different words or expressions), you MUST NOT output it. Do not add any semantically duplicate or redundant rules. Only output highly unique, newly discovered frustration rules.

1. "skill_patches": Action execution pitfalls. If user complained about how a specific skill (like "play-music") behaved, generate a precise pitfall guideline patch (e.g. "避坑：深夜禁止推荐摇滚乐").

CRITICAL LANGUAGE RULE: The generated 'patch_content' MUST be written in Simplified Chinese (简体中文) to ensure the AI's internal memory alignment remains high.

You MUST reply with a single JSON object matching this structure EXACTLY. If no frustration signals are found, return empty fields or null. Do not write anything outside the JSON.

Target JSON format:
{
  "skill_patches": [
    {
      "skill_name": "play-music",
      "patch_content": "declarative pitfall/guideline to be appended to DREAM.md, or null"
    }
  ]
}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[CHAT SNAPSHOT]\n${chatTranscript}` }
    ];

    try {
      // 3. 调用辅助模型进行静默推理 (useSecondary: true)
      const response = await modelAdapter.chat(messages, { useSecondary: true });
      const rawContent = response.content.trim();

      // 正则截获 JSON
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[BackgroundReviewService] 大模型未吐出有效反思指令，睡眠结束。');
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        skill_patches: { skill_name: string; patch_content: string | null }[] | null;
      };

      // 4. 物理 Patch 写盘：将反思避坑补丁追加写入专属 DREAM.md，并不再改动 Soul.md 与 skills 目录
      if (Array.isArray(parsed.skill_patches)) {
        const dreamMdPath = path.join(charDir, 'DREAM.md');
        let dreamContent = '';
        
        if (fs.existsSync(dreamMdPath)) {
          dreamContent = fs.readFileSync(dreamMdPath, 'utf8').trim();
        } else {
          dreamContent = `# 梦境自省反思与进化补丁\n\n## 专属避坑准则与习惯修正`;
        }
        
        let hasNewPatch = false;
        for (const skillPatch of parsed.skill_patches) {
          if (skillPatch.patch_content && skillPatch.patch_content.trim()) {
            const cleanPatch = skillPatch.patch_content.trim();
            // 防重复写入
            if (!dreamContent.includes(cleanPatch)) {
              // 自动将默认占位说明行替换成真实条目
              if (dreamContent.includes('暂无梦境自省事实与避坑规则沉淀。')) {
                dreamContent = dreamContent.replace('暂无梦境自省事实与避坑规则沉淀。', '').trim();
              }
              dreamContent += `\n* 避坑补丁（${skillPatch.skill_name || '通用'}）：${cleanPatch}`;
              hasNewPatch = true;
              console.log(`[BackgroundReviewService] ✔ 梦境进化避坑追加至 DREAM.md: "${cleanPatch}"`);
            }
          }
        }
        
        if (hasNewPatch) {
          fs.writeFileSync(dreamMdPath, dreamContent, 'utf8');
        }
      }

      console.log(`[BackgroundReviewService] 💾 Self-improvement review: DREAM.md patches applied`);

    } catch (err) {
      console.error('[BackgroundReviewService] 后台睡眠进化反思失败:', err);
    }
  }
}
