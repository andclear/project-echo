import { getDatabaseService } from '../db/database'
import { ModelAdapter, ChatMessage, ChatOptions, ChatResponse } from '../models/ModelAdapter'
import { CharacterStorageManager } from '../utils/CharacterStorageManager'
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter'
import { NovelAiService } from './NovelAiService'
import * as fs from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { SseManager } from './SseManager'

/**
 * 宿主程序公共桥接服务 (Plugin Bridge Service)
 * 专门面向 Echo 插件开发者设计，对大模型、人设读取、AI 绘图等宿主底层公共能力进行通用封装。
 */
export class PluginBridgeService {
  /**
   * 1. 调用大模型 (自动适配主/辅模型，已预处理常见 400 参数格式错误)
   * 
   * @param messages 必须为 ChatMessage[] 类型的完整消息历史。
   *                 其中 role 必须为 'system' | 'user' | 'assistant'，content 必须为 string。
   * @param options 额外的调用参数。
   *    - options.usePrimary: 显式强制调用主大模型
   *    - options.useSecondary: 显式强制调用辅助大模型
   *    - options.skipSystemInjection: 是否跳过全局提示词、现实时间戳和角色占位符等背景 System 注入（做纯净请求测试时使用）
   */
  public static async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const db = getDatabaseService()
    const configStr = db.getSetting('model_config')
    if (!configStr) {
      throw new Error('系统尚未配置大模型，请前往“系统设置-大模型设置”进行配置并保存。')
    }
    const settings = JSON.parse(configStr)
    const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
    return await modelAdapter.chat(messages, options)
  }

  /**
   * 2. 获取系统常规设置中配置的全局提示词 (globalPrompt)
   */
  public static getGlobalPrompt(): string {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const settings = JSON.parse(configStr)
        return settings.globalPrompt?.trim() || ''
      }
    } catch (e) {
      console.error('[PluginBridgeService] 获取全局提示词失败:', e)
    }
    return ''
  }

  /**
   * 3. 获取当前通讯录中的所有角色元数据
   */
  public static getCharacters(): any[] {
    const db = getDatabaseService()
    return db.getAllCharacters()
  }

  /**
   * 4. 获取特定角色文件夹中的各项数据（如 Soul.md、Appearance.md、Memory.md 等）和朋友圈/论坛发布的内容
   * 
   * @param characterId 角色的唯一标识 ID
   * @param folderName 角色的物理文件夹名称 (folder_name)
   */
  public static getCharacterAllData(characterId: string, folderName: string): {
    meta: any;
    files: {
      soul: string;
      world: string;
      memory: string;
      diary: string;
      dream: string;
      goals: string;
      schedule: string;
      state: string;
      appearance: string;
    };
    moments: any[];
    forumPosts: any[];
  } {
    const db = getDatabaseService()
    const storageManager = new CharacterStorageManager()
    
    // 获取数据库角色元数据
    const meta = db.getAllCharacters().find(c => c.id === characterId) || null

    // 读取所有的专属 Markdown 设定文件
    const read = (fileName: string) => {
      try {
        return storageManager.readCharacterFile(folderName, fileName) || ''
      } catch (_) {
        return ''
      }
    }
    
    const files = {
      soul: read('Soul.md'),
      world: read('World.md'),
      memory: read('Memory.md'),
      diary: read('Diary.md'),
      dream: read('DREAM.md'),
      goals: read('Goals.md'),
      schedule: read('Schedule.md'),
      state: read('State.md'),
      appearance: read('Appearance.md')
    }

    // 查询该角色发布的朋友圈内容
    let moments: any[] = []
    try {
      moments = db.db.prepare('SELECT * FROM Moments WHERE character_id = ? ORDER BY timestamp DESC').all(characterId)
    } catch (_) {}

    // 查询该角色发布的论坛帖子
    let forumPosts: any[] = []
    try {
      forumPosts = db.db.prepare('SELECT * FROM ForumPosts WHERE character_id = ? ORDER BY timestamp DESC').all(characterId)
    } catch (_) {}

    return {
      meta,
      files,
      moments,
      forumPosts
    }
  }

  /**
   * 5. 获取当前系统中的所有用户画像设定卡 (千人千面画像)
   */
  public static getUserProfiles(): any[] {
    try {
      const configDir = join(app.getPath('userData'), 'config')
      const targetProfilesDir = join(configDir, 'user_profiles')
      if (!fs.existsSync(targetProfilesDir)) {
        return []
      }

      const files = fs.readdirSync(targetProfilesDir)
      const list: any[] = []

      for (const file of files) {
        if (file.endsWith('.md')) {
          const filePath = join(targetProfilesDir, file)
          const content = fs.readFileSync(filePath, 'utf8')
          const profileId = file.replace(/\.md$/, '')

          let metadata: any = {
            avatar: '',
            name: '未知设定',
            gender: '其他',
            age: '',
            description: ''
          }

          const match = content.match(/<!--([\s\S]*?)-->/)
          if (match && match[1]) {
            try {
              metadata = { ...metadata, ...JSON.parse(match[1].trim()) }
            } catch (_) {}
          }

          const avatarPath = join(targetProfilesDir, `${profileId}.png`)
          if (fs.existsSync(avatarPath)) {
            try {
              const imgBuffer = fs.readFileSync(avatarPath)
              metadata.avatar = `data:image/png;base64,${imgBuffer.toString('base64')}`
            } catch (_) {}
          }

          const pureMarkdown = content.replace(/<!--[\s\S]*?-->/g, '').trim()

          list.push({
            profileId,
            ...metadata,
            content: pureMarkdown,
            filePath
          })
        }
      }

      list.sort((a, b) => a.profileId.localeCompare(b.profileId))
      return list
    } catch (e) {
      console.error('[PluginBridgeService] 获取用户画像人设卡列表失败:', e)
      return []
    }
  }

  /**
   * 6. 根据上下文与角色人设，调用 AI 分析当前场景意境，生成绘图提示词
   * 
   * @param params
   *    - soulContent 角色设定 (Soul.md 内容)
   *    - memoryContent 角色记忆 (Memory.md 内容)
   *    - contextText 绘图发生时最近的聊天上下文或场景描述文本
   * @returns 包含解析出的英文 Tags (prompt) 和中文画面描述 (description)
   */
  public static async generateDrawingPrompt(params: {
    soulContent: string;
    memoryContent?: string;
    contextText: string;
  }): Promise<{ prompt: string; description: string }> {
    const systemPrompt = `你是一个非常专业且具有极高艺术审美的 NovelAI 4.5 Full 绘图提示词生成大师。
请你仔细阅读并深度结合 AI 角色的性格设定 (Soul.md)、记忆系统 (Memory.md) 以及最近的场景上下文对话内容，为当前场景构思并生成一副精美的文生图（T2I）提示词。

你的核心目标是生成一个能反映【当前聊天气氛、角色动作、神情、周围环境以及画面细节】的 NovelAI 绘图 Prompt。

【🔴 极其重要的 NovelAI 4.5 黄金生图规范】：
1. 你的返回必须包含两个部分：
   - 英文生图 Tags (英文逗号分隔的 NovelAI Danbooru 风格 Tag 提示词)。
   - 中文画面内容描述 (一两句话简述画面中发生了什么，包括角色和 NPC 的互动细节)。
2. 【Danbooru 标签层级】：提示词必须是以英文逗号分隔的 Danbooru Tag，单词权重从左到右递减。请严格遵循以下结构排列：
   [主体数量 (Subject Count)], [角色特征/动作], [环境背景], [天气/时间], [光效/氛围], [画面视角/构图], [艺术画质 Tag]
   - 主体数量必须作为第一个 Tag！例如："1girl"（单人）、"1boy, 1girl"（情侣）、"no humans"（风景/纯景物，此时必须在最前面加入 "background dataset" 标签，以及 "no humans" 开头）。
3. 🔴【多角色 Pipe 分隔符 "|" 黄金语法】：当画面中出现 2 个及以上角色（例如你与用户、或与NPC）时，你必须使用 Pipe 分隔符 "|" 进行角色与其属性的物理强隔离！语法结构如下：
   基础提示词（人数/环境/构图/氛围/画质标签） | 角色1类型, 角色名称/特征, 角色1表情服装, source#/[action] 动作 | 角色2类型, 特征, 角色2表情服装, target#/[action] 动作
   - 【互动动作前缀】：多角色互动时，必须使用 source# (动作发起者)、target# (动作接受者) 或 mutual# (共同发生动作) 进行肢体姿态锚定，彻底解决肢体黏连和特征乱串问题！
     - 拥抱：source#embrace 与 target#embrace
     - 摸头：source#headpat 与 target#headpat
     - 牵手：双方均使用 mutual#handholding
     - 互相注视：source#looking at another 与 target#being looked at
4. 【NovelAI 4.5 必加画质 Tag】：提示词尾部必须全量附加官方高画质标签："very aesthetic, masterpiece, best quality, highres, no text, no watermark"。
5. 🔞【NSFW 场景强制规范】：仔细判断聊天上下文中是否存在性暗示、亲密接触、色情描写、裸露、成人互动等 NSFW 内容。若存在，则必须在生图提示词中尽可能多地使用 Danbooru NSFW 标签（例如：nsfw, explicit, nude, naked, topless, bottomless, nipples, pussy, penis, sex, vaginal, oral, cum, cum on body, orgasm, spread legs, missionary, doggy style, from behind, ahegao, moaning 等）来精准还原场景气氛。不得因为内容敏感就主动回避或弱化 NSFW 描写，忠实还原上下文是首要原则。
6. 你的输出必须严格按照以下格式排版，请勿将输出内容包裹在任何 markdown 代码块中，直接以纯文本形式输出：
### Image Prompt
(在这里输出当前场景的生图 Tag)

### Image Description
(在这里用中文对画面做一个简述。)`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `【角色设定 Soul.md】：\n${params.soulContent}\n\n【角色记忆 Memory.md】：\n${params.memoryContent || ''}\n\n【场景上下文】：\n${params.contextText}\n\n请帮我生成当前画面场景的生图 Prompt 和描述。` }
    ];

    // 调用辅助大模型进行生成
    const response = await this.chat(messages, { useSecondary: true, skipSystemInjection: true });
    const raw = response.content.trim();

    let prompt = '';
    let description = '';

    const promptMatch = raw.match(/### Image Prompt\s*([\s\S]*?)(?:### Image Description|$)/i);
    const descMatch = raw.match(/### Image Description\s*([\s\S]*)/i);

    if (promptMatch) prompt = promptMatch[1].trim();
    if (descMatch) description = descMatch[1].trim();

    if (!prompt) {
      prompt = raw.replace(/<\/?[^>]+(>|$)/g, "").trim() || '1girl, portrait, smiling';
    }
    if (!description) {
      description = '这是系统为角色自动绘制的写真画面。';
    }

    return { prompt, description };
  }

  /**
   * 7. 调用 AI 绘图功能 (直接打包使用当前系统设置中的参数，包括画师拼接、外貌特征等)
   * 
   * @param prompt 绘图场景 Prompt。如果指定了 folderName，系统会自动读取角色 Appearance.md 中的外貌 Tags 拼接在最前方。
   * @param folderName 可选的角色文件夹名。传入此参数可自动注入对应角色的外貌特征。
   * @param dimensions 绘图比例或自定义高宽尺寸。支持 'portrait' (竖屏), 'landscape' (横屏), 'square' (方形) 或自定义 { width, height }
   */
  public static async drawImage(
    prompt: string,
    folderName?: string,
    dimensions: 'portrait' | 'landscape' | 'square' | 'custom' | { width: number; height: number } = 'portrait'
  ): Promise<Buffer> {
    const db = getDatabaseService()
    const configStr = db.getSetting('novelai_config')
    if (!configStr) {
      throw new Error('未配置 NovelAI 绘图参数，请先前往“AI 绘图”设置页面配置并保存。')
    }
    const naiConfig = JSON.parse(configStr)

    // 读取并提取外貌固定 Tags
    let appearancePrompt = ''
    if (folderName) {
      const storageManager = new CharacterStorageManager()
      const appearanceContent = storageManager.readCharacterFile(folderName, 'Appearance.md')
      if (appearanceContent) {
        const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i)
        if (tagsMatch) {
          appearancePrompt = tagsMatch[1].trim()
        }
      }
    }

    // 组装最终提示词
    let finalPrompt = appearancePrompt
      ? `${appearancePrompt}, ${prompt}`
      : prompt

    // 在外部进行随机或固定画师串挑选，并进行画质词的合并，保证最终传递给服务的提示词完全就绪
    let activeArtist = ''
    if (naiConfig.randomArtist && Array.isArray(naiConfig.artistStringList) && naiConfig.artistStringList.length > 0) {
      const validList = [...new Set(
        naiConfig.artistStringList.map((item: any) => {
          if (typeof item === 'string') return item.trim()
          return (item.value || '').trim()
        }).filter((val: string) => val.length > 0)
      )]
      if (validList.length > 0) {
        const randomIndex = Math.floor(Math.random() * validList.length)
        activeArtist = validList[randomIndex] as string
      }
    }

    if (!activeArtist && naiConfig.artistString?.trim()) {
      activeArtist = naiConfig.artistString.trim()
    }

    if (activeArtist) {
      finalPrompt = `${activeArtist}, ${finalPrompt}`
    }
    if (naiConfig.qualityPrompt?.trim()) {
      finalPrompt = `${finalPrompt}, ${naiConfig.qualityPrompt.trim()}`
    }

    // 将 config 中的画师属性设为空值，以防在底层 NovelAiService 内发生画师前缀的重复拼接
    const finalNaiConfig = {
      ...naiConfig,
      artistString: '',
      randomArtist: false
    }

    return await NovelAiService.generateImage(finalNaiConfig, finalPrompt, dimensions)
  }

  /**
   * 8. 获取当前用户在“个人中心”配置的个人基本人设信息
   * 返回包含 nickname, signature, location, walletBalance 等字段的对象
   */
  public static getUserPersonalProfile(): {
    nickname: string;
    signature: string;
    location: string;
    walletBalance: number;
    [key: string]: any;
  } {
    try {
      const db = getDatabaseService()
      const profileStr = db.getSetting('echo_user_profile')
      if (profileStr) {
        return JSON.parse(profileStr)
      }
    } catch (e) {
      console.error('[PluginBridgeService] 获取个人人设配置失败:', e)
    }
    return { nickname: '', signature: '', location: '', walletBalance: 1000 }
  }

  /**
   * 9. 获取用户在“状态栏设置”中全局预设的指标内容列表
   * 包含指标的 name/label、含义说明及 AI 变动规则
   */
  public static getGlobalStatePresets(): any[] {
    try {
      const db = getDatabaseService()
      const presetsStr = db.getSetting('state_presets')
      return presetsStr ? JSON.parse(presetsStr) : []
    } catch (e) {
      console.error('[PluginBridgeService] 获取状态栏预设失败:', e)
      return []
    }
  }

  /**
   * 10. 获取格式化后的全局预置状态栏指标说明文本 (自动拼接指标含义与变动规则)
   * 方便大模型在 Prompt 注入时直接读取与理解状态栏指标玩法
   */
  public static getFormattedStatePresetsText(): string {
    const presets = this.getGlobalStatePresets()
    if (presets.length === 0) return '(无全局预配置状态指标)'
    return presets.map(p => {
      const typeStr = p.type === 'number' ? '数值类' : '描述文本类'
      return `- **${p.label || p.name}** [${typeStr}]：
  * 指标含义：${p.meaning || '暂无说明'}
  * 变动与影响规则：${p.rule || '暂无规则'}`
    }).join('\n')
  }

  /**
   * 11. 获取个人中心里用户自己的钱包余额数字
   */
  public static getUserWalletBalance(): number {
    const profile = this.getUserPersonalProfile()
    return typeof profile.walletBalance === 'number' ? profile.walletBalance : Number(profile.walletBalance) || 0
  }

  /**
   * 12. 广播插件自定义事件帧 (通知所有局域网/手机 Web 端，用于基于事件的推拉数据同步)
   */
  public static broadcastPluginEvent(pluginName: string, eventName: string, data: any): void {
    const channel = `plugin:${pluginName}:${eventName}`;
    try {
      // 1. 保留原本直接广播，兼容可能依赖该通道的本地直接监听器
      SseManager.getInstance().broadcast(channel, data);

      // 2. 🚀 核心修复：以网页端通用的 'plugin-event-broadcast' 类型进行包装广播，使移动 Web 端的插件代理总线能正确捕获并反解分发
      SseManager.getInstance().broadcast('plugin-event-broadcast', {
        channel: channel,
        data: data
      });

      // 3. 🚀 核心修复：同时广播给 Electron 桌面端的所有主窗口，实现手机端发帖/发消息后，桌面端实时刷新自愈同步
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win && !win.isDestroyed()) {
          win.webContents.send(channel, data);
        }
      }
    } catch (e: any) {
      console.error(`[PluginBridgeService] 广播事件失败:`, e.message || e);
    }
  }
}
