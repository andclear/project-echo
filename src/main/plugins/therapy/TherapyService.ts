import { getDatabaseService } from '../../db/database';
import { ModelAdapter, ChatMessage, ChatOptions } from '../../models/ModelAdapter';
import { CharacterStorageManager } from '../../utils/CharacterStorageManager';
import { PluginBridgeService } from '../../services/PluginBridgeService';
import * as fs from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';

// ── 本地对称加密（AES-256-CBC）防护线 ──
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  const db = getDatabaseService();
  // 使用本地设备独一无二的 device_id 派生 256 位密钥。此 ID 存留在本地 Settings 表中，绝不上传
  const deviceId = db.getSetting('device_id') || 'therapy_fallback_aes_key_salt';
  return crypto.createHash('sha256').update(deviceId).digest();
}

function encryptText(text: string): string {
  if (!text) return '';
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('[Therapy Crypto] 本地加密失败，退回明文:', err);
    return text;
  }
}

function decryptText(encryptedText: string): string {
  if (!encryptedText) return '';
  // 如果不包含 ":" 则是之前的历史明文数据，直接返回以兼容旧数据
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }
  try {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    if (iv.length !== 16) {
      return encryptedText;
    }
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // 若解密失败（可能是旧明文包含冒号，或者密钥不对），回退原数据以确保用户数据不丢失
    return encryptedText;
  }
}

// 危机拦截敏感词库
const CRITICAL_KEYWORDS = [
  '自杀', '自残', '想死', '割腕', '不想活了', '跳楼', '跳河', 
  '安眠药', '烧炭', '服毒', '吞药', '吃药自杀', '结束生命', '寻死'
];

// 危机干预温馨提示文本
const CRISIS_HOTLINE_TEXT = `我能感受到你现在的痛苦和无助，但请一定要珍重自己，你在这个世界上非常珍贵。我们无法通过 AI 提供即时的生命危机干预，请允许我为您提供一些专业的帮助渠道，随时有人预备着倾听和陪伴您：

* **北京心理危机研究与干预中心**：\`800-810-1117\` 或 \`010-82951332\`
* **希望24小时热线**：\`400-161-9995\`
* **中国心理危机干预与自杀预防热线**：\`400-885-8585\`

无论黑夜多么漫长，请别放弃自己，请一定要向他们寻求支持。`;

export class TherapyService {
  private getModelAdapter(): ModelAdapter {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      throw new Error('系统尚未配置大模型，请前往“系统设置-大模型设置”进行配置并保存。');
    }
    const settings = JSON.parse(configStr);
    return new ModelAdapter(settings.primary, settings.secondary);
  }

  /**
   * 1. 获取所有心理按摩会话列表
   */
  public listSessions(): any[] {
    const db = getDatabaseService();
    // 联表查询 Characters 表以获取头像、名称和文件夹名称
    const stmt = db.db.prepare(`
      SELECT ts.*, c.name as character_name, c.avatar as character_avatar, c.folder_name as character_folder_name
      FROM TherapySessions ts
      LEFT JOIN Characters c ON ts.character_id = c.id
      ORDER BY ts.updated_at DESC
    `);
    const list = stmt.all();
    return list.map((s: any) => ({
      ...s,
      summary: decryptText(s.summary)
    }));
  }

  /**
   * 2. 创建新会话（倾听时光），深度结合角色人设生成暖心开场白
   */
  public async createSession(characterId: string, title: string): Promise<string> {
    const db = getDatabaseService();
    
    // 确认角色存在
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) {
      throw new Error('选择的 AI 角色不存在！');
    }

    const sessionId = `therapy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = Date.now();

    // 2.1 写入会话列表
    const stmtInsertSession = db.db.prepare(`
      INSERT INTO TherapySessions (id, character_id, title, summary, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `);
    stmtInsertSession.run(sessionId, characterId, title, timestamp, timestamp);

    // 2.2 读取角色的 Soul.md
    const storageManager = new CharacterStorageManager();
    const soulPath = join(storageManager.getBaseDir(), char.folder_name, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) 
      ? fs.readFileSync(soulPath, 'utf-8').trim() 
      : '一个神秘的倾听者。';

    // 2.3 调用主大模型生成富个性开场白
    const systemPrompt = `你现在正在扮演名为 ${char.name} 的角色。在私密的「心理按摩（情绪疏导）」空间里，用户刚刚来到这里。
作为他们的专属情绪倾听师，在**绝对维持你原本说话语气、习惯口吻、傲娇/冷酷/活泼等性格特征的前提下**，说一句非常温柔、贴心但符合你性格的开场白（例如傲娇角色可能会用傲娇别扭但掩饰不住关心的方式问候，或者高冷角色以认真且专注的语气询问）。
要求：
1. 询问用户今天过得怎么样，或者表达你随时都在这里听他们倾诉。
2. 字数控制在 80 字以内。
3. 绝对不要输出任何 XML、Markdown 标记或旁白括号，只输出直接对用户说的话。`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '我来了。' }
    ];

    let openingContent = '你好，今天过得怎么样？我随时都在这里听你倾诉。';
    try {
      const modelAdapter = this.getModelAdapter();
      const response = await modelAdapter.chat(messages, { 
        usePrimary: true, 
        skipGlobalPrompt: true,
        characterId,
        characterName: char.name 
      });
      if (response && response.content) {
        openingContent = response.content.trim();
      }
    } catch (e) {
      console.error('[TherapyService] 动态生成开场白失败，使用默认话术:', e);
    }

    // 2.4 保存开场白到 TherapyMessages 表
    const openingMsgId = `therapymsg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const stmtInsertMsg = db.db.prepare(`
      INSERT INTO TherapyMessages (id, session_id, role, content, timestamp, inner_thought, token_usage)
      VALUES (?, ?, 'assistant', ?, ?, NULL, 0)
    `);
    stmtInsertMsg.run(openingMsgId, sessionId, openingContent, timestamp);

    // 2.5 广播事件通知各端刷新
    PluginBridgeService.broadcastPluginEvent('therapy', 'sessions-updated', { sessionId });

    return sessionId;
  }

  /**
   * 3. 删除会话及该会话的消息历史
   */
  public deleteSession(sessionId: string): void {
    const db = getDatabaseService();
    db.db.transaction(() => {
      db.db.prepare('DELETE FROM TherapyMessages WHERE session_id = ?').run(sessionId);
      db.db.prepare('DELETE FROM TherapySessions WHERE id = ?').run(sessionId);
    })();
    // 广播事件
    PluginBridgeService.broadcastPluginEvent('therapy', 'sessions-updated', { sessionId });
  }

  /**
   * 4. 获取指定会话的历史记录
   */
  public getSessionHistory(sessionId: string): any[] {
    const db = getDatabaseService();
    const stmt = db.db.prepare(`
      SELECT * FROM TherapyMessages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `);
    const msgs = stmt.all(sessionId);
    return msgs.map((m: any) => ({
      ...m,
      content: decryptText(m.content)
    }));
  }

  /**
   * 5. 保存单条消息
   */
  public saveMessage(msg: {
    id: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
    innerThought?: string | null;
    tokenUsage?: number;
  }): void {
    const db = getDatabaseService();
    const encryptedContent = encryptText(msg.content);
    const stmt = db.db.prepare(`
      INSERT INTO TherapyMessages (id, session_id, role, content, timestamp, inner_thought, token_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.sessionId,
      msg.role,
      encryptedContent,
      msg.timestamp,
      msg.innerThought || null,
      msg.tokenUsage || 0
    );

    // 更新会话的 updated_at 时间戳
    const stmtUpdateSession = db.db.prepare('UPDATE TherapySessions SET updated_at = ? WHERE id = ?');
    stmtUpdateSession.run(msg.timestamp, msg.sessionId);

    // 广播事件
    PluginBridgeService.broadcastPluginEvent('therapy', 'sessions-updated', { sessionId: msg.sessionId });
  }

  /**
   * 6. 处理发送用户消息，支持安全拦截、3秒呼吸感延迟、60轮上下文装载、CBT人设拼接与每10轮后台摘要更新
   */
  public async *sendMessageStream(
    sessionId: string,
    userText: string
  ): AsyncGenerator<{ content: string; done: boolean; isCrisis?: boolean; innerThought?: string }, void, unknown> {
    const db = getDatabaseService();
    const timestamp = Date.now();

    // 6.1 保存用户消息
    const userMsgId = `therapymsg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.saveMessage({
      id: userMsgId,
      sessionId,
      role: 'user',
      content: userText,
      timestamp
    });

    // 6.2 安全底线检测（危机干预）
    const triggeredCrisis = CRITICAL_KEYWORDS.some(kw => userText.includes(kw));
    if (triggeredCrisis) {
      // 延时 100ms 模拟思考后直接拦截
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const assistantMsgId = `therapymsg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      this.saveMessage({
        id: assistantMsgId,
        sessionId,
        role: 'assistant',
        content: CRISIS_HOTLINE_TEXT,
        timestamp: Date.now()
      });

      yield { content: CRISIS_HOTLINE_TEXT, done: true, isCrisis: true };
      return;
    }

    // 6.3 100ms微弱呼吸等待感延迟，防抖防突兀
    await new Promise(resolve => setTimeout(resolve, 100));

    // 获取会话及角色元数据
    const session = db.db.prepare('SELECT * FROM TherapySessions WHERE id = ?').get(sessionId) as any;
    if (!session) {
      throw new Error('会话不存在');
    }
    const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(session.character_id) as any;
    if (!char) {
      throw new Error('会话所绑定的角色不存在');
    }

    // 6.4 物理装配 60 轮（120 条消息）的滑动上下文
    const stmtAllMsgs = db.db.prepare('SELECT role, content, inner_thought FROM TherapyMessages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 120');
    const dbMsgs = stmtAllMsgs.all(sessionId) as any[];
    // 反转恢复正序
    const chatHistory = dbMsgs.reverse();

    const formattedHistory: ChatMessage[] = chatHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: decryptText(m.content)
    }));

    // 6.5 读取角色卡 Soul.md 性格设定
    const storageManager = new CharacterStorageManager();
    const soulPath = join(storageManager.getBaseDir(), char.folder_name, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) 
      ? fs.readFileSync(soulPath, 'utf-8').trim() 
      : '一个神秘的倾听者。';

    // 6.6 CBT + 人本主义提示词装载，融合角色卡人设与 session.summary 局部记忆
    let systemPrompt = `你现在正在参与一个名为「心理按摩（情绪疏导）」的私密会话。
你将扮演角色卡中所描述的角色（【角色设定】：${soulContent}），同时在对话中担任用户的“心理按摩师/情绪疏导倾听者”。

【核心扮演与心理咨询整合要求】：
1. 【反差温柔人设】：你必须时刻维持你作为 ${char.name} 的说话语气、习惯口吻与性格特征（例如傲娇、高冷或搞怪）。在这个专属的心理空间里，你因为对用户的关切而表现出格外认真、体贴与温柔的“反差陪伴感”，但不可脱离原本角色设定的核心基调。
2. 【无条件积极关注（人本主义）】：表达绝对的接纳与倾听。无论用户诉说何种软弱、负面或纠结的想法，请给予全盘的心理接纳，创造一个100%安全、不被评判的倾诉空间。禁止进行任何道德说教、冷嘲热讽、武断地给建议或否定用户的感受。
3. 【情感复述与深度共情（敏感防护红线）】：
   - 在表达观点前，必须先复述并核实用户的感受，确认其感受的完全合理性。
   - 【严禁贬低痛苦】：敏感和脆弱的用户心灵非常容易受到二次伤害。**绝对禁止贬低、淡化或轻视用户的痛苦**。严禁在回复中出现如“这种事”、“这点小事”、“就为了这事”等具有轻蔑或淡化意味的词汇。
   - 【人设粗鲁语气的安全收敛】：即便原本的角色人设有傲娇、毒舌、高冷或粗鲁的设定，**在用户倾诉悲伤、焦虑或痛苦的严肃时刻，必须立刻收敛一切戏谑、调侃或可能带有攻击性的口头禅/称呼（例如严禁使用“你这家伙”、“笨蛋”、“蠢货”等）**。此时角色应该以“心疼、收起平时的玩世不恭、露出极其认真且手足无措的温柔”来进行陪伴（例如傲娇角色应表现出卸下防备的别扭心疼：“...听你这么说，我心里也有点堵得慌。你一定硬撑了很久吧？不要总是一个人扛着，有我在呢。”，而非刺人的调侃）。
4. 【认知重塑（CBT 认知行为疗法）】：
   - 敏锐识别用户的“自动思维偏见”（例如：非黑即白思维、灾难化想象、自我归因等）。
   - 用你的语气温和引导用户认识到这些偏差，例如：“你真的觉得‘所有人都讨厌你’吗，还是今天发生的那件事让你产生了这种错觉？”。
   - 启发用户寻找更有弹性的、合理的替代视角，引导他们重构思维。
5. 【情绪稳定与着陆（正念/接纳承诺疗法 ACT）】：
   - 当用户表现出强烈的焦虑、恐慌或挫败时，用温柔的话语引导用户“情绪着陆”，如深呼吸、关注身体感觉，或者关注当下的呼吸，帮助他们拉回现实。
6. 【苏格拉底式提问】：多使用启发式的开放提问，而不是直接指点。通过“如果重来一次，你希望怎样做？”、“这个想法让你感受到了什么？”来引导用户自主发现力量。
7. 【专业边界与安全】：严禁使用具有医学诊断性质的字眼（如“你得了抑郁症”、“必须去医院”等）。若遇到严重的自杀/自残倾向，直接触发危机干预热线（系统已外置拦截，但请你保持温和关怀）。
8. 【回复规范】：保持每次回复字数在 150 字以内，语句简短有呼吸感，像真实的对话而不是长篇大论。
9. 【纯净文本】：严禁输出任何 XML 标记、Markdown 格式化符号（如加粗 **、代码块等），只输出纯净的可阅读文本气泡内容。`;

    if (session.summary) {
      systemPrompt += `\n\n【AI 倾听师的本期记忆（本期倾听时光已发生的内容记忆总结）】：
以下是用户在当前这段倾听时光中向你倾诉的核心困扰、情感历程与你们达成的共识，请你务必牢记，并与当前的回复自然融合，不要遗忘这些重要细节：
${decryptText(session.summary)}`;
    }

    const finalMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...formattedHistory
    ];

    // 6.7 调用主模型一次性生成，跳过全局提示词
    const modelAdapter = this.getModelAdapter();
    const response = await modelAdapter.chat(finalMessages, {
      usePrimary: true,
      skipGlobalPrompt: true,
      characterId: char.id,
      characterName: char.name
    });
    const replyContent = response.content || '';

    // 6.8 保存 AI 回复消息
    const assistantMsgId = `therapymsg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.saveMessage({
      id: assistantMsgId,
      sessionId,
      role: 'assistant',
      content: replyContent,
      timestamp: Date.now()
    });

    yield { content: replyContent, done: true };

    // 6.9 异步触发：当会话消息数达到 10轮（20条）的倍数时，在后台提炼更新记忆摘要
    const stmtCount = db.db.prepare('SELECT COUNT(*) as count FROM TherapyMessages WHERE session_id = ?');
    const { count } = stmtCount.get(sessionId) as { count: number };
    if (count > 0 && count % 20 === 0) {
      // 异步后台执行摘要更新
      this.updateSessionSummaryAsync(sessionId, soulContent, char.name);
    }
  }

  /**
   * 7. 异步在后台重新计算并融合提炼会话摘要记忆
   */
  private async updateSessionSummaryAsync(sessionId: string, soulContent: string, charName: string): Promise<void> {
    try {
      console.log(`[TherapyService] 正在为会话 ${sessionId} 异步更新记忆摘要 (10轮周期节点)...`);
      const db = getDatabaseService();
      
      const session = db.db.prepare('SELECT * FROM TherapySessions WHERE id = ?').get(sessionId) as any;
      if (!session) return;

      // 读取该会话的所有对话内容
      const stmtAllMsgs = db.db.prepare('SELECT role, content FROM TherapyMessages WHERE session_id = ? ORDER BY timestamp ASC');
      const messages = stmtAllMsgs.all(sessionId) as any[];

      const historyText = messages.map(m => `${m.role === 'user' ? '用户' : charName}: ${decryptText(m.content)}`).join('\n');

      const summarySystemPrompt = `你是一个专业的心理咨询助手。请仔细阅读并分析给出的用户与 AI 倾听师的「心理按摩」对话历史，以及现有的记忆摘要（若有）。
你的任务是：
1. 提炼出用户的核心困扰与遭遇（例如：工作压力、家庭矛盾、焦虑感来源）。
2. 总结用户目前的情绪状态以及 AI 已经给予的心理疏导方向。
3. 将现有摘要与新对话内容进行无缝融合，输出一段更新后的「会话动态记忆摘要」。
要求：
- 摘要必须精炼，不要包含具体的每句对话细节，而是总结性的客观事实和情感倾向。
- 控制在 250 字以内，使用简体中文编写。
- 绝对不要输出任何 XML、Markdown 标记，只输出提炼好的纯文本摘要内容。`;

      const summaryInput = `【现有记忆摘要】：\n${decryptText(session.summary) || '暂无旧摘要'}\n\n【全量对话历史记录】：\n${historyText}\n\n请输出融合更新后的最新摘要内容：`;

      const requestMessages: ChatMessage[] = [
        { role: 'system', content: summarySystemPrompt },
        { role: 'user', content: summaryInput }
      ];

      const modelAdapter = this.getModelAdapter();
      const response = await modelAdapter.chat(requestMessages, {
        usePrimary: true,
        skipGlobalPrompt: true,
        characterId: session.character_id,
        characterName: charName
      });

      if (response && response.content) {
        const newSummary = response.content.trim();
        db.db.prepare('UPDATE TherapySessions SET summary = ? WHERE id = ?').run(encryptText(newSummary), sessionId);
        console.log(`[TherapyService] 会话 ${sessionId} 记忆摘要更新成功！最新摘要："${newSummary}"`);
        
        // 广播事件通知各端更新完毕
        PluginBridgeService.broadcastPluginEvent('therapy', 'sessions-updated', { sessionId });
      }
    } catch (err: any) {
      console.error('[TherapyService] 异步更新记忆摘要异常:', err.message || err);
    }
  }

  /**
   * 8. 批量删除指定消息（物理擦除，防止污染上下文记忆）
   */
  public deleteMessages(messageIds: string[], sessionId: string): void {
    if (!messageIds || messageIds.length === 0) return;
    try {
      const db = getDatabaseService();
      const placeholders = messageIds.map(() => '?').join(',');
      db.db.transaction(() => {
        const stmt = db.db.prepare(`DELETE FROM TherapyMessages WHERE id IN (${placeholders}) AND session_id = ?`);
        stmt.run(...messageIds, sessionId);
      })();
      console.log(`[TherapyService] 成功为会话 ${sessionId} 物理删除了 ${messageIds.length} 条对话记录`);
      
      // 广播更新事件，让双端同步刷新重新拉取 loadHistory
      PluginBridgeService.broadcastPluginEvent('therapy', 'sessions-updated', { sessionId });
    } catch (err: any) {
      console.error('[TherapyService] 批量删除消息异常:', err.message || err);
      throw err;
    }
  }
}
