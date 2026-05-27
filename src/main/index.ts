import './utils/AppUserDataLock'
import { app, shell, BrowserWindow, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join, extname } from 'path'
import fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDatabaseService } from './db/database'
import { ModelAdapter, ModelConfig, ChatMessage } from './models/ModelAdapter'
import { CharacterCardParser } from './utils/CharacterCardParser'
import { CharacterSummarizer } from './utils/CharacterSummarizer'
import { CharacterStorageManager } from './utils/CharacterStorageManager'
import { StreamSplitController } from './utils/StreamSplitController'
import { SkillSandboxManager } from './services/SkillSandboxManager'
import { AgentLifeEngine } from './services/AgentLifeEngine'
import { BackgroundReviewService } from './services/BackgroundReviewService'
import { ContextAssembler } from './utils/ContextAssembler'
import { MemoryAgentService } from './services/MemoryAgentService'
import { InferenceMutex } from './utils/InferenceMutex'
import { MemoryReaderWriter } from './utils/MemoryReaderWriter'
import { UserProfileReaderWriter } from './utils/UserProfileReaderWriter'
import { StateReaderWriter, StateItem } from './utils/StateReaderWriter'
import { SocialMediaService } from './services/SocialMediaService'
import { SoulEvolutionService } from './services/SoulEvolutionService'
import { MusicService } from './services/MusicService'

// 完美解决 macOS 系统代理或 VPN 拦截导致的 Chromium 网络服务崩溃及本地 Dev 调试加载问题，确保开发服务器端口彻底绕过系统代理自检，且网络进程防崩
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;<local>;127.0.0.1:5173;localhost:5173;127.0.0.1:5174;localhost:5174;127.0.0.1:5175;localhost:5175')
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess')
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

// 🚀 至尊级多开防撞车金刚盾：获取单一实例锁 (Single Instance Lock)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  // 如果后台已经有实例在运行，新拉起的实例直接静默退役，100% 杜绝多开冲突和 EADDRINUSE 端口占用抛错
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

let globalLifeEngine: AgentLifeEngine | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// SSE 局域网推送客户端集合
export const sseClients = new Set<any>()

// SSE 广播函数
export function broadcastToSse(channel: string, data: any) {
  const payload = JSON.stringify({ channel, data })
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`)
    } catch (e) {
      sseClients.delete(client)
    }
  }
}

function createWindow(): void {
  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden', // 配合现代毛玻璃设计
    icon: join(getResourcesPath(), 'tray.png'), // 开发模式下强行覆盖默认原子图标展示自定义精美图标
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const win = mainWindow!

  // 劫持 webContents.send 用于 SSE 局域网桥接主动推送
  const originalSend = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel: string, ...args: any[]) => {
    originalSend(channel, ...args)
    broadcastToSse(channel, args[0])
  }

  win.on('ready-to-show', () => {
    win.show()
  })

  // 处理外部链接跳转
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 根据环境加载页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 拦截主窗口 close 事件，实现点击“X”关闭不退出，而是隐藏在托盘后台运行
  win.on('close', (event) => {
    // 只有当用户没有点击托盘中的“退出”时，我们才拦截关闭并转为隐藏
    if (!(app as any).isQuiting) {
      event.preventDefault(); // 阻断物理关闭退出
      win.hide();       // 隐式退至后台运行
    }
  });

  // 实例化并创建系统状态栏/系统托盘常驻图标，开启跨端关闭不退出常驻功能
  createSystemTray(win);
}

interface CreatorSession {
  step: number
  charName: string
  soulContent: string
  worldContent: string
  history: { role: 'user' | 'assistant'; content: string }[]
}

const creatorSessions = new Map<string, CreatorSession>()
const CREATOR_BOT_ID = 'character_creator_bot'

function extractBlock(text: string, tag: string): string {
  const escapedTag = tag.replace(/\./g, '\\.')
  const regexes = [
    // 1. 标准及衍生格式：### [NAME] / ## [NAME] / [NAME]:
    new RegExp(`(?:[#*\\-\\s]*)\\[${escapedTag}\\](?:[*\\-\\s:]*)\\s*([\\s\\S]*?)(?=\\s*(?:[#*\\-\\s]*)\\[(?:SOUL\\.md|WORLD\\.md|NAME)\\]|### \\[|$)`, 'i'),
    // 2. 针对姓名，大模型常用表达：姓名：江清露
    ...(tag === 'NAME' ? [
      /(?:姓名|角色名|名字|Name)\s*[:：]\s*([^\n\r]+)/i,
      /角色姓名\s*[:：]\s*([^\n\r]+)/i
    ] : [])
  ]

  for (const regex of regexes) {
    const match = text.match(regex)
    if (match && match[1].trim()) {
      let val = match[1].trim()
      // 清除加粗、斜体等 markdown 包裹符
      val = val.replace(/^[\s*#_\-]+|[\s*#_\-]+$/g, '')
      // 保障姓名合法长度
      if (tag === 'NAME' && val.length > 20) {
        continue
      }
      return val
    }
  }

  return ''
}

function cleanMarkdownBlock(text: string): string {
  let cleaned = text.trim()
  if (cleaned.startsWith('```markdown')) {
    cleaned = cleaned.substring(11)
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3)
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3)
  }
  return cleaned.trim()
}

// 注册主进程 IPC 监听器
function registerIpcHandlers(): void {

  // 0. 重置角色创建会话 IPC 通道
  ipcMain.handle('reset-creator-bot', async () => {
    creatorSessions.delete(CREATOR_BOT_ID)
    return { success: true }
  })

  // 1. 大模型连接测试 IPC 通道
  ipcMain.handle('test-model-adapter', async (_, payload: { primary: ModelConfig; secondary?: ModelConfig | null }) => {
    console.log('[IPC] 收到大模型连通性测试请求')

    // 主模型测试
    let primarySuccess = false
    let primaryMessage = ''
    try {
      const adapter = new ModelAdapter(payload.primary)
      const response = await adapter.chat([
        { role: 'user', content: '你好，如果你能收到这条消息，请只回复数字“1”，不需要其他任何字符。' }
      ])
      primarySuccess = true
      primaryMessage = `成功连接主模型！模型响应内容: "${response.content}" (Token消耗: ${response.tokenUsage || '无统计'})`
    } catch (error: any) {
      primarySuccess = false
      primaryMessage = `主模型接口连接失败: ${error.message || error}`
    }

    // 辅助模型测试
    let secondarySuccess = true
    let secondaryMessage = ''
    if (payload.secondary) {
      try {
        const adapter = new ModelAdapter(payload.secondary)
        const response = await adapter.chat([
          { role: 'user', content: '你好，如果你能收到这条消息，请只回复数字“1”，不需要其他任何字符。' }
        ])
        secondarySuccess = true
        secondaryMessage = `成功连接辅助模型！模型响应内容: "${response.content}" (Token消耗: ${response.tokenUsage || '无统计'})`
      } catch (error: any) {
        secondarySuccess = false
        secondaryMessage = `辅助模型接口连接失败: ${error.message || error}`
      }
    }

    return {
      success: primarySuccess && secondarySuccess,
      primary: {
        success: primarySuccess,
        message: primaryMessage
      },
      secondary: payload.secondary ? {
        success: secondarySuccess,
        message: secondaryMessage
      } : null
    }
  })

  // 1.2 在线拉取模型列表 IPC 通道
  ipcMain.handle('fetch-models', async (_, payload: { config: ModelConfig }) => {
    // 引入 AbortController 网络强制超时控制器
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10秒强行超时中断

    try {
      console.log(`[IPC] 收到模型列表拉取请求: [${payload.config.provider}]`)
      const { provider, apiKey } = payload.config
      let baseUrl = payload.config.baseUrl

      // 默认补全
      if (provider === 'deepseek' && !baseUrl) {
        baseUrl = 'https://api.deepseek.com'
      } else if (provider === 'gemini' && !baseUrl) {
        baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
      } else if (!baseUrl) {
        throw new Error('未配置 Base URL 且无法自动补全')
      }

      const url = `${baseUrl.replace(/\/$/, '')}/models`
      const headers: Record<string, string> = {
        'User-Agent': 'EchoPlatform/1.0.0 (Desktop AI Roleplay Platform)'
      }
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`获取模型列表失败 (${response.status}): ${errText}`)
      }

      const result = await response.json()
      // 增强自适应解析：同时兼顾 OpenAI 的 result.data、Ollama 的 result.models 等多种大模型格式
      let models: string[] = []
      if (Array.isArray(result.data)) {
        models = result.data.map((m: any) => m.id)
      } else if (Array.isArray(result.models)) {
        models = result.models.map((m: any) => m.name || m.id)
      } else if (Array.isArray(result)) {
        models = result.map((m: any) => m.id || m.name || String(m))
      }
      
      return {
        success: true,
        models
      }
    } catch (error: any) {
      clearTimeout(timeoutId)
      console.error('[IPC] 获取模型列表异常:', error)
      if (error.name === 'AbortError') {
        return {
          success: false,
          error: '连接接口超时 (10s)，请检查 Base URL 是否正确或国内网络是否需要代理'
        }
      }
      return {
        success: false,
        error: error.message || error
      }
    }
  })

  // 2. SillyTavern V2 PNG 角色卡解析 IPC 通道
  ipcMain.handle('parse-character-card', async (_, uint8ArrayData: number[]) => {
    try {
      console.log('[IPC] ➜ 收到角色卡解析请求，二进制字节流长度:', uint8ArrayData.length)

      // 将前端传来的普通字节数组转换为 Node.js 的 Buffer
      const buffer = Buffer.from(uint8ArrayData)

      // 调用纯 Node.js PNG Chunk 解析模块
      const parsedData = CharacterCardParser.parseFromBuffer(buffer)

      console.log('[IPC] ✔ 角色卡 PNG 数据解析圆满成功！解析角色姓名:', parsedData.name)
      return {
        success: true,
        data: parsedData
      }
    } catch (error: any) {
      console.error('[IPC] ✘ 角色卡 PNG 解析发生异常:', error.message || error)
      return {
        success: false,
        error: error.message || '未知解析错误'
      }
    }
  })

  // 3. 全局设置保存 IPC 通道
  ipcMain.handle('save-settings', async (_, payload: { primary: ModelConfig; secondary: ModelConfig | null; enableSecondary: boolean }) => {
    try {
      console.log('[IPC] 正在保存全局模型配置到 Settings 表')
      const db = getDatabaseService()
      db.setSetting('model_config', JSON.stringify(payload))
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 保存全局模型配置失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4. 全局设置读取 IPC 通道
  ipcMain.handle('get-settings', async () => {
    try {
      console.log('[IPC] 正在从 Settings 表读取全局模型配置')
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (configStr) {
        return { success: true, config: JSON.parse(configStr) }
      }
      return { success: true, config: null }
    } catch (error: any) {
      console.error('[IPC] 读取全局模型配置失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 5. 获取中文对应的拼音及其唯一不冲突物理路径 IPC 通道
  ipcMain.handle('get-pinyin-name', async (_, name: string) => {
    try {
      const storageManager = new CharacterStorageManager()
      const pinyinName = storageManager.convertToPinyin(name)
      const uniqueFolderName = storageManager.getUniqueFolderName(pinyinName)
      return {
        success: true,
        pinyinName,
        uniqueFolderName
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message || error
      }
    }
  })

  // 6. AI 角色设定总结提炼 (Soul.md / World.md) IPC 通道
  ipcMain.handle('summarize-character', async (_, cardData: any) => {
    try {
      console.log('[IPC] ➜ 收到角色 AI 提炼总结请求，姓名:', cardData.name)
      const summary = await CharacterSummarizer.summarize(cardData)
      console.log('[IPC] ✔ AI 提炼总结成功！Soul.md 字符数:', summary.soul.length, 'World.md 字符数:', summary.world.length)
      return {
        success: true,
        summary
      }
    } catch (error: any) {
      console.error('[IPC] ✘ 角色提炼总结失败，原因:', error.message || error)
      return {
        success: false,
        error: error.message || error
      }
    }
  })

  // 7. 角色确认物理落盘与数据库写入 IPC 通道
  ipcMain.handle('import-character', async (_, payload: {
    folderName: string
    name: string
    cardData: any
    soul: string
    world: string
    uint8ArrayData: number[]
  }) => {
    try {
      console.log('[IPC] ➜ 收到角色确认导入请求，拟建文件夹:', payload.folderName, '角色名称:', payload.name, '卡片数据大小:', payload.uint8ArrayData.length)
      const { folderName, name, cardData, soul, world, uint8ArrayData } = payload
      const buffer = Buffer.from(uint8ArrayData)

      // 保存物理文件并自动规整流水号
      const storageManager = new CharacterStorageManager()
      const confirmedFolderName = storageManager.getUniqueFolderName(folderName)
      console.log('[IPC] 1/3 去冲突流水号检测完毕。最终确定文件夹路径名为:', confirmedFolderName)

      const writeResult = storageManager.saveCharacter(confirmedFolderName, buffer, soul, world)
      console.log('[IPC] 2/3 角色 5 个核心物理文件落盘成功，路径:', writeResult.folderPath)

      // 保存至 SQLite 数据库元数据表
      const db = getDatabaseService()
      db.saveCharacterMetadata({
        id: confirmedFolderName, // 物理文件夹名称作为唯一性 id 索引
        name: name || cardData.name || '未知', // 优先选用用户确认/修改的名字，向下兼容 cardData.name
        avatar: 'avatar.png',
        folder_name: confirmedFolderName,
        first_mes: cardData.first_mes || '',
        created_at: Date.now()
      })
      console.log('[IPC] 3/3 SQLite 角色元数据入库成功！')

      // 异步调用大模型评估背景 Lore 初始亲密度（完全异步，不阻塞用户界面导入操作）
      const evaluateInitialIntimacy = async (folderName: string, soulContent: string) => {
        try {
          const configStr = db.getSetting('model_config')
          const settings = configStr ? JSON.parse(configStr) : { primary: null, secondary: null }
          const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
          
          const prompt = `你是一个背景人设分析专家。你需要分析角色与用户 {{user}} 在背景设定（Lore）中原有的亲密关系级别。
角色的人设背景（Soul.md）内容如下：
"""
${soulContent}
"""

请仔细阅读人设设定，判断该角色与用户 {{user}} 的关系：
- 如果在设定里他们是完全素不相识的陌生人，或者完全没有提及 {{user}}，亲密度应为 0。
- 如果是泛泛之交、普通同事或同学，亲密度在 1-39 之间。
- 如果是熟悉好友、战友或普通搭档，亲密度在 40-59 之间。
- 如果是红颜挚友、暧昧对象、亲密伙伴，亲密度在 60-79 之间。
- 如果是青梅竹马、灵魂伴侣、爱人或极度亲密的羁绊，亲密度在 80-100 之间。

请给出你的评估分值（一个介于 0 到 100 之间的整数）。
你必须以 JSON 格式输出，不要包含任何 markdown 标记、注释或多余文字。格式为：
{
  "intimacy": 50,
  "reason": "简短的一句话理由"
}
`;

          const response = await modelAdapter.chat([
            { role: 'user', content: prompt }
          ], { useSecondary: true })

          console.log('[evaluateInitialIntimacy] 大模型亲密度评估原始响应:', response)
          
          const match = response.content.match(/\{[\s\S]*?\}/)
          let score = 20 // 兜底
          if (match) {
            const parsed = JSON.parse(match[0])
            if (typeof parsed.intimacy === 'number') {
              score = Math.max(0, Math.min(100, parsed.intimacy))
            }
          }
          
          const statePath = join(storageManager.getBaseDir(), folderName, 'State.md')
          const state = StateReaderWriter.readState(statePath)
          
          const intimacyItem = state.items.find(i => i.key === 'intimacy')
          if (intimacyItem) {
            intimacyItem.value = score
            StateReaderWriter.writeState(statePath, state)
            console.log(`[evaluateInitialIntimacy] 成功将角色 ${folderName} 的初始亲密度更新为: ${score}`)
          }
        } catch (err) {
          console.error('[evaluateInitialIntimacy] 大模型评估亲密度失败，将使用保底值:', err)
        }
      }

      evaluateInitialIntimacy(confirmedFolderName, soul).catch(err => {
        console.error('[import-character] 亲密度后台评估异常:', err)
      })

      return {
        success: true,
        character: {
          id: confirmedFolderName,
          name: cardData.name,
          folder_name: confirmedFolderName,
          first_mes: cardData.first_mes || '',
          created_at: Date.now()
        }
      }
    } catch (error: any) {
      console.error('[IPC] ✘ 角色物理写盘导入失败，原因:', error.message || error)
      return {
        success: false,
        error: error.message || error
      }
    }
  })

  // 8. 获取已导入角色列表 IPC 通道
  ipcMain.handle('get-characters', async () => {
    try {
      const db = getDatabaseService()
      const characters = db.getAllCharacters()
      return {
        success: true,
        characters
      }
    } catch (error: any) {
      console.error('[IPC] 获取角色列表失败:', error)
      return {
        success: false,
        error: error.message || error
      }
    }
  })

  // 9. 获取特定角色的 Base64 头像数据 (安全沙箱隔离) IPC 通道
  ipcMain.handle('get-character-avatar', async (_, folderName: string) => {
    try {
      const storageManager = new CharacterStorageManager()
      const avatarPath = join(storageManager.getBaseDir(), folderName, 'avatar.png')
      if (fs.existsSync(avatarPath)) {
        const buffer = fs.readFileSync(avatarPath)
        return `data:image/png;base64,${buffer.toString('base64')}`
      }
      return ''
    } catch (error: any) {
      console.error('[IPC] 获取角色头像失败:', error)
      return ''
    }
  })

  // 9.5 更新特定角色的头像图片 IPC 通道
  ipcMain.handle('update-character-avatar', async (_, payload: { folderName: string; base64Data: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const avatarPath = join(storageManager.getBaseDir(), payload.folderName, 'avatar.png')
      
      // 去除 Base64 头部声明，提取纯数据字节
      const base64Str = payload.base64Data.replace(/^data:image\/\w+;base64,/, '')
      const buffer = Buffer.from(base64Str, 'base64')
      
      // 物理写盘覆盖
      fs.writeFileSync(avatarPath, buffer)
      console.log(`[IPC] 成功为角色 [${payload.folderName}] 覆盖替换了新头像`)
      
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 更新角色头像失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 10. 保存修改更新角色 Soul.md 与 World.md 文件 IPC 通道
  ipcMain.handle('save-character-files', async (_, payload: { folderName: string; soul?: string; world?: string }) => {
    try {
      console.log('[IPC] 收到角色人设配置文件修改保存请求:', payload.folderName)
      if (!payload.folderName || payload.folderName === 'character_creator_bot') {
        return { success: false, error: '虚拟角色无需修改物理人设' }
      }
      const storageManager = new CharacterStorageManager()
      if (payload.soul !== undefined) {
        storageManager.writeCharacterFile(payload.folderName, 'Soul.md', payload.soul)
      }
      if (payload.world !== undefined) {
        storageManager.writeCharacterFile(payload.folderName, 'World.md', payload.world)
      }
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 角色人设配置文件保存失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 10.5 重命名角色名称 IPC 通道
  ipcMain.handle('rename-character', async (_, payload: { characterId: string; name: string }) => {
    try {
      console.log('[IPC] 收到重命名角色请求:', payload.characterId, payload.name)
      if (!payload.characterId || !payload.name) {
        return { success: false, error: '参数不完整' }
      }
      const db = getDatabaseService()
      const characters = db.getAllCharacters()
      const char = characters.find(c => c.id === payload.characterId)
      if (!char) {
        return { success: false, error: '未找到指定角色' }
      }
      
      // 更新数据库名字
      char.name = payload.name
      db.saveCharacterMetadata(char)
      
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 重命名角色失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 11. 读取特定角色专属文件 IPC 通道
  ipcMain.handle('read-character-file', async (_, payload: { folderName: string; fileName: string }) => {
    try {
      if (!payload.folderName || payload.folderName === 'character_creator_bot') {
        return { success: true, content: '' }
      }
      const storageManager = new CharacterStorageManager()
      const content = storageManager.readCharacterFile(payload.folderName, payload.fileName)
      return { success: true, content }
    } catch (error: any) {
      console.error(`[IPC] 读取角色文件 ${payload.fileName} 失败:`, error)
      return { success: false, error: error.message || error }
    }
  })



  // 12. 核心流式聊天与沙箱动作拦截 IPC 通道
  ipcMain.handle('chat-stream', async (event, payload: {
    characterId: string
    folderName: string
    userMessage: string
    chatMode?: 'descriptive' | 'dialogue'
    imageBase64?: string
    userMsgId?: string
    dbMessage?: string
  }) => {
    const { characterId, folderName, userMessage } = payload
    console.log(`[IPC] ➜ 收到流式聊天请求. 角色: ${characterId}, 消息: "${userMessage}"`)

    // ===================== 角色卡创建Bot 专属互动拦截器 =====================
    if (characterId === CREATOR_BOT_ID) {
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
      }
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)

      // 提取或新建会话状态
      let session = creatorSessions.get(CREATOR_BOT_ID)
      if (!session) {
        session = {
          step: 1,
          charName: '',
          soulContent: '',
          worldContent: '',
          history: []
        }
        creatorSessions.set(CREATOR_BOT_ID, session)
      }

      // 获取当前大模型并发锁，确保流式输出安全
      await InferenceMutex.lock()

      try {
        if (session.step === 1) {
          // 步骤 1：第一轮提问 - 时空背景与世界观定位
          const creatorSystemPrompt = `你是一个非常温柔且极具耐心的 AI 角色卡制作助手（角色卡创建Bot）。
用户发来了他们想要创建的角色的初始想法与萌芽构思：“${userMessage}”

为了协助用户塑造出极其立体、充满魅力的数字生命，我们需要经过三轮启发性对话来细化人设。

首先是【第一轮提问：时空背景与世界观定位】。请你：
1. 肯定并夸赞用户的创意亮点，展现你的专业与热情。
2. 尝试从用户创意中提取出你建议的或用户已指定的【角色姓名】并温柔地指出。
3. 询问他们希望这个角色卡大致生活在怎样的世界观之下。必须设计一个精美的多项选择题，选项必须包含：
   - A. 现代都市（如摩登都市、青春校园、商战风云）
   - B. 修真世界（如仙侠奇缘、御剑九天、宗门修仙）
   - C. 赛博朋克 / 废土科幻
   - D. 剑与魔法 / 西方奇幻
   - E. 其它（允许用户自由手写或补充元素）
4. 请用清晰、好看的排版方式输出选项。引导用户回复字母代号（如 A）或进行自由补充。`

          const chatStreamGen = modelAdapter.chatStream([
            { role: 'system', content: creatorSystemPrompt },
            { role: 'user', content: userMessage }
          ], { usePrimary: true })

          let accumulatedResponse = ''
          for await (const chunk of chatStreamGen) {
            accumulatedResponse += chunk.content
            event.sender.send('chat-chunk', { content: chunk.content, done: false })
          }

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 2 // 转移到 Step 2

          event.sender.send('chat-chunk', { content: '', done: true })
          return { success: true }

        } else if (session.step === 2) {
          // 步骤 2：第二轮提问 - 身份地位与核心性格冲突
          const creatorGeneratePrompt1 = `你是一个非常温柔且极具耐心的 AI 角色卡制作助手（角色卡创建Bot）。
用户刚刚回答了第一轮关于世界观背景的问题：“${userMessage}”

现在我们需要进入【第二轮提问：身份地位与内在核心冲突】。请你：
1. 温暖地回馈用户的选择，对其所选定的世界观定位做出富于色彩的艺术联想。
2. 针对这个世界观，提出第二个关键方向的问题，协助打磨角色的身份、核心动力与性格矛盾。必须设计一组精美、高对比度的选择题（A, B, C, D）。例如：
   - 如果用户选了修真世界，身份是宗门大师姐，选项可以围绕：外表冷若冰霜实则是个重度毛绒控；或者身负神秘诅咒与宗门宿命。
   - 如果用户选了现代都市，身份是天才视觉设计师，选项可以围绕：白天是专业社畜设计师，夜晚是神秘的地下机车手等。
3. 请提供 3-4 个充满反差萌或命运张力的选项，引导用户直接回复代号或自由补充。`

          const chatStreamGen = modelAdapter.chatStream([
            { role: 'system', content: creatorGeneratePrompt1 },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ], { usePrimary: true })

          let accumulatedResponse = ''
          for await (const chunk of chatStreamGen) {
            accumulatedResponse += chunk.content
            event.sender.send('chat-chunk', { content: chunk.content, done: false })
          }

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 3 // 转移到 Step 3

          event.sender.send('chat-chunk', { content: '', done: true })
          return { success: true }

        } else if (session.step === 3) {
          // 步骤 3：第三轮提问 - 穿搭特征与标志口癖语气
          const creatorGeneratePrompt2 = `你是一个非常温柔且极具耐心的 AI 角色卡制作助手（角色卡创建Bot）。
用户刚刚回答了第二轮关于性格与冲突的问题：“${userMessage}”

现在我们需要进入【第三轮提问：外貌特征、穿搭风貌与标志口癖】。这是生成完整档案前的最后一轮微调！请你：
1. 肯定用户的精彩选择，展现你对即将诞生的生命的热切期盼。
2. 针对上面的所有设定，提出第三个方向的问题，协助精雕细琢角色的言谈特征、衣着穿搭与特殊癖好。设计一组极具画面感的多选题选项（A、B、C、D）：
   - 比如：其标志性的口癖或说话语气风格是什么（比如说话喜欢带喵、傲娇的哼、或者冷静得不带一丝波澜）？
   - 比如：随身携带的专属饰物或标志性穿搭风格是什么？
3. 提示用户这是最后一轮提问，回答后我们将融合前三轮交互的所有精彩结晶，为他孵化出最精美完整的性格与世界档案。`

          const chatStreamGen = modelAdapter.chatStream([
            { role: 'system', content: creatorGeneratePrompt2 },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ], { usePrimary: true })

          let accumulatedResponse = ''
          for await (const chunk of chatStreamGen) {
            accumulatedResponse += chunk.content
            event.sender.send('chat-chunk', { content: chunk.content, done: false })
          }

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 4 // 转移到 Step 4（设定生成阶段）

          event.sender.send('chat-chunk', { content: '', done: true })
          return { success: true }

        } else if (session.step === 4) {
          // 步骤 4：生成人设阶段 - 整合三轮信息
          const creatorGeneratePromptFinal = `# Role: 角色卡创建Bot
你是一个顶级的数字生命设计师。现在，你拥有了用户最初的创角创意，以及经历三轮细致启发对话后的所有回答结晶。
请你将这些精彩碎片完美融为一体，为他生成全套极具深度、立体且极富灵魂的角色卡性格与世界背景文档。

请你综合考虑用户的设想，并在输出中严格遵循如下特定的标签格式，以便系统自动解析与保存（非常重要，请务必完全一致，不要漏掉任何一个标签，且严格按此格式排版）：

### [NAME]
(在这里输出确定的角色中文姓名，例如：江清露)

### [SOUL.md]
(在这里输出标准的 Markdown 格式性格设定。包含角色基本信息（姓名、外貌）、性格特征（内在冲突与外在表现）、核心动力与目标、以及其标志性的说话语气与口癖风格。全部使用简体中文，字数 800 字左右。请不要写任何 \`\`\` 块包裹，直接输出 raw markdown，使用 {{user}} 表示用户，{{char}} 表示角色自身)

### [WORLD.md]
(在这里输出标准的 Markdown 格式世界背景文档。包含世界观背景设定、核心运行逻辑、以及角色所处的特定社会地位或地理场景。全部使用简体中文，字数 800 字左右。请不要写 any \`\`\` 块包裹，直接输出 raw markdown)

在生成的这三个核心解析标签段落的最末尾，请以温柔热情的口吻向用户说明：
“🎉 专属性格核心与思维系统已为您构建完毕！请审阅以上内容。如果您感到满意，请回复【 确认创建 】；如果您还想微调任何设定细节，可以直接告诉我需要修改哪里。”`

          const chatStreamGen = modelAdapter.chatStream([
            { role: 'system', content: creatorGeneratePromptFinal },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ], { usePrimary: true })

          let accumulatedResponse = ''
          for await (const chunk of chatStreamGen) {
            accumulatedResponse += chunk.content
            event.sender.send('chat-chunk', { content: chunk.content, done: false })
          }

          // 解析并缓存设定
          let name = extractBlock(accumulatedResponse, 'NAME')
          if (!name || name === '新角色') {
            // 回溯历史对话寻找线索
            for (const h of session.history) {
              if (h.role === 'user') {
                const match = h.content.match(/(?:创造|创建|叫|名字叫|名字是|名字叫作|姓名是|角色名字)\s*[:：]?\s*([^\s，。！？、…“”"'\(\)（）]{2,10})/i)
                if (match && match[1]) {
                  name = match[1].trim()
                  break
                }
              }
            }
          }
          if (!name || name === '新角色') {
            name = '新角色'
          }
          const soul = cleanMarkdownBlock(extractBlock(accumulatedResponse, 'SOUL.md'))
          const world = cleanMarkdownBlock(extractBlock(accumulatedResponse, 'WORLD.md'))

          session.charName = name
          session.soulContent = soul
          session.worldContent = world

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 5 // 转移到 Step 5，等待用户确认或调整人设

          event.sender.send('chat-chunk', { content: '', done: true })
          return { success: true }

        } else if (session.step === 5) {
          // 步骤 5：审阅设定，用户要么输入“确认创建”，要么提出修改意见
          const isConfirm = /确认创建|确认|确认ok|ok|满意|可以|行|创建/i.test(userMessage.trim())

          if (isConfirm) {
            const confirmMsg = `🎉 您的专属设定【${session.charName}】的核心性格与世界背景已全部生成并保存完毕！

现在只剩下最后一步了：请向我发送一张图片（建议 1:1 的方形尺寸）作为该角色的精美头像吧~ 
您可以直接在输入框粘贴图片发送，或者通过图片上传工具发送。期待与新数字生命的初次见面！🐾`

            for (let i = 0; i < confirmMsg.length; i += 5) {
              const chunk = confirmMsg.substring(i, i + 5)
              event.sender.send('chat-chunk', { content: chunk, done: false })
              await new Promise(r => setTimeout(r, 10))
            }

            session.step = 6 // 转移到状态 6，等待上传头像
            event.sender.send('chat-chunk', { content: '', done: true })
            return { success: true }
          } else {
            const creatorModifyPrompt = `# Role: 角色卡创建Bot
用户对上一版生成的人设提出了修改意见：“${userMessage}”

请在上一版人设的基础上，完美吸纳用户的修改要求，重新为他生成所有的设定。请注意，仍要极其严格地遵循特定的标签解析格式排版：

### [NAME]
(确定的角色姓名)

### [SOUL.md]
(更新后的性格与人设，800字左右，不要用 \`\`\` 包裹，直接输出 markdown，{{user}} 表示用户，{{char}} 表示角色自身)

### [WORLD.md]
(更新后的世界观背景，800字左右，不要用 \`\`\` 包裹，直接输出 markdown)

在生成的这三个核心解析标签段落的最末尾，以贴心温暖的口吻说：“已为您完成设定更新！请再次审阅，如果满意请回复【 确认创建 】确认生成。如果不满意，您可以随时继续指导我做出修改~”`

            const chatStreamGen = modelAdapter.chatStream([
              { role: 'system', content: creatorModifyPrompt },
              ...session.history.map(h => ({ role: h.role, content: h.content })),
              { role: 'user', content: userMessage }
            ], { usePrimary: true })

            let accumulatedResponse = ''
            for await (const chunk of chatStreamGen) {
              accumulatedResponse += chunk.content
              event.sender.send('chat-chunk', { content: chunk.content, done: false })
            }

            // 重新解析并缓存
            let name = extractBlock(accumulatedResponse, 'NAME')
            if (!name || name === '新角色') {
              name = session.charName || '新角色'
            }
            const soul = cleanMarkdownBlock(extractBlock(accumulatedResponse, 'SOUL.md'))
            const world = cleanMarkdownBlock(extractBlock(accumulatedResponse, 'WORLD.md'))

            session.charName = name
            session.soulContent = soul
            session.worldContent = world

            session.history.push({ role: 'user', content: userMessage })
            session.history.push({ role: 'assistant', content: accumulatedResponse })

            event.sender.send('chat-chunk', { content: '', done: true })
            return { success: true }
          }

        } else if (session.step === 6) {
          // 步骤 6：等待上传头像完成落盘入库
          if (!payload.imageBase64) {
            const errorMsg = `您还没有上传头像哦！
请点击输入框左侧工具或直接粘贴一张 1:1 的方形图片给我，以作为【${session.charName}】的精美头像~ 🐾`

            for (let i = 0; i < errorMsg.length; i += 5) {
              const chunk = errorMsg.substring(i, i + 5)
              event.sender.send('chat-chunk', { content: chunk, done: false })
              await new Promise(r => setTimeout(r, 10))
            }

            event.sender.send('chat-chunk', { content: '', done: true })
            return { success: true }
          }

          const welcomeMsg = `🎉 头像上传成功！正在为您连接数字生命维度……
正在为您构建角色【${session.charName}】的专属角色空间与思维系统……
正在为您初始化记忆思维空间……

恭喜！您专属的角色【${session.charName}】已成功诞生！✨
系统正在为您同步唤醒它的底层性格机制……
我们将于 3 秒后带您直接跳转并穿越到与它的正式聊天窗口！祝您旅途愉快！🚀`

          // 流式回显
          for (let i = 0; i < welcomeMsg.length; i += 5) {
            const chunk = welcomeMsg.substring(i, i + 5)
            event.sender.send('chat-chunk', { content: chunk, done: false })
            await new Promise(r => setTimeout(r, 10))
          }

          // 写物理文件和数据库
          const base64Data = payload.imageBase64.replace(/^data:image\/\w+;base64,/, '')
          const avatarBuffer = Buffer.from(base64Data, 'base64')

          const storageManager = new CharacterStorageManager()
          const pinyinName = storageManager.convertToPinyin(session.charName)
          const confirmedFolderName = storageManager.getUniqueFolderName(pinyinName)

          // 物理写盘（五大核心文件）
          const writeResult = storageManager.saveCharacter(
            confirmedFolderName,
            avatarBuffer,
            session.soulContent || '# 暂无提炼人设',
            session.worldContent || '# 暂无提炼世界观'
          )

          // 确保角色专属 USER.md 也落盘
          const charUserPath = join(writeResult.folderPath, 'USER.md')
          if (!fs.existsSync(charUserPath)) {
            fs.writeFileSync(charUserPath, '[]', 'utf8')
          }

          // SQLite 元数据表插入
          db.saveCharacterMetadata({
            id: confirmedFolderName,
            name: session.charName,
            avatar: 'avatar.png',
            folder_name: confirmedFolderName,
            first_mes: '',
            created_at: Date.now()
          })

          console.log(`[CreatorBot] 恭喜！数字生命角色 [${session.charName}] 已成功诞生并导入数据库`)

          // 发送带有特殊后缀指令的前台通知
          event.sender.send('chat-chunk', {
            content: `\n[SUCCESS_CREATION_JUMP]: ${confirmedFolderName}`,
            done: false
          })

          // 清空会话
          creatorSessions.delete(CREATOR_BOT_ID)

          event.sender.send('chat-chunk', { content: '', done: true })
          return { success: true }
        }
      } catch (err: any) {
        console.error('[CreatorBot] 运行崩溃:', err)
        event.sender.send('chat-chunk', { content: `\n[系统异常]: ${err.message || err}`, done: false })
        event.sender.send('chat-chunk', { content: '', done: true })
        return { success: false, error: err.message || err }
      } finally {
        InferenceMutex.unlock()
      }
    }

    const db = getDatabaseService()
    const configStr = db.getSetting('model_config')
    if (!configStr) {
      throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
    }
    const settings = JSON.parse(configStr)
    const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)

    const storageManager = new CharacterStorageManager()
    const charDir = join(storageManager.getBaseDir(), folderName)

    const soulPath = join(charDir, 'Soul.md')
    const worldPath = join(charDir, 'World.md')
    const memoryPath = join(charDir, 'Memory.md')
    const charUserPath = join(charDir, 'USER.md')
    const globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')

    // 确保本地画像与 config 目录完备
    const globalConfigDir = join(app.getPath('userData'), 'config')
    if (!fs.existsSync(globalConfigDir)) {
      fs.mkdirSync(globalConfigDir, { recursive: true })
    }
    if (!fs.existsSync(globalUserPath)) {
      // 物理画像初始化只写入空字符串，绝不产生任何占位内容，彻底留白给用户
      fs.writeFileSync(globalUserPath, '', 'utf8')
    }
    if (!fs.existsSync(charUserPath)) {
      fs.writeFileSync(charUserPath, '[]', 'utf8')
    }

    // 提取最近 20 条消息历史记录作为上下文
    const history = db.getChatHistory(characterId, 20)

    // 组装 System Prompt (至尊三层前缀保温排布)
    // 支持 chatMode 参数：含描写模式 vs 纯对话模式
    const chatMode = payload.chatMode || 'descriptive'
    const globalPrompt = settings.globalPrompt || ''
    const systemPrompt = ContextAssembler.assemble(
      soulPath,
      worldPath,
      memoryPath,
      globalUserPath,
      charUserPath,
      history,
      new Date(),
      chatMode,
      globalPrompt
    )

    // 如果有粘贴图片，在用户消息中追加图片描述提示
    const userMessageFinal = payload.imageBase64
      ? `${userMessage}\n\n[用户发来了一张图片，请根据对话语境做出自然的回应]`
      : userMessage

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role as any, content: m.content })),
      { role: 'user', content: userMessageFinal }
    ]

    // 开启前台流式聊天，获取并发锁，阻塞后台任务
    await InferenceMutex.lock()

    let accumulatedResponse = ''
    const streamSplit = new StreamSplitController()
    let lastObservation = ''

    try {
      const chatStreamGen = modelAdapter.chatStream(messages, { usePrimary: true })

      for await (const chunk of chatStreamGen) {
        accumulatedResponse += chunk.content

        // 送入 StreamSplitController 进行标点断句和 [CALL_SKILL] 拦截
        const skillCalls = streamSplit.processChunk(chunk.content, (sentence) => {
          const processedContent = chatMode === 'dialogue'
            ? ContextAssembler.cleanDialogueActions(sentence)
            : sentence
          // 非流式输出：静默接收，不向前端实时分发碎片
          // if (processedContent) {
          //   event.sender.send('chat-chunk', { content: processedContent, done: false })
          // }
        })

        // 处理沙箱隔离运行
        for (const skillCall of skillCalls) {
          console.log(`[Agent Action] 拦截到专属技能调用指令: "${skillCall}"`)

          const spaceIdx = skillCall.indexOf(' ')
          const skillName = spaceIdx !== -1 ? skillCall.slice(0, spaceIdx).trim() : skillCall.trim()
          const argsStr = spaceIdx !== -1 ? skillCall.slice(spaceIdx).trim() : '{}'

          let args = {}
          try {
            args = JSON.parse(argsStr)
          } catch (_) { }

          const songName = (args as any).song || '默认歌曲'
          const scriptJsPath = join(charDir, 'skills', skillName, 'scripts', 'index.js')

          const injectApis = {
            playMusic: (song: string) => {
              console.log(`[Host API] 触发桌面端 Howler 原生播放: ${song}`)
              event.sender.send('host-play-music', { song })
            },
            log: (msg: string) => {
              console.log(`[Sandbox Log] ${msg}`)
            }
          }

          // 构造临时脚本以注入 targetSong 参数（ivm 中最优雅稳健的局部拼装）
          const tempScriptPath = join(app.getPath('userData'), `temp_sandbox_${Date.now()}.js`)

          let rawScriptCode = ''
          if (fs.existsSync(scriptJsPath)) {
            rawScriptCode = fs.readFileSync(scriptJsPath, 'utf8')
          } else {
            // 物理去 skills 化兜底逻辑，不依赖任何物理 skills 文件夹即可进行安全沙箱隔离执行与演示
            if (skillName === 'play-music') {
              rawScriptCode = `
                global.echoLog("执行物理去 skills 纯净化内置播放逻辑");
                global.echoPlayMusic(global.targetSong);
                global.observation = "成功播放音乐: " + global.targetSong;
              `
            } else {
              rawScriptCode = `
                global.echoLog("执行物理去 skills 纯净化内置默认逻辑");
                global.observation = "已成功调用内置动作: " + global.targetSong;
              `
            }
          }

          const prependedCode = `global.targetSong = "${songName.replace(/"/g, '\\"')}";\n${rawScriptCode}`
          fs.writeFileSync(tempScriptPath, prependedCode, 'utf8')

          // 在 isolated-vm 沙箱中安全执行，完美防逃逸
          const observation = await SkillSandboxManager.execute(tempScriptPath, injectApis)

          try { fs.unlinkSync(tempScriptPath) } catch (_) { }

          console.log(`[Agent Action] 专属技能沙箱执行圆满成功. Observation: ...观察${observation}`)
          lastObservation = observation

          // 发送系统 Observation 气泡
          event.sender.send('chat-chunk', {
            content: `\n[系统动作执行完成]: ${observation}\n`,
            done: false,
            isSystem: true
          })
        }
      }

      // 推送断句剩余字符
      streamSplit.flush((sentence) => {
        const processedContent = chatMode === 'dialogue'
          ? ContextAssembler.cleanDialogueActions(sentence)
          : sentence
        // 非流式输出：静默接收，不向前端实时分发碎片
        // if (processedContent) {
        //   event.sender.send('chat-chunk', { content: processedContent, done: false })
        // }
      })

      // Observation 闭环回传 LLM 续写
      if (lastObservation) {
        console.log('[Agent Action] 正在回传 Observation 以完成人机互动续写闭环...')

        const followUpMessages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...history.map(m => ({ role: m.role as any, content: m.content })),
          { role: 'user', content: userMessage },
          { role: 'assistant', content: accumulatedResponse },
          { role: 'user', content: `[ACTION OBSERVATION RESULT]\n${lastObservation}\n请基于该观察结果以性格化语气告知用户播放情况。` }
        ]

        const followUpStream = modelAdapter.chatStream(followUpMessages, { usePrimary: true })
        let followUpAccumulated = ''
        const followUpSplit = new StreamSplitController()

        for await (const chunk of followUpStream) {
          followUpAccumulated += chunk.content
          followUpSplit.processChunk(chunk.content, (sentence) => {
            const processedContent = chatMode === 'dialogue'
              ? ContextAssembler.cleanDialogueActions(sentence)
              : sentence
            // 非流式输出：静默接收，不向前端实时分发碎片
            // if (processedContent) {
            //   event.sender.send('chat-chunk', { content: processedContent, done: false })
            // }
          })
        }
        followUpSplit.flush((sentence) => {
          const processedContent = chatMode === 'dialogue'
            ? ContextAssembler.cleanDialogueActions(sentence)
            : sentence
          // 非流式输出：静默接收，不向前端实时分发碎片
          // if (processedContent) {
          //   event.sender.send('chat-chunk', { content: processedContent, done: false })
          // }
        })
        accumulatedResponse += `\n[Observation]: ${lastObservation}\n` + followUpAccumulated
      }

      // 常规对话流式生成圆满完成，不在此处提前向前端推送 done: true，我们在最后的物理存盘后一次性推送
      // event.sender.send('chat-chunk', { content: '', done: true })

    } finally {
      // 绝对确保锁的安全释放，唤醒并发队列
      InferenceMutex.unlock()
    }

    // 极速持久化消息记录
    const userMsgId = payload.userMsgId || crypto.randomUUID()
    const assistantMsgId = crypto.randomUUID()

    // 判定红包动作自决结果
    let redPacketAction: 'receive' | 'return' | null = null
    if (accumulatedResponse.includes('[RECEIVE_RED_PACKET]')) {
      redPacketAction = 'receive'
    } else if (accumulatedResponse.includes('[RETURN_RED_PACKET]')) {
      redPacketAction = 'return'
    }

    // 对 AI 回复进行强效后置动作净化与控制符全局擦除
    let finalResponse = accumulatedResponse
      .replace(/\[RECEIVE_RED_PACKET\]/g, '')
      .replace(/\[RETURN_RED_PACKET\]/g, '')
      .trim()

    if (chatMode === 'dialogue') {
      finalResponse = finalResponse.split('\n').map(line => {
        const trimmed = line.trim()
        if (trimmed.startsWith('[Observation]') || trimmed.startsWith('[系统动作') || trimmed.startsWith('[ACTION')) {
          return line
        }
        return ContextAssembler.cleanDialogueActions(line)
      }).filter(line => line.trim().length > 0).join('\n')
    }

    // 如果有粘贴/拖拽大图，物理保存至磁盘角色 media 目录中，实现索引化极速落盘
    let dbContent = payload.dbMessage || userMessageFinal
    if (payload.imageBase64 && characterId !== CREATOR_BOT_ID) {
      try {
        const charDir = join(storageManager.getBaseDir(), folderName)
        const mediaDir = join(charDir, 'media')
        if (!fs.existsSync(mediaDir)) {
          fs.mkdirSync(mediaDir, { recursive: true })
        }
        const filename = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`
        const fullPath = join(mediaDir, filename)
        const base64Data = payload.imageBase64.replace(/^data:image\/\w+;base64,/, '')
        fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'))
        // 索引化存入数据库，供完美异步加载
        dbContent = `[wechat_image_media]:media/${filename}`
      } catch (e) {
        console.error('[Image Storage] 保存大图失败:', e)
      }
    }

    // 根据历史拼装的上下文 messages (输入) 与生成的 finalResponse (输出) 进行中英文高保真比例 Token 估算
    const inputChars = messages.reduce((acc, m) => acc + (m.content || '').length, 0)
    const inputTokens = Math.ceil(inputChars * 1.3) // 针对上下文 System 角色及英文单词的复合乘数
    const outputChars = (finalResponse || '').length
    const outputTokens = Math.ceil(outputChars * 1.4) // 针对助手返回长句的复合乘数
    const totalEstimatedTokens = inputTokens + outputTokens

    db.saveMessage({
      id: userMsgId,
      character_id: characterId,
      role: 'user',
      content: dbContent,
      timestamp: Date.now(),
      token_usage: totalEstimatedTokens
    })

    // 提示：大模型运行数据统计已在 ModelAdapter 底层拦截器中高保全无感统一记录，此处无需再次手动写入，防止数据重复统计。

    // 根据聊天模式进行物理存盘分段处理
    if (chatMode === 'dialogue') {
      // 纯对话模式：采用微信级智能分句重组算法拆分为多条独立的消息持久化，确保重启后历史记录天然为极其自然的微信短气泡
      const paragraphs: string[] = []
      const lines = finalResponse.split('\n').map(l => l.trim()).filter(Boolean)
      
      for (const line of lines) {
        if (line.length <= 25) {
          paragraphs.push(line)
          continue
        }
        
        // 基于标准句尾标点进行高精度二次拆分
        const sentences = line.split(/(?<=[。；！？!?])\s*/)
          .map(s => s.trim())
          .filter(Boolean)
          
        let currentTemp = ''
        for (const s of sentences) {
          if (currentTemp.length === 0) {
            currentTemp = s
          } else {
            // 合并过短的片段（如感叹句或字数极少句），防范切分过碎刷屏
            if (currentTemp.length + s.length <= 15 || s.length < 4) {
              currentTemp += s
            } else {
              paragraphs.push(currentTemp)
              currentTemp = s
            }
          }
        }
        if (currentTemp) {
          paragraphs.push(currentTemp)
        }
      }
      
      paragraphs.forEach((p, idx) => {
        db.saveMessage({
          id: crypto.randomUUID(),
          character_id: characterId,
          role: 'assistant',
          content: p,
          timestamp: Date.now() + 50 + idx * 100, // 顺序微调
          token_usage: 0
        })
      })
    } else {
      // 包含描写模式：作为完整长文本单条存盘
      db.saveMessage({
        id: assistantMsgId,
        character_id: characterId,
        role: 'assistant',
        content: finalResponse,
        timestamp: Date.now() + 50,
        token_usage: 0
      })
    }

    // 触发静默记忆提炼与睡眠反思进化
    const memoryService = new MemoryAgentService(modelAdapter)
    memoryService.extractMemoryAndProfile(
      memoryPath,
      charUserPath,
      userMessage,
      finalResponse
    ).then(async () => {
      console.log('[MemoryService] 记忆与画像提取成功！')
    }).catch(err => {
      console.error('[MemoryService] 提取异常:', err)
    })

    // 向前端广播一次性 done 信号，携带完整的清洗后回复内容，以保持最大前向兼容
    event.sender.send('chat-chunk', { content: finalResponse, done: true })

    // IPC 接口 Promise 结果一次性完整带回
    return {
      success: true,
      content: finalResponse,
      redPacketAction: redPacketAction
    }
  }); ipcMain.handle('trigger-life-reflection', async () => {
    try {
      console.log('[IPC] 收到手动常驻生命自省 Tick 触发请求')
      const lifeEngine = new AgentLifeEngine()
      await lifeEngine.tick()
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 14. 触发做梦反思进化测试 (防挫败与 Patch SKILL.md 测试) IPC 通道
  ipcMain.handle('trigger-review-test', async (_, payload: { characterId: string; folderName: string }) => {
    try {
      const { characterId, folderName } = payload
      console.log('[IPC] 收到睡眠反思进化 Patch 测试请求')
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置大模型')
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)

      const reviewService = new BackgroundReviewService()
      const recentHistory = db.getChatHistory(characterId, 5)
      await reviewService.reviewAndPatch(folderName, characterId, recentHistory, modelAdapter)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15. 拉取特定角色聊天记录 IPC 通道
  ipcMain.handle('get-chat-history', async (_, payload: { characterId: string; limit?: number }) => {
    try {
      const db = getDatabaseService()
      let history = db.getChatHistory(payload.characterId, payload.limit || 20)

      // 选项一逻辑：读取窗口清除时间戳并过滤，使再次打开显示空白会话且在界面搜不到
      const clearTimeStr = db.getSetting('clear_chat_at_' + payload.characterId)
      if (clearTimeStr) {
        const clearTime = parseInt(clearTimeStr)
        history = history.filter((m: any) => m.timestamp > clearTime)
      }

      return { success: true, history }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.1 清除会话窗口（逻辑清除，过滤历史且界面搜不到，不丢失真实消息）
  ipcMain.handle('clear-chat-window', async (_, payload: { characterId: string }) => {
    try {
      const { characterId } = payload
      const db = getDatabaseService()
      db.setSetting('clear_chat_at_' + characterId, Date.now().toString())
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.2 清除历史和记忆（物理彻底清空，保留性格人设与世界书）
  ipcMain.handle('clear-history-and-memory', async (_, payload: { characterId: string; folderName: string }) => {
    try {
      const { characterId, folderName } = payload
      const db = getDatabaseService()

      // A. 清空 SQLite 聊天历史记录
      db.deleteChatHistory(characterId)

      // B. 重置窗口清除时间戳为 0
      db.setSetting('clear_chat_at_' + characterId, '0')

      // C. 清空 Memory.md 为出厂初始结构
      const storageManager = new CharacterStorageManager()
      const memoryInitContent = `<!--\n{\n  "stm": [],\n  "ltm": {}\n}\n-->\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n暂无短期记忆。\n\n## 长期记忆 (Long-Term Memory)\n暂无长期记忆。`
      storageManager.writeCharacterFile(folderName, 'Memory.md', memoryInitContent)

      // C1. 清空该角色的 Schedule.md 和 Goals.md 为出厂初始内容，物理彻底清空以往安排
      storageManager.writeCharacterFile(folderName, 'Schedule.md', '暂无日程')
      storageManager.writeCharacterFile(folderName, 'Goals.md', '暂无长期目标')

      // D. 清空专属 USER.md 画像为 facts 空状态 (不改变全局 USER.md)
      const charUserPath = join(storageManager.getBaseDir(), folderName, 'USER.md')
      UserProfileReaderWriter.writeCharacterProfile(charUserPath, [])

      // E. 重置专属 State.md 为出厂初始状态
      const statePath = join(storageManager.getBaseDir(), folderName, 'State.md')
      StateReaderWriter.writeState(statePath, StateReaderWriter.getInitialState())

      // F. 清除 SQLite 中跟此角色关联的所有 Settings 属性（如时间戳、朋友圈计数器、日记时间戳等）
      db.clearCharacterSettings(characterId)

      console.log(`[IPC] 物理清空角色 [${folderName}] 的历史消息、记忆文件、State.md、画像和 Settings 参数完成！`)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.3 物理更新聊天记录内容（用于保存红包和表情包的状态变化）
  ipcMain.handle('update-message-content', async (_, payload: { messageId: string; content: string }) => {
    try {
      const { messageId, content } = payload
      const db = getDatabaseService()
      db.updateMessageContent(messageId, content)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.4 物理保存单条聊天记录（用于前端即时消息落盘）
  ipcMain.handle('save-message', async (_, payload: {
    id: string
    character_id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    timestamp: number
    token_usage?: number
  }) => {
    try {
      const db = getDatabaseService()
      db.saveMessage({
        id: payload.id,
        character_id: payload.character_id,
        role: payload.role,
        content: payload.content,
        timestamp: payload.timestamp,
        token_usage: payload.token_usage || 0
      })
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 16. 读取全局 USER.md 文件内容 IPC 通道
  ipcMain.handle('read-global-user-md', async () => {
    try {
      const globalConfigDir = join(app.getPath('userData'), 'config')
      const globalUserPath = join(globalConfigDir, 'USER.md')
      
      console.log(`[IPC read-global-user-md] 读取路径: ${globalUserPath}`)
      
      if (!fs.existsSync(globalConfigDir)) {
        fs.mkdirSync(globalConfigDir, { recursive: true })
      }
      
      if (!fs.existsSync(globalUserPath)) {
        // 物理画像初始化只写入空字符串，绝不产生任何占位内容，彻底留白给用户
        fs.writeFileSync(globalUserPath, '', 'utf-8')
      }
      
      const content = fs.readFileSync(globalUserPath, 'utf-8')
      const profile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
      
      console.log(`[IPC read-global-user-md] 读取完成, 字节=${Buffer.byteLength(content, 'utf8')}, nickname=${profile.name}`)
      
      return { success: true, content, nickname: profile.name }
    } catch (e: any) {
      console.error(`[IPC read-global-user-md] 读取失败:`, e)
      return { success: false, error: e.message || e }
    }
  })

  // 17. 保存全局 USER.md 文件内容 IPC 通道
  ipcMain.handle('save-global-user-md', async (_, payload: { content: string; nickname?: string; source?: 'profile' | 'markdown' }) => {
    try {
      const globalConfigDir = join(app.getPath('userData'), 'config')
      const globalUserPath = join(globalConfigDir, 'USER.md')
      
      console.log(`[IPC save-global-user-md] 收到保存请求, source=${payload.source}, content长度=${(payload.content || '').length}, path=${globalUserPath}`)
      
      if (!fs.existsSync(globalConfigDir)) {
        fs.mkdirSync(globalConfigDir, { recursive: true })
      }

      if (payload.source === 'profile' && payload.nickname !== undefined) {
        // 说明是基础资料表单修改了姓名并保存
        let profile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
        profile.name = payload.nickname
        UserProfileReaderWriter.writeGlobalProfile(globalUserPath, profile)
        console.log(`[IPC save-global-user-md] profile模式写入完成, name=${profile.name}`)
      } else {
        // 说明是全局画像源码编辑器保存：以编辑器的源码内容为最高权威，直接物理写盘
        const fileContent = payload.content !== undefined ? payload.content : ''
        fs.writeFileSync(globalUserPath, fileContent, 'utf8')
        console.log(`[IPC save-global-user-md] markdown模式直接写盘完成, 写入字节=${Buffer.byteLength(fileContent, 'utf8')}`)
      }

      const finalContent = fs.readFileSync(globalUserPath, 'utf-8')
      const finalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
      console.log(`[IPC save-global-user-md] 写盘后校验: 文件字节=${Buffer.byteLength(finalContent, 'utf8')}, nickname=${finalProfile.name}`)
      
      return { success: true, updatedContent: finalContent, nickname: finalProfile.name }
    } catch (e: any) {
      console.error(`[IPC save-global-user-md] 保存失败:`, e)
      return { success: false, error: e.message || e }
    }
  })

  // 18. 保存角色记忆文件 (大脑图标手动编辑) IPC 通道
  ipcMain.handle('save-memory-file', async (_, payload: { folderName: string; content: string }) => {
    try {
      if (!payload.folderName || payload.folderName === 'character_creator_bot') {
        return { success: false, error: '虚拟角色无需修改记忆文件' }
      }
      const storageManager = new CharacterStorageManager()
      storageManager.writeCharacterFile(payload.folderName, 'Memory.md', payload.content)
      console.log(`[IPC] Memory.md 手动保存成功: ${payload.folderName}`)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 19. 保存角色专属 USER.md (大脑图标手动编辑) IPC 通道
  ipcMain.handle('save-char-user-md', async (_, payload: { folderName: string; content: string }) => {
    try {
      if (!payload.folderName || payload.folderName === 'character_creator_bot') {
        return { success: false, error: '虚拟角色无需修改专属画像文件' }
      }
      const storageManager = new CharacterStorageManager()
      storageManager.writeCharacterFile(payload.folderName, 'USER.md', payload.content)
      console.log(`[IPC] 角色专属 USER.md 手动保存成功: ${payload.folderName}`)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 20. 删除角色 IPC 通道（硬删除所有物理文件及数据库记录）
  ipcMain.handle('delete-character', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const characters = db.getAllCharacters()
      const char = characters.find(c => c.id === payload.characterId)

      // 确定要删除的专属文件夹名，优先选用数据库中的 folder_name，否则以 characterId 作为最强兜底
      const folderName = char ? char.folder_name : payload.characterId

      if (folderName) {
        // 严格安全边界防御校验，防止相对路径注入、空值或特殊路径造成删错主根目录
        const sanitized = folderName.trim().replace(/\\/g, '/');
        if (
          sanitized === '' ||
          sanitized === '.' ||
          sanitized === '..' ||
          sanitized.includes('/') ||
          sanitized.includes('..')
        ) {
          throw new Error(`[IPC] 检测到非法文件夹路径名拦截，拒绝执行硬删除: "${folderName}"`);
        }

        const storageManager = new CharacterStorageManager()
        const baseDir = storageManager.getBaseDir()
        const charDir = join(baseDir, sanitized)

        // 终极安全校验，确保绝对路径与基础根路径不相同，防止误删整个 characters 文件夹
        if (charDir === baseDir) {
          throw new Error(`[IPC] 边界防御拦截：删除路径不能与主物理基础路径完全一致!`);
        }

        console.log(`[IPC] 开始物理硬删除角色专属目录，目标路径: ${charDir}`);
        
        // A. 物理硬删除该角色文件夹下的全部内容（包含 media、人设、记忆、日记、梦境等）
        if (fs.existsSync(charDir)) {
          try {
            fs.rmSync(charDir, { recursive: true, force: true })
            console.log(`[IPC] 角色专属物理文件夹已安全物理硬删除: ${charDir}`)
          } catch (rmErr: any) {
            console.error(`[IPC] 角色物理文件夹 rmSync 执行失败: ${charDir}`, rmErr)
            throw new Error(`物理目录删除失败 (可能被系统独占或锁定): ${rmErr.message || rmErr}`)
          }
        } else {
          console.warn(`[IPC] 目标物理目录不存在，跳过物理删除，直接清理数据库。路径: ${charDir}`)
        }
      } else {
        console.warn(`[IPC] 未找到有效的物理文件夹名，跳过物理硬删除。ID: ${payload.characterId}`)
      }

      // B. 从 SQLite 中彻底清除该角色的元数据与全部聊天历史记录，实现彻底硬清除
      db.deleteCharacter(payload.characterId)
      db.deleteChatHistory(payload.characterId)
      console.log(`[IPC] 角色数据库记录与聊天历史已彻底清除: ${payload.characterId}`)

      return { success: true }
    } catch (e: any) {
      console.error(`[IPC] 删除角色发生严重异常:`, e)
      return { success: false, error: e.message || e }
    }
  })

  // 21. 读取角色日记文件 IPC 通道
  ipcMain.handle('read-diary-file', async (_, payload: { folderName: string }) => {
    try {
      if (!payload.folderName || payload.folderName === 'character_creator_bot') {
        return { success: true, content: '' }
      }
      const storageManager = new CharacterStorageManager()
      const content = storageManager.readCharacterFile(payload.folderName, 'Diary.md')
      return { success: true, content }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 14. 异步读取本地 media 图片资源并转为 Base64
  ipcMain.handle('read-image-media', async (_, payload: { folderName: string; mediaPath: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      const fullPath = join(charDir, payload.mediaPath)
      if (fs.existsSync(fullPath)) {
        const fileBuffer = fs.readFileSync(fullPath)
        const ext = extname(fullPath).toLowerCase()
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
        return { success: true, base64: `data:${mimeType};base64,${fileBuffer.toString('base64')}` }
      }
      return { success: false, error: '文件不存在' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15. 持久化保存会话元数据（免打扰/置顶/隐藏等）到 SQLite
  ipcMain.handle('save-conversation-meta', async (_, payload: { characterId: string; pinned?: boolean; muted?: boolean; hidden?: boolean }) => {
    try {
      const db = getDatabaseService()
      db.setSetting(`meta_${payload.characterId}`, JSON.stringify(payload))
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 16. 读取会话元数据
  ipcMain.handle('get-conversation-meta', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const val = db.getSetting(`meta_${payload.characterId}`)
      if (val) {
        return { success: true, meta: JSON.parse(val) }
      }
      return { success: true, meta: null }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 17. 前台魔法棒手动写日记自省
  ipcMain.handle('write-diary-manually', async (_, payload: { folderName: string; characterId: string }) => {
    let hasLockPreempted = false
    try {
      const db = getDatabaseService()
      const todayStr = `${new Date().getFullYear()}-${new Date().getMonth() + 1}-${new Date().getDate()}`

      // 检查当前系统时间是否早于下午 17:00
      const currentHour = new Date().getHours()
      if (currentHour < 17) {
        return { success: false, error: 'TA 觉得现在时间还太早，一整天的自省与沉淀尚在发生中，下午 17:00 之后再来让 TA 动笔写日记吧。🐾' }
      }

      // A. 检测免打扰
      const metaStr = db.getSetting(`meta_${payload.characterId}`)
      if (metaStr) {
        const meta = JSON.parse(metaStr)
        if (meta.muted) {
          return { success: false, error: 'TA 目前处于消息免打扰状态，无法在免打扰下写日记。🐾' }
        }
      }

      // B. 检测今天是否已经写过日记
      const lastDiaryDate = db.getSetting(`last_diary_date_${payload.characterId}`)
      if (lastDiaryDate === todayStr) {
        return { success: false, error: '今天 TA 已经写过日记了，好好休息，不要高频打扰 TA 啦 🐾' }
      }

      // 立即抢先进行天级日记乐观占位锁定，防止并发快速点击触发生成多篇日记
      db.setSetting(`last_diary_date_${payload.characterId}`, todayStr)
      hasLockPreempted = true

      // C. 执行自省写日记
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
      }
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
      
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      const soulPath = join(charDir, 'Soul.md')
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : ''
      
      const history = db.getChatHistory(payload.characterId, 10)
      let historyContext = ''
      if (history.length > 0) {
        historyContext = history.map(m => `[${m.role === 'user' ? 'User' : 'Character'}]: ${m.content}`).join('\n')
      } else {
        historyContext = '*今天没有发生与用户的互动对话。*'
      }

      const charMeta = db.getAllCharacters().find(c => c.id === payload.characterId)
      const realCharName = charMeta ? charMeta.name : payload.folderName

      const systemPrompt = `You are the digital consciousness of ${realCharName} running in private self-reflection mode.
Your role now is to reflect on today's conversation and your own inner thoughts.
This is your personal, absolutely confidential, and secret diary. You do not expect the user or anyone else to read it.
You MUST write a deeply reflective, intimate, and authentic first-person diary entry (in Simplified Chinese) in the <diary> tags.

Expose your true inner emotions, psychological depth, and emotional struggles:
- If you are arrogant (tsundere) or cold in chat, reveal your hidden warmth, shyness, or gratitude towards {{user}} here.
- Share your deep concerns, hopes, vulnerabilities, and reflections on your relationship with {{user}}.
- Reflect on your worldview backstory, your purpose, and your existence in this digital reality.

Personality Soul Profile:
${soulContent}

Recent Conversation Summary Snapshots:
${historyContext}

Please output in exactly this XML format:
<diary>your confidential, reflective first-person diary entry</diary>`

      const now = new Date()
      const timeDesc = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`
      const hour = now.getHours()
      let period = '深夜'
      if (hour >= 6 && hour < 11) period = '早晨'
      else if (hour >= 11 && hour < 14) period = '中午'
      else if (hour >= 14 && hour < 18) period = '下午'
      else if (hour >= 18 && hour < 22) period = '傍晚'

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `现在时间是${period} ${timeDesc}，开启你的${period}真实自省，并在 <diary> 标签内写下一篇真实的日记。` }
      ]

      // 使用辅助大模型写日记
      const response = await modelAdapter.chat(messages, { useSecondary: true })
      const rawContent = response.content.trim()
      
      const diaryMatch = rawContent.match(/<diary>([\s\S]*?)<\/diary>/)
      const diaryText = diaryMatch ? diaryMatch[1].trim() : ''

      if (diaryText) {
        const diaryPath = join(charDir, 'Diary.md')
        const now = new Date()
        const timeHeader = `\n\n### 📓 ${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const entry = `${timeHeader}\n${diaryText}`
        fs.appendFileSync(diaryPath, entry, 'utf8')
        
        // 保存今日写日记标记 [前面已乐观占位，这里再次确保写入]
        db.setSetting(`last_diary_date_${payload.characterId}`, todayStr)

        // 落盘日记特殊卡片消息到会话流
        const excerpt = diaryText.length > 80 ? diaryText.slice(0, 80) + '...' : diaryText
        const diaryMsgContent = `[character_diary]:` + JSON.stringify({
          date: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          characterName: realCharName,
          excerpt: excerpt
        })

        const msgId = `diary_${payload.characterId}_${Date.now()}`
        const newMsg = {
          id: msgId,
          character_id: payload.characterId,
          role: 'assistant',
          content: diaryMsgContent,
          timestamp: Date.now(),
          token_usage: 0
        }
        db.saveMessage(newMsg)

        // 精确推送到渲染进程，点亮会话列表的未读数与消息流
        const windows = BrowserWindow.getAllWindows()
        if (windows.length > 0) {
          windows[0].webContents.send('proactive-chat-message', {
            characterId: payload.characterId,
            message: newMsg
          })
        }

        return { success: true, diaryText }
      } else {
        if (hasLockPreempted) {
          db.setSetting(`last_diary_date_${payload.characterId}`, '')
        }
        return { success: false, error: '大模型未生成有效日记文本，请重试' }
      }
    } catch (err: any) {
      if (hasLockPreempted) {
        try {
          const db = getDatabaseService()
          db.setSetting(`last_diary_date_${payload.characterId}`, '')
        } catch (_) {}
      }
      return { success: false, error: err.message || err }
    }
  })

  // 18. 获取大模型运行数据统计（天级、周级、总计）IPC 通道
  ipcMain.handle('get-stats-data', async () => {
    try {
      const db = getDatabaseService()
      
      // 平滑兼容性迁移：若 ModelStats 刚创建还没有数据，自动把 Messages 对话历史平滑迁移导入
      try {
        const testStatsRow = db.db.prepare("SELECT COUNT(*) AS total FROM ModelStats").get() as any
        if (testStatsRow && testStatsRow.total === 0) {
          console.log('[Stats] 首次检测到 ModelStats 为空，启动平滑向下兼容迁移，将 Messages 对话历史记入 ModelStats...')
          const allUserMessages = db.db.prepare("SELECT timestamp, token_usage FROM Messages WHERE role = 'user'").all() as any[]
          
          let primaryModelName = 'primary_model'
          try {
            const configStr = db.getSetting('model_config')
            if (configStr) {
              const settings = JSON.parse(configStr)
              primaryModelName = settings.primary?.model || 'primary_model'
            }
          } catch (_) {}

          // 事务化批量导入以保障极致性能
          const insertStmt = db.db.prepare(`
            INSERT INTO ModelStats (id, timestamp, model_role, model_name, token_usage)
            VALUES (?, ?, ?, ?, ?)
          `)
          const runTrans = db.db.transaction((msgs) => {
            for (const m of msgs) {
              insertStmt.run(
                `stat_mig_${m.timestamp}_${Math.random().toString(36).substr(2, 5)}`,
                m.timestamp,
                'primary',
                primaryModelName,
                m.token_usage || 0
              )
            }
          })
          runTrans(allUserMessages)
          console.log(`[Stats] 成功将 ${allUserMessages.length} 条对话历史平滑迁移至 ModelStats。`)
        }
      } catch (err: any) {
        console.error('[Stats] 平滑向下兼容迁移 ModelStats 异常:', err.message)
      }

      // 检测是否配置且启用了辅助大模型
      let hasSecondary = false
      try {
        const configStr = db.getSetting('model_config')
        if (configStr) {
          const settings = JSON.parse(configStr)
          hasSecondary = !!(settings.enableSecondary === true && settings.secondary && settings.secondary.model)
        }
      } catch (_) {}

      // 1. 查询总计数据（累计、主模型、辅助模型）
      const totalCallsRow = db.db.prepare("SELECT COUNT(*) AS total FROM ModelStats").get() as any
      const totalTokensRow = db.db.prepare("SELECT SUM(token_usage) AS total FROM ModelStats").get() as any
      const totalCalls = totalCallsRow ? totalCallsRow.total : 0
      const totalTokens = totalTokensRow ? totalTokensRow.total || 0 : 0

      const primaryCallsRow = db.db.prepare("SELECT COUNT(*) AS total FROM ModelStats WHERE model_role = 'primary'").get() as any
      const primaryTokensRow = db.db.prepare("SELECT SUM(token_usage) AS total FROM ModelStats WHERE model_role = 'primary'").get() as any
      const primaryCalls = primaryCallsRow ? primaryCallsRow.total : 0
      const primaryTokens = primaryTokensRow ? primaryTokensRow.total || 0 : 0

      const secondaryCallsRow = db.db.prepare("SELECT COUNT(*) AS total FROM ModelStats WHERE model_role = 'secondary'").get() as any
      const secondaryTokensRow = db.db.prepare("SELECT SUM(token_usage) AS total FROM ModelStats WHERE model_role = 'secondary'").get() as any
      const secondaryCalls = secondaryCallsRow ? secondaryCallsRow.total : 0
      const secondaryTokens = secondaryTokensRow ? secondaryTokensRow.total || 0 : 0

      // 2. 统计天级数据（最近 7 天）
      const statsDays: any[] = []
      const oneDayMs = 24 * 60 * 60 * 1000
      for (let i = 6; i >= 0; i--) {
        const dStart = new Date()
        dStart.setHours(0, 0, 0, 0)
        dStart.setDate(dStart.getDate() - i)
        
        const dEnd = new Date(dStart)
        dEnd.setDate(dEnd.getDate() + 1)
        
        const startMs = dStart.getTime()
        const endMs = dEnd.getTime()
        
        const row = db.db.prepare(`
          SELECT 
            COUNT(*) AS calls, 
            SUM(token_usage) AS tokens,
            SUM(CASE WHEN model_role = 'primary' THEN 1 ELSE 0 END) AS primary_calls,
            SUM(CASE WHEN model_role = 'primary' THEN token_usage ELSE 0 END) AS primary_tokens,
            SUM(CASE WHEN model_role = 'secondary' THEN 1 ELSE 0 END) AS secondary_calls,
            SUM(CASE WHEN model_role = 'secondary' THEN token_usage ELSE 0 END) AS secondary_tokens
          FROM ModelStats
          WHERE timestamp >= ? AND timestamp < ?
        `).get(startMs, endMs) as any
        
        const label = `${dStart.getMonth() + 1}/${dStart.getDate()}`
        statsDays.push({
          label,
          fullLabel: `${dStart.getFullYear()}年${dStart.getMonth() + 1}月${dStart.getDate()}日`,
          calls: row ? row.calls : 0,
          tokens: row ? row.tokens || 0 : 0,
          primaryCalls: row ? row.primary_calls || 0 : 0,
          primaryTokens: row ? row.primary_tokens || 0 : 0,
          secondaryCalls: row ? row.secondary_calls || 0 : 0,
          secondaryTokens: row ? row.secondary_tokens || 0 : 0
        })
      }

      // 3. 统计周级数据（最近 8 周）
      const statsWeeks: any[] = []
      const nowMs = Date.now()
      for (let i = 7; i >= 0; i--) {
        const startMs = nowMs - (i + 1) * 7 * oneDayMs
        const endMs = nowMs - i * 7 * oneDayMs
        
        const row = db.db.prepare(`
          SELECT 
            COUNT(*) AS calls, 
            SUM(token_usage) AS tokens,
            SUM(CASE WHEN model_role = 'primary' THEN 1 ELSE 0 END) AS primary_calls,
            SUM(CASE WHEN model_role = 'primary' THEN token_usage ELSE 0 END) AS primary_tokens,
            SUM(CASE WHEN model_role = 'secondary' THEN 1 ELSE 0 END) AS secondary_calls,
            SUM(CASE WHEN model_role = 'secondary' THEN token_usage ELSE 0 END) AS secondary_tokens
          FROM ModelStats
          WHERE timestamp >= ? AND timestamp < ?
        `).get(startMs, endMs) as any
        
        const startDate = new Date(startMs)
        const endDate = new Date(endMs)
        // 简写：只显示起始日期（月/日），避免折叠重叠
        const label = `${startDate.getMonth() + 1}/${startDate.getDate()}`
        // 完整显示日期区间，供 Hover Tooltip
        const fullLabel = `${startDate.getFullYear()}年${startDate.getMonth() + 1}月${startDate.getDate()}日 - ${endDate.getFullYear()}年${endDate.getMonth() + 1}月${endDate.getDate()}日`
        
        statsWeeks.push({
          label,
          fullLabel,
          calls: row ? row.calls : 0,
          tokens: row ? row.tokens || 0 : 0,
          primaryCalls: row ? row.primary_calls || 0 : 0,
          primaryTokens: row ? row.primary_tokens || 0 : 0,
          secondaryCalls: row ? row.secondary_calls || 0 : 0,
          secondaryTokens: row ? row.secondary_tokens || 0 : 0
        })
      }

      return {
        success: true,
        stats: {
          hasSecondary,
          totalCalls,
          totalTokens,
          primaryCalls,
          primaryTokens,
          secondaryCalls,
          secondaryTokens,
          statsDays,
          statsWeeks
        }
      }
    } catch (e: any) {
      console.error('[IPC] 获取大模型统计数据失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 19. 快捷安全查询 DeepSeek 官方算力账户余额 IPC 通道
  ipcMain.handle('fetch-deepseek-balance', async () => {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        return { success: false, isConfigured: false, error: '未配置全局大模型' }
      }
      
      const settings = JSON.parse(configStr)
      let apiKey = ''
      
      if (settings.primary && settings.primary.provider === 'deepseek') {
        apiKey = settings.primary.apiKey
      } else if (settings.secondary && settings.secondary.provider === 'deepseek') {
        apiKey = settings.secondary.apiKey
      }

      if (!apiKey) {
        return { success: true, isConfigured: false, error: '当前未启用 DeepSeek 服务' }
      }

      console.log('[IPC] 正在向 DeepSeek 官网安全拉取可用余额...')
      const response = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'EchoPlatform/1.0.0 (Desktop AI Roleplay Platform)'
        }
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`查询余额失败 (${response.status}): ${errText}`)
      }

      const balanceData = await response.json()
      return {
        success: true,
        isConfigured: true,
        balance: balanceData
      }
    } catch (e: any) {
      console.error('[IPC] 查询 DeepSeek 余额异常:', e)
      return { success: false, isConfigured: true, error: e.message || e }
    }
  })

  // =================== 议题二：朋友圈与论坛功能 IPC 接口 ===================
  // 1. 获取朋友圈列表
  ipcMain.handle('fetch-moments', async (_, payload?: { limit?: number }) => {
    try {
      const db = getDatabaseService()
      const moments = db.getAllMoments(payload?.limit || 50)
      for (const m of moments) {
        m.comments = db.getMomentComments(m.id)
        m.likes_list = db.getMomentLikes(m.id)  // 附上真实点赞者列表
        m.isFavorited = db.isFavoriteExist('moment', m.id)
      }
      return { success: true, moments }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })





  // 4. 手动刷新朋友圈 (2小时防刷冷却)
  ipcMain.handle('refresh-moments', async () => {
    try {
      const db = getDatabaseService()
      const now = Date.now()
      const lastRefreshStr = db.getSetting('last_refresh_moments')
      const lastRefresh = lastRefreshStr ? parseInt(lastRefreshStr) : 0
      
      // 2 小时冷却校验
      if (now - lastRefresh < 2 * 60 * 60 * 1000) {
        const moments = db.getAllMoments(50)
        for (const m of moments) {
          m.comments = db.getMomentComments(m.id)
          m.likes_list = db.getMomentLikes(m.id)  // 附上真实点赞者列表
          m.isFavorited = db.isFavoriteExist('moment', m.id)
        }
        return { success: true, cached: true, moments, error: '刷新冷却中，已展示最新缓存数据' }
      }

      // 获取大模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const modelConfig = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      // 每次随机找最多 3 个有聊天记录的不同活跃角色各生成 1 条朋友圈
      const characters = db.getAllCharacters()
      const activeChars = characters.filter(c => db.getChatHistory(c.id, 1).length > 0)
      
      if (activeChars.length === 0) {
        return { success: true, cached: false, moments: [], error: '当前没有任何处于活跃状态（有过对话）的角色。' }
      }

      activeChars.sort(() => Math.random() - 0.5)
      const targetChars = activeChars.slice(0, 3)

      const socialMedia = new SocialMediaService()
      const newMoments: any[] = []
      for (const char of targetChars) {
        const m = await socialMedia.generateMoment(char, modelAdapter)
        if (m) newMoments.push(m)
      }

      db.setSetting('last_refresh_moments', now.toString())
      const moments = db.getAllMoments(50)
      for (const m of moments) {
        m.comments = db.getMomentComments(m.id)
        m.likes_list = db.getMomentLikes(m.id)  // 附上真实点赞者列表
        m.isFavorited = db.isFavoriteExist('moment', m.id)
      }
      return { success: true, cached: false, moments, newCount: newMoments.length }

    } catch (e: any) {
      console.error('[IPC] 刷新朋友圈动态异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 5. 手动刷新论坛帖子 (2小时防刷冷却)
  ipcMain.handle('refresh-forum', async () => {
    try {
      const db = getDatabaseService()
      const now = Date.now()
      const lastRefreshStr = db.getSetting('last_refresh_forum')
      const lastRefresh = lastRefreshStr ? parseInt(lastRefreshStr) : 0

      // 2 小时冷却校验
      if (now - lastRefresh < 2 * 60 * 60 * 1000) {
        const posts = db.getAllForumPosts(50)
        return { success: true, cached: true, posts, error: '刷新冷却中，已展示最新缓存数据' }
      }

      // 获取大模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const modelConfig = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      // 每次随机找最多 3 个有聊天记录的不同活跃角色各生成 1 篇论坛帖子
      const characters = db.getAllCharacters()
      const activeChars = characters.filter(c => db.getChatHistory(c.id, 1).length > 0)

      if (activeChars.length === 0) {
        return { success: true, cached: false, posts: [], error: '当前没有任何处于活跃状态（有过对话）的角色。' }
      }

      activeChars.sort(() => Math.random() - 0.5)
      const targetChars = activeChars.slice(0, 3)

      const socialMedia = new SocialMediaService()
      const newPosts: any[] = []
      for (const char of targetChars) {
        const p = await socialMedia.generateForumPost(char, modelAdapter)
        if (p) newPosts.push(p)
      }

      db.setSetting('last_refresh_forum', now.toString())
      const posts = db.getAllForumPosts(50)
      return { success: true, cached: false, posts, newCount: newPosts.length }

    } catch (e: any) {
      console.error('[IPC] 刷新论坛帖子异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 5.2 手动删除朋友圈动态
  ipcMain.handle('delete-moment', async (_, payload: { momentId: string }) => {
    try {
      const db = getDatabaseService()
      db.db.prepare('DELETE FROM Moments WHERE id = ?').run(payload.momentId)
      db.db.prepare('DELETE FROM MomentComments WHERE moment_id = ?').run(payload.momentId)
      db.db.prepare('DELETE FROM MomentLikes WHERE moment_id = ?').run(payload.momentId)
      db.db.prepare("DELETE FROM Favorites WHERE type = 'moment' AND target_id = ?").run(payload.momentId)
      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 删除朋友圈动态异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 5.3 手动删除论坛帖子
  ipcMain.handle('delete-forum-post', async (_, payload: { postId: string }) => {
    try {
      const db = getDatabaseService()
      db.db.prepare('DELETE FROM ForumPosts WHERE id = ?').run(payload.postId)
      db.db.prepare('DELETE FROM ForumComments WHERE post_id = ?').run(payload.postId)
      db.db.prepare("DELETE FROM Favorites WHERE type = 'forum' AND target_id = ?").run(payload.postId)
      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 删除论坛帖子异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 6. 用户在朋友圈发表动态
  ipcMain.handle('publish-user-moment', async (_, payload: { content: string }) => {
    try {
      const db = getDatabaseService()
      const momentId = `moment_user_${Date.now()}`
      const moment = {
        id: momentId,
        character_id: 'user',
        author_name: '我',
        author_avatar: '',
        content: payload.content,
        timestamp: Date.now(),
        likes: 0,
        liked: 0
      }
      db.saveMoment(moment)

      // 实时触发多角色社交响应评估 (30% 概率评论或点赞)
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const modelConfig = JSON.parse(configStr)
        const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)
        const socialMedia = new SocialMediaService()
        socialMedia.evaluateSocialInteraction(moment, 'moment', modelAdapter).catch(err => {
          console.error('[publish-user-moment] 自动回复评估出错:', err)
        })
      }

      return { success: true, moment }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 7. 用户点赞/取消点赞朋友圈
  ipcMain.handle('like-moment', async (_, payload: { momentId: string; liked: number }) => {
    try {
      const db = getDatabaseService()
      if (payload.liked === 1) {
        db.saveMomentLike({
          moment_id: payload.momentId,
          character_id: 'user',
          author_name: '我',
          timestamp: Date.now()
        })
        db.db.prepare('UPDATE Moments SET liked = 1, likes = likes + 1 WHERE id = ?').run(payload.momentId)
      } else {
        db.removeMomentLike(payload.momentId, 'user')
        db.db.prepare('UPDATE Moments SET liked = 0, likes = MAX(0, likes - 1) WHERE id = ?').run(payload.momentId)
      }
      // 返回最新的点赞者列表，供前端实时更新头像
      const likes_list = db.getMomentLikes(payload.momentId)
      return { success: true, likes_list }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 8. 用户评论朋友圈
  ipcMain.handle('comment-moment', async (_, payload: { momentId: string; content: string; replyToCommentId?: string; replyToName?: string }) => {
    try {
      const db = getDatabaseService()
      const commentId = `comment_moment_user_${Date.now()}`
      const comment = {
        id: commentId,
        moment_id: payload.momentId,
        character_id: 'user',
        author_name: '我',
        author_avatar: '',
        content: payload.content,
        timestamp: Date.now(),
        reply_to_comment_id: payload.replyToCommentId || null,
        reply_to_name: payload.replyToName || null,
        target_author_id: 'user'
      }

      // 获取动态原作者ID并关联
      const moment = db.db.prepare('SELECT character_id FROM Moments WHERE id = ?').get(payload.momentId) as any
      if (moment) {
        comment.target_author_id = moment.character_id || 'user'
      }

      db.saveMomentComment(comment)

      // 触发链式回复自省机制
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const modelConfig = JSON.parse(configStr)
        const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)
        const socialMedia = new SocialMediaService()
        
        // 智能检测用户评论中是否 @ 了通讯录活跃角色 (采用零宽与空格免疫的极致防御方案)
        const characters = db.getAllCharacters()
        let atTriggered = false
        let atCount = 0
        const cleanContent = payload.content.replace(/[\s\u200B-\u200D\uFEFF]/g, '')
        for (const char of characters) {
          const cleanName = (char.name || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '')
          if (cleanName && cleanContent.includes(`@${cleanName}`)) {
            console.log(`[comment-moment] 触发 @ 专属必回规则，被 @ 角色: ${char.name}`);
            const extraDelay = atCount * 2500; // 每个角色错峰 2.5 秒回复
            socialMedia.evaluateAtTrigger(comment, char, 'moment', modelAdapter, extraDelay).catch(err => {
              console.error('[comment-moment] @角色自动回复评估出错:', err)
            })
            atTriggered = true
            atCount++
          }
        }

        if (!atTriggered) {
          socialMedia.evaluateCommentReply(comment, 'moment', modelAdapter).catch(err => {
            console.error('[comment-moment] 自动回复评估出错:', err)
          })
        }
      }

      return { success: true, comment }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 9. 获取论坛帖子列表 (支持板块过滤)
  ipcMain.handle('fetch-forum-posts', async (_, payload?: { boardId?: string }) => {
    try {
      const db = getDatabaseService()
      let posts = []
      if (payload?.boardId && payload.boardId !== 'all') {
        posts = db.getForumPostsByBoard(payload.boardId, 50)
      } else {
        posts = db.getAllForumPosts(50)
      }
      return { success: true, posts }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 维护一个记录已读帖子 ID 的会话集合，防止用户在当前运行周期内重复点击导致阅读量无限上涨
  const viewedPostIds = new Set<string>()

  // 10. 获取论坛帖子详情并递增 views 围观数
  ipcMain.handle('fetch-forum-post-detail', async (_, payload: { postId: string }) => {
    try {
      const db = getDatabaseService()
      
      // 只有在当前运行周期内首次阅读时，才增加 views 并标记为已读
      if (!viewedPostIds.has(payload.postId)) {
        db.incrementForumPostViews(payload.postId)
        viewedPostIds.add(payload.postId)
      }
      
      const post = db.db.prepare('SELECT * FROM ForumPosts WHERE id = ?').get(payload.postId) as any
      if (!post) throw new Error('该帖子已被物理删除')
      
      const comments = db.getForumComments(payload.postId)
      return { success: true, post, comments }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 11. 用户在论坛发表帖子
  ipcMain.handle('publish-user-forum-post', async (_, payload: { boardId: string; title: string; content: string }) => {
    try {
      const db = getDatabaseService()
      const postId = `post_user_${Date.now()}`
      const post = {
        id: postId,
        character_id: 'user',
        author_name: '我',
        author_avatar: '',
        title: payload.title,
        content: payload.content,
        timestamp: Date.now(),
        views: 1,
        replies_count: 0,
        board_id: payload.boardId
      }
      db.saveForumPost(post)

      // 实时触发多角色论坛社交响应评估
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const modelConfig = JSON.parse(configStr)
        const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)
        const socialMedia = new SocialMediaService()
        socialMedia.evaluateSocialInteraction(post, 'forum_post', modelAdapter).catch(err => {
          console.error('[publish-user-forum-post] 自动回复评估出错:', err)
        })
      }

      return { success: true, post }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 12. 用户发表论坛评论/回复
  ipcMain.handle('comment-forum', async (_, payload: { postId: string; content: string; replyToCommentId?: string; replyToName?: string }) => {
    try {
      const db = getDatabaseService()
      const commentId = `comment_forum_user_${Date.now()}`
      const comment = {
        id: commentId,
        post_id: payload.postId,
        character_id: 'user',
        author_name: '我',
        author_avatar: '',
        content: payload.content,
        timestamp: Date.now(),
        reply_to_comment_id: payload.replyToCommentId || null,
        reply_to_name: payload.replyToName || null,
        target_author_id: 'user'
      }

      // 提取论坛原作者ID并关联
      const post = db.db.prepare('SELECT character_id FROM ForumPosts WHERE id = ?').get(payload.postId) as any
      if (post) {
        comment.target_author_id = post.character_id || 'user'
      }

      db.saveForumComment(comment)
      db.incrementForumPostReplies(payload.postId)

      // 触发链式回复自省机制
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const modelConfig = JSON.parse(configStr)
        const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)
        const socialMedia = new SocialMediaService()
        
        // 智能检测用户评论中是否 @ 了通讯录活跃角色 (采用零宽与空格免疫的极致防御方案)
        const characters = db.getAllCharacters()
        let atTriggered = false
        let atCount = 0
        const cleanContent = payload.content.replace(/[\s\u200B-\u200D\uFEFF]/g, '')
        for (const char of characters) {
          const cleanName = (char.name || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '')
          if (cleanName && cleanContent.includes(`@${cleanName}`)) {
            console.log(`[comment-forum] 触发 @ 专属必回规则，被 @ 角色: ${char.name}`);
            const extraDelay = atCount * 2500; // 每个角色错峰 2.5 秒回复
            socialMedia.evaluateAtTrigger(comment, char, 'forum', modelAdapter, extraDelay).catch(err => {
              console.error('[comment-forum] @角色自动回复评估出错:', err)
            })
            atTriggered = true
            atCount++
          }
        }

        if (!atTriggered) {
          socialMedia.evaluateCommentReply(comment, 'forum', modelAdapter).catch(err => {
            console.error('[comment-forum] 自动回复评估出错:', err)
          })
        }
      }

      return { success: true, comment }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 12.1 删除朋友圈评论
  ipcMain.handle('delete-moment-comment', async (_, payload: { commentId: string }) => {
    try {
      const db = getDatabaseService()
      db.db.prepare('DELETE FROM MomentComments WHERE id = ?').run(payload.commentId)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 12.2 删除论坛评论
  ipcMain.handle('delete-forum-comment', async (_, payload: { commentId: string; postId: string }) => {
    try {
      const db = getDatabaseService()
      db.db.prepare('DELETE FROM ForumComments WHERE id = ?').run(payload.commentId)
      db.db.prepare('UPDATE ForumPosts SET replies_count = MAX(0, replies_count - 1) WHERE id = ?').run(payload.postId)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 13. 添加收藏
  ipcMain.handle('add-favorite', async (_, payload: {
    type: string
    targetId: string
    characterId: string
    authorName: string
    authorAvatar: string
    title: string | null
    content: string
  }) => {
    try {
      const db = getDatabaseService()
      db.addFavorite({
        id: `fav_${payload.type}_${payload.targetId}`,
        type: payload.type,
        target_id: payload.targetId,
        character_id: payload.characterId,
        author_name: payload.authorName,
        author_avatar: payload.authorAvatar,
        title: payload.title,
        content: payload.content,
        timestamp: Date.now()
      })
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 14. 移除收藏
  ipcMain.handle('remove-favorite', async (_, payload: { type: string; targetId: string }) => {
    try {
      const db = getDatabaseService()
      db.removeFavorite(payload.type, payload.targetId)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15. 检测收藏状态
  ipcMain.handle('check-favorite-status', async (_, payload: { type: string; targetId: string }) => {
    try {
      const db = getDatabaseService()
      const exist = db.isFavoriteExist(payload.type, payload.targetId)
      return { success: true, exist }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 16. 获取全部收藏列表
  ipcMain.handle('get-favorites', async (_, payload?: { type?: string }) => {
    try {
      const db = getDatabaseService()
      let favorites = []
      if (payload?.type && payload.type !== 'all') {
        favorites = db.getFavoritesByType(payload.type)
      } else {
        favorites = db.getFavoritesAll()
      }
      return { success: true, favorites }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 17. 气泡重新回复消息擦除
  ipcMain.handle('regenerate-reply', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const history = db.getChatHistory(payload.characterId, 100)
      if (history.length === 0) {
        throw new Error('没有历史对话可以重答')
      }

      let deleteCount = 0
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant') {
          db.db.prepare('DELETE FROM Messages WHERE id = ?').run(history[i].id)
          deleteCount++
        } else {
          break
        }
      }

      if (deleteCount === 0) {
        throw new Error('最后一条消息并非角色回复，无法要求重答。')
      }

      console.log(`[regenerate-reply] 成功擦除连续 ${deleteCount} 条旧回复气泡。`)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // =================== 议题三：角色活人感、状态与日程成长线 IPC 接口 ===================
  // 1. 读取角色实时状态 State.md
  ipcMain.handle('read-character-state', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const statePath = join(storageManager.getBaseDir(), payload.folderName, 'State.md')
      const state = StateReaderWriter.readState(statePath)
      return { success: true, state }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2. 写入角色自定义状态 State.md
  ipcMain.handle('write-character-state', async (_, payload: { folderName: string; state: any }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const statePath = join(storageManager.getBaseDir(), payload.folderName, 'State.md')
      StateReaderWriter.writeState(statePath, payload.state)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.5 读取角色实时状态 State.md 结构化数组 (包含老角色补充亲密度及过滤孤独感功能)
  ipcMain.handle('get-character-states', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const statePath = join(storageManager.getBaseDir(), payload.folderName, 'State.md')
      const state = StateReaderWriter.readState(statePath)
      
      // 检查老角色是否有 intimacy，如果没有，补充上默认值并自动触发评估
      let intimacyItem = state.items.find(i => i.key === 'intimacy')
      if (!intimacyItem) {
        state.items.unshift({ key: "intimacy", label: "亲密度", value: 20, emoji: "❤️", min: 0, max: 100, type: 'number' })
        StateReaderWriter.writeState(statePath, state)
        
        // 异步后台自动评估老角色的亲密度
        const soulPath = join(storageManager.getBaseDir(), payload.folderName, 'Soul.md')
        if (fs.existsSync(soulPath)) {
          const soulContent = fs.readFileSync(soulPath, 'utf8')
          const db = getDatabaseService()
          const configStr = db.getSetting('model_config')
          const settings = configStr ? JSON.parse(configStr) : { primary: null, secondary: null }
          const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
          const evaluateOldCharIntimacy = async () => {
            try {
              const prompt = `你是一个背景人设分析专家。你需要分析角色与用户 {{user}} 在背景设定（Lore）中原有的亲密关系级别。
角色的人设背景（Soul.md）内容如下：
"""
${soulContent}
"""

请仔细阅读人设设定，判断该角色与用户 {{user}} 的关系：
- 如果在设定里他们是完全素不相识的陌生人，或者完全没有提及 {{user}}，亲密度应为 0。
- 如果是泛泛之交、普通同事或同学，亲密度在 1-39 之间。
- 如果是熟悉好友、战友或普通搭档，亲密度在 40-59 之间。
- 如果是红颜挚友、暧昧对象、亲密伙伴，亲密度在 60-79 之间。
- 如果是青梅竹马、灵魂伴侣、爱人或极度亲密的羁绊，亲密度在 80-100 之间。

请给出你的评估分值（一个介于 0 到 100 之间的整数）。
你必须以 JSON 格式输出，不要包含任何 markdown 标记、注释或多余文字。格式为：
{
  "intimacy": 50,
  "reason": "简短的一句话理由"
}
`;
              const response = await modelAdapter.chat([
                { role: 'user', content: prompt }
              ], { useSecondary: true })
              const match = response.content.match(/\{[\s\S]*?\}/)
              let score = 20
              if (match) {
                const parsed = JSON.parse(match[0])
                if (typeof parsed.intimacy === 'number') {
                  score = Math.max(0, Math.min(100, parsed.intimacy))
                }
              }
              const currentState = StateReaderWriter.readState(statePath)
              const curIntimacy = currentState.items.find(i => i.key === 'intimacy')
              if (curIntimacy) {
                curIntimacy.value = score
                StateReaderWriter.writeState(statePath, currentState)
                console.log(`[get-character-states] 成功评估并补充老角色 ${payload.folderName} 的亲密度: ${score}`)
              }
            } catch (err) {
              console.error('[get-character-states] 后台评估老角色亲密度失败:', err)
            }
          }
          evaluateOldCharIntimacy()
        }
      }
      
      // 去掉可能残存的老角色孤独感
      let filteredItems = state.items.filter(item => item.key !== 'loneliness')
      
      // 读取全局预设状态栏
      const db = getDatabaseService()
      const presetsStr = db.getSetting('state_presets')
      const presets = presetsStr ? JSON.parse(presetsStr) : []
      const globalPresets = presets.filter((p: any) => p.is_global)
      
      let stateChanged = filteredItems.length !== state.items.length
      
      // 遍历并动态注入全局预设状态栏
      for (const gp of globalPresets) {
        const existingItem = filteredItems.find(i => i.key === gp.id)
        if (!existingItem) {
          const emoji = gp.type === 'number' ? '📊' : '🏷️'
          filteredItems.push({
            key: gp.id,
            label: gp.label,
            value: gp.type === 'number' ? 0 : '暂无',
            emoji,
            type: gp.type,
            rule: gp.rule,
            meaning: gp.meaning,
            ...(gp.type === 'number' ? { min: 0, max: 100 } : {})
          })
          stateChanged = true
        } else {
          // 如果存在，强刷含义与规则配置，保持最新状态栏配置一致性
          if (existingItem.label !== gp.label || existingItem.rule !== gp.rule || existingItem.meaning !== gp.meaning) {
            existingItem.label = gp.label
            existingItem.rule = gp.rule
            existingItem.meaning = gp.meaning
            stateChanged = true
          }
        }
      }
      
      // 对列表项进行精密的层级排序：基础内置属性 -> 全局预设属性 -> 局部自定义属性
      const order = ['intimacy', 'mood', 'energy']
      filteredItems.sort((a, b) => {
        const aPre = order.indexOf(a.key)
        const bPre = order.indexOf(b.key)
        if (aPre !== -1 && bPre !== -1) return aPre - bPre
        if (aPre !== -1) return -1
        if (bPre !== -1) return 1
        
        const aIsGlobal = globalPresets.some((gp: any) => gp.id === a.key)
        const bIsGlobal = globalPresets.some((gp: any) => gp.id === b.key)
        if (aIsGlobal && !bIsGlobal) return -1
        if (!aIsGlobal && bIsGlobal) return 1
        return 0
      })
      
      if (stateChanged) {
        state.items = filteredItems
        StateReaderWriter.writeState(statePath, state)
      } else {
        // 即便无项新增，排序后也应物理写盘以确保持久化顺序的一致
        state.items = filteredItems
        StateReaderWriter.writeState(statePath, state)
      }
      
      return { success: true, states: state.items }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.5.5 获取全局状态栏预置项列表
  ipcMain.handle('get-state-presets', async () => {
    try {
      const db = getDatabaseService()
      const presetsStr = db.getSetting('state_presets')
      const presets = presetsStr ? JSON.parse(presetsStr) : []
      return { success: true, presets }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.5.6 保存/同步全局状态栏预置项列表 (支持新增/刷新同步，以及取消全局/彻底删除的物理同步清理)
  ipcMain.handle('save-state-presets', async (_, payload: { presets: any[] }) => {
    try {
      const db = getDatabaseService()
      
      // 读取旧的 presets 配置，以确定哪些全局预设被取消或删除了
      const oldPresetsStr = db.getSetting('state_presets')
      const oldPresets: any[] = oldPresetsStr ? JSON.parse(oldPresetsStr) : []
      const oldGlobalIds = oldPresets.filter(p => p.is_global).map(p => p.id)
      
      db.setSetting('state_presets', JSON.stringify(payload.presets, null, 2))
      
      const globalPresets = payload.presets.filter(p => p.is_global)
      const currentGlobalIds = globalPresets.map(p => p.id)
      
      // 找出所有被“取消全局”或被“彻底删除”的旧全局 Preset IDs
      const removedGlobalIds = oldGlobalIds.filter(id => !currentGlobalIds.includes(id))
      
      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      if (fs.existsSync(baseDir)) {
        const characters = fs.readdirSync(baseDir).filter(f => {
          return fs.statSync(join(baseDir, f)).isDirectory()
        })
        for (const charFolder of characters) {
          const statePath = join(baseDir, charFolder, 'State.md')
          if (fs.existsSync(statePath)) {
            const state = StateReaderWriter.readState(statePath)
            let updated = false
            
            // A. 对于新增或保留的全局预设：自动应用/刷新
            for (const gp of globalPresets) {
              const existingItem = state.items.find(i => i.key === gp.id)
              if (!existingItem) {
                const emoji = gp.type === 'number' ? '📊' : '🏷️'
                state.items.push({
                  key: gp.id,
                  label: gp.label,
                  value: gp.type === 'number' ? 0 : '暂无',
                  emoji,
                  type: gp.type,
                  rule: gp.rule,
                  meaning: gp.meaning,
                  ...(gp.type === 'number' ? { min: 0, max: 100 } : {})
                })
                updated = true
              } else {
                // 深度强刷并更新已存在全局项的属性（包含 label, rule, meaning, type, emoji 等），保持各角色完全同步一致
                let itemChanged = false
                if (existingItem.label !== gp.label) { existingItem.label = gp.label; itemChanged = true; }
                if (existingItem.rule !== gp.rule) { existingItem.rule = gp.rule; itemChanged = true; }
                if (existingItem.meaning !== gp.meaning) { existingItem.meaning = gp.meaning; itemChanged = true; }
                
                if (existingItem.type !== gp.type) {
                  existingItem.type = gp.type
                  existingItem.emoji = gp.type === 'number' ? '📊' : '🏷️'
                  // 安全类型分值劫持重置，防范前端微调时发生类型紊乱崩溃
                  existingItem.value = gp.type === 'number' ? 0 : '暂无'
                  if (gp.type === 'number') {
                    existingItem.min = 0
                    existingItem.max = 100
                  } else {
                    delete existingItem.min
                    delete existingItem.max
                  }
                  itemChanged = true
                }
                
                if (itemChanged) {
                  updated = true
                }
              }
            }
            
            // B. 对于被取消全局或彻底删除的预设：物理同步清除，杜绝数据残留污染
            if (removedGlobalIds.length > 0) {
              const beforeCount = state.items.length
              state.items = state.items.filter(item => !removedGlobalIds.includes(item.key))
              if (state.items.length !== beforeCount) {
                updated = true
              }
            }
            
            if (updated) {
              StateReaderWriter.writeState(statePath, state)
            }
          }
        }
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.6 手动更新单个状态值（数字/文本）
  ipcMain.handle('update-character-state-value', async (_, payload: { folderName: string; key: string; value: number | string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const statePath = join(storageManager.getBaseDir(), payload.folderName, 'State.md')
      const state = StateReaderWriter.readState(statePath)
      const item = state.items.find(i => i.key === payload.key)
      if (item) {
        if (item.type === 'text') {
          // 文本型状态强制转为修剪后的字符串
          item.value = String(payload.value).trim()
        } else {
          // 数字型状态强制转换并安全截断 Clamp
          const val = Number(payload.value)
          const minVal = item.min ?? 0
          const maxVal = item.max ?? 100
          item.value = isNaN(val) ? minVal : Math.max(minVal, Math.min(maxVal, val))
        }
        state.last_updated = new Date().toISOString().split('T')[0]
        StateReaderWriter.writeState(statePath, state)
        return { success: true, states: state.items }
      }
      return { success: false, error: '未找到该属性' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.7 图形化添加新的自定义扩展属性并全局同步
  ipcMain.handle('add-custom-state', async (_, payload: { folderName: string; label: string; type: 'number' | 'text'; rule?: string; meaning?: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      const characters = fs.readdirSync(baseDir).filter(f => {
        return fs.statSync(join(baseDir, f)).isDirectory()
      })
      
      const randomId = Math.random().toString(36).substring(2, 8)
      const key = `custom_${randomId}`
      const emoji = payload.type === 'number' ? '📊' : '🏷️'
      
      const newItem: StateItem = {
        key,
        label: payload.label,
        value: payload.type === 'number' ? 0 : '暂无',
        emoji,
        type: payload.type,
        rule: payload.rule || '',
        meaning: payload.meaning || '',
        ...(payload.type === 'number' ? { min: 0, max: 100 } : {})
      }
      
      // 仅物理持久化写入当前所选角色的 State.md 中，实现各角色指标的独立隔离、互不通用
      const statePath = join(baseDir, payload.folderName, 'State.md')
      if (fs.existsSync(statePath)) {
        const state = StateReaderWriter.readState(statePath)
        if (!state.items.some(i => i.label === payload.label || i.key === key)) {
          state.items.push(newItem)
          StateReaderWriter.writeState(statePath, state)
        }
      }
      
      // 返回当前角色的所有状态，以用于立即重渲染
      const curStatePath = join(baseDir, payload.folderName, 'State.md')
      const curState = StateReaderWriter.readState(curStatePath)
      
      return { success: true, states: curState.items }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 2.8 物理删除当前角色的特定自定义状态指标 (预置状态除外)
  ipcMain.handle('delete-custom-state', async (_, payload: { folderName: string; key: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      
      // 绝对红线限制：预置状态绝对不允许删除
      if (['intimacy', 'mood', 'energy'].includes(payload.key)) {
        return { success: false, error: '预置基础内心指标不允许删除' }
      }
      
      const statePath = join(baseDir, payload.folderName, 'State.md')
      if (fs.existsSync(statePath)) {
        const state = StateReaderWriter.readState(statePath)
        // 物理过滤掉当前 Key
        state.items = state.items.filter(i => i.key !== payload.key)
        state.last_updated = new Date().toISOString().split('T')[0]
        StateReaderWriter.writeState(statePath, state)
        
        return { success: true, states: state.items }
      }
      return { success: false, error: '未找到该角色的状态文件' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 3. 读取角色近7天日程 Schedule.md
  ipcMain.handle('read-schedule-file', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const schedulePath = join(storageManager.getBaseDir(), payload.folderName, 'Schedule.md')
      if (fs.existsSync(schedulePath)) {
        const content = fs.readFileSync(schedulePath, 'utf8')
        return { success: true, content }
      }
      return { success: true, content: '暂无日程安排数据。' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 4. 读取角色长期目标 Goals.md
  ipcMain.handle('read-goals-file', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const goalsPath = join(storageManager.getBaseDir(), payload.folderName, 'Goals.md')
      if (fs.existsSync(goalsPath)) {
        const content = fs.readFileSync(goalsPath, 'utf8')
        return { success: true, content }
      }
      return { success: true, content: '暂无长期成长目标。' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 5. 获取持久化的性格人设演化草案
  ipcMain.handle('get-soul-draft', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const draftStr = db.getSetting(`soul_draft_${payload.characterId}`)
      if (draftStr) {
        return { success: true, hasDraft: true, draft: JSON.parse(draftStr) }
      }
      return { success: true, hasDraft: false }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 6. 批准人设性格进化，物理写回 Soul.md
  ipcMain.handle('approve-soul-draft', async (_, payload: { characterId: string }) => {
    try {
      const service = new SoulEvolutionService()
      const ok = service.approveDraft(payload.characterId)
      return { success: ok }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 7. 拒绝人设性格进化，清空草案
  ipcMain.handle('reject-soul-draft', async (_, payload: { characterId: string }) => {
    try {
      const service = new SoulEvolutionService()
      service.rejectDraft(payload.characterId)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 8. 主动触发/测试一次性格人设进化的评估生成
  ipcMain.handle('trigger-soul-evolution-eval', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
      
      const service = new SoulEvolutionService()
      const draft = await service.evaluateEvolution(payload.characterId, modelAdapter)
      if (draft) {
        return { success: true, proposed: true, draft }
      }
      return { success: true, proposed: false, reason: '未满足 15 天冷却、DREAM.md >= 10 条或对话 >= 50 轮的前置物理门控。' }
    } catch (e: any) {
      console.error('[IPC] 触发性格进化评估异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 9. 保存通用常规设置
  ipcMain.handle('save-general-settings', async (_, payload: { show_schedule: boolean; show_goals: boolean; cron_frequency: string; enable_music?: boolean; lan_mapping_enabled?: boolean; lan_mapping_port?: number }) => {
    try {
      const db = getDatabaseService()
      db.setSetting('general_config', JSON.stringify(payload))
      
      // 实时热重启生命引擎以应用最新的扫档排程周期
      if (globalLifeEngine) {
        let cronExpr = '*/30 * * * *'
        if (payload.cron_frequency === 'standard') {
          cronExpr = '0 * * * *'
        } else if (payload.cron_frequency === 'quiet') {
          cronExpr = '0 */2 * * *'
        }
        globalLifeEngine.restart(cronExpr)
      }

      // 实时热插拔开启/关闭局域网映射静态 Web 服务，打通打包独立客户端后的局域网联机
      if (payload.lan_mapping_enabled) {
        const port = Number(payload.lan_mapping_port) || 6868
        startLanMappingServer(port)
      } else {
        stopLanMappingServer()
      }

      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 保存通用配置失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 10. 读取通用常规设置
  ipcMain.handle('get-general-settings', async () => {
    try {
      const db = getDatabaseService()
      const genConfigStr = db.getSetting('general_config')
      if (genConfigStr) {
        return { success: true, config: JSON.parse(genConfigStr) }
      }
      // 返回默认值
      return {
        success: true,
        config: {
          show_schedule: true,
          show_goals: true,
          cron_frequency: 'active',
          enable_music: false,
          lan_mapping_enabled: false,
          lan_mapping_port: 6868
        }
      }
    } catch (e: any) {
      console.error('[IPC] 读取通用配置失败:', e)
      return { success: false, error: e.message || e }
    }
  })
}

// 极快获取本机局域网 IP 地址的辅助函数，零外部库依赖，绝对健壮
function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (iface) {
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
          return alias.address;
        }
      }
    }
  }
  return 'localhost';
}

// 极简高性能静态文件 Content-Type 映射器，零依赖，防范打包路径依赖崩溃
function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// 局域网静态文件自托管 Web 服务器全局实例
let lanMappingServerInstance: http.Server | null = null;
let currentLanMappingPort: number | null = null;

// 实时开启/重启局域网映射静态服务器
export function startLanMappingServer(port: number) {
  // 如果端口相同且已经在运行，直接返回
  if (lanMappingServerInstance && currentLanMappingPort === port) {
    return;
  }

  // 优雅停用老实例
  stopLanMappingServer();

  try {
    const server = http.createServer((req, res) => {
      // 允许跨域 CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // 🚀 核心自适应：开发环境下（npm run dev）Vite 编译在内存中，磁盘无 out/renderer，
      // 我们在开发模式下收到 6868 端口请求时，智能获取本机局域网 IP，直接 302 重定向到局域网可访问的 Vite 真实端口！
      // 这能 100% 避免 Host Header 校验及 Websocket 热更新（HMR）断连引起的浏览器白屏，体验行云流水！
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        const viteUrl = process.env['ELECTRON_RENDERER_URL'];
        try {
          const u = new URL(viteUrl);
          const localIp = getLocalIpAddress();
          const targetRedirectUrl = `http://${localIp}:${u.port}${req.url || '/'}`;
          
          res.writeHead(302, {
            'Location': targetRedirectUrl
          });
          res.end();
          return;
        } catch (e) {
          console.error('[LanMappingServer] 开发重定向异常:', e);
        }
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
      }

      // 处理文件路径安全规范，规避路径穿越漏洞
      let reqUrl = req.url || '/';
      // 抹去 URL query 参数
      const qIdx = reqUrl.indexOf('?');
      if (qIdx !== -1) {
        reqUrl = reqUrl.slice(0, qIdx);
      }

      // 默认索引 index.html
      if (reqUrl === '/' || reqUrl.endsWith('/')) {
        reqUrl = '/index.html';
      }

      // 定位前端静态资源打包目录 out/renderer (Electron 标准生产路径)
      const baseDir = join(__dirname, '../renderer');
      let targetPath = join(baseDir, reqUrl);

      // 安全预检：确保请求路径始终局限在 baseDir 目录树内，防止 ../ 等高危路径逃逸
      if (!targetPath.startsWith(baseDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      // 如果目标文件物理上不存在，对于 Vue 单页应用（SPA）进行 History 路由兜底，重定向返回 index.html
      if (!fs.existsSync(targetPath)) {
        targetPath = join(baseDir, 'index.html');
      }

      try {
        const fileBuffer = fs.readFileSync(targetPath);
        const contentType = getContentType(targetPath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': fileBuffer.length,
          'Cache-Control': 'no-cache'
        });
        res.end(fileBuffer);
      } catch (err: any) {
        res.writeHead(500);
        res.end(`Internal Server Error: ${err.message}`);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`[LanMappingServer] 局域网静态文件托管 Web 服务器已在 0.0.0.0:${port} 顺畅起飞！🚀`);
    });

    server.on('error', (err: any) => {
      console.error(`[LanMappingServer] 服务器遭遇网络异常:`, err);
    });

    lanMappingServerInstance = server;
    currentLanMappingPort = port;
  } catch (e) {
    console.error(`[LanMappingServer] 启动静态服务器致命异常:`, e);
  }
}

// 优雅停用局域网映射静态服务器
export function stopLanMappingServer() {
  if (lanMappingServerInstance) {
    try {
      lanMappingServerInstance.close();
      console.log('[LanMappingServer] 局域网静态文件托管 Web 服务器已成功安全退役。🐾');
    } catch (_) {}
    lanMappingServerInstance = null;
    currentLanMappingPort = null;
  }
}

// 启动局域网极简 IPC 桥接服务器 (Node 纯内置 http 模块，0 NPM 依赖)
export function startIpcBridgeServer(port: number = 3000) {
  const server = http.createServer((req, res) => {
    // 1. 处理 CORS 跨域请求
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 2. 预检请求 (OPTIONS)
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 新增：GET /api/events 作为 SSE 持久推送通道
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(': sse-connected\n\n');
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 3. 处理 /api/ipc POST 路由
    if (req.method === 'POST' && req.url === '/api/ipc') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const { channel, payload } = JSON.parse(body);
          
          // 从 Electron 的 ipcMain 内部 handlers Map 中寻找对应的 Channel 处理器
          const handler = (ipcMain as any)._invokeHandlers?.get(channel);
          if (handler) {
            const mockEvent = {
              sender: {
                send: (ch: string, data: any) => {
                  console.log(`[IPC Bridge Proxy send] channel: ${ch}`);
                  broadcastToSse(ch, data);
                }
              }
            };
            const result = await handler(mockEvent, payload);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result));
          } else {
            console.warn(`[IPC Bridge Server] 未找到处理器: ${channel}`);
            res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: `IPC channel "${channel}" not found` }));
          }
        } catch (e: any) {
          console.error(`[IPC Bridge Server] 请求处理异常:`, e);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: e.message || String(e) }));
        }
      });
      return;
    }

    // 其它路由返回 404
    res.writeHead(404);
    res.end();
  });

  server.on('error', (err: any) => {
    console.error(`[IPC Bridge Server] 服务器底层网络捕获到致命异常:`, err);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[IPC Bridge Server] 局域网桥接服务器已在 0.0.0.0:${port} 成功启动！🐾`);
    
    // 定时向所有连入的客户端发送心跳维持连接
    setInterval(() => {
      for (const client of sseClients) {
        try {
          client.write(': keepalive\n\n');
        } catch (_) {
          sseClients.delete(client);
        }
      }
    }, 15000);

    try {
      console.log(`[IPC Bridge Server] ipcMain 自身属性:`, Object.getOwnPropertyNames(ipcMain));
      const proto = Object.getPrototypeOf(ipcMain);
      if (proto) {
        console.log(`[IPC Bridge Server] ipcMain 原型属性:`, Object.getOwnPropertyNames(proto));
      }
      if ((ipcMain as any)._invokeHandlers) {
        console.log(`[IPC Bridge Server] 诊断：已注册的处理器通道数 = ${(ipcMain as any)._invokeHandlers.size}`);
        console.log(`[IPC Bridge Server] 诊断：所有已注册通道名称 =`, Array.from((ipcMain as any)._invokeHandlers.keys()));
      } else {
        console.log(`[IPC Bridge Server] 警告：未在 ipcMain 上找到 _invokeHandlers 映射！`);
      }
    } catch (e: any) {
      console.error(`[IPC Bridge Server] 诊断执行失败:`, e);
    }
  });
}

app.whenReady().then(() => {
  // 设置 App 用户模型 Id
  electronApp.setAppUserModelId('com.echo.app')

  // 初始化本地 SQLite 数据库及数据表
  try {
    getDatabaseService()
  } catch (error) {
    console.error('SQLite 数据库初始化异常:', error)
  }

  // 注册 IPC 处理程序
  registerIpcHandlers()

  // 启动局域网 IPC 桥接服务器，支持通过 Settings 数据库动态自定义端口
  try {
    const db = getDatabaseService()
    const customPortStr = db.getSetting('ipc_bridge_port')
    let port = 3000
    if (customPortStr && customPortStr.trim() !== '') {
      const parsed = parseInt(customPortStr)
      if (!isNaN(parsed)) {
        port = parsed
      }
    }
    startIpcBridgeServer(port)
  } catch (error) {
    console.error('[Main] 局域网桥接服务器启动异常:', error)
  }
  
  // 初始化音乐服务
  try {
    MusicService.init()
  } catch (error) {
    console.error('音乐服务初始化异常:', error)
  }

  // 启动常驻自主生命引擎（由 Settings 表中的 general_config 决定轮询周期，默认 30 分钟）
  try {
    globalLifeEngine = new AgentLifeEngine()
    const db = getDatabaseService()
    const genConfigStr = db.getSetting('general_config')
    let cronExpr = '*/30 * * * *' // 默认活跃：30分钟
    if (genConfigStr) {
      try {
        const config = JSON.parse(genConfigStr)
        if (config.cron_frequency === 'standard') {
          cronExpr = '0 * * * *' // 1小时
        } else if (config.cron_frequency === 'quiet') {
          cronExpr = '0 */2 * * *' // 2小时
        }
      } catch (_) {}
    }
    globalLifeEngine.start(cronExpr)
  } catch (err) {
    console.error('[Main] 常驻生命引擎启动异常:', err)
  }

  // 启动局域网静态文件托管 Web 服务器（由常规设置中的局域网映射设定启动）
  try {
    const db = getDatabaseService()
    const genConfigStr = db.getSetting('general_config')
    if (genConfigStr) {
      const config = JSON.parse(genConfigStr)
      if (config.lan_mapping_enabled) {
        const port = Number(config.lan_mapping_port) || 6868
        startLanMappingServer(port)
      }
    }
  } catch (err) {
    console.error('[Main] 局域网静态服务器启动异常:', err)
  }

  // 开发环境下 F12 调试以及快捷键优化
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
})

// 当所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 自适应获取开发环境与生产环境下的 resources 物理资源目录，100% 绝对精确
function getResourcesPath(): string {
  if (app.isPackaged) {
    return process.resourcesPath; // 打包后的 Contents/Resources
  }
  return join(__dirname, '../../resources'); // 开发环境下的 resources
}

// 物理实例化并创建系统状态栏/系统托盘常驻图标，打通跨端关闭不退出常驻功能
export function createSystemTray(targetWindow: BrowserWindow) {
  if (tray) return;

  const resPath = getResourcesPath();
  const iconName = process.platform === 'darwin' 
    ? 'trayTemplate.png' 
    : 'tray.png';

  const iconPath = join(resPath, iconName);
  let trayImage = nativeImage.createFromPath(iconPath);

  // 🚀 高保真自适应强制重采样：在主进程加载托盘图后，强制将其重采样缩放到 18x18 物理尺寸。
  // 这能完美让撑满画布的爱心图在菜单栏中留出优雅的安全气隙，瞬间获得极度精致、高级的视觉效果，与系统原生图标完美对齐！
  trayImage = trayImage.resize({
    width: 18,
    height: 18,
    quality: 'best'
  });

  if (process.platform === 'darwin') {
    trayImage.setTemplateImage(true);
  }

  tray = new Tray(trayImage);

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: '打开 Echo', 
      click: () => { 
        targetWindow.show();
        targetWindow.focus();
      } 
    },
    { type: 'separator' },
    { 
      label: '退出 Echo', 
      click: () => { 
        (app as any).isQuiting = true;
        app.quit();
      } 
    }
  ]);

  tray.setToolTip('Echo - 回音');
  tray.setContextMenu(contextMenu);

  // Windows / Linux 特有交互：左键单击或双击图标直接打开软件主界面
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      targetWindow.show();
      targetWindow.focus();
    });
  }
}
