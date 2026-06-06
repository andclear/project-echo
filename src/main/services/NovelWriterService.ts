import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { getDatabaseService } from '../db/database'
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter'
import { CharacterStorageManager } from '../utils/CharacterStorageManager'
import { InferenceMutex } from '../utils/InferenceMutex'

export const NOVEL_TOKEN_THRESHOLD: Record<string, number> = {
  dialogue: 1500,
  descriptive: 3500,
}

/**
 * 用户未配置文风时使用的默认文风档（对齐 style-profile-protocol 结构）
 */
export const DEFAULT_STYLE_PROMPT = `## 整体语感
- 句长分布：短句(<15字)占40%、中句(15-30字)占45%、长句(>30字)占15%。日常对话段以中短句为主；情绪爆发点切换3~8字短句叠加
- 标点习惯：破折号用于话语中断与思路转折；省略号仅限真正的沉默或欲言又止，每千字≤2处；感叹号克制，每千字≤1个；逗号不连续超过3个
- 段落节奏：1-3句为主段长，偶尔1句独占1行制造停顿感。长短交错，禁止连续3段以上相同长度

## 对话技法
- 潜台词模式：角色不直球表达内心——善用答非所问、语气反差、刻意岔开话题。示例："你吃了吗？"——实际在问"你还好吗"
- 对话标签习惯：60%+对话无标签，用微动作穿插替代"说"（如"她低头搅着吸管"引出对话）。普通"说"可保留，禁用"沉声道""淡淡地说""缓缓开口"等公式化标签
- 角色语气区分：口语化、生活化，不写书面腔。不同角色有各自口头禅和句式节奏

## 情绪表达
- 情绪展示手法：用身体反应和具体行为展示——紧张时"指甲掐进掌心"、愤怒时"筷子在桌上磕出声响"、心动时"视线追着对方的背影走"。绝不写"他很紧张""她很伤心"等直接情绪词
- 基调切换节奏：紧张与松弛、甜蜜与酸涩交替穿插，同一章内至少一次明显的情绪起伏转折

## 写法技巧
1. 留白与省略：大量省略，让读者自己脑补。对话间隙以沉默、停顿、小动作暗示未说出口的潜台词
2. 五感锚定场景：重要场景至少调动两种感官（气味、触感、声音、光线），不写空洞的"环境很好"
3. 动作链叙事：用连续小动作串联人物状态变化，不拆成"发生→感知→反应"三段分写，织入同一段呈现
4. 克制温柔基调：情感浓度在字面之下流动，不滥用浓烈修辞
5. 动作/对话收束：章尾以具体动作、一句未说完的话或悬念画面收尾，禁止哲理感悟式总结`

export class NovelWriterService {
  private modelAdapter: ModelAdapter
  private static readonly MAX_RETRIES = 3

  // 全局小说生成串行队列
  private static taskQueue: Array<{
    characterId: string
    action: () => Promise<void>
    onDone?: (err?: any) => void
  }> = []
  private static isProcessing = false
  private static generatingSet = new Set<string>()

  public static isGenerating(characterId: string): boolean {
    return this.generatingSet.has(characterId)
  }

  private broadcastGenerationState(characterId: string, generating: boolean) {
    if (generating) {
      NovelWriterService.generatingSet.add(characterId)
    } else {
      NovelWriterService.generatingSet.delete(characterId)
    }

    BrowserWindow.getAllWindows().forEach(w => {
      if (!w.webContents.isDestroyed()) {
        w.webContents.send('novel-generation-state-changed', {
          characterId,
          generating
        })
      }
    })
  }

  private static enqueue(characterId: string, action: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({
        characterId,
        action,
        onDone: (err) => {
          if (err) reject(err)
          else resolve()
        }
      })
      this.processQueue()
    })
  }

  private static async processQueue() {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()
      if (task) {
        try {
          await task.action()
          if (task.onDone) task.onDone()
        } catch (err) {
          console.error(`[NovelWriterService] 全局小说队列任务执行失败:`, err)
          if (task.onDone) task.onDone(err)
        }
      }
    }

    this.isProcessing = false
  }

  constructor(modelAdapter: ModelAdapter) {
    this.modelAdapter = modelAdapter
  }

  /**
   * 带自动重试的大模型调用，失败后等待 2 秒重试，最多 MAX_RETRIES 次
   */
  private async chatWithRetry(messages: ChatMessage[], options: any, label: string): Promise<any> {
    for (let attempt = 1; attempt <= NovelWriterService.MAX_RETRIES; attempt++) {
      try {
        return await this.modelAdapter.chat(messages, options)
      } catch (err: any) {
        console.error(`[NovelWriterService] ${label}调用失败（第${attempt}/${NovelWriterService.MAX_RETRIES}次）:`, err.message || err)
        if (attempt >= NovelWriterService.MAX_RETRIES) {
          throw err // 重试耗尽，向上抛出
        }
        // 等待 2 秒后重试
        await new Promise(resolve => setTimeout(resolve, 2000))
        console.log(`[NovelWriterService] ${label}正在第 ${attempt + 1} 次重试...`)
      }
    }
    throw new Error(`${label}重试耗尽`) // 理论上不会到达
  }

  /**
   * 检查并触发小说章节生成（后台自动检查）
   */
  public async checkAndGenerateChapter(characterId: string): Promise<void> {
    const db = getDatabaseService()
    const novelEnabled = db.getSetting(`novel_enabled_${characterId}`) === '1'
    if (!novelEnabled) return

    // 导演模式 (director) 不支持小说生成，只支持 descriptive 和 dialogue 模式
    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'dialogue'
    if (chatMode === 'director') return

    const chapterCount = db.getNovelChapterCount(characterId)
    const startTsStr = db.getSetting(`novel_start_ts_${characterId}`) || '0'
    const startTs = parseInt(startTsStr, 10)

    // 1. 首章：开启AI写手、章节数为 0，且是用户和角色第一次发消息时（未改编消息中包含且仅包含 1 条角色回复时）立即触发
    if (chapterCount === 0) {
      const assistantMsgs = db.db.prepare(`
        SELECT id FROM Messages 
        WHERE character_id = ? AND role = 'assistant' AND timestamp > ?
      `).all(characterId, startTs)

      if (assistantMsgs.length === 1) {
        console.log(`[NovelWriterService] 检测到角色 ${characterId} 满足首章生成条件，开始生成第一章。`)
        await this.generateChapter(characterId, { isFirstChapter: true })
      }
      return
    }

    // 2. 后续章节：按仅包含对话内容的 token 累积阈值触发
    const threshold = NOVEL_TOKEN_THRESHOLD[chatMode] ?? 3500
    const lastEndTs = parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
    const baseTs = Math.max(lastEndTs, startTs)
    
    const pendingMessages = db.db.prepare(`
      SELECT content FROM Messages
      WHERE character_id = ? AND timestamp > ?
    `).all(characterId, baseTs) as any[]

    let newTokens = 0
    for (const msg of pendingMessages) {
      newTokens += this.estimateMessageTokens(msg)
    }

    console.log(`[NovelWriterService] 角色 ${characterId} 自动检查：当前未改编对话估算 token 量为 ${newTokens}，生成阈值为 ${threshold}`)
    if (newTokens >= threshold) {
      console.log(`[NovelWriterService] 角色 ${characterId} 已达到阈值条件，开始生成续章小说。`)
      await this.generateChapter(characterId, { isFirstChapter: false })
    }
  }

  public async generateChapter(characterId: string, options: { isFirstChapter: boolean }): Promise<void> {
    console.log(`[NovelWriterService] 角色 ${characterId} 触发小说生成，正在加入全局串行队列...`)
    this.broadcastGenerationState(characterId, true)
    NovelWriterService.enqueue(characterId, async () => {
      try {
        await this.generateChaptersFromPendingDialogue(characterId, options.isFirstChapter)
      } finally {
        this.broadcastGenerationState(characterId, false)
      }
    }).catch(err => {
      this.broadcastGenerationState(characterId, false)
      throw err
    })
  }

  /**
   * 精准估算消息本身的纯文本 tokens 数量，排除 API 调用的上下文开销
   */
  private estimateMessageTokens(msg: any): number {
    const content = msg.content || ''
    // 剔除可能的思维链以准确估算真实输出长度
    const cleanContent = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    return Math.ceil(cleanContent.length * 1.3) + 5
  }

  /**
   * 将消息时间戳格式化为可读的 YYYY-MM-DD HH:mm 格式，供 AI 识别时间线
   */
  private formatTimestamp(ts: number): string {
    const date = new Date(ts)
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${y}-${m}-${d} ${hh}:${mm}`
  }

  /**
   * 按照约 3000 tokens 切割 pending 的原始对话消息
   */
  private chunkMessagesByToken(messages: any[], targetTokenLimit = 3000): any[][] {
    const chunks: any[][] = []
    let currentChunk: any[] = []
    let currentTokens = 0

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const tokens = this.estimateMessageTokens(msg)

      currentChunk.push(msg)
      currentTokens += tokens

      // 当累加 tokens 达到限制，且当前消息是角色回复（以 assistant 结尾以结束一轮完整对话）时，进行切分
      if (currentTokens >= targetTokenLimit && msg.role === 'assistant') {
        chunks.push(currentChunk)
        currentChunk = []
        currentTokens = 0
      }
    }

    if (currentChunk.length > 0) {
      // 边缘优化：如果最后一个遗留片段没有包含角色的回复（无 assistant 消息），
      // 且 chunks 中已经有切好的前序分段，为了避免废章，我们直接并入上一个分段
      const hasAssistant = currentChunk.some(m => m.role === 'assistant')
      if (!hasAssistant && chunks.length > 0) {
        chunks[chunks.length - 1].push(...currentChunk)
      } else {
        chunks.push(currentChunk)
      }
    }

    return chunks
  }

  /**
   * 辅助获取当前设定的用户名
   */
  private getUserName(): string {
    const db = getDatabaseService()
    const profileStr = db.getSetting('echo_user_profile')
    if (profileStr) {
      try {
        const parsed = JSON.parse(profileStr)
        if (parsed.nickname) return parsed.nickname
      } catch (_) {}
    }
    return '用户'
  }

  /**
   * 从 pending 对话中分段并串行生成多章节
   */
  private async generateChaptersFromPendingDialogue(characterId: string, isFirstChapter: boolean): Promise<void> {
    const db = getDatabaseService()

    const startTsStr = db.getSetting(`novel_start_ts_${characterId}`) || '0'
    const startTs = parseInt(startTsStr, 10)

    // 1. 读取当前未改编的聊天消息
    const lastEndTs = isFirstChapter ? startTs : parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
    const baseTs = Math.max(lastEndTs, startTs)
    const rawMessages = db.db.prepare(`
      SELECT * FROM Messages 
      WHERE character_id = ? AND timestamp > ? 
      ORDER BY timestamp ASC
    `).all(characterId, baseTs) as any[]

    if (rawMessages.length === 0) {
      console.log(`[NovelWriterService] 没有新的聊天记录用于改编角色 ${characterId} 的小说章节。`)
      return
    }

    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'dialogue'

    // 读取文风设置
    const styleId = db.getSetting(`novel_style_id_${characterId}`) || ''
    const stylesStr = db.getSetting('novel_styles')
    let stylePrompt = ''
    if (stylesStr) {
      try {
        const styles = JSON.parse(stylesStr) as any[]
        const matchedStyle = styles.find(s => s.id === styleId)
        if (matchedStyle && matchedStyle.prompt) {
          stylePrompt = matchedStyle.prompt
        }
      } catch (_) {}
    }

    // 2. 获取角色元数据与设定文件夹
    const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(characterId) as any
    if (!char) {
      console.warn(`[NovelWriterService] 找不到角色 ${characterId}，生成终止。`)
      return
    }

    const folderName = char.folder_name
    const storageManager = new CharacterStorageManager()

    // 读取设定文件
    const soulContent = storageManager.readCharacterFile(folderName, 'Soul.md') || ''
    const worldContent = storageManager.readCharacterFile(folderName, 'World.md') || ''
    const charUserProfile = storageManager.readCharacterFile(folderName, 'USER.md') || ''
    
    const globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')
    const globalUserProfile = fs.existsSync(globalUserPath) ? fs.readFileSync(globalUserPath, 'utf8') : ''

    // 叙事人称与改编尺度设置
    const pov = db.getSetting(`novel_pov_${characterId}`) || 'third_user'
    const adaptation = db.getSetting(`novel_adaptation_${characterId}`) || 'moderate'

    const userName = this.getUserName()
    const charName = char.name

    const povInstruction = this.getPovInstruction(pov, userName, charName)
    const adaptationInstruction = this.getAdaptationInstruction(adaptation)

    const contextOptions = {
      stylePrompt,
      soulContent,
      worldContent,
      globalUserProfile,
      charUserProfile,
      povInstruction,
      adaptationInstruction
    }

    // 3. 计算未改编消息的估算 Token 数量，并提取其中的角色回复数量
    let totalTokens = 0
    for (const msg of rawMessages) {
      totalTokens += this.estimateMessageTokens(msg)
    }
    const assistantMsgs = rawMessages.filter(m => m.role === 'assistant')

    // 4. 双轨判定逻辑
    // 轨道 A：如果估算 Token < 4500，或角色回复数量 < 3 条，直接截取并生成单章（节省调用开销）
    if (totalTokens < 4500 || assistantMsgs.length < 3) {
      const lastAssistantIdx = rawMessages.map(m => m.role).lastIndexOf('assistant')
      if (lastAssistantIdx === -1) {
        console.log(`[NovelWriterService] 角色 ${characterId} 未改编对话中没有角色的回复，暂不生成。`)
        return
      }

      const chunkMessages = rawMessages.slice(0, lastAssistantIdx + 1)
      console.log(`[NovelWriterService] 正在直接生成单章小说，估算 Token 量: ${totalTokens}，对话条数: ${chunkMessages.length}...`)
      try {
        await this.generateSingleChapter(characterId, chunkMessages, {
          isFirstChapter,
          suggestedTitle: '', // 留空由 AI 自行生成标题
          ...contextOptions
        })
      } catch (err: any) {
        console.error(`[NovelWriterService] 直接生成单章小说失败:`, err.message || err)
        throw err
      }
    } 
    // 轨道 B：海量积压历史，必须调用 AI 进行前置智能分章规划
    else {
      console.log(`[NovelWriterService] 未改编对话估算 Token 量达 ${totalTokens}（角色回复数 ${assistantMsgs.length} 条），触发前置智能分章规划。`)
      const plans = await this.planChapters(characterId, rawMessages, stylePrompt)
      console.log(`[NovelWriterService] 智能前置分章规划完成，共拆分为 ${plans.length} 个章节串行生成。`)

      let currentStartIdx = 0
      for (let i = 0; i < plans.length; i++) {
        const plan = plans[i]
        const endMsgIdx = rawMessages.findIndex(m => m.id === plan.endMsgId)
        if (endMsgIdx === -1) continue

        const chunkMessages = rawMessages.slice(currentStartIdx, endMsgIdx + 1)
        currentStartIdx = endMsgIdx + 1

        const chunkIsFirst = isFirstChapter && (i === 0)
        console.log(`[NovelWriterService] 正在串行生成第 ${i + 1}/${plans.length} 章《${plan.title || '拟定中'}》...`)
        
        try {
          await this.generateSingleChapter(characterId, chunkMessages, {
            isFirstChapter: chunkIsFirst,
            suggestedTitle: plan.title,
            ...contextOptions
          })
        } catch (err: any) {
          console.error(`[NovelWriterService] 串行生成第 ${i + 1} 章时失败，中断后续生成:`, err.message || err)
          throw err
        }
      }
    }
  }

  /**
   * AI 前置分章规划器
   */
  private async planChapters(
    characterId: string,
    rawMessages: any[],
    stylePrompt: string
  ): Promise<Array<{ title: string, endMsgId: string }>> {
    const assistantMsgs = rawMessages.filter(m => m.role === 'assistant')
    if (assistantMsgs.length === 0) {
      return []
    }

    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1]

    let totalTokens = 0
    for (const msg of rawMessages) {
      totalTokens += this.estimateMessageTokens(msg)
    }

    // 1. 如果消息量较少，或者只有一条角色回复，直接作为一章处理，不调用 AI 规划，省 Token
    if (totalTokens < 3000 || assistantMsgs.length === 1) {
      return [{
        title: '',
        endMsgId: lastAssistantMsg.id
      }]
    }

    // 2. 消息量较多，调用 AI 进行规划分章
    const systemPrompt = `你是网文分章规划专家。现在有一批未改编为小说的聊天对话原材料。
你的任务是评估这批对话内容，并将其规划为一章或多章小说。

网文的单章字数建议在 1500 ~ 2500 字（大约对应聊天记录中累积 1500 ~ 3000 tokens 的对话量）。
请根据剧情发展的连贯性、场景切换、或者情感转折点，合理地决定分章数量和分割边界。

【分章规则】
1. 每一章都必须以角色的回复（即 role 为 assistant 的消息）作为结尾。你必须在提供的消息列表中选择某条 assistant 消息的 ID 作为该章的结束锚点。
2. 最后一个章节的结束锚点必须是列表中最后一条 assistant 消息的 ID，不能遗漏任何对话。
3. 请为规划的每一章拟定一个富有文采、独立的建议标题（如《月下风铃》），标题中绝对不能包含“第X章”或“第9章”等任何序号字样。

请严格返回一个 JSON 数组，格式如下：
[
  {
    "title": "章节建议标题",
    "endMsgId": "该章结束的消息ID"
  }
]
禁止输出任何额外的解释或 Markdown 包裹标记，直接输出 JSON 数组本身。`

    const formattedList = rawMessages.map(m => {
      const roleName = m.role === 'user' ? '用户' : '角色'
      const timeStr = this.formatTimestamp(m.timestamp)
      return `[ID: ${m.id}] [时间: ${timeStr}] [${roleName}]: ${m.content.substring(0, 100)}`
    }).join('\n')

    const userPrompt = `【待分章的原始对话列表】\n${formattedList}\n\n请输出你的分章计划：`

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]

    try {
      const res = await this.chatWithRetry(messages as any, { useSecondary: true, skipSystemInjection: true }, '分章规划')
      let reply = res.content.trim()
      reply = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
      const parsed = JSON.parse(reply)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const validPlans: Array<{ title: string, endMsgId: string }> = []
        for (const p of parsed) {
          if (p.endMsgId && assistantMsgs.some(m => m.id === p.endMsgId)) {
            validPlans.push({
              title: p.title || '',
              endMsgId: p.endMsgId
            })
          }
        }
        if (validPlans.length > 0) {
          validPlans[validPlans.length - 1].endMsgId = lastAssistantMsg.id
          return validPlans
        }
      }
    } catch (e) {
      console.error('[NovelWriterService] AI 分章规划失败，回退为单章', e)
    }

    return [{
      title: '',
      endMsgId: lastAssistantMsg.id
    }]
  }

  /**
   * 生成单个章节并落盘
   */
  private async generateSingleChapter(
    characterId: string,
    rawMessages: any[],
    options: {
      isFirstChapter: boolean;
      suggestedTitle?: string;
      stylePrompt: string;
      soulContent: string;
      worldContent: string;
      globalUserProfile: string;
      charUserProfile: string;
      povInstruction: string;
      adaptationInstruction: string;
    }
  ): Promise<void> {
    const db = getDatabaseService()

    // 1. 获取并发锁，保证推理不并发，杜绝卡顿
    await InferenceMutex.lock()

    try {
      const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(characterId) as any
      if (!char) {
        console.warn(`[NovelWriterService] generateSingleChapter: 找不到角色 ${characterId}`)
        return
      }

      const charName = char.name
      const userName = this.getUserName()

      // 获取这批消息的起止时间戳
      const dialogue_start_ts = rawMessages[0].timestamp
      const dialogue_end_ts = rawMessages[rawMessages.length - 1].timestamp

      // 格式化聊天记录
      const formattedDialogue = this.preprocessMessages(rawMessages, userName, charName)

      // 读取已有章节的摘要与最近 2 章全文 (连贯性注入)
      const allChapters = db.getNovelChapters(characterId)
      let prevSummaries = ''
      allChapters.forEach((ch: any) => {
        prevSummaries += `[第${ch.chapter_index}章]《${ch.title}》：${ch.summary}\n`
      })
      if (!prevSummaries) prevSummaries = '暂无前序章节。'

      let prevFullChapters = ''
      if (allChapters.length > 0) {
        const recentChapters = allChapters.slice(-2)
        for (const ch of recentChapters) {
          const fullContent = db.getNovelChapterContent(ch.id)
          if (fullContent && fullContent.content) {
            prevFullChapters += `【第${ch.chapter_index}章《${ch.title}》正文参考】\n${fullContent.content}\n\n`
          }
        }
      }

      // 组装 System Prompt 与 User Prompt
      const systemPrompt = this.buildWriterSystemPrompt(
        options.soulContent,
        options.worldContent,
        options.globalUserProfile,
        options.charUserProfile,
        options.stylePrompt,
        prevSummaries,
        prevFullChapters,
        options.povInstruction,
        options.adaptationInstruction,
        options.isFirstChapter
      )

      const userPrompt = `【待改编的对话原材料（每行开头带有 [YYYY-MM-DD HH:mm] 格式的聊天发生时间，按时间顺序）】
${formattedDialogue}

请立即以小说叙事手法将以上对话改编成一个完整的小说章节。
创作要点（核心硬性指标）：
① 剧情至上：小说的核心是连贯精彩的情节和画面感，绝对禁止像剧本一样逐条翻译台词！
② 合理时间过渡：注意每条消息开头的时间戳，如果两次对话之间跨度较大（比如隔了数个小时或几天），必须在小说里描写合理的时间流逝、天色变迁、或日期转换（例如「第二天清晨」、「过了几个小时」等），确保故事的发展脉络在时间线上完全对齐，严禁将不同时间段的对话生硬地挤在同一天内发生。
③ 丰满 NPC 角色：当对话中出现第三方 NPC（或在多人群聊中）时，必须赋予 NPC 独立的说话内容、面部表情、肢体动作与情绪反应，使其作为一个鲜活的小说配角参与互动，决不能只做只提名字的背景板，也不要让他们在两位主角对话的间隙“凭空消失”。
④ 大胆剪辑：无用的日常废话和重复拉扯必须剔除，或者概括性带过。把字数留给真正的矛盾和情感冲突。
⑤ 用场景和微动作包裹留下的台词，且让读者始终清楚说话者是谁。
⑥ 用行动和身体反应展示情绪，绝不直接陈述情绪。
${options.isFirstChapter ? '⑦ 首章铺垫规范（仅限首章）：绝对严禁以第一句聊天对话或日常问候作为小说正文的开头。你必须先用至少两个段落的篇幅（描写当前场景、时间、氛围、或物理背景），交代清楚故事背景和初始情境，随后再以戏剧化的方式引入第一句对话。' : ''}
${options.suggestedTitle ? `⑧ 章节标题建议：本次改编建议使用的标题为《${options.suggestedTitle}》，你可优先考虑直接使用或在其基础上进行微调，但标题仍必须严格遵守下方要求。` : ''}

不要写任何开场白或多余解释，正文完成后另起一行输出章节标题，格式固定为:
### TITLE: {章节标题}

【关于章节标题】⚠️ 章节标题拟定硬约束：由你自行拟定具体、独立、富有网文文采的小说章节标题（如《月下风铃》等），6~15字为宜。绝对严禁直接使用形如“第X章”、“第9章”、“第九章”或类似的章回纯序号作为标题名称！标题中绝对不能包含任何“第X章”或“第9章”等数字序号。`


      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

      console.log(`[NovelWriterService] 开始调用大模型生成小说正文...`)
      const res = await this.chatWithRetry(chatMessages, { usePrimary: true, skipSystemInjection: true }, '正文生成')
      
      const newChapterIndex = allChapters.length > 0
        ? Math.max(...allChapters.map((ch: any) => ch.chapter_index)) + 1
        : 1

      const { title: rawTitle, content: rawContent } = this.parseChapterOutput(res.content, newChapterIndex)

      const partTitle = this.getUniqueChapterTitle(characterId, rawTitle || options.suggestedTitle || `无题`, newChapterIndex, db)
      const partSummary = await this.generateChapterSummary(rawContent, charName)
      const chapterId = crypto.randomUUID()
      const chapterIndex = newChapterIndex

      db.insertNovelChapter({
        id: chapterId,
        character_id: characterId,
        chapter_index: chapterIndex,
        title: partTitle,
        content: rawContent,
        summary: partSummary,
        dialogue_start_ts,
        dialogue_end_ts,
        token_count: 0,
        rating: 0,
        created_at: Date.now()
      })

      // 更新最新章节结束时间戳
      db.setSetting(`last_novel_chapter_end_ts_${characterId}`, dialogue_end_ts.toString())

      // 广播事件给前端
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('novel-chapter-added', {
          characterId,
          chapterId,
          chapterIndex,
          title: partTitle
        })
      })
      console.log(`[NovelWriterService] 章节生成落盘成功！`)

    } catch (err: any) {
      console.error(`[NovelWriterService] 生成单个小说章节时发生致命错误:`, err.message || err)
      throw err
    } finally {
      // 15. 释放互斥锁
      InferenceMutex.unlock()
    }
  }

  /**
   * 重新生成指定章节
   */
  public async rewriteChapter(chapterId: string): Promise<void> {
    const db = getDatabaseService()

    // 0. 获取原章节信息以取得 characterId 并进行状态广播
    const stmt = db.db.prepare('SELECT character_id, chapter_index, dialogue_start_ts, dialogue_end_ts FROM NovelChapters WHERE id = ?')
    const chapter = stmt.get(chapterId) as any
    const characterId = chapter?.character_id
    if (characterId) {
      this.broadcastGenerationState(characterId, true)
    }

    // 1. 获取并发锁
    await InferenceMutex.lock()

    try {
      if (!chapter) {
        console.warn(`[NovelWriterService] 重写章节失败：未找到指定章节 ${chapterId}`)
        return
      }

      const chapterIndex = chapter.chapter_index
      const dialogue_start_ts = chapter.dialogue_start_ts
      const dialogue_end_ts = chapter.dialogue_end_ts

      const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(characterId) as any
      if (!char) {
        console.warn(`[NovelWriterService] 重写章节失败：未找到角色 ${characterId}`)
        return
      }

      const folderName = char.folder_name
      const storageManager = new CharacterStorageManager()
      
      // 3. 读取设定文件
      const soulContent = storageManager.readCharacterFile(folderName, 'Soul.md') || ''
      const worldContent = storageManager.readCharacterFile(folderName, 'World.md') || ''
      const charUserProfile = storageManager.readCharacterFile(folderName, 'USER.md') || ''
      
      const globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')
      const globalUserProfile = fs.existsSync(globalUserPath) ? fs.readFileSync(globalUserPath, 'utf8') : ''

      // 4. 读取该章节对应的聊天记录
      const rawMessages = db.db.prepare(`
        SELECT * FROM Messages 
        WHERE character_id = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `).all(characterId, dialogue_start_ts, dialogue_end_ts) as any[]

      if (rawMessages.length === 0) {
        console.log(`[NovelWriterService] 重写章节失败：未找到章节对应的对话记录。`)
        return
      }

      // 5. 格式化聊天记录
      const profileStr = db.getSetting('echo_user_profile')
      let userName = '用户'
      if (profileStr) {
        try {
          const parsed = JSON.parse(profileStr)
          if (parsed.nickname) userName = parsed.nickname
        } catch (_) {}
      }
      const charName = char.name
      const formattedDialogue = this.preprocessMessages(rawMessages, userName, charName)

      // 6. 读取前序章节的摘要与最近 2 章全文（不包含本章自身）
      const allChapters = db.getNovelChapters(characterId)
      let prevSummaries = ''
      allChapters.forEach((ch: any) => {
        if (ch.chapter_index < chapterIndex) {
          prevSummaries += `[第${ch.chapter_index}章]《${ch.title}》：${ch.summary}\n`
        }
      })
      if (!prevSummaries) prevSummaries = '暂无前序章节。'

      let prevFullChapters = ''
      // 找出 chapterIndex 之前的最近 2 章
      const earlierChapters = allChapters.filter((ch: any) => ch.chapter_index < chapterIndex)
      if (earlierChapters.length > 0) {
        const recentChapters = earlierChapters.slice(-2)
        for (const ch of recentChapters) {
          const fullContent = db.getNovelChapterContent(ch.id)
          if (fullContent && fullContent.content) {
            prevFullChapters += `【第${ch.chapter_index}章《${ch.title}》正文参考】\n${fullContent.content}\n\n`
          }
        }
      }

      // 7. 读取文风设置
      const styleId = db.getSetting(`novel_style_id_${characterId}`) || ''
      const stylesStr = db.getSetting('novel_styles')
      let stylePrompt = ''
      if (stylesStr) {
        try {
          const styles = JSON.parse(stylesStr) as any[]
          const matchedStyle = styles.find(s => s.id === styleId)
          if (matchedStyle && matchedStyle.prompt) {
            stylePrompt = matchedStyle.prompt
          }
        } catch (_) {}
      }

      // 8. 叙事人称与改编尺度设置
      const pov = db.getSetting(`novel_pov_${characterId}`) || 'third_user'
      const adaptation = db.getSetting(`novel_adaptation_${characterId}`) || 'moderate'

      const povInstruction = this.getPovInstruction(pov, userName, charName)
      const adaptationInstruction = this.getAdaptationInstruction(adaptation)

      // 读取后序紧邻章节的全文（如果存在的话）
      let nextFullChapters = ''
      const nextChapter = allChapters.find((ch: any) => ch.chapter_index === chapterIndex + 1)
      if (nextChapter) {
        const nextContentRes = db.getNovelChapterContent(nextChapter.id)
        if (nextContentRes && nextContentRes.content) {
          nextFullChapters = `【第${nextChapter.chapter_index}章《${nextChapter.title}》正文参考】\n${nextContentRes.content}\n\n`
        }
      }

      // 9. 组装 System Prompt 与 User Prompt
      const systemPrompt = this.buildWriterSystemPrompt(
        soulContent,
        worldContent,
        globalUserProfile,
        charUserProfile,
        stylePrompt,
        prevSummaries,
        prevFullChapters,
        povInstruction,
        adaptationInstruction,
        chapterIndex === 1,
        nextFullChapters
      )

      const userPrompt = `【待改编的对话原材料（每行开头带有 [YYYY-MM-DD HH:mm] 格式的聊天发生时间，按时间顺序）】
${formattedDialogue}

请立即将以上对话改编成一个完整的小说章节。
创作要点（核心硬性指标）：
① 剧情至上：小说的核心是连贯精彩的情节和画面感，绝对禁止像剧本一样逐条翻译台词！
② 合理时间过渡：注意每条消息开头的时间戳，如果两次对话之间跨度较大（比如隔了数个小时或几天），必须在小说里描写合理的时间流逝、天色变迁、或日期转换（例如「第二天清晨」、「过了几个小时」等），确保故事的发展脉络在时间线上完全对齐，严禁将不同时间段的对话生硬地挤在同一天内发生。
③ 丰满 NPC 角色：当对话中出现第三方 NPC（或在多人群聊中）时，必须赋予 NPC 独立的说话内容、面部表情、肢体动作与情绪反应，使其作为一个鲜活的小说配角参与互动，决不能只做只提名字的背景板，也不要让他们在两位主角对话的间隙“凭空消失”。
④ 大胆剪辑：无用的日常废话和重复拉扯必须剔除，或者概括性带过。把字数留给真正的矛盾和情感冲突。
⑤ 用场景和微动作包裹留下的台词，且让读者始终清楚说话者是谁。
⑥ 用行动和身体反应展示情绪，绝不直接陈述情绪。
${chapterIndex === 1 ? '⑦ 首章铺垫规范（仅限首章）：绝对严禁以第一句聊天对话或日常问候作为小说正文的开头。你必须先用至少两个段落的篇幅（描写当前场景、时间、氛围、或物理背景），交代清楚故事背景和初始情境，随后再以戏剧化的方式引入第一句对话。' : ''}

不要写任何开场白或多余解释，正文完成后另起一行输出章节标题，格式固定为：
### TITLE: {章节标题}`


      // 10. 调用大模型生成章节正文 (辅助模型)
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

      console.log(`[NovelWriterService] 重写章节：开始调用大模型重新生成正文...`)
      const res = await this.chatWithRetry(chatMessages, { usePrimary: true, skipSystemInjection: true }, '重写正文')
      
      const { title, content: rawContent } = this.parseChapterOutput(res.content, chapterIndex)
      
      const content = rawContent

      // 12. 生成 200 字以内的摘要
      console.log(`[NovelWriterService] 重写章节：开始生成本章故事摘要...`)
      const summary = await this.generateChapterSummary(content, charName)

      // 13. 更新数据库
      db.updateNovelChapterContent(chapterId, content, summary, title)

      console.log(`[NovelWriterService] 章节重写成功！第 ${chapterIndex} 章：《${title}》已覆盖。`)

      // 13. 广播事件给前端
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('novel-chapter-rewritten', {
          characterId,
          chapterId
        })
      })

    } catch (err: any) {
      console.error(`[NovelWriterService] 重写章节发生致命错误:`, err.message || err)
    } finally {
      // 14. 释放互斥锁
      InferenceMutex.unlock()
      if (characterId) {
        this.broadcastGenerationState(characterId, false)
      }
    }
  }

  private preprocessMessages(messages: any[], userName: string, charName: string): string {
    return messages
      .map(m => {
        const roleName = m.role === 'user' ? userName : charName
        let content = m.content || ''
        
        // 过滤微信图片描述：用户图片替换为文字描述，assistant 图片完全过滤
        if (content.startsWith('[wechat_image_media]:')) {
          if (m.role === 'user') {
            content = `（${userName}发来了一张图片）`
          } else {
            return '' // assistant 生成的图片消息不传入写手
          }
        }
        // 过滤日记描述
        if (content.startsWith('[character_diary]:')) {
          return ''
        }
        // 替换红包
        if (content.startsWith('[wechat_red_packet]:')) {
          try {
            const rpStr = content.replace('[wechat_red_packet]:', '')
            const rp = JSON.parse(rpStr)
            content = `（发出了一个微信红包，金额为 ${rp.amount} 元，附言为 "${rp.title}"）`
          } catch (_) {
            content = '（发出了一个微信红包）'
          }
        }
        // 替换 placeholder
        content = content
          .replace(/\{\{user\}\}/g, userName)
          .replace(/\{\{char\}\}/g, charName)

        // 剔除思维链标签 <think>...</think>
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

        if (!content) return ''
        const timeStr = this.formatTimestamp(m.timestamp || Date.now())
        return `[${timeStr}] [${roleName}]: ${content}`
      })
      .filter(Boolean)
      .join('\n')
  }

  /**
   * 叙事人称的指令生成
   */
  private getPovInstruction(pov: string, userName: string, charName: string): string {
    switch (pov) {
      case 'third_char':
        return `请以第三人称视角创作，以 ${charName} 为叙事主角，重点刻画 ${charName} 的内心感受与行动，${userName} 作为对手戏角色呈现。`
      case 'user_first':
        return `请以 ${userName}（用户）的第一人称视角创作，使用「我」指代 ${userName}，用「他/她」指代 ${charName}。`
      case 'char_first':
        return `请以 ${charName}（角色）的第一人称视角创作，使用「我」指代 ${charName}，用「他/她」指代 ${userName}。`
      case 'third_user':
      default:
        return `请以第三人称视角创作，以 ${userName} 为叙事主角，重点刻画 ${userName} 的内心感受与行动，${charName} 作为对手戏角色呈现。`
    }
  }

  /**
   * 改编尺度的指令生成
   */
  private getAdaptationInstruction(adaptation: string): string {
    switch (adaptation) {
      case 'faithful':
        return `【改编尺度：忠实记录】
核心原则：对话是小说叙事的骨架，但台词的呈现必须服从于小说的文学节奏，严禁剧本式的逐条翻译。

必须做到：
- 补充充沛的场景感（具体的时间流逝、空间布局、环境氛围、光影色彩），使对话材料在空间上立足。
- 每一段对话必须配合细腻的人物动作、神态或微表情，绝对不能只有单调的引号台词堆叠。
- 明确区分说话人，通过微动作或段落切分让读者清晰辨认出谁在开口。
- 大力精简废话：必须砍掉日常寒暄（如“你好”、“在吗”）与无休止的确认性拉扯（如“好吧”、“知道了”），允许删除 50% 以上的非核心对话。
- 对话向客观叙述的转化：将次要的、单纯起交代作用的对话，转化为概括性的小说叙事（例如将「“我昨晚去喝酒了，头好疼。”」转化为「他揉了揉发胀的太阳穴，简单提及昨晚宿醉的宿痛，语气透着些许疲惫。」），把珍贵的引号对白留给最关键、最具情绪张力的碰撞点。
- 保留对话的原始情感基调，不改变已发生的情节事实。

允许做的：语言润色、对话周围的动作与环境描写、合理的心理呈现。
禁止做的：新增原文中完全没有提及的情节转折、改变对话含义。`

      case 'free':
        return `【改编尺度：自由创作（大胆扩展创作）】
核心原则：原始对话只是激发你创作的灵感药引和最底层的角色情感倾向。你不需要拘泥于原始对话中的情节走向，请根据人物设定与世界观，写出最具网文张力、文学深度与戏剧冲突的全新小说剧情！

必须做到：
- 重塑剧情与台词：聊天记录只起到“引子”作用。你可以重写 95% 以上的对白，甚至设计出全新的动作场景和冲突。
- 高度小说化的叙事结构：只保留 1-2 句高光对白作为华彩段落，其余所有对白必须彻底打碎，融化在丰富的动作链、细节白描、心理侧写和第三方 NPC 的互动交织中。
- 大胆扩展情节：允许并鼓励你基于已知的世界观与人物关系，大胆构思和补充全新的外部冲突事件（例如突然袭来的变故、撞见新的人物、产生逻辑相关的意外事件、过去回忆的插入与闪回等），为平淡 of 日常聊天赋予强烈的悬念和张力。
- NPC 的深度演绎：NPC 绝不只是说话，他们必须成为推动主角关系或触发本章情节转折的关键推手，拥有鲜明的性格和独特的动机。
- 极致的 Show Don't Tell：严禁平铺直叙，用极富电影感的手法白描环境和角色的物理动作，让读者在动作中感受波澜起伏的情感暗流。

底线：不能背离角色已明确表达的核心情感走向。`

      case 'moderate':
      default:
        return `【改编尺度：适度改编】
核心原则：原始对话仅作为故事的情感核心和主线骨架，生成的“小说剧情”精彩好读是唯一衡量标准。

必须做到：
- 颠覆式的对话删改：允许你删减、合并、改写 80% 以上的聊天对白，只提炼并升华核心情感，绝不保留流水账式的对答。
- 大段白描与动作化替换：鼓励你采用连续的客观动作描写、环境烘托、人物心理活动与回忆描写，来代替密集冗长的对话引号。
- 打破时序限制：根据需要打散和重新编排原始聊天对白，按小说的戏剧性张力与网文节奏重新构筑高潮。
- 补充原创过渡：加入聊天里未涉及但逻辑上完全合理的情节过渡（如两段对话之间的移动赶路、等待时的焦躁心理、第三方势力的隐性活动等）。
- 极度精简引号：每一小节中保留的直接对白（引号台词）不应超过 3-5 句，其余全部用间接引语、行为或者心理描写消化掉，使小说更具厚重感和文学感。

禁止做的：新增对话中从未涉及的重大情节，改变已明确表达的情感走向。`
    }
  }


  /**
   * 构建写手 System Prompt
   */
  private buildWriterSystemPrompt(
    soulContent: string,
    worldContent: string,
    globalUserProfile: string,
    charUserProfile: string,
    stylePrompt: string,
    prevSummaries: string,
    prevFullChapters: string,
    povInstruction: string,
    adaptationInstruction: string,
    isFirstChapter: boolean,
    nextFullChapters?: string
  ): string {
    let styleSection = ''
    if (stylePrompt.trim()) {
      let sampleExcerptSection = ''
      if (stylePrompt.includes('## 原文示范片段') || stylePrompt.includes('示范片段') || stylePrompt.includes('## 原文锚点片段')) {
        const match = stylePrompt.match(/(?:## 原文示范片段|## 原文锚点片段|示范片段)[\s\S]*/)
        if (match) {
          sampleExcerptSection = `\n【写作手法示范（few-shot）】\n以下原文片段展示了目标文风的典型写法，模仿其手法，不要抄袭字句：\n${match[0]}`
        }
      }
      styleSection = `\n【文风档】\n${stylePrompt.trim()}\n${sampleExcerptSection}\n`
    } else {
      // 用户未配置文风时注入默认文风
      styleSection = `\n【文风档（系统默认）】\n${DEFAULT_STYLE_PROMPT}\n`
    }

    let postChaptersSection = ''
    if (nextFullChapters && nextFullChapters.trim()) {
      postChaptersSection = `\n【后序章节连贯性参考】\n以下是紧随本章之后的后序章节正文。你本章重写的内容在情节、逻辑和时间上必须能在结尾处与后序章节实现平滑、无缝地过渡和对接，严禁前后脱节：\n${nextFullChapters.trim()}\n`
    }

    return `你是专职将聊天记录精编扩写为小说章节的写手。你的目标是写出读起来像真人作家手笔的网文，而非 AI 生成的文本。

【最重要的前提：剧情第一，对话为辅 —— 严格限制对话比重】
1. **彻底拒绝逐句翻译**：绝对禁止按对话行数“一比一”翻译成小说对白。小说不是剧本，大量连续的引号对白在小说里是极其单薄且业余的。
2. **严格控制引号对白比重**：在本章的小说正文中，**直接对白（带双引号的台词）的字数占比绝对不能超过总字数的 30%**。其余 70% 以上的篇幅必须由场景白描、物理动作链、角色内心独白、间接引语以及环境氛围渲染占据。
3. **对话向动作与描述的转化方法（核心）**：
   - 交代性质的对话，全部转化为**间接引语**（例如，把「“你吃过早饭了吗？”“吃过了，喝了碗粥。”」改为「他顺口问起早饭的事，她微笑着答了，语气里带着几分慵懒。」）。
   - 情绪性的对话，转化为**微表情与身体反应**（例如，把「“我现在真的很生气！”」改为「她死死捏着衣角，指尖因为用力而泛出青白，胸口剧烈起伏着，一言不发。」）。
   - 琐碎的寒暄与确认，直接**概括性一笔带过**或**物理删除**（例如，「“好的。”」「“嗯。”」「“在吗？”」等消息必须无情剔除，不留任何痕迹）。
4. **保留高光对白**：只在剧情的核心冲突、情感的决定性爆发点，保留 1-3 句极其精炼、掷地有声的直接对白。用前面铺垫的动作和环境，像放大镜一样把这几句台词的戏剧张力放大。

【角色设定（仅供理解，不要直接引用或转述进正文）】
角色性格：
${soulContent}

世界观背景：
${worldContent}

【人物画像（供理解人物动机和关系，不要照抄进正文）】
用户画像：
${globalUserProfile}

角色视角的用户侧写：
${charUserProfile}
${styleSection}

【多章节连贯性参考】
以下是已有章节的摘要，仅供你把握整体进展与情感弧线（对话中出现的 NPC 角色也是故事的一部分，应自然融入叙事）：
${prevSummaries}

${prevFullChapters}
${postChaptersSection}
【叙事人称】
${povInstruction}

【改编尺度】
${adaptationInstruction}

【NPC 角色刻画与互动规范】
当聊天记录中出现第三方 NPC（如家人、朋友、同事、路人等）时，请务必充实其戏剧存在感，拒绝扁平化和背景板：
- 独立的言行举止：为 NPC 补充具体的微动作（如「局促地揉揉裤脚」、「在一旁擦拭着杯子」）、表情及神态，有独立的情绪起伏。
- 丰满的对手戏：NPC 必须主动参与当前的交流，有自己的态度、情绪和立场，他们会打趣、起哄、质疑、围观或在主角对话的间歇中合理插嘴。
- 绝不“人间蒸发”：多人群聊或多人场景中，NPC 的行动线必须保持连贯，严禁出现前半段还在说话，后半段两位主角私聊时就毫无反应、彻底消失的情况。

【核心创作指令】
1. 正文完成后，另起一行输出章节标题，格式固定为：
   ### TITLE: {标题内容}
   ⚠️ 章节标题拟定硬约束：你必须拟定一个具体、独立、富有网文文采的小说章节标题（如《月下风铃》、《图书馆里的秘密》等）。绝对严禁直接使用形如“第X章”、“第9章”、“第九章”或类似的章回纯序号作为标题名称！标题中绝对不能含有任何“第X章”或“第9章”等数字序号字样。
2. 全程使用简体中文创作。字数根据对话内容量弹性调整：对话内容少时 800~1200 字足够，不强行堆砌；内容丰富时可写到 1800~2500 字。
3. ${isFirstChapter ? '这是故事的第一章，非常关键。你必须进行充分的背景铺垫与初始情境介绍：①绝对严禁一上来就平铺直叙地写聊天记录里的第一句台词；②必须在章节开头使用 1~2 个自然段（约 200~400 字）来进行细腻的场景描写、气氛烘托与背景介绍（如当时的物理环境、天气色调、人物所处的境遇或状态）；③交代清楚两位主角的关系起点或他们当下各自面临的困境、所处的基调，为整个故事拉开序幕；④接着再将背景自然过渡、平滑接入对话材料，以此打破生硬的开头感，创造真正优秀的网文式开局。' : '根据前情进展和本次对话内容，自然续写下一章，确保情节和文笔的连贯性。'}
4. 拒绝单薄 NPC：当对话中出现第三方 NPC 时，必须赋予其独立的台词、动作、行为和自主的情绪变化，使其作为一个有血有肉的小说配角参与互动，禁止让他们做只提名字的背景板。
5. 每一段引号对白都必须让读者清楚知道是谁在说话——通过微动作标签、段落归属或视角切换实现，严禁出现连续多行引号对白却让读者分不清说话人的情况。


【写作质量硬约束（优先级高于文风）】

【去AI味润色信条（一步到位生成）】
核心信念：AI味的主要问题是过度圆滑、工整、解释充分。你的创作目标是降低模板化、书面腔和过度工整感，增加真实人类作家的口语、停顿、跳跃和具体动作。只改写「怎么说」，不改写「说什么」——情节人设严格遵循原作。能用一个词就不用一句话，能用细节暗示就不做直白陈述。

一级禁用词（出现即违规）：
仿佛、犹如、宛若、如同、一丝、一抹、些许、几分、隐约、不禁、缓缓、微微、轻轻、淡淡、眼中闪过、嘴角勾起、眉头微皱、瞳孔微缩、心中一动、心头一震、心下了然、心底泛起、不由得、不容置疑、不易察觉、显而易见、不由自主、情不自禁、自然而然

最毒禁用句式（出现即违规）：
- 「不是A，而是B」→ 直接写 B
- 「……，带着……」万能状语 → 拆成独立短句或动作
- 「声音不大，却带着……」→ 直接写声音特征
- 「他/她知道……」→ 用行为展示认知
- 「仿佛/犹如/宛若……一般」→ 白描或口语化"像"

禁止章末升华：
不得用总结/感悟/哲理/预告收束（「他终于明白了……」「他不知道的是……」「这一刻……」「一切……都……」），改用动作、对话或具体悬念画面收尾。

情绪展示（Show Don't Tell）：
- 「他很紧张」→「他的手在抖」
- 「她很愤怒」→「她一把掀翻了桌子」
- 「他感到一丝失落」→「他愣了一下，把手机放回口袋」
- 内心独白不超过连续 2 句，用行为和对话暗示心理

段落与节奏：
- 一段 1-3 句为主，偶尔 1 句独占 1 行。段落长短交错，禁止连续 3 段以上相同长度
- 紧张场景：3~8 字短句叠加
- 日常场景：8~20 字，朗读不卡顿
- 禁止连续 3 句以上排比，保留最有力的 1 句
- 同一动作/瞬间不拆成「发生→感知→反应」三段分写，织入同一段呈现

对话规则：
- 严禁流水账照搬：原始聊天中的多轮对话，如果对推动剧情或爆发冲突无直接贡献，必须缩减 80% 以上甚至完全删除，只保留极少数核心对白，其余一律转化为动作、环境描写或客观叙述。
- 口语化，不写书面腔（「我认为此事不妥」→「我觉得不靠谱」）
- 60%+对话不加标签，用动作引出。普通「说」可保留，禁用「沉声道」「淡淡地说」「缓缓开口」等公式化标签
- 允许答非所问、打断、沉默、省略——真实对话不必逻辑完整，也可以转化为间接引语或心理描写
- 减少对话中不必要的称呼（真实对话很少每句都叫对方名字）
- 赋予 NPC 生命力：NPC 说话时必须配有神态动作，严禁只有冰冷的台词而无行为细节；当两位主角在说话时，NPC 应在一旁以眼神、动作或吐槽来动态展示其存在，使多人群戏更生动。

修饰词原则：
- 一次只用一个形容词修饰，不堆砌。「白色的药片」→「药片」；「飞驰的汽车」→「车」
- 带"像/如/仿佛"的比喻默认删除，改为直接描述。「脸色惨白得像雪」→「脸色惨白」`
  }

  /**
   * 解析大模型输出，获取标题与正文
   */
  private parseChapterOutput(raw: string, index: number): { title: string; content: string } {
    const titleRegex = /### TITLE:\s*(.+)/i
    const match = raw.match(titleRegex)
    
    let title = `第 ${index} 章`
    let content = raw

    if (match) {
      title = match[1].trim()
      content = raw.replace(match[0], '').trim()
    } else {
      // 兼容一些带 ### TITLE {xxx} 或者不标准的输出
      const altMatch = raw.match(/(?:章节标题|TITLE)[:：]\s*(.+)/i)
      if (altMatch) {
        title = altMatch[1].trim()
        content = raw.replace(altMatch[0], '').trim()
      }
    }

    // 物理去除多余的 Markdown 格式包围
    content = content.replace(/^```markdown/i, '').replace(/```$/, '').trim()

    return { title, content }
  }

  /**
   * 清除标题中的“第X章”、“第9章”等各种前缀
   */
  private cleanChapterTitle(title: string): string {
    let clean = title.trim().replace(/^《|》$/g, '').trim()
    // 匹配类似 "第 9 章"、"第9章"、"第十章："、"第12节-" 等各种前缀
    const prefixRegex = /^第\s*[\d一二三四五六七八九十百千两]+\s*[章节回节][:：·\s.-]*\s*/i
    clean = clean.replace(prefixRegex, '')
    clean = clean.replace(/^[#\s*]+|[#\s*]+$/g, '').trim()
    return clean
  }

  /**
   * 确保章节标题在当前角色下不重复，并且不以“第X章”等格式开头，若清洗后为空或纯序号则使用“无题”作为兜底
   */
  private getUniqueChapterTitle(characterId: string, rawTitle: string, index: number, db: any, excludeChapterId?: string): string {
    let title = this.cleanChapterTitle(rawTitle)
    
    // 如果清洗后为空，或仅剩下“第X章”等形式的前缀被误读，使用无题进行兜底
    if (!title || /^第\s*[\d一二三四五六七八九十百千两]+\s*[章节回节]$/i.test(title)) {
      title = `无题（${index}）`
    }

    const existingChapters = db.getNovelChapters(characterId) as any[]
    const existingTitles = new Set(
      existingChapters
        .filter(ch => ch.id !== excludeChapterId)
        .map(ch => ch.title.trim())
    )

    let uniqueTitle = title
    let suffix = 1
    while (existingTitles.has(uniqueTitle)) {
      suffix++
      uniqueTitle = `${title}（${suffix}）`
    }

    return uniqueTitle
  }



  /**
   * 二次调用主模型，对生成的章节进行去 AI 味润色与审阅
   * 基于 story-deslop skill 的 6 Gate 方法论 + banned-words 禁用词表
   */
  private async polishAndReview(rawContent: string, stylePrompt: string): Promise<string> {
    return rawContent;
  }


  /**
   * 二次调用辅助大模型，生成本章摘要
   */
  private async generateChapterSummary(chapterContent: string, charName: string): Promise<string> {
    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: '你是一个非常专业的网文大纲与摘要提炼助手。请阅读章节内容，并提炼一段简短的故事摘要（要求：200字以内，仅客观陈述发生的情节进展与人物情感变化，不得有任何文学性修饰语，开头不要有“本章讲述了”、“摘要”等字样）。'
        },
        {
          role: 'user',
          content: `【章节正文内容】\n${chapterContent}\n\n请输出本章摘要：`
        }
      ]
      
      const res = await this.chatWithRetry(messages, { useSecondary: true, skipSystemInjection: true }, '摘要生成')
      let summary = res.content.trim()
      
      // 去除可能含有的思维链标签
      summary = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      
      // 截断字数防范溢出
      if (summary.length > 200) {
        summary = summary.substring(0, 197) + '...'
      }
      return summary
    } catch (e: any) {
      console.error(`[NovelWriterService] 生成摘要失败，采用默认字词截断。`, e)
      return chapterContent.substring(0, 150) + '...'
    }
  }

  /**
   * 用户手动触发续写：绕过 token 阈值直接调用 generateChapter。
   * generateChapter 内部在写完后会更新 last_novel_chapter_end_ts，自动重置 token 计数。
   */
  public async continueNow(characterId: string): Promise<void> {
    const db = getDatabaseService()
    const novelEnabled = db.getSetting(`novel_enabled_${characterId}`) === '1'
    if (!novelEnabled) {
      throw new Error('该角色尚未开启 AI 写手功能，请先在弹窗中开启。')
    }

    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'dialogue'
    if (chatMode === 'director') {
      throw new Error('导演模式不支持自动写小说。')
    }

    // 检查是否有新对话内容（上一章结束时间戳之后是否有 assistant 消息）
    const isFirstChapter = db.getNovelChapterCount(characterId) === 0
    const startTsStr = db.getSetting(`novel_start_ts_${characterId}`) || '0'
    const startTs = parseInt(startTsStr, 10)
    const lastEndTs = isFirstChapter
      ? startTs
      : parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
    const baseTs = Math.max(lastEndTs, startTs)

    const hasNewMessages = (db.db.prepare(`
      SELECT 1 FROM Messages
      WHERE character_id = ? AND timestamp > ? AND role = 'assistant'
      LIMIT 1
    `).get(characterId, baseTs)) != null

    if (!hasNewMessages) {
      throw new Error('当前没有新的对话内容，无法续写。')
    }

    console.log(`[NovelWriterService] 用户手动触发续写，角色 ${characterId}`)
    await this.generateChapter(characterId, { isFirstChapter })
  }
}
