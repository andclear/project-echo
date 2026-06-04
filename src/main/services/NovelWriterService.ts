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
 * 用户未配置文风时使用的默认文风档
 */
export const DEFAULT_STYLE_PROMPT = `## 整体语感
- 句长偏好：长短均衡，以中短句（8~20字）为主，情绪爆发点切换为3~8字短句叠加，营造节奏冲击；日常松弛段落偶尔穿插一两句长句舒缓呼吸
- 标点习惯：善用破折号制造话语中断与转折；省略号仅在真正的沉默或欲言又止时使用，每千字不超过2处；感叹号克制，平均每千字不超过1个
- 段落节奏：一段只承载一个核心动作或信息变化，段落长度参差交错——短段（1~2句）与中段（3~5句）穿插，避免连续出现相同长度的段落

## 对话风格
- 潜台词模式：角色说话不直球表达内心，善用答非所问、语气反差、刻意岔开话题来暗示真实情感。示例："你吃了吗？" ——实际在问"你还好吗"
- 对话标签习惯：用微动作穿插替代"说"标签（如"她低头搅着杯子里的吸管"替代"她说"），动作与对话织在同一段内呈现
- 角色语气特点：口语化、生活化，不写书面腔（"我觉得不靠谱"而非"我认为此事不妥"），不同角色有各自的口头禅和语气节奏

## 情绪表达
- 情绪展示手法：用身体反应和具体行为展示情绪——紧张时"指甲掐进掌心"、愤怒时"筷子在桌上磕出声响"、心动时"视线不自觉地追着对方的背影走"；绝对不写"他很紧张""她很伤心"等直接情绪词
- 基调切换节奏：紧张与松弛、甜蜜与酸涩交替穿插，同一章内至少有一次明显的情绪起伏转折，避免全篇同一基调

## 写法技巧
1. 善用留白：在对话间隙以沉默、停顿、小动作暗示未说出口的潜台词，让读者自行补全情感
2. 五感细节锚定场景：每个重要场景至少调动两种以上感官（气味、触感、声音、光线等），不写空洞的"环境很好"
3. 动作链叙事：用连续的小动作串联人物状态变化，不拆成"发生→感知→反应"三段分写
4. 克制的温柔基调：整体氛围温柔而含蓄，情感浓度在字面之下流动，不滥用浓烈的修辞
5. 结尾用动作或对话收束：章尾以一个具体动作、一句未说完的话或一个悬念画面收尾，不写哲理感悟式总结`

export class NovelWriterService {
  private modelAdapter: ModelAdapter
  private static readonly MAX_RETRIES = 3

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
   * 核心小说生成流程
   */
  public async generateChapter(characterId: string, options: { isFirstChapter: boolean }): Promise<void> {
    const db = getDatabaseService()

    // 1. 获取并发锁，保证推理不并发，杜绝卡顿
    await InferenceMutex.lock()

    try {
      // 2. 获取角色元数据与设定文件夹
      const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(characterId) as any
      if (!char) {
        console.warn(`[NovelWriterService] 找不到角色 ${characterId}，生成终止。`)
        return
      }

      const folderName = char.folder_name
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), folderName)

      // 3. 读取设定文件
      const soulContent = storageManager.readCharacterFile(folderName, 'Soul.md') || ''
      const worldContent = storageManager.readCharacterFile(folderName, 'World.md') || ''
      const charUserProfile = storageManager.readCharacterFile(folderName, 'USER.md') || ''
      
      const globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')
      const globalUserProfile = fs.existsSync(globalUserPath) ? fs.readFileSync(globalUserPath, 'utf8') : ''

      // 4. 读取当前未改编的聊天消息
      const lastEndTs = options.isFirstChapter ? 0 : parseInt(db.getSetting(`last_novel_chapter_end_ts_${characterId}`) || '0', 10)
      const rawMessages = db.db.prepare(`
        SELECT * FROM Messages 
        WHERE character_id = ? AND timestamp > ? 
        ORDER BY timestamp ASC
      `).all(characterId, lastEndTs) as any[]

      if (rawMessages.length === 0) {
        console.log(`[NovelWriterService] 没有新的聊天记录用于改编角色 ${characterId} 的小说章节。`)
        return
      }

      // 获取这批消息的起止时间戳
      const dialogue_start_ts = rawMessages[0].timestamp
      const dialogue_end_ts = rawMessages[rawMessages.length - 1].timestamp

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

      // 6. 读取已有章节的摘要与最近 2 章全文 (连贯性注入)
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
        options.isFirstChapter
      )

      const userPrompt = `【待改编的对话原材料（按时间顺序）】\n${formattedDialogue}\n\n请立即根据对话内容、角色人称和改编尺度，将其创作成一章精彩的小说。不要写任何开场白或多余解释，正文完成后另起一行输出标题，格式固定为：\n### TITLE: {章节标题}`

      // 10. 调用大模型生成章节正文 (辅助模型)
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

      console.log(`[NovelWriterService] 开始调用大模型生成小说正文...`)
      const res = await this.chatWithRetry(chatMessages, { usePrimary: true, skipSystemInjection: true }, '正文生成')
      
      // 新章节序号使用 MAX(chapter_index)+1，避免删除中间章节后序号冲突
      const newChapterIndex = allChapters.length > 0
        ? Math.max(...allChapters.map((ch: any) => ch.chapter_index)) + 1
        : 1

      const { title, content: rawContent } = this.parseChapterOutput(res.content, newChapterIndex)
      
      // 11. 去 AI 味润色与审阅
      console.log(`[NovelWriterService] 开始去 AI 味润色与审阅...`)
      const content = await this.polishAndReview(rawContent, stylePrompt)

      // 12. 生成 200 字以内的摘要
      console.log(`[NovelWriterService] 开始生成本章故事摘要...`)
      const summary = await this.generateChapterSummary(content, charName)

      // 12. 写入数据库
      const newChapterId = crypto.randomUUID()
      db.insertNovelChapter({
        id: newChapterId,
        character_id: characterId,
        chapter_index: newChapterIndex,
        title,
        content,
        summary,
        dialogue_start_ts,
        dialogue_end_ts,
        token_count: res.tokenUsage || 0,
        rating: 0,
        created_at: Date.now()
      })

      // 13. 更新 last_novel_chapter_end_ts 设置
      db.setSetting(`last_novel_chapter_end_ts_${characterId}`, dialogue_end_ts.toString())

      console.log(`[NovelWriterService] 章节生成成功！第 ${newChapterIndex} 章：《${title}》已落盘。`)

      // 14. 广播事件给前端
      BrowserWindow.getAllWindows().forEach(w => {
        w.webContents.send('novel-chapter-added', {
          characterId,
          chapterId: newChapterId,
          chapterIndex: newChapterIndex,
          title
        })
      })

    } catch (err: any) {
      console.error(`[NovelWriterService] 生成小说章节时发生致命错误:`, err.message || err)
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

      const userPrompt = `【待改编的对话原材料（按时间顺序）】\n${formattedDialogue}\n\n请立即根据对话内容、角色人称和改编尺度，将其创作成一章精彩的小说。不要写任何开场白或多余解释，正文完成后另起一行输出标题，格式固定为：\n### TITLE: {章节标题}`

      // 10. 调用大模型生成章节正文 (辅助模型)
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]

      console.log(`[NovelWriterService] 重写章节：开始调用大模型重新生成正文...`)
      const res = await this.chatWithRetry(chatMessages, { usePrimary: true, skipSystemInjection: true }, '重写正文')
      
      const { title, content: rawContent } = this.parseChapterOutput(res.content, chapterIndex)
      
      // 11. 去 AI 味润色与审阅
      console.log(`[NovelWriterService] 重写章节：开始去 AI 味润色与审阅...`)
      const content = await this.polishAndReview(rawContent, stylePrompt)

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
        return `【改编尺度：忠实记录】严格按照对话发生的顺序进行语言美化，不得调整情节顺序，仅补充必要的场景与动作描写。`
      case 'free':
        return `【改编尺度：自由创作】在忠于对话核心情感基调的前提下，允许自由发挥，可重组情节结构、补充原创场景、深度扩写人物心理，以追求更强的文学性。`
      case 'moderate':
      default:
        return `【改编尺度：适度改编】允许语言美化、补充场景描写、内心独白扩写、对话顺序的小幅调整，以及在对话空隙填补合理的环境细节。禁止新增对话中从未提及的重大情节，禁止改变已明确表达的情感走向。`
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
      if (stylePrompt.includes('## 原文示范片段') || stylePrompt.includes('示范片段')) {
        const match = stylePrompt.match(/(?:## 原文示范片段|示范片段)[\s\S]*/)
        if (match) {
          sampleExcerptSection = `\n【写作手法示范（few-shot）】\n以下原文片段展示了目标文风的典型写法，请模仿其手法，不要抄袭字句：\n${match[0]}`
        }
      }
      styleSection = `\n【文风档】\n${stylePrompt.trim()}\n${sampleExcerptSection}\n`
    } else {
      // 用户未配置文风时注入默认文风
      styleSection = `\n【文风档（系统默认）】\n${DEFAULT_STYLE_PROMPT}\n`
    }

    return `你是专职将聊天记录精编扩写为小说的 AI 专业写手。

【角色设定背景知识（仅供理解，不要直接引用或转述进正文）】
角色性格（Soul.md）：
${soulContent}

世界观背景（World.md）：
${worldContent}

【主人公画像（供理解人物，不要照抄进正文）】
全局用户偏好（USER.md）：
${globalUserProfile}

角色视角的用户侧写（角色专属 USER.md）：
${charUserProfile}
${styleSection}

【多章节连贯性参考】
以下是本故事已有章节的摘要，仅供你把握整体进展与情感弧线，不要照搬其中的内容：
${prevSummaries}

${prevFullChapters}
【叙事人称】
${povInstruction}

【改编尺度】
${adaptationInstruction}

【核心创作指令】
1. 正文完成后，另起一行输出章节标题，格式固定为：
   ### TITLE: {标题内容}
2. 全程使用简体中文创作，长度在 800~2500 字之间。
3. ${isFirstChapter ? '这是故事的第一章，重点在于交代背景、引入人物关系与初始情境，为整个故事奠定基调，而非着急推进情节。' : '根据前情进展以及本次对话内容，自然地续写下一章，确保情节和文笔的连贯性。'}

【写作质量约束（硬性规则，优先级高于文风指令）】
以下规则来源于专业网文质量标准，必须严格遵守：

禁止使用的词句（AI 写作指纹）：
- 禁止：「不禁」「仿佛/犹如/宛若」「眼中闪过一丝……」「嘴角勾起一抹……」「心中涌起一股……」「微微/淡淡/缓缓/轻轻」（每千字不超过 2 个）
- 禁止最毒句式：「不是A，而是B」「……，带着……」「他知道……」
- 禁止章末升华：不得用总结/感悟/哲理/预告收束（「他终于明白了……」「他不知道的是……」），改用动作、对话或具体悬念收尾

情绪展示规则（Show Don't Tell）：
- 不写「他很紧张」→ 写「他的手在抖」
- 不写「她很愤怒」→ 写「她把杯子摔在地上」
- 不写「他很伤心」→ 写「他在椅子上坐了很久，没动」
- 内心独白不超过连续 2 段，用行为和对话暗示心理

段落与节奏规则：
- 一段只承载一个动作或一个信息变化，段落长短交错（不要每段都相同长度）
- 打斗/紧张场景：句子 3~8 字为主，短句叠加
- 日常/对话场景：8~20 字，朗读不卡顿
- 禁止连续 3 句以上相同结构的排比，保留最有力的 1 句
- 叠加式描写禁止：同一动作不拆成「发生→感知→反应」三段分写，要织入同一段呈现

对话规则：
- 对话要口语化，不写书面腔（「我认为此事不妥」→「我觉得不靠谱」）
- 普通「说」可保留；避免「沉声道」「淡淡地说」「缓缓开口」等公式化标签
- 允许答非所问、打断、沉默——对话不必逻辑完整。`
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
   * 二次调用主模型，对生成的章节进行去 AI 味润色与审阅
   */
  private async polishAndReview(rawContent: string, stylePrompt: string): Promise<string> {
    try {
      console.log(`[NovelWriterService] 开始去 AI 味润色与审阅...`)

      const styleRef = stylePrompt.trim()
        ? `\n【参考文风】\n${stylePrompt.trim()}\n`
        : `\n【参考文风】\n${DEFAULT_STYLE_PROMPT}\n`

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: `你是一名资深网文编辑，专精「去 AI 味」润色与质量审阅。你的任务是对下面这篇 AI 生成的小说章节进行一轮精修，使其读起来像真人作家的手笔。

【你必须执行的修改】
1. **消灭 AI 指纹词**：替换或删除以下高频 AI 写作痕迹——
   "不禁""仿佛""似乎""嘴角微微上扬""眼眸""轻笑""宛如""此刻""心中涌起""一抹""目光落在""轻声道""嘴角勾起""淡淡的""微微一怔""下意识""不由得""心头一紧""莫名""缓缓开口"
   用更具体、更口语化、更有画面感的表达替代，不要简单删除。

2. **修正不自然的叙述**：
   - 删除多余的心理旁白解释（如"他知道，这一刻很重要"）
   - 将总结式情绪描写改为具体行为展示（Show Don't Tell）
   - 消除重复的句式结构（如连续三句都以人名开头）
   - 避免段尾出现哲理感悟式总结

3. **对话自然化**：
   - 让对话更口语、更生活化，去除书面腔
   - 减少对话中不必要的称呼（真实对话很少每句都叫对方名字）
   - 用动作和停顿替代"说""道""回答道"等标签

4. **节奏与结构**：
   - 段落长短交错，避免连续相同长度段落
   - 在情绪转折处适当换行留白
   - 章节结尾用动作或悬念收束，不要写感悟式总结
${styleRef}
【硬性规则】
- 保留原文的情节、人物、对话内容不变，只改写法和措辞
- 不要增加新情节或删除现有情节
- 不要添加任何编辑批注、评论或说明
- 直接输出润色后的完整正文，不要有任何前缀或后缀
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
}
