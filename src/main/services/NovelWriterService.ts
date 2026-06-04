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
    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive'
    if (chatMode === 'director') return

    const chapterCount = db.getNovelChapterCount(characterId)

    // 1. 首章：章节数为 0，且 Messages 包含 assistant 的消息时立即触发
    if (chapterCount === 0) {
      const hasAssistantMsg = db.db.prepare(`
        SELECT 1 FROM Messages 
        WHERE character_id = ? AND role = 'assistant' 
        LIMIT 1
      `).get(characterId)

      if (hasAssistantMsg) {
        console.log(`[NovelWriterService] 检测到角色 ${characterId} 满足首章生成条件，开始生成第一章。`)
        await this.generateChapter(characterId, { isFirstChapter: true })
      }
      return
    }

    // 2. 后续章节：按 token 累积阈值触发
    const threshold = NOVEL_TOKEN_THRESHOLD[chatMode] ?? 3500
    const lastEndTs = parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
    const newTokens = db.sumMessageTokensSince(characterId, lastEndTs)

    if (newTokens >= threshold) {
      console.log(`[NovelWriterService] 角色 ${characterId} 的新增 token 量为 ${newTokens}，达到阈值 ${threshold}，开始生成续章。`)
      await this.generateChapter(characterId, { isFirstChapter: false })
    }
  }

  /**
   * 核心小说生成流程（已接入全局串行队列）
   */
  public async generateChapter(characterId: string, options: { isFirstChapter: boolean }): Promise<void> {
    console.log(`[NovelWriterService] 角色 ${characterId} 触发小说生成，正在加入全局串行队列...`)
    await NovelWriterService.enqueue(characterId, async () => {
      await this.generateChaptersFromPendingDialogue(characterId, options.isFirstChapter)
    })
  }

  /**
   * 估算单条消息消耗的 tokens 数量
   */
  private estimateMessageTokens(msg: any): number {
    if (msg.token_usage && msg.token_usage > 0) {
      return msg.token_usage
    }
    const content = msg.content || ''
    return Math.ceil(content.length * 1.5) + 10
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

    // 1. 读取当前未改编的聊天消息
    const lastEndTs = isFirstChapter ? 0 : parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
    const rawMessages = db.db.prepare(`
      SELECT * FROM Messages 
      WHERE character_id = ? AND timestamp > ? 
      ORDER BY timestamp ASC
    `).all(characterId, lastEndTs) as any[]

    if (rawMessages.length === 0) {
      console.log(`[NovelWriterService] 没有新的聊天记录用于改编角色 ${characterId} 的小说章节。`)
      return
    }

    // 2. 调用分段算法切分
    const chunks = this.chunkMessagesByToken(rawMessages, 3000)
    console.log(`[NovelWriterService] 角色 ${characterId} 未改编对话共 ${rawMessages.length} 条，已切分为 ${chunks.length} 个分段进行生成。`)

    // 3. 获取角色元数据与设定文件夹
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

    // 4. 依次串行循环生成每一段
    for (let i = 0; i < chunks.length; i++) {
      const chunkMessages = chunks[i]
      const chunkIsFirst = isFirstChapter && (i === 0)
      console.log(`[NovelWriterService] 正在串行生成分段 ${i + 1}/${chunks.length}（包含 ${chunkMessages.length} 条对话）...`)
      
      try {
        await this.generateSingleChapter(characterId, chunkMessages, {
          isFirstChapter: chunkIsFirst,
          ...contextOptions
        })
      } catch (err: any) {
        console.error(`[NovelWriterService] 串行生成分段 ${i + 1} 时失败，中断后续生成:`, err.message || err)
        throw err
      }
    }
  }

  /**
   * 生成单个章节并落盘
   */
  private async generateSingleChapter(
    characterId: string,
    rawMessages: any[],
    options: {
      isFirstChapter: boolean;
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

      const userPrompt = `【待改编的对话原材料（按时间顺序）】
${formattedDialogue}

请立即以小说叙事手法将以上对话改编成一个完整的小说章节。
创作要点（核心硬性指标）：
① 剧情至上：小说的核心是连贯精彩的情节和画面感，绝对禁止像剧本一样逐条翻译台词！
② 大胆剪辑：无用的日常废话和重复拉扯必须剔除，或者概括性带过。把字数留给真正的矛盾和情感冲突。
③ 用场景和微动作包裹留下的台词，且让读者始终清楚说话者是谁。
④ 用行动和身体反应展示情绪，绝不直接陈述情绪。

不要写任何开场白或多余解释，正文完成后另起一行输出章节标题，格式固定为：
### TITLE: {章节标题}

【关于章节标题】由你自行拟定，简洁有力、贴合本章情感基调，6~15字为宜，无需使用"第X章"字样。`

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
      
      // 使用辅助模型判断是否拆分章节并获取拆分结果
      const splitParts = await this.splitIntoChapters(rawContent, options.stylePrompt)

      // 循环处理每个拆分后的章节
      for (let i = 0; i < splitParts.length; i++) {
        const part = splitParts[i]
        const partTitle = splitParts.length === 1
          ? rawTitle
          : (part.title && part.title.trim() ? part.title.trim() : `${rawTitle}（${i + 1}）`)

        const polished = part.content
        const partSummary = await this.generateChapterSummary(polished, charName)
        const chapterId = crypto.randomUUID()
        const chapterIndex = newChapterIndex + i

        db.insertNovelChapter({
          id: chapterId,
          character_id: characterId,
          chapter_index: chapterIndex,
          title: partTitle,
          content: polished,
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
      }
      console.log(`[NovelWriterService] 分段章节生成落盘成功！`)

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

    // 1. 获取并发锁
    await InferenceMutex.lock()

    try {
      // 2. 获取原章节信息
      const stmt = db.db.prepare('SELECT * FROM NovelChapters WHERE id = ?')
      const chapter = stmt.get(chapterId) as any
      if (!chapter) {
        console.warn(`[NovelWriterService] 重写章节失败：未找到指定章节 ${chapterId}`)
        return
      }

      const characterId = chapter.character_id
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
        chapterIndex === 1
      )

      const userPrompt = `【待改编的对话原材料（按时间顺序）】
${formattedDialogue}

请立即将以上对话改编成一个完整的小说章节。
创作要点（核心硬性指标）：
① 剧情至上：小说的核心是连贯精彩的情节和画面感，绝对禁止像剧本一样逐条翻译台词！
② 大胆剪辑：无用的日常废话和重复拉扯必须剔除，或者概括性带过。把字数留给真正的矛盾和情感冲突。
③ 用场景和微动作包裹留下的台词，且让读者始终清楚说话者是谁。
④ 用行动和身体反应展示情绪，绝不直接陈述情绪。

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
      
      // 暂时注释去 AI 味润色与审阅
      // console.log(`[NovelWriterService] 重写章节：开始去 AI 味润色与审阅...`)
      // const content = await this.polishAndReview(rawContent, stylePrompt)
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
    }
  }

  /**
   * 格式化消息内容为 AI 写手可以理解的原始剧本/对话格式
   */
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
        return `[${roleName}]: ${content}`
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
核心原则：对话是取材原料，不是要照搬的剧本。你的任务是把这些对话"翻译"成有血肉的小说场景。

必须做到：
- 补充完整的场景感（时间、地点、光线、气氛），让读者知道故事发生在哪里
- 要有对应的人物动作、神态或微表情，绝对不能只有光秃秃的引号对白
- 明确区分"谁在说话"——通过动作标签、视角切换或段落归属让读者一眼看清说话人
- 保留对话的原始情感基调，不改变已发生的情节事实
- 严禁流水账式对照翻译：剔除日常寒暄、确认性无意义对白（如"好的"、"在吗"），将核心交流提炼出来，其余转化为眼神、动作或一笔带过的客观叙事。

允许做的：语言润色、对话周围的动作与环境描写、合理的心理呈现
禁止做的：新增原文中完全没有提及的情节转折、改变对话含义`

      case 'free':
        return `【改编尺度：自由创作】
核心原则：对话是情感锚点和事件骨架，最终呈现出来的“剧情”好不好看才是唯一标准。

可以大胆做的：
- 大幅重构对话：你可以删减、合并、甚至改写 80% 以上的台词，只保留情感内核。
- 允许采用大段的客观动作、环境烘托、回忆和心理活动来代替密集的对话引号。
- 打散原有对话顺序，按网文黄金戏剧节奏重新编排
- 补充原创的过渡场景（如赶路途中、等待时的心理活动）
- 大幅扩写人物内心，用行为和细节代替直白情绪
- 给 NPC 角色增加更多戏份和独特性格

底线：不能背离角色已明确表达的核心情感走向`

      case 'moderate':
      default:
        return `【改编尺度：适度改编】
核心原则：对话是骨架，剧情是灵魂。原文对话中的情节和情感是不变的参照，但台词呈现必须符合小说节奏。

必须做到：
- 补充场景感（时间地点光线氛围），让读者进入画面
- 每段对话配合相应的人物动作或神态，而非只有引号台词堆叠
- 明确区分说话人，通过微动作、视角归属等手法让读者清楚知道谁在开口
- 大力精简废话：必须剪辑日常寒暄与重复拉扯，允许删除 50% 以上的非核心对话。
- 将次要的、交代性质的对话转化为概括性叙述（如「他简单说起昨晚的事，语气有些无奈」），把宝贵的引号对白留给最关键的情绪碰撞点。
- 用动作/场景/潜台词填补对话间的空白

禁止做的：新增对话中从未涉及的重大情节；改变已明确表达的情感走向`
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
    isFirstChapter: boolean
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

    return `你是专职将聊天记录精编扩写为小说章节的写手。你的目标是写出读起来像真人作家手笔的网文，而非 AI 生成的文本。

【最重要的前提：剧情第一，对话为辅】
1. 对话只是素材，绝非要照搬的剧本。你的最高宗旨是呈现有戏剧张力、情节连贯、画面感强烈的小说剧情。
2. 绝对禁止将聊天记录逐条翻译成小说台词——那只是在给对话换格式，是极度低级、无聊的流水账。
3. 允许并强烈鼓励你大刀阔斧地剪辑对话：
   - 所有的日常废话、琐碎寒暄、确认性答复、重复的拉扯，必须直接删掉，或者用一句概括叙事（如「两人简单打了个招呼」）一笔带过。
   - 大量对话应该转化为人物的眼神交流、肢体动作、环境渲染或内心活动，有些对话甚至可以完全不写出来。
   - 只在情绪爆发点、戏剧冲突处、或决定情节走向的关键点保留精炼、有力的直接对白。

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
【叙事人称】
${povInstruction}

【改编尺度】
${adaptationInstruction}

【核心创作指令】
1. 正文完成后，另起一行输出章节标题，格式固定为：
   ### TITLE: {标题内容}
2. 全程使用简体中文创作。字数根据对话内容量弹性调整：对话内容少时 800~1200 字足够，不强行堆砌；内容丰富时可写到 1800~2500 字。
3. ${isFirstChapter ? '这是故事的第一章，重点交代背景、引入人物关系与初始情境，为故事奠定基调。' : '根据前情进展和本次对话内容，自然续写下一章，确保情节和文笔的连贯性。'}
4. 对话中出现的第三方 NPC 角色（如朋友、家人、路人等），必须作为故事角色自然融入小说叙事中，赋予其合理的动作和对话描写。
5. 每一段引号对白都必须让读者清楚知道是谁在说话——通过微动作标签、段落归属或视角切换实现，严禁出现连续多行引号对白却让读者分不清说话人的情况。


【写作质量硬约束（优先级高于文风）】

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
   * 使用辅助大模型判断是否需要拆分章节，并返回章节数组。
   * 若模型返回 "NO_SPLIT"，返回单章节数组 [{ title: '', content: rawContent }]
   */
  private async splitIntoChapters(rawContent: string, stylePrompt: string): Promise<Array<{title: string, content: string}>> {
    const charCount = rawContent.length
    const systemPrompt = `你是网文章节拆分专家。当前提供的小说正文总字数大约为 ${charCount} 字。
网文的最佳单章字数为 1500 ~ 2500 字左右。

拆分判定规则：
1. 若总字数小于 2500 字，你可以认为不需要拆分，直接返回 "NO_SPLIT"。
2. 若总字数在 2500 字以上（如本篇已达 ${charCount} 字），你**必须**进行拆分，绝对禁止返回 "NO_SPLIT"。拆分时以 1500 ~ 2500 字为单个章节的基准字数，将其拆分为 2 个或更多章节。
3. 拆分时请选择在剧情自然转折、场景切换、或留下悬念的地方作为章节交界处。

返回格式要求：
- 若需要拆分，请仅返回一个 JSON 数组，每个元素包含 "title"（本章参考标题）和 "content"（本章的正文内容）。必须保持内容的绝对连贯与完整，不得漏掉或改写原文的任何段落！
- 若不需要拆分，仅返回字符串 "NO_SPLIT"。
- 严禁输出任何 markdown 格式之外的解释、前言或后语，直接输出 JSON 或 "NO_SPLIT" 字符串本身。`;
    const userPrompt = `正文内容：\n${rawContent}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    try {
      const res = await this.chatWithRetry(messages, { usePrimary: false, skipSystemInjection: true }, '章节拆分判断');
      let reply = res.content.trim();

      // 剥去可能的 markdown 代码块包装（```json ... ``` 或 ``` ... ```）
      reply = reply.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

      // 大小写不敏感地匹配 NO_SPLIT
      if (/^no_split$/i.test(reply)) {
        return [{ title: '', content: rawContent }];
      }
      const parsed = JSON.parse(reply);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(item => ({ title: item.title || '', content: item.content || '' }));
      }
      return [{ title: '', content: rawContent }];
    } catch (e) {
      console.error('[NovelWriterService] 拆分章节失败，回退为单章节', e);
      return [{ title: '', content: rawContent }];
    }

  }

  /**
   * 二次调用主模型，对生成的章节进行去 AI 味润色与审阅
   * 基于 story-deslop skill 的 6 Gate 方法论 + banned-words 禁用词表
   */
  private async polishAndReview(rawContent: string, stylePrompt: string): Promise<string> {
    // 暂时注释去 AI 味润色与审阅，直接返回原文
    return rawContent;

    try {
      console.log(`[NovelWriterService] 开始去 AI 味润色与审阅...`)

      const styleRef = stylePrompt.trim()
        ? `\n【参考文风（文风指令优先级高于默认 Gate，但低于硬约束）】\n${stylePrompt.trim()}\n`
        : `\n【参考文风】\n${DEFAULT_STYLE_PROMPT}\n`

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `你是网文润色专家。你的任务是把这篇文本改写自然，降低模板化、书面腔和过度工整感。

核心信念：AI 味的主要问题不是语法，而是过度圆滑、工整、解释充分。改写目标是保留剧情功能，同时增加口语、停顿、跳跃和具体动作。

原则：改最少，效果最大。能改一个词就不改一句，能删一句就不重写一段。只改「怎么说」，不改「说什么」——剧情、人设、情节走向、NPC 角色一概不动。

按以下 6 Gate 顺序逐项清除：

【Gate A：禁用词替换】
逐项扫描以下词汇，替换为具体动作/细节描写，不能简单换成另一个形容词：
一级禁用（出现即替换）：仿佛、犹如、宛若、如同、一丝、一抹、些许、几分、隐约、深吸一口气、缓缓、不禁、微微、轻轻、淡淡、眼中闪过、嘴角勾起、眉头微皱、瞳孔微缩、心中一动、心头一震、心下了然、心底泛起、不由得、不容置疑、不易察觉、显而易见、不由自主、情不自禁、自然而然
替换示例：
- 「眼中闪过一丝悲伤」→「他垂下眼」
- 「深吸一口气」→「胸口起伏了一下」或直接删掉
- 「嘴角勾起一抹冷笑」→「他笑了一下，没到眼底」
- 「不禁」→ 直接写动作

【Gate B：句式去套路】
最毒句式（出现即改）：
- 「不是A，而是B」→ 直接写 B
- 「……，带着……」万能状语 → 拆成独立短句或动作描写
- 「声音不大，却带着……」→ 直接写声音特征或动作
- 「他/她知道……」→ 用行为展示认知
- 带「像/如/仿佛/犹如/宛若」的比喻默认改为直接描述
修饰词清扫：物品/人物前的多余形容词、定语、副词直接删。「白色的药片」→「药片」；一次只用一个形容词。

【Gate C：心理描写外化】
- 「他很紧张」→「他的手在抖」
- 「她很愤怒」→「她一把掀翻了桌子」
- 「他感到一丝失落」→「他愣了一下，把手机放回口袋」
重复描写去重：相邻段反复表达同一信息/动作/情绪时，合并保留最能推动情绪的细节。同一瞬间不拆成「发生→感知→反应」三段。
重复语义四类（只留一个最合适的）：形容词重复、近义词重复、含义重复、上下文主语重复。

【Gate D：节奏打碎】
- 打断连续排比句（保留1-2个，删掉其余）
- 长句拆短句
- 偶尔用不完整句（口语感）
- 段落长短交错（1-3句为主，不要每段都相同行数）

【Gate E：对话去腔调】
- 加入口语化表达（"嗯""哦""行吧"）
- 适当打断对话（角色可以答非所问）
- 用动作穿插对话（"她喝了口水。'然后呢？'"）
- 删掉解释性对话（角色不会把自己的动机说清楚）
- 减少对话中不必要的称呼

【Gate F：结尾去升华】
- 删掉总结性语句（「他终于明白了……」「这一刻……」「一切……都……」）
- 用动作/场景/对话收尾，不要用感慨收尾
- 「他不知道的是……更大的风暴即将来临」→ 用具体钩子物件/事件收束
${styleRef}
【硬性规则（不可违反）】
- 保留已生成章节的核心剧情线、人设和情感走向。如果发现章节内依然残留拖沓、照搬对话、流水账叙事的情况，允许大刀阔斧地予以提炼和删减，使整体故事更加紧凑、富有小说质感。
- 不增加无中生有的新情节，允许并提倡删减多余废话和流水账内容。
- 直接输出润色后的完整正文，不要有任何前缀、后缀、编辑批注。
- 保持简体中文`
        },
        {
          role: 'user',
          content: `【待润色的章节原文】\n${rawContent}\n\n请直接输出润色后的完整正文：`
        }
      ]

      const res = await this.chatWithRetry(messages, { usePrimary: true, skipSystemInjection: true }, '去AI味润色')
      let polished = res.content.trim()

      // 去除可能的思维链标签
      polished = polished.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

      // 去除可能的 markdown 代码块包围
      polished = polished.replace(/^```[\s\S]*?\n/, '').replace(/\n```\s*$/, '').trim()

      // 如果润色结果过短（大模型异常），回退到原文
      if (polished.length < rawContent.length * 0.3) {
        console.warn(`[NovelWriterService] 润色结果异常过短（${polished.length}字 vs 原文${rawContent.length}字），回退使用原文。`)
        return rawContent
      }

      console.log(`[NovelWriterService] 去 AI 味润色完成。原文 ${rawContent.length} 字 → 润色后 ${polished.length} 字。`)
      return polished
    } catch (err: any) {
      console.error(`[NovelWriterService] 去 AI 味润色失败，使用原始正文:`, err.message || err)
      return rawContent
    }
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

    const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive'
    if (chatMode === 'director') {
      throw new Error('导演模式不支持自动写小说。')
    }

    // 检查是否有新对话内容（上一章结束时间戳之后是否有 assistant 消息）
    const isFirstChapter = db.getNovelChapterCount(characterId) === 0
    const lastEndTs = isFirstChapter
      ? 0
      : parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)

    const hasNewMessages = (db.db.prepare(`
      SELECT 1 FROM Messages
      WHERE character_id = ? AND timestamp > ? AND role = 'assistant'
      LIMIT 1
    `).get(characterId, lastEndTs)) != null

    if (!hasNewMessages) {
      throw new Error('当前没有新的对话内容，无法续写。')
    }

    console.log(`[NovelWriterService] 用户手动触发续写，角色 ${characterId}`)
    await this.generateChapter(characterId, { isFirstChapter })
  }
}
