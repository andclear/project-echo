import './utils/AppUserDataLock'
import { app, shell, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, screen } from 'electron'
import path, { join, extname, basename } from 'path'
import fs from 'fs'
import zlib from 'zlib'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { getDatabaseService, resetDatabaseService } from './db/database'
import { ModelAdapter, ModelConfig, ChatMessage } from './models/ModelAdapter'
import { CharacterCardParser } from './utils/CharacterCardParser'
import { CharacterSummarizer } from './utils/CharacterSummarizer'
import { CharacterStorageManager } from './utils/CharacterStorageManager'
import { CharacterSummaryService } from './utils/CharacterSummaryService'
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
import { MusicService, Mp3Id3Writer } from './services/MusicService'
import { NovelAiService } from './services/NovelAiService'
import { UpdateService } from './services/UpdateService'
import { WeChatService } from './services/WeChatService'
import { WeatherService } from './utils/WeatherService'



// 完美解决 macOS 系统代理或 VPN 拦截导致的 Chromium 网络服务崩溃及本地 Dev 调试加载问题，确保开发服务器端口彻底绕过系统代理自检，且网络进程防崩
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;<local>;127.0.0.1:5173;localhost:5173;127.0.0.1:5174;localhost:5174;127.0.0.1:5175;localhost:5175')
// 🚀 注意：在较新版本的 Electron 中，启用 NetworkServiceInProcess 极易导致 Chromium 网络服务崩溃并触发自动重启（报 network_service_instance_impl.cc 错误）。
// 故在现代版本中将其注释掉，使用默认的进程隔离网络服务以解决启动时的 Network service crashed 报错。
// app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess')
// app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

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

// 🚀 极致缓存前缀保温还原全局内存字典：以角色ID为键值，缓存最近一次大模型吐出的 100% 原始未清洗的 assistant 消息内容
export const LastAssistantRawResponse: Record<string, string> = {}

// SSE 消息环形缓冲区（最近 50 条），用于断线重连后的消息补偿
interface SseBufferedMsg {
  id: number;
  channel: string;
  data: any;
  raw: string;
}
const sseMessageBuffer: SseBufferedMsg[] = []
let sseMessageIdCounter = 0
const SSE_BUFFER_MAX = 50

// 🚀 记录当前 Electron 本机正在流式处理的单聊请求（characterId 集合）
// 用于消息广播时区分本机流式回复（已由 chat-chunk 渲染）和外设备推送的消息
const activeElectronChats = new Set<string>()

/**
 * 全局公共工具：物理剔除大模型思维链标签及其内容
 * 支持 <think>...</think>、<thinking>...</thinking>、<cot>...</cot>（大小写不敏感，支持多行）
 * 同时处理未闭合的半截开头标签（流式中断时）
 */
function stripThinkingTags(content: string): string {
  // 剔除完整的思维链标签及内容
  const fullTagsReg = /<(cot|think|thinking)>[\s\S]*?<\/\1>/gi
  // 剔除未闭合的思维链开头（流式截断情形）
  const halfOpenTagReg = /<(cot|think|thinking)>[\s\S]*$/gi
  return content
    .replace(fullTagsReg, '')
    .replace(halfOpenTagReg, '')
    .trim()
}

// SSE 广播函数
export function broadcastToSse(channel: string, data: any) {
  const id = ++sseMessageIdCounter
  const payload = JSON.stringify({ channel, data })
  const raw = `id: ${id}\ndata: ${payload}\n\n`

  // 存入环形缓冲区（淘汰最旧条目）
  sseMessageBuffer.push({ id, channel, data, raw })
  if (sseMessageBuffer.length > SSE_BUFFER_MAX) {
    sseMessageBuffer.shift()
  }

  for (const client of sseClients) {
    try {
      client.write(raw)
    } catch (e) {
      sseClients.delete(client)
    }
  }
}

// 级联反向流式拼合器：将数据库中连续的、时间相近的角色分段气泡，融合成单条高密度大消息
export function mergeChatHistory(history: any[]): any[] {
  if (!history || history.length === 0) return []

  const merged: any[] = []
  let currentMsg: any = null

  // 逆向排序为从旧到新进行合并
  const sorted = [...history].reverse()

  for (const msg of sorted) {
    if (!currentMsg) {
      currentMsg = { ...msg }
    } else if (
      currentMsg.role === msg.role &&
      msg.role === 'assistant' &&
      (msg.timestamp - currentMsg.timestamp < 15000) // 15秒内连续的多气泡，判定为同一条消息的分段
    ) {
      // 融合成单条消息并换行拼接
      currentMsg.content = currentMsg.content + '\n' + msg.content
      currentMsg.timestamp = msg.timestamp // 保持最新时间戳
      if (msg.token_usage) {
        currentMsg.token_usage = (currentMsg.token_usage || 0) + msg.token_usage
      }
    } else {
      merged.push(currentMsg)
      currentMsg = { ...msg }
    }
  }

  if (currentMsg) {
    merged.push(currentMsg)
  }

  // 反转回原汁原味的从新到旧的顺序
  return merged.reverse()
}

function createWindow(): void {
  // 🚀 窗口状态持久化：读取上次保存的窗口尺寸与位置，首次启动按屏幕逻辑分辨率自动计算舒适默认値
  const getWindowState = (): { width: number; height: number; x?: number; y?: number } => {
    try {
      const db = getDatabaseService()
      const saved = db.getSetting('window_bounds')
      if (saved) {
        const bounds = JSON.parse(saved)
        // 验证保存的位置在当前某块显示器上仍然有效（防止用户拔除外接昿示器导致窗口弹到屏幕外）
        const allDisplays = screen.getAllDisplays()
        const isOnScreen = allDisplays.some(d => {
          const wa = d.workArea
          return (
            bounds.x != null && bounds.y != null &&
            bounds.x >= wa.x - 50 && bounds.y >= wa.y - 50 &&
            bounds.x + bounds.width <= wa.x + wa.width + 50 &&
            bounds.y + bounds.height <= wa.y + wa.height + 50
          )
        })
        if (isOnScreen && bounds.width >= 800 && bounds.height >= 600) {
          return bounds
        }
      }
    } catch (_) {}

    // 首次启动：按主屏逻辑分辨率计算舒适默认值，带上上下限
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea
    return {
      width: Math.round(Math.max(1100, Math.min(1380, sw * 0.70))),
      height: Math.round(Math.max(750, Math.min(880, sh * 0.82)))
    }
  }

  const windowState = getWindowState()

  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 900,
    minHeight: 640,
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
    // 关闭前先保存当前窗口尺寸与位置，下次启动时恢复（含 Windows 自定义标题栏关闭按钮触发路径）
    try {
      const db = getDatabaseService()
      db.setSetting('window_bounds', JSON.stringify(mainWindow!.getBounds()))
    } catch (_) {}

    // 只有当用户没有点击托盘中的“退出”时，我们才拦截关闭并转为隐藏
    if (!(app as any).isQuiting) {
      event.preventDefault(); // 阻断物理关闭退出
      win.hide();       // 隐式退至后台运行
      
      // 🚀 核心修复：仅在用户主动点 “X” 关闭窗口将其隐式隐藏到后台时，才物理隐藏 Dock 图标！
      // 彻底解决全局监听 win.on('hide') 误杀窗口最小化、挂机挂后台系统 App Nap 导致的 Dock 图标和整个窗口莫名不见丢失的重大 macOS 交互 Bug！
      if (process.platform === 'darwin' && app.dock) {
        app.dock.hide();
      }
    }
  });

  // 监听窗口显示事件，在 macOS 上同步显示 Dock 图标并确保设置高清晰度应用图标，防范系统因 show/hide 导致的图标丢失 Bug
  win.on('show', () => {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.show()
      
      // 🚀 核心修复：强行重新设置一次 Dock 图标，解决 macOS 在隐藏后重新 show 导致的图标丢失或退化为默认原子图标的 Bug
      try {
        const iconPath = app.isPackaged
          ? join(process.resourcesPath, 'icon.png')
          : join(app.getAppPath(), 'icon.png');
        
        if (fs.existsSync(iconPath)) {
          const dockIcon = nativeImage.createFromPath(iconPath);
          app.dock.setIcon(dockIcon);
        } else {
          // 优雅降级兜底：使用 tray.png 作为 Dock 图标
          const fallbackPath = join(getResourcesPath(), 'tray.png');
          if (fs.existsSync(fallbackPath)) {
            const fallbackIcon = nativeImage.createFromPath(fallbackPath);
            app.dock.setIcon(fallbackIcon);
          }
        }
      } catch (e) {
        console.error('[Mac Dock] 设置应用图标异常:', e);
      }
    }
  })

  // 实例化并创建系统状态栏/系统托盘常驻图标，开启跨端关闭不退出常驻功能
  createSystemTray(win);

  // 启动时自动检查更新（限制每天仅执行一次，避免频繁请求）
  const db = getDatabaseService()
  UpdateService.getInstance().startAutoCheck(win, db)
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

// 物理清洗存盘的历史消息格式，把 wechat_custom_emoji/wechat_red_packet 等 JSON 格式清洗为对大模型友好的文本提示词，杜绝格式混乱
/**
 * 将消息内容格式化为适合 LLM 输入的文本。
 * - AI 绘图生成的图片消息（role = 'assistant'）：返回空字符串，调用方应将该消息整体过滤掉。
 * - 用户发送的图片消息（role = 'user'）：返回全角括号叙事描述，避免 LLM 将方括号标记误当作可输出文本。
 */
function formatMessageContentForLLM(content: string, role?: string): string {
  if (!content) return ''
  if (content.startsWith('[wechat_custom_emoji]:')) {
    try {
      const jsonStr = content.substring('[wechat_custom_emoji]:'.length)
      const emoji = JSON.parse(jsonStr)
      return `[表情: ${emoji.meaning}]`
    } catch (_) {
      return '[表情]'
    }
  }
  if (content.startsWith('[wechat_red_packet]:')) {
    try {
      const jsonStr = content.substring('[wechat_red_packet]:'.length)
      const rp = JSON.parse(jsonStr)
      const statusDesc = rp.status === 'received' ? '（已领取）' : rp.status === 'returned' ? '（已退回）' : '（待处理）'
      return `[微信红包: ${rp.amount}元 (附言: ${rp.title}) ${statusDesc}]`
    } catch (_) {
      return '[微信红包]'
    }
  }
  if (content.startsWith('[wechat_image_media]:')) {
    // AI 绘图消息（assistant 发出）：返回空字符串，由调用方 filter 掉，绝不让噪音进入上下文
    if (role === 'assistant') return ''
    // 用户发送的图片消息：用全角括号叙事描述，避免 LLM 将方括号标记误当作可输出文本
    return '（用户发来了一张图片）'
  }
  return content
}

// 动态读取用户自定义大图表情包列表并拼装 Prompt 注入块，使得大模型能够完美感知用户的表情包资产
function buildEmojiSystemPromptSuffix(chatMode?: string): string {
  if (chatMode === 'director') {
    return '' // 🚀 导演模式下绝对不允许发送或注入表情包 Prompt 规则，保持纯净文学剧作
  }
  try {
    const db = getDatabaseService()
    const emojisStr = db.getSetting('echo_custom_emojis')
    const customEmojis = emojisStr ? JSON.parse(emojisStr) : []
    if (customEmojis.length === 0) {
      return ''
    }
    const meaningList = customEmojis.map((e: any) => `- ${e.meaning}`).join('\n')
    return `\n\n【微信自定义大图表情包库】
用户当前添加了以下可供你选择发送的自定义微信表情包名称列表：
${meaningList}

【特定发送格式规则】
如果在与用户的聊天中，你觉得当前的【对话语义、叙事语境或情绪契合度】非常适合发送某个表情包，请严格选择上述列表中存在的表情包名称，并在你的回复正文的【最末尾】输出以下特定指令格式（单次回复限发一个表情包）：
👉 特定指令格式：[SEND_CUSTOM_EMOJI: 表情包名称]

【小说叙事与包含描写模式的特化发送规则】
如果你当前处于【包含描写】（descriptive）或【导演模式】（director）等第三人称小说叙事文风下：
你必须将该特定表情指令输出在【小说正文的最末尾】（如果有 </content> 标签，请务必输出在 </content> 标签的内部最末尾，即与正文连在一起输出）。
例如：
“……街上的梧桐树影晃了晃，又安静下来。彤彤锁好店门，走下台阶去。脚步声很轻，慢慢消失在夜色里。[SEND_CUSTOM_EMOJI: 开心]</content>”
系统在后台会自动为你物理拦截并擦除该指令，并在你的精美描写气泡下方追加一张真实的微信大图表情卡片展现给用户。请不要输出列表中不存在的表情包名称，也不要进行多余的代码层面的口头说明。`
  } catch (err) {
    console.error('[Emoji Prompt Injection Error]:', err)
    return ''
  }
}

// 注册主进程 IPC 监听器
function registerIpcHandlers(): void {

  // ===================== 微信个人号接入专属 IPC 通道注册 =====================
  // 获取当前微信服务的全部状态与绑定映射表
  ipcMain.handle('wechat-get-status', async () => {
    try {
      const wechatService = WeChatService.getInstance();
      return { success: true, status: wechatService.getStatus() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 触发获取登录 Scheme 并启动长轮询监听
  ipcMain.handle('wechat-start-login', async () => {
    try {
      const wechatService = WeChatService.getInstance();
      const qrcodeUrl = await wechatService.requestQRAndStartLogin();
      return { success: true, qrcodeUrl };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 安全解除当前微信号的绑定，清除全部凭证和好友映射
  ipcMain.handle('wechat-unbind', async () => {
    try {
      const wechatService = WeChatService.getInstance();
      await wechatService.stopService();
      
      const db = getDatabaseService();
      db.setSetting('wechat_token', '');
      db.setSetting('wechat_sync_buf', '');
      db.setSetting('wechat_account_id', '');
      db.setSetting('wechat_qrcode_url', '');
      db.saveWeChatMapping({}); // 清空绑定
      db.setSetting('wechat_enabled', '0');

      // 广播状态更新
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('wechat-status-updated', wechatService.getStatus());
      }

      return { success: true, status: wechatService.getStatus() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // 允许用户直接在 PC 端手动强制更新或修改某微信好友所绑定的角色
  ipcMain.handle('wechat-update-mapping', async (_, payload: { friendId: string; characterId: string }) => {
    try {
      const { friendId, characterId } = payload;
      const db = getDatabaseService();
      const mappings = db.getWeChatMappings();
      
      if (characterId) {
        mappings[friendId] = characterId;
      } else {
        delete mappings[friendId]; // 清空绑定
      }

      db.saveWeChatMapping(mappings);
      
      const wechatService = WeChatService.getInstance();
      // 广播状态更新给 Vue
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('wechat-status-updated', wechatService.getStatus());
      }
      return { success: true, status: wechatService.getStatus() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });


  // ====== 桌面挂载与搜索增强 IPC 通道 ======
  // 聊天历史全局物理搜索
  ipcMain.handle('search-chat-history', async (_, payload: { characterId: string; keyword: string }) => {
    try {
      const db = getDatabaseService()
      const list = db.searchChatHistory(payload.characterId, payload.keyword)
      return { success: true, list }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 时钟挂机挂件呼唤主窗口
  ipcMain.handle('clock-open-main-window', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
    return { success: true }
  })

  // 时钟挂机挂件平滑退出应用
  ipcMain.handle('clock-quit-app', () => {
    (app as any).isQuiting = true
    app.quit()
    return { success: true }
  })

  // Windows 自定义标题栏窗口控制按钒组 (minimize / maximize / close)
  // 注意：window-close 与 macOS 点 X 行为完全一致，都是隐藏到系统托盘后台运行，彻底退出需从托盘菜单操作
  ipcMain.handle('window-minimize', () => {
    mainWindow?.minimize()
    return { success: true }
  })

  ipcMain.handle('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
    return { success: true }
  })

  ipcMain.handle('window-close', () => {
    // 触发 win.on('close', ...) 事件，已有防山 event.preventDefault() + win.hide() 逻辑，行为与 macOS 托盘完全一致
    mainWindow?.close()
    return { success: true }
  })

  // ====== 核心数据导出与备份 IPC 通道 ======
  ipcMain.handle('export-project-data', async () => {
    try {
      const userDataPath = app.getPath('userData')
      
      // 🚀 Docker 部署环境下：直接将打包的备份文件静默输出到 backups 映射目录下，不拉起物理保存窗口
      if (process.env.DOCKER_MODE === 'true') {
        const backupDir = path.join(userDataPath, 'backups')
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true })
        }
        const backupFilename = `EchoBackup_${new Date().toISOString().slice(0, 10)}.echo`
        const targetPath = path.join(backupDir, backupFilename)

        const backupDirs = ['database', 'characters', 'config', 'groups', 'EchoMusicSources']
        const filesToPack: Array<{ relativePath: string; content: string }> = []

        const traverseDirectory = (currentDir: string, relativeRoot: string) => {
          if (!fs.existsSync(currentDir)) return
          const items = fs.readdirSync(currentDir)
          for (const item of items) {
            const fullPath = path.join(currentDir, item)
            const relPath = path.join(relativeRoot, item)
            const stat = fs.statSync(fullPath)
            
            if (stat.isDirectory()) {
              traverseDirectory(fullPath, relPath)
            } else if (stat.isFile()) {
              const contentBuffer = fs.readFileSync(fullPath)
              filesToPack.push({
                relativePath: relPath,
                content: contentBuffer.toString('base64')
              })
            }
          }
        }

        for (const dir of backupDirs) {
          const fullDir = path.join(userDataPath, dir)
          traverseDirectory(fullDir, dir)
        }

        const backupData = {
          version: app.getVersion(),
          timestamp: Date.now(),
          files: filesToPack
        }

        const jsonStr = JSON.stringify(backupData)
        const compressedBuffer = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'))
        fs.writeFileSync(targetPath, compressedBuffer)
        console.log(`[Backup] Docker 模式自动导出备份文件成功: ${targetPath}`)

        return { success: true, path: targetPath, filename: backupFilename, isDocker: true }
      }

      // 🚀 极致体验升级：点击后立刻（第 0 毫秒）让用户选择保存路径，不进行任何前期冗余打包，实现零迟滞瞬发响应！
      const focusedWindow = mainWindow || BrowserWindow.getFocusedWindow()
      const result = await dialog.showSaveDialog(focusedWindow!, {
        title: '导出核心备份数据',
        defaultPath: `EchoBackup_${new Date().toISOString().slice(0, 10)}.echo`,
        filters: [
          { name: '回音系统备份文件', extensions: ['echo'] }
        ]
      })

      if (result.canceled || !result.filePath) {
        console.log('[Backup] 用户取消了备份导出')
        return { success: false, error: '用户取消了保存', canceled: true }
      }

      const targetPath = result.filePath

      // 用户确认好保存路径后，主进程才在后台极其迅捷地进行物理目录遍历、打包压缩与写入，完美节省 CPU 与内存开销
      const backupDirs = ['database', 'characters', 'config', 'groups', 'EchoMusicSources']
      const filesToPack: Array<{ relativePath: string; content: string }> = []

      // 递归读取目录中的所有文件
      const traverseDirectory = (currentDir: string, relativeRoot: string) => {
        if (!fs.existsSync(currentDir)) return
        const items = fs.readdirSync(currentDir)
        for (const item of items) {
          const fullPath = path.join(currentDir, item)
          const relPath = path.join(relativeRoot, item)
          const stat = fs.statSync(fullPath)
          
          if (stat.isDirectory()) {
            traverseDirectory(fullPath, relPath)
          } else if (stat.isFile()) {
            const contentBuffer = fs.readFileSync(fullPath)
            filesToPack.push({
              relativePath: relPath,
              content: contentBuffer.toString('base64')
            })
          }
        }
      }

      for (const dir of backupDirs) {
        const fullDir = path.join(userDataPath, dir)
        traverseDirectory(fullDir, dir)
      }

      // 组织备份 JSON 结构
      const backupData = {
        version: app.getVersion(),
        timestamp: Date.now(),
        files: filesToPack
      }

      const jsonStr = JSON.stringify(backupData)
      // 使用内置 zlib 模块进行物理级压缩
      const compressedBuffer = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'))

      fs.writeFileSync(targetPath, compressedBuffer)
      console.log(`[Backup] 数据已物理导出并压缩至用户选定路径: ${targetPath}, 共 ${filesToPack.length} 个文件`)

      return { success: true, path: targetPath }
    } catch (err: any) {
      console.error('[Backup] 导出备份失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  // 🚀 Docker 模式专属：获取已备份包列表 IPC 通道
  ipcMain.handle('get-docker-backups', async () => {
    try {
      const userDataPath = app.getPath('userData')
      const backupDir = path.join(userDataPath, 'backups')
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true })
        return { success: true, list: [] }
      }
      const files = fs.readdirSync(backupDir)
      const list = files
        .filter(file => file.endsWith('.echo'))
        .map(file => {
          const fullPath = path.join(backupDir, file)
          const stat = fs.statSync(fullPath)
          return {
            name: file,
            path: fullPath,
            size: stat.size,
            createdAt: stat.mtimeMs
          }
        })
        .sort((a, b) => b.createdAt - a.createdAt)
      return { success: true, list }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  })

  // 🚀 核心升级：由主进程拉起系统原生文件选择窗口，精确获取备份文件的绝对路径，百分之百 0 兼容性故障！
  ipcMain.handle('open-backup-file-dialog', async () => {
    try {
      // 🚀 Docker 部署环境下：直接返回 Docker 模式警告，引导前端切换至自适应备份点选界面
      if (process.env.DOCKER_MODE === 'true') {
        return { success: false, error: 'Docker模式下请直接在备份列表中选择文件进行恢复', isDocker: true }
      }

      const focusedWindow = mainWindow || BrowserWindow.getFocusedWindow()
      const result = await dialog.showOpenDialog(focusedWindow!, {
        title: '选择回音系统备份文件 (.echo)',
        properties: ['openFile'],
        filters: [
          { name: '回音系统备份文件', extensions: ['echo'] }
        ]
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      const filePath = result.filePaths[0]
      return {
        success: true,
        path: filePath,
        name: path.basename(filePath)
      }
    } catch (err: any) {
      console.error('[Backup] 打开备份文件选择窗口失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  ipcMain.handle('import-project-data', async (_, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, error: '非法的物理备份文件路径' }
      }

      const userDataPath = app.getPath('userData')
      
      // 🚀 Docker 模式路径越界安全防御
      if (process.env.DOCKER_MODE === 'true') {
        const backupDir = path.join(userDataPath, 'backups')
        const normalizedPath = path.normalize(filePath)
        if (!normalizedPath.startsWith(backupDir)) {
          return { success: false, error: '安全拦截：只允许导入 backups 目录下的备份文件' }
        }
      }

      // 🚀 核心升级：直接由主进程通过路径在后台读取物理文件，IPC 通道只需传输极小路径字符串，彻底避开 FileReader 大文件 Base64 的跨进程卡顿与内存崩溃！
      const compressedBuffer = fs.readFileSync(filePath)

      // 解压数据
      let decompressedData: string
      try {
        decompressedData = zlib.gunzipSync(compressedBuffer).toString('utf-8')
      } catch (decompressErr) {
        return { success: false, error: '解析备份文件失败，文件可能已损坏或格式不正确' }
      }

      // 解析 JSON
      let backupObj: any
      try {
        backupObj = JSON.parse(decompressedData)
      } catch (jsonErr) {
        return { success: false, error: '备份数据格式不正确' }
      }

      if (!backupObj || !Array.isArray(backupObj.files)) {
        return { success: false, error: '非法的备份文件结构，未找到有效的文件列表' }
      }

      const backupDirs = ['database', 'characters', 'config', 'groups', 'EchoMusicSources']

      // 🚀 物理重置数据库单例（释放 SQLite 文件句柄锁）
      resetDatabaseService()

      // 2. 将旧的文件夹重命名或移动到临时备份目录，做两阶段安全事务防灾
      const backupTimestamp = Date.now()
      const tempRestoreBackupDir = path.join(userDataPath, `temp_restore_backup_${backupTimestamp}`)
      fs.mkdirSync(tempRestoreBackupDir, { recursive: true })

      const movedDirs: string[] = []
      try {
        for (const dir of backupDirs) {
          const oldDirPath = path.join(userDataPath, dir)
          if (fs.existsSync(oldDirPath)) {
            const destPath = path.join(tempRestoreBackupDir, dir)
            fs.renameSync(oldDirPath, destPath)
            movedDirs.push(dir)
          }
        }
      } catch (moveErr: any) {
        // 如果移动现有目录失败，进行灾难恢复，恢复原状
        for (const dir of movedDirs) {
          const tempPath = path.join(tempRestoreBackupDir, dir)
          const oldDirPath = path.join(userDataPath, dir)
          if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, oldDirPath)
          }
        }
        return { success: false, error: `备份现有数据失败（请确保没有其他程序占用数据库）: ${moveErr.message}` }
      }

      // 3. 依次解密解压并物理覆盖写入所有备份的文件
      try {
        for (const fileItem of backupObj.files) {
          if (!fileItem.relativePath || typeof fileItem.content !== 'string') continue
          
          // 路径防越界安全校验 (Path Traversal Protection)
          const normalizedPath = path.normalize(fileItem.relativePath)
          if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
            throw new Error(`非法的安全越界文件路径: ${fileItem.relativePath}`)
          }

          // 确认该文件属于允许导入的目录
          const firstDir = normalizedPath.split(path.sep)[0]
          if (!backupDirs.includes(firstDir)) {
            continue // 忽略不属于备份目录的文件
          }

          const targetFilePath = path.join(userDataPath, normalizedPath)
          const targetFileDir = path.dirname(targetFilePath)

          // 确保父级文件夹目录存在
          if (!fs.existsSync(targetFileDir)) {
            fs.mkdirSync(targetFileDir, { recursive: true })
          }

          const fileBuffer = Buffer.from(fileItem.content, 'base64')
          fs.writeFileSync(targetFilePath, fileBuffer)
        }
      } catch (writeErr: any) {
        // 如果物理覆盖写入失败，必须进行绝对安全的灾难回滚还原
        console.error('[Backup] 还原写入发生异常，触发灾难级回滚恢复中...', writeErr)
        // 清理刚刚写入的不完整文件
        for (const dir of backupDirs) {
          const currentPath = path.join(userDataPath, dir)
          if (fs.existsSync(currentPath)) {
            fs.rmSync(currentPath, { recursive: true, force: true })
          }
        }
        // 将临时备份还原回来
        for (const dir of movedDirs) {
          const tempPath = path.join(tempRestoreBackupDir, dir)
          const oldDirPath = path.join(userDataPath, dir)
          if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, oldDirPath)
          }
        }
        // 清理临时目录
        fs.rmSync(tempRestoreBackupDir, { recursive: true, force: true })
        return { success: false, error: `写入恢复数据出错（数据已安全回滚至导入前状态）: ${writeErr.message || String(writeErr)}` }
      }

      // 恢复成功后，清理临时安全目录
      try {
        fs.rmSync(tempRestoreBackupDir, { recursive: true, force: true })
      } catch (_) {}

      console.log(`[Backup] 数据解包与覆盖还原成功，共解包恢复了 ${backupObj.files.length} 个文件！即将重启应用。`)

      // 4. 延迟 1.5 秒后自动热重启应用，留足前端毛玻璃框渲染和声音提示的缓冲时间
      setTimeout(() => {
        app.relaunch()
        app.exit(0)
      }, 1500)

      return { success: true }
    } catch (err: any) {
      console.error('[Backup] 导入还原失败:', err)
      return { success: false, error: err.message || String(err) }
    }
  })

  // ====== 客户端自动检查更新 IPC 通道 ======
  // 手动检查更新
  ipcMain.handle('check-for-updates-manual', async () => {
    try {
      if (!mainWindow) return { success: false, error: '主窗口未初始化' }
      const db = getDatabaseService()
      const updateService = UpdateService.getInstance()
      return await updateService.checkForUpdates(mainWindow, db, true)
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 重启并安装
  ipcMain.handle('restart-and-install', async () => {
    try {
      const updateService = UpdateService.getInstance()
      return updateService.restartAndInstall()
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 0.0.1.b 获取目前真实天气数据
  ipcMain.handle('get-realtime-weather', async (_, location: string, forceRefresh = false) => {
    try {
      console.log(`[IPC get-realtime-weather] 收到天气请求, location="${location}", forceRefresh=${forceRefresh}`);
      const weatherText = await WeatherService.prefetchWeather(location, forceRefresh)
      console.log(`[IPC get-realtime-weather] 天气请求完成, 结果="${weatherText}"`);
      return { success: true, weather: weatherText }
    } catch (e: any) {
      console.error(`[IPC get-realtime-weather] 天气请求异常:`, e);
      return { success: false, error: e.message || e }
    }
  })

  // 0.0.1 获取用户个人配置 (包含钱包余额、昵称等)
  ipcMain.handle('get-user-profile', async () => {
    try {
      const db = getDatabaseService()
      const profileStr = db.getSetting('echo_user_profile')
      if (profileStr) {
        return { success: true, profile: JSON.parse(profileStr) }
      }
      return { success: true, profile: null }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 0.0.2 保存用户个人配置，并广播通知其他局域网客户端
  ipcMain.handle('save-user-profile', async (_, payload: any) => {
    try {
      const db = getDatabaseService()
      db.setSetting('echo_user_profile', JSON.stringify(payload))
      
      // 广播通知其他局域网客户端
      mainWindow?.webContents.send('user-profile-updated', payload)
      
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 0.0.3 获取自定义表情包列表
  ipcMain.handle('get-custom-emojis', async () => {
    try {
      const db = getDatabaseService()
      const emojisStr = db.getSetting('echo_custom_emojis')
      if (emojisStr) {
        return { success: true, emojis: JSON.parse(emojisStr) }
      }
      return { success: true, emojis: [] }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 0.0.4 保存自定义表情包列表，并广播通知其他局域网客户端
  ipcMain.handle('save-custom-emojis', async (_, payload: any[]) => {
    try {
      const db = getDatabaseService()
      db.setSetting('echo_custom_emojis', JSON.stringify(payload))
      
      // 广播通知其他局域网客户端
      mainWindow?.webContents.send('custom-emojis-updated', payload)
      
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

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
        'User-Agent': 'EchoPlatform/1.0.3 (Desktop AI Roleplay Platform)'
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

  // 物理删除单条消息 IPC 通道
  ipcMain.handle('delete-message', async (_, payload: { messageId: string }) => {
    try {
      console.log('[IPC] 收到物理删除消息请求，ID:', payload.messageId)
      const db = getDatabaseService()
      
      // 1. 先查出此条消息的内容
      const stmt = db.db.prepare('SELECT * FROM Messages WHERE id = ?')
      const msg = stmt.get(payload.messageId) as { character_id: string; content: string } | undefined
      
      // 2. 如果存在且是图片消息，物理硬删除它
      if (msg && msg.content && msg.content.startsWith('[wechat_image_media]:')) {
        const relativePath = msg.content.substring('[wechat_image_media]:'.length) // e.g. "media/drawing_xxxx.png"
        
        // 3. 查出对应角色的 folder_name
        const charStmt = db.db.prepare('SELECT folder_name FROM Characters WHERE id = ?')
        const charRow = charStmt.get(msg.character_id) as { folder_name: string } | undefined
        
        if (charRow) {
          const storageManager = new CharacterStorageManager()
          const charDir = join(storageManager.getBaseDir(), charRow.folder_name)
          const pngPath = join(charDir, relativePath)
          const jsonPath = pngPath.replace('.png', '.json')
          
          console.log('[IPC] 正在物理硬删除消息对应的图片:', pngPath)
          if (fs.existsSync(pngPath)) {
            try { fs.unlinkSync(pngPath) } catch (err) {}
          }
          if (fs.existsSync(jsonPath)) {
            try { fs.unlinkSync(jsonPath) } catch (err) {}
          }
        }
      }

      db.deleteMessage(payload.messageId)

      // 🚀 物理删除消息后，立即触发秒级自愈同步：广播给电脑软件前端和局域网连接的所有手机浏览器（SSE 通道）
      if (msg) {
        const charId = msg.character_id
        
        // 1. 广播给电脑端前端
        if (mainWindow && !mainWindow.webContents.isDestroyed()) {
          mainWindow.webContents.send('message-deleted', { characterId: charId, messageId: payload.messageId })
        }
        
        // 2. 广播给所有连入局域网的客户端 SSE 通道
        const ssePayload = {
          channel: 'message-deleted',
          data: { characterId: charId, messageId: payload.messageId }
        }
        for (const client of sseClients) {
          try {
            client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
          } catch (_) {
            sseClients.delete(client)
          }
        }

        // 3. 清除该角色的待确认记忆草稿（防止被删消息的记忆被延迟写入污染上下文）
        try {
          db.db.prepare('DELETE FROM Settings WHERE key = ?').run(`pending_memory_diff_${charId}`)
          console.log(`[IPC] 删除消息时清除角色 ${charId} 的记忆草稿。`)
        } catch (_) {}
      }

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 物理删除消息失败:', error)
      return { success: false, error: error.message || String(error) }
    }
  })

  // ====== 意见反馈系统专属 IPC 通道 ======
  // 1. 获取设备唯一 ID
  ipcMain.handle('get-device-id', async () => {
    try {
      const db = getDatabaseService()
      return db.getSetting('device_id') || 'unknown'
    } catch (err) {
      return 'unknown'
    }
  })

  // 2. 保存用户提交的意见反馈到本地 SQLite
  ipcMain.handle('save-user-feedback', async (_, payload: { id: string; title: string; content: string; type: string; contact?: string; status: string; created_at: number }) => {
    try {
      const db = getDatabaseService()
      const stmt = db.db.prepare(`
        INSERT OR REPLACE INTO UserFeedbacks (id, title, content, type, contact, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(payload.id, payload.title, payload.content, payload.type, payload.contact || null, payload.status, payload.created_at)
      return { success: true }
    } catch (err: any) {
      console.error('[IPC save-user-feedback] 异常:', err)
      return { success: false, error: err.message }
    }
  })

  // 3. 读取本地保存的所有意见反馈记录
  ipcMain.handle('get-user-feedbacks', async () => {
    try {
      const db = getDatabaseService()
      const stmt = db.db.prepare(`SELECT * FROM UserFeedbacks ORDER BY created_at DESC`)
      const rows = stmt.all()
      return { success: true, list: rows }
    } catch (err: any) {
      console.error('[IPC get-user-feedbacks] 异常:', err)
      return { success: false, error: err.message, list: [] }
    }
  })

  // 4. 同步更新本地已提交反馈的状态
  ipcMain.handle('update-user-feedback-status', async (_, payload: { id: string; status: string }) => {
    try {
      const db = getDatabaseService()
      const stmt = db.db.prepare(`UPDATE UserFeedbacks SET status = ? WHERE id = ?`)
      stmt.run(payload.status, payload.id)
      return { success: true }
    } catch (err: any) {
      console.error('[IPC update-user-feedback-status] 异常:', err)
      return { success: false, error: err.message }
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

  // 3.1 获取角色专属聊天模式 IPC 通道
  ipcMain.handle('get-character-chat-mode', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const mode = db.getSetting(`chat_mode_${payload.characterId}`) || 'dialogue'
      return { success: true, mode }
    } catch (error: any) {
      return { success: false, error: error.message || error }
    }
  })

  // 3.2 设置角色专属聊天模式 IPC 通道（立即写库并广播给其他端）
  ipcMain.handle('set-character-chat-mode', async (_, payload: { characterId: string; mode: string }) => {
    try {
      const db = getDatabaseService()
      db.setSetting(`chat_mode_${payload.characterId}`, payload.mode)
      // 通过 broadcastToSse 广播，保证写入环形缓冲区，其他端断线重连后也能补偿收到
      broadcastToSse('character-chat-mode-changed', { characterId: payload.characterId, mode: payload.mode })
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 设置角色聊天模式失败:', error)
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

  // 4.1 获取 NovelAI 配置 IPC 通道
  // 通用设置读取接口（供前端查询任意 DB 设置项）
  ipcMain.handle('get-setting', async (_, payload: { key: string }) => {
    try {
      const db = getDatabaseService()
      const value = db.getSetting(payload.key)
      return { success: true, value: value ?? null }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-novelai-config', async () => {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('novelai_config')
      if (configStr) {
        return { success: true, config: JSON.parse(configStr) }
      }
      return { success: true, config: null }
    } catch (error: any) {
      console.error('[IPC] 读取 NovelAI 配置失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.2 保存 NovelAI 配置 IPC 通道
  ipcMain.handle('save-novelai-config', async (_, payload: any) => {
    try {
      console.log('[IPC] 正在保存 NovelAI 配置到 Settings 表')
      const db = getDatabaseService()
      db.setSetting('novelai_config', JSON.stringify(payload))
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 保存 NovelAI 配置失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.3 获取 NovelAI Anlas 余额 IPC 通道
  ipcMain.handle('fetch-novelai-anlas', async (_, payload: { apiKey: string }) => {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('novelai_config')
      let baseUrl: string | undefined = undefined
      if (configStr) {
        try {
          const config = JSON.parse(configStr)
          baseUrl = config.baseUrl
        } catch (_) {}
      }
      const anlas = await NovelAiService.fetchAnlas(payload.apiKey, baseUrl)
      return { success: true, anlas }
    } catch (error: any) {
      console.error('[IPC] 获取 NovelAI Anlas 余额失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.4 提取角色外貌固定特征 IPC 通道
  ipcMain.handle('extract-appearance-features', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const soul = storageManager.readCharacterFile(payload.folderName, 'Soul.md')
      if (!soul) {
        return { success: false, error: '性格设定文件 Soul.md 为空或不存在' }
      }

      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
      }
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)

      const systemPrompt = `你是一个非常专业的人物设定提取助手。请仔细阅读并分析给出的 AI 角色性格人设文档（Soul.md），精炼提取出其【固定的、永久的、不随场景改变的物理外貌特征】。
要求：
1. 【重要】绝对不能包含衣服、首饰或任何容易随着场景和穿着改变的物品（如：连衣裙、项链、帽子、包包、眼镜等）。
2. 只关注固定的身体外貌特征：如性别、年龄外观、眼睛颜色、发色、发型、肤色、身材特征（身高、丰满程度）、面部特征（泪痣、表情倾向）等。
3. 将提取的外貌特征翻译并整理为一套 NovelAI/Danbooru 精简英语提示词（Tags）以及一段简短的中文外貌说明。
4. 输出必须严格按照以下格式排版，不要写任何 \`\`\` 块包裹：
### Appearance Tags
(在这里只输出半角逗号分隔的英文生图 Tag，例如: 1girl, blue eyes, silver long hair, twin tails, pale skin, petite)

### Appearance Description
(在这里用中文描述该角色的固定外貌特征，例如: 银发双马尾少女，拥有蔚蓝的双眸，皮肤白皙，身材娇小)`

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `请帮我提取该角色的人设外貌特征，以下是人设文档：\n\n${soul}` }
      ]

      const response = await modelAdapter.chat(messages)
      const raw = response.content.trim()

      let tags = ''
      let description = ''

      const tagsMatch = raw.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i)
      const descMatch = raw.match(/### Appearance Description\s*([\s\S]*)/i)

      if (tagsMatch) tags = tagsMatch[1].trim()
      if (descMatch) description = descMatch[1].trim()

      return { success: true, tags, description }
    } catch (error: any) {
      console.error('[IPC] 提取角色外貌特征失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.5 读取角色专属 Appearance.md IPC 通道
  ipcMain.handle('read-appearance-file', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const content = storageManager.readCharacterFile(payload.folderName, 'Appearance.md')
      return { success: true, content }
    } catch (error: any) {
      console.error(`[IPC] 读取 Appearance.md 失败:`, error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.6 保存角色专属 Appearance.md IPC 通道
  ipcMain.handle('save-appearance-file', async (_, payload: { folderName: string; content: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      storageManager.writeCharacterFile(payload.folderName, 'Appearance.md', payload.content)
      // 🚀 广播通知其他局域网客户端与电脑端外貌文件已更新，触发秒级同步
      const appearanceBroadcast = { folderName: payload.folderName, fileName: 'Appearance.md', content: payload.content }
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('character-file-updated', appearanceBroadcast)
      }
      const appearanceSse = {
        channel: 'character-file-updated',
        data: appearanceBroadcast
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(appearanceSse)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

      return { success: true }
    } catch (error: any) {
      console.error(`[IPC] 保存 Appearance.md 失败:`, error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.7 调用 NovelAI 生成图片并落盘至角色专属 media 目录 IPC 通道
  ipcMain.handle('generate-novelai-image', async (_, payload: {
    characterId: string
    folderName: string
    prompt: string
    dimensions: 'portrait' | 'landscape' | 'square'
    prefixType?: 'chat' | 'social' | 'proactive'
  }) => {
    try {
      const db = getDatabaseService()
      const naiConfigStr = db.getSetting('novelai_config')
      if (!naiConfigStr) {
        return { success: false, error: '未配置 NovelAI 参数，请前往设置页面进行配置。' }
      }
      const naiConfig = JSON.parse(naiConfigStr)

      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)

      // 读取外貌固定特征
      let appearancePrompt = ''
      const appearanceContent = storageManager.readCharacterFile(payload.folderName, 'Appearance.md')
      if (appearanceContent) {
        const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i)
        if (tagsMatch) {
          appearancePrompt = tagsMatch[1].trim()
        }
      }

      // 组装最终提示词：画师串 + 外貌特征 + 当前动作场景 + 质量提示词
      let finalPrompt = appearancePrompt 
        ? `${appearancePrompt}, ${payload.prompt}`
        : payload.prompt

      // 仅在固定模式下由调用方预拼画师串；随机模式下由 NovelAiService.generateImage 内部统一随机选取并拼接
      // 避免随机模式下 cleaning 逻辑失配导致固定画师串残留，造成该画师出现频率虚高
      if (!naiConfig.randomArtist && naiConfig.artistString?.trim()) {
        finalPrompt = `${naiConfig.artistString.trim()}, ${finalPrompt}`
      }
      if (naiConfig.qualityPrompt?.trim()) {
        finalPrompt = `${finalPrompt}, ${naiConfig.qualityPrompt.trim()}`
      }

      // 调用 NovelAI 绘图
      const imageBuffer = await NovelAiService.generateImage(naiConfig, finalPrompt, payload.dimensions)

      // 确保 media 文件夹存在
      const mediaDir = join(charDir, 'media')
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true })
      }

      // 保存图片
      const prefix = payload.prefixType || 'drawing'
      const timestamp = Date.now()
      const filename = `${prefix}_${timestamp}_${Math.random().toString(36).substr(2, 5)}.png`
      const fullPath = join(mediaDir, filename)
      fs.writeFileSync(fullPath, imageBuffer)

      // 额外保存同名元数据 .json 文件，便于图库秒开与精确读取提示词和尺寸
      const metaFilename = filename.replace('.png', '.json')
      const metaFullPath = join(mediaDir, metaFilename)
      const metadata = {
        prompt: finalPrompt,
        negativePrompt: naiConfig.negativePrompt || '',
        dimensions: payload.dimensions,
        timestamp,
        prefixType: prefix
      }
      fs.writeFileSync(metaFullPath, JSON.stringify(metadata, null, 2))

      const relativePath = `media/${filename}`
      const base64 = `data:image/png;base64,${imageBuffer.toString('base64')}`

      return {
        success: true,
        relativePath,
        base64
      }
    } catch (error: any) {
      console.error('[IPC] NovelAI 绘图发生异常:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.8 获取角色专属已生成图库图片 IPC 通道
  ipcMain.handle('get-gallery-images', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      const mediaDir = join(charDir, 'media')

      if (!fs.existsSync(mediaDir)) {
        return { success: true, images: [] }
      }

      const files = fs.readdirSync(mediaDir)
      const list: any[] = []

      for (const file of files) {
        if (
          file.endsWith('.png') && (
            file.startsWith('drawing_') ||
            file.startsWith('social_') ||
            file.startsWith('proactive_')
          )
        ) {
          const filePath = join(mediaDir, file)
          const stat = fs.statSync(filePath)
          
          let meta: any = {}
          const metaPath = filePath.replace('.png', '.json')
          if (fs.existsSync(metaPath)) {
            try {
              meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
            } catch (e) {
              console.error('读取图片 metadata 失败:', e)
            }
          }
          
          list.push({
            filename: file,
            relativePath: `media/${file}`,
            createdAt: stat.mtimeMs,
            prompt: meta.prompt || '',
            negativePrompt: meta.negativePrompt || '',
            dimensions: meta.dimensions || 'portrait',
            prefixType: meta.prefixType || (file.startsWith('social_') ? 'social' : file.startsWith('proactive_') ? 'proactive' : 'chat')
          })
        }
      }

      // 倒序：最迎生成的在前
      list.sort((a, b) => b.createdAt - a.createdAt)

      return { success: true, images: list }
    } catch (error: any) {
      console.error('[IPC] 读取图库列表失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  // 4.8.5 物理删除专属图库图片 IPC 通道
  ipcMain.handle('delete-gallery-image', async (_, payload: { folderName: string; filename: string }) => {
    try {
      console.log(`[IPC] 收到专属图库图片删除请求，目录: ${payload.folderName}, 文件: ${payload.filename}`)
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      const mediaDir = join(charDir, 'media')

      const pngPath = join(mediaDir, payload.filename)
      const jsonPath = pngPath.replace('.png', '.json')

      if (fs.existsSync(pngPath)) {
        try { fs.unlinkSync(pngPath) } catch (err) {}
      }
      if (fs.existsSync(jsonPath)) {
        try { fs.unlinkSync(jsonPath) } catch (err) {}
      }
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 物理删除图库图片失败:', error)
      return { success: false, error: error.message || String(error) }
    }
  })
  ipcMain.handle('analyze-chat-image-prompt', async (_, payload: { 
    characterId: string; 
    folderName: string;
    recentMessages: any[];
  }) => {
    try {
      const db = getDatabaseService()
      
      // A. 读取 Memory.md 记忆系统与 Soul.md 人设文件
      const storageManager = new CharacterStorageManager()
      const memoryContent = storageManager.readCharacterFile(payload.folderName, 'Memory.md') || ''
      const soulContent = storageManager.readCharacterFile(payload.folderName, 'Soul.md') || ''

      // B. 初始化大模型
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
      }
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)

      // C. 组装提示词系统指令
      const systemPrompt = `你是一个非常专业且具有极高艺术审美的 NovelAI 4.5 Full 绘图提示词生成大师。
请你仔细阅读并深度结合 AI 角色的性格设定 (Soul.md)、记忆系统 (Memory.md) 以及他们之间最近的聊天上下文对话内容，为当前场景构思并生成一副精美的文生图（T2I）提示词。

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
(在这里输出当前场景的生图 Tag。例如单人：1girl, bedroom, upper body, long black hair, white nightgown, smiling, morning sunlight, soft shadows, very aesthetic, masterpiece, best quality, highres, no text, no watermark。例如双人：1boy, 1girl, living room, close-up, very aesthetic, masterpiece, best quality, highres, no text, no watermark | girl, emilia (re:zero), long silver hair, white dress, flushed cheeks, source#embrace, arms around neck, smiling | boy, short black hair, casual shirt, target#embrace, hands on waist, looking down at her)

### Image Description
(在这里用中文对画面做一个简述。例如：少女正坐在温馨的咖啡厅窗边，手端着热咖啡，对着镜头微微甜笑，身后是落日余晖洒在街景上。)`

      // 过滤掉 AI 生成图片消息（assistant 图片），用户图片保留为占位文字
      const contextText = payload.recentMessages
        .filter((m: any) => !(m.role === 'assistant' && (m.content || '').startsWith('[wechat_image_media]:')))
        .map((m: any) => {
          const label = m.role === 'user' ? '用户' : '角色'
          const content = (m.role === 'user' && (m.content || '').startsWith('[wechat_image_media]:'))
            ? '（用户发来了一张图片）'
            : (m.content || '')
          return `${label}: ${content}`
        }).join('\n')
      
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `【角色设定 Soul.md】：\n${soulContent}\n\n【角色记忆 Memory.md】：\n${memoryContent}\n\n【最近聊天上下文】：\n${contextText}\n\n请帮我生成当前画面场景的生图 Prompt 和描述。` }
      ]

      const response = await modelAdapter.chat(messages)
      const raw = response.content.trim()

      let prompt = ''
      let description = ''

      const promptMatch = raw.match(/### Image Prompt\s*([\s\S]*?)(?:### Image Description|$)/i)
      const descMatch = raw.match(/### Image Description\s*([\s\S]*)/i)

      if (promptMatch) prompt = promptMatch[1].trim()
      if (descMatch) description = descMatch[1].trim()

      return { success: true, prompt, description }
    } catch (error: any) {
      console.error('[IPC] 分析聊天生图 Prompt 失败:', error)
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
  ipcMain.handle('summarize-character', async (_, cardData: any, userInstruction?: string) => {
    try {
      console.log('[IPC] ➜ 收到角色 AI 提炼总结请求，姓名:', cardData.name, userInstruction ? `用户修正要求: "${userInstruction}"` : '')
      const summary = await CharacterSummarizer.summarize(cardData, userInstruction)
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

      // 首次导入成功后，强制异步触发大模型生成角色 100 字核心设定总结 (不阻塞导入完成返回)
      CharacterSummaryService.getOrGenerateSummary(confirmedFolderName, true).catch(err => {
        console.error('[import-character] 初始生成设定总结异常:', err)
      })

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
          ])

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

  // 8.5 群聊相关核心 IPC 通道注册
  ipcMain.handle('create-group-chat', async (_, payload: {
    groupId: string
    name: string
    memberIds: string[]
    avatarBase64?: string
  }) => {
    try {
      const { groupId, name, memberIds, avatarBase64 } = payload
      console.log(`[IPC] ➜ 收到创建群聊请求, ID: ${groupId}, 名称: ${name}, 成员数: ${memberIds.length}`)

      const db = getDatabaseService()
      
      // 1. 初始化物理群聊目录并写入 Memory.md 与 拼贴头像
      const groupDir = join(app.getPath('userData'), 'groups', groupId)
      if (!fs.existsSync(groupDir)) {
        fs.mkdirSync(groupDir, { recursive: true })
      }

      const memoryPath = join(groupDir, 'Memory.md')
      if (!fs.existsSync(memoryPath)) {
        const memoryInitContent = `<!--\n{\n  "stm": [],\n  "ltm": {}\n}\n-->\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n暂无短期记忆。\n\n## 长期记忆 (Long-Term Memory)\n暂无长期记忆。`
        fs.writeFileSync(memoryPath, memoryInitContent, 'utf8')
      }

      if (avatarBase64) {
        const avatarPath = join(groupDir, 'avatar.png')
        const base64Data = avatarBase64.replace(/^data:image\/\w+;base64,/, '')
        fs.writeFileSync(avatarPath, Buffer.from(base64Data, 'base64'))
      }

      // 2. 数据库落盘
      db.saveGroupChat({
        id: groupId,
        name,
        avatar: 'avatar.png',
        created_at: Date.now()
      })

      db.saveGroupMembers(groupId, memberIds)
      console.log(`[IPC] ✔ 群聊 ${name} (${groupId}) 物理与数据库落盘大获成功！`)

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 创建群聊失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  ipcMain.handle('get-group-chats', async () => {
    try {
      const db = getDatabaseService()
      const groups = db.getAllGroupChats()
      
      // 携带群成员 ID 列表
      const richGroups = groups.map(g => {
        const memberIds = db.getGroupMembers(g.id)
        return {
          ...g,
          isGroup: true, // 明确标识为群聊，便于前端列表统一渲染
          memberIds
        }
      })
      
      return { success: true, groups: richGroups }
    } catch (error: any) {
      console.error('[IPC] 获取群聊列表失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  ipcMain.handle('get-group-avatar', async (_, groupId: string) => {
    try {
      const avatarPath = join(app.getPath('userData'), 'groups', groupId, 'avatar.png')
      if (fs.existsSync(avatarPath)) {
        const buffer = fs.readFileSync(avatarPath)
        return `data:image/png;base64,${buffer.toString('base64')}`
      }
      return ''
    } catch (error: any) {
      console.error('[IPC] 获取群聊头像失败:', error)
      return ''
    }
  })

  ipcMain.handle('update-group-name', async (_, payload: { groupId: string; name: string }) => {
    try {
      const { groupId, name } = payload
      console.log(`[IPC] ➜ 收到更新群名请求, ID: ${groupId}, 新名称: ${name}`)
      const db = getDatabaseService()
      db.updateGroupName(groupId, name)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 更新群名失败:', error)
      return { success: false, error: error.message || error }
    }
  })

  ipcMain.handle('read-group-file', async (_, payload: { groupId: string; fileName: string }) => {
    try {
      const { groupId, fileName } = payload
      const filePath = join(app.getPath('userData'), 'groups', groupId, fileName)
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8')
        return { success: true, content }
      }
      return { success: true, content: '' }
    } catch (error: any) {
      console.error(`[IPC] 读取群文件 ${payload.fileName} 失败:`, error)
      return { success: false, error: error.message || error }
    }
  })

  ipcMain.handle('save-group-file', async (_, payload: { groupId: string; fileName: string; content: string }) => {
    try {
      const { groupId, fileName, content } = payload
      const groupDir = join(app.getPath('userData'), 'groups', groupId)
      if (!fs.existsSync(groupDir)) {
        fs.mkdirSync(groupDir, { recursive: true })
      }
      const filePath = join(groupDir, fileName)
      fs.writeFileSync(filePath, content, 'utf8')
      console.log(`[IPC] 群聊文件 ${fileName} 保存成功: ${groupId}`)
      return { success: true }
    } catch (error: any) {
      console.error(`[IPC] 保存群文件 ${payload.fileName} 失败:`, error)
      return { success: false, error: error.message || error }
    }
  })

  ipcMain.handle('delete-group-chat', async (_, payload: { groupId: string }) => {
    try {
      const { groupId } = payload
      console.log(`[IPC] ➜ 收到删除群聊请求, ID: ${groupId}`)
      const db = getDatabaseService()
      
      // 1. 物理清空磁盘群目录
      const groupDir = join(app.getPath('userData'), 'groups', groupId)
      if (fs.existsSync(groupDir)) {
        fs.rmSync(groupDir, { recursive: true, force: true })
      }
      
      // 2. 数据库级联物理删除
      db.deleteGroupChat(groupId)
      console.log(`[IPC] ✔ 群聊 ${groupId} 已被物理彻底擦除`)
      return { success: true }
    } catch (error: any) {
      console.error('[IPC] 删除群聊失败:', error)
      return { success: false, error: error.message || error }
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

      // 【生命周期自清洁】：由于人设已被用户修改，我们主动置空其设定总结 Summary.md 缓存文件
      const speakerDir = join(storageManager.getBaseDir(), payload.folderName)
      const summaryPath = join(speakerDir, 'Summary.md')
      if (fs.existsSync(summaryPath)) {
        try {
          fs.writeFileSync(summaryPath, '', 'utf-8') // 置空文件
        } catch (_) { }
      }

      // 异步调用总结服务，由于 Summary.md 已置空，它会百分之百自动调用大模型重新提炼存盘 (不阻塞用户保存操作)
      CharacterSummaryService.getOrGenerateSummary(payload.folderName, true).catch(err => {
        console.error('[save-character-files] 保存触发重生成设定总结异常:', err)
      })

      // 🚀 广播通知其他局域网客户端与电脑端人设已更新，触发秒级同步
      const settingsBroadcast = { folderName: payload.folderName, soul: payload.soul, world: payload.world }
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('character-settings-updated', settingsBroadcast)
      }
      const settingsSse = {
        channel: 'character-settings-updated',
        data: settingsBroadcast
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(settingsSse)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
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
    chatMode?: 'descriptive' | 'dialogue' | 'director'
    imageBase64?: string
    userMsgId?: string
    dbMessage?: string
    isGroup?: boolean
    isRegenerate?: boolean // 🚀 是否是重新回复触发
  }) => {
    const { characterId, folderName, userMessage } = payload
    const isGroup = !!payload.isGroup

    // 异步拉取当前所在地天气数据，并加入2秒超时保护
    try {
      const db = getDatabaseService()
      const profileStr = db.getSetting('echo_user_profile')
      if (profileStr) {
        const parsed = JSON.parse(profileStr)
        if (parsed.location) {
          await Promise.race([
            WeatherService.prefetchWeather(parsed.location.trim()),
            new Promise(resolve => setTimeout(resolve, 2000))
          ])
        }
      }
    } catch (_) {}

    // ===================== 群聊模式专属级联调度与流式生成引擎 =====================
    if (isGroup) {
      const groupId = characterId // 群聊时 characterId 传入的是 groupId
      console.log(`[Group Chat] ➜ 收到群聊流式请求. 会话群组: ${groupId}, 发送消息: "${userMessage}"`)
      
      const db = getDatabaseService()
      
      // 1. 获取群聊元数据与全局模型设置
      const groupMeta = db.getGroupChat(groupId)
      if (!groupMeta) {
        throw new Error('未找到指定的群聊会话，请先创建或刷新群聊！')
      }
      
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！')
      }
      const settings = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(settings.primary, settings.secondary)
      const globalPrompt = settings.globalPrompt || ''

      const memberIds = db.getGroupMembers(groupId) as string[] // AI 成员 ID 列表
      if (memberIds.length === 0) {
        throw new Error('群聊中没有任何 AI 成员，请先往群聊中添加角色！')
      }

      const groupDir = join(app.getPath('userData'), 'groups', groupId)
      const groupMemoryPath = join(groupDir, 'Memory.md')
      const globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')

      // 2. 将用户的发言首先持久化存盘入库
      const userMsgId = payload.userMsgId || crypto.randomUUID()
      if (!payload.isRegenerate) {
        db.saveMessage({
          id: userMsgId,
          character_id: groupId,
          role: 'user',
          content: payload.dbMessage || userMessage,
          timestamp: Date.now(),
          token_usage: 0,
          sender_id: 'user'
        })
      }

      // 3. 核心决策：决定当前发言人队列 speakerQueue
      const speakerQueue: string[] = []

      // 获取群 AI 成员姓名及智能简称（用于唤醒与提名）
      const aiMembers = memberIds.map(id => {
        const charRow = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(id) as any
        const name = charRow ? charRow.name : '未知'
        let shortName = name
        if (name.length === 3) {
          shortName = name.substring(1) // 3字姓名简称后2字 (如李沧海 -> 沧海)
        }
        return { id, name, shortName }
      })

      // A. 精确 @ 唤醒检测 (支持带或不带空格的 @)
      aiMembers.forEach(member => {
        if (userMessage.includes(`@${member.name}`) || userMessage.includes(`@ ${member.name}`)) {
          if (!speakerQueue.includes(member.id)) {
            speakerQueue.push(member.id)
          }
        }
      })

      // B. 提名检测 (若无精确 @，只要提到了简称便必回)
      if (speakerQueue.length === 0) {
        aiMembers.forEach(member => {
          if (userMessage.includes(member.shortName)) {
            if (!speakerQueue.includes(member.id)) {
              speakerQueue.push(member.id)
            }
          }
        })
      }

      // C. 随机接话机制 (无 @ 且无提名提名时，60% 概率 1 人，30% 概率 2 人，10% 概率 3 人)
      if (speakerQueue.length === 0) {
        const rand = Math.random()
        let numToPick = 1
        if (rand < 0.6) {
          numToPick = 1
        } else if (rand < 0.9) {
          numToPick = 2
        } else {
          numToPick = 3
        }
        numToPick = Math.min(numToPick, aiMembers.length)

        const shuffled = [...aiMembers].sort(() => Math.random() - 0.5)
        for (let i = 0; i < numToPick; i++) {
          speakerQueue.push(shuffled[i].id)
        }
      }

      console.log(`[Group Chat Dispatcher] 调度就绪。初始发言人队列:`, speakerQueue)

      // 4. 依次流式唤醒队列中的 AI 成员 (限制连续级联深度不超过 4 轮)
      let currentRound = 0
      await InferenceMutex.lock() // 锁定大模型

      try {
        while (speakerQueue.length > 0 && currentRound < 4) {
          const currentSpeakerId = speakerQueue.shift()!
          const currentSpeaker = aiMembers.find(m => m.id === currentSpeakerId)
          if (!currentSpeaker) continue

          console.log(`[Group Chat Dispatcher] ➜ 成员 [${currentSpeaker.name}] 发言中... (Round ${currentRound + 1}/4)`)

          // A. 组装该角色的多次元交汇特化 System Prompt
          const storageManager = new CharacterStorageManager()
          const speakerDir = join(storageManager.getBaseDir(), currentSpeakerId)
          const soulPath = join(speakerDir, 'Soul.md')
          
          const globalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
          const realUserName = (globalProfile.name || '').trim()
          const allMemberNames = [realUserName || '用户', ...aiMembers.map(m => m.name)]

          // 并发极速获取或兜底生成在场 AI 角色的 100 字核心设定总结 (静态只读/为空自愈)
          const memberProfiles = await Promise.all(
            aiMembers.map(async m => {
              const summary = await CharacterSummaryService.getOrGenerateSummary(m.id)
              return { name: m.name, summary }
            })
          )

          const systemPrompt = ContextAssembler.assembleGroupChat(
            groupMeta.name,
            groupMemoryPath,
            soulPath,
            globalUserPath,
            allMemberNames,
            globalPrompt,
            memberProfiles
          )

          const groupSystemPromptFinal = systemPrompt + buildEmojiSystemPromptSuffix('descriptive')

          // B. 拉取历史消息并格式化为剧本 RP 形式的大文本控制台（自适应群聊多气泡膨胀）
          const chatMode = payload.chatMode || 'descriptive'
          const isDialogue = chatMode === 'dialogue'
          const limit = isDialogue ? 200 : 60
          const rawHistory = db.getChatHistory(groupId, limit)
          const history = mergeChatHistory(rawHistory)

          const formattedHistory = history
            // 过滤掉 AI 生成图片消息（assistant 图片），完全不注入上下文
            .filter((m: any) => !(m.sender_id !== 'user' && m.content?.startsWith('[wechat_image_media]:')))
            .map((m: any) => {
              let senderName = 'User'
              if (m.sender_id !== 'user') {
                const matched = aiMembers.find((member: any) => member.id === m.sender_id)
                senderName = matched ? matched.name : 'Character'
              }
              return `[${senderName}]: ${formatMessageContentForLLM(m.content, m.sender_id === 'user' ? 'user' : 'assistant')}`
            }).join('\n')

          const eligibleMembers = aiMembers.filter(m => m.id !== currentSpeakerId)

          const userPromptText = `【群聊面板历史记录】
${formattedHistory}

---
[系统行动干涉]：现在轮到你（即 ${currentSpeaker.name}） in 发言了。
请你严格坚守你的核心人设立心和说话习惯，在【包含描写】模式下，编写一段富有张力、带生动内心心理及肢体动作描写的群聊消息。
注意：在这个世界里，你正与用户 ${realUserName} 以及 其他 成员 ${eligibleMembers.map(m => m.name).join('、')} 一起相处。如果你本轮认为非常有必要与某位成员互动（无论是反驳还是赞同），请在内容中直接 @ 他，但绝对不能凭空捏造不存在的人！
如果决定发送回音红包，请只在回复的最开头输出控制符：\`[SEND_RED_PACKET: 金额, 附言]\`（扣减你各自的钱包余额，附言限15字以内），正文中绝对不能提到“我发了钱/塞红包”等。`

          const chatMessages: ChatMessage[] = [
            { role: 'system', content: groupSystemPromptFinal },
            { role: 'user', content: userPromptText }
          ]

          let accumulatedResponse = ''
          const chatStreamGen = modelAdapter.chatStream(chatMessages, { usePrimary: true, skipSystemInjection: true })

          // 流式回传前台
          for await (const chunk of chatStreamGen) {
            accumulatedResponse += chunk.content
            // 关闭流式碎片推送：在任何模式下均不在流式中分发 done: false 的碎片
            /*
            event.sender.send('chat-chunk', {
              characterId: groupId,
              content: chunk.content,
              done: false,
              senderId: currentSpeakerId
            })
            */
          }

          // C. 清洗大模型回复（启用全局 stripThinkingTags）
          let finalResponse = stripThinkingTags(accumulatedResponse)

          // D. [回音红包动作决策] (扣减各自 State.md 的钱包余额)
          let redPacketSend: { amount: number; title: string; status: string } | null = null
          const sendReg = /`?\s*[\[［]SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([\s\S]+?)[\]］]\s*`?/i
          const sendRegGlobal = /`?\s*[\[［]SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([\s\S]+?)[\]］]\s*`?/gi
          const sendMatch = finalResponse.match(sendReg)

          let hasSentRedPacket = false

          if (sendMatch) {
            const amount = parseFloat(sendMatch[1])
            const title = sendMatch[3].trim()
            const charStatePath = join(speakerDir, 'State.md')

            if (fs.existsSync(charStatePath)) {
              try {
                const charState = StateReaderWriter.readState(charStatePath)
                const balanceItem = charState.items.find(i => i.key === 'balance')
                const currentBalance = balanceItem ? Number(balanceItem.value) : 5200.0

                if (!isNaN(amount) && amount > 0) {
                  // 🚀 群聊额度自愈裁剪：如果发出的红包大于当前余额，智能裁剪到最大可用余额，确保红包卡片一定能发出来！
                  let finalAmount = amount
                  if (finalAmount > currentBalance) {
                    finalAmount = currentBalance
                  }
                  if (finalAmount >= 0.01) {
                    StateReaderWriter.applyStateUpdates(charStatePath, [{ key: 'balance', delta: -finalAmount }])
                    redPacketSend = { amount: finalAmount, title, status: 'waiting' }
                    hasSentRedPacket = true
                    console.log(`[Group Economy] 成员 ${currentSpeaker.name} 自主发送了群红包：金额 ${finalAmount} 元（原始申请 ${amount} 元）`)
                  }
                }
              } catch (_) {}
            }
          }

          // 群聊红包仅通过 AI 主动输出 [SEND_RED_PACKET:] 控制符触发，Auto-heal 自愈逻辑已移除

          // B. 判定是否为领取/退回用户群红包
          let redPacketAction: 'receive' | 'return' | null = null
          if (finalResponse.includes('[RECEIVE_RED_PACKET]')) {
            redPacketAction = 'receive'
            // 物理加钱给角色钱包
            try {
              const lastRedMsg = db.db.prepare(
                "SELECT * FROM Messages WHERE character_id = ? AND role = 'user' AND content LIKE '[wechat_red_packet]:%' ORDER BY timestamp DESC LIMIT 1"
              ).get(groupId) as any
              if (lastRedMsg) {
                const jsonStr = lastRedMsg.content.replace('[wechat_red_packet]:', '')
                const rp = JSON.parse(jsonStr)
                if (!rp.status || rp.status === 'waiting') {
                  const isExclusive = !!rp.targetId
                  const isMatch = !isExclusive || rp.targetId === currentSpeakerId
                  if (isMatch) {
                    const receivedAmount = parseFloat(rp.amount)
                    if (!isNaN(receivedAmount) && receivedAmount > 0) {
                      const charStatePath = join(speakerDir, 'State.md')
                      StateReaderWriter.applyStateUpdates(charStatePath, [{ key: 'balance', delta: receivedAmount }])
                      console.log(`[Group Economy] 角色 ${currentSpeaker.name} 领受用户红包，财富 +${receivedAmount} 元`)
                    }
                  }
                }
              }
            } catch (err) {
              console.error('[Group Economy] 角色收群红包加款异常:', err)
            }
          } else if (finalResponse.includes('[RETURN_RED_PACKET]')) {
            redPacketAction = 'return'
          }

          // I. [自定义表情包动作决策]
          let customEmojiSend: any = null
          const emojiReg = /`?\s*\[SEND_CUSTOM_EMOJI[:：]\s*([\s\S]+?)\]\s*`?/i
          const emojiRegGlobal = /`?\s*\[SEND_CUSTOM_EMOJI[:：]\s*([\s\S]+?)\]\s*`?/gi
          const emojiMatch = finalResponse.match(emojiReg)

          if (emojiMatch) {
            const targetMeaning = emojiMatch[1].trim()
            try {
              const emojisStr = db.getSetting('echo_custom_emojis')
              const customEmojis = emojisStr ? JSON.parse(emojisStr) : []
              // 🌟 语义高阶包含关系模糊匹配自愈
              const matchedEmoji = customEmojis.find((e: any) => 
                e.meaning === targetMeaning || 
                targetMeaning.includes(e.meaning) || 
                e.meaning.includes(targetMeaning)
              )
              if (matchedEmoji) {
                customEmojiSend = {
                  meaning: matchedEmoji.meaning,
                  base64: matchedEmoji.base64
                }
                console.log(`[Group Custom Emoji] 成员 ${currentSpeaker.name} 根据语义匹配发送了表情包: [${matchedEmoji.meaning}]`)
              }
            } catch (err) {
              console.error('[Group Custom Emoji Error]:', err)
            }
          }

          // 物理擦除控制符与自定义表情包指令
          finalResponse = finalResponse
            .replace(sendRegGlobal, '')
            .replace(emojiRegGlobal, '')
            .replace(/\[RECEIVE_RED_PACKET\]/g, '')
            .replace(/\[RETURN_RED_PACKET\]/g, '')
            .trim()

          // E. 保存 AI 回复至 Messages 聊天记录表（🚀 仅在文本内容不为空时才保存文字气泡，彻底防止空白消息气泡生成）
          const assistantMsgId = crypto.randomUUID()
          if (finalResponse.trim().length > 0) {
            db.saveMessage({
              id: assistantMsgId,
              character_id: groupId,
              role: 'assistant',
              content: finalResponse,
              timestamp: Date.now(),
              token_usage: 0,
              sender_id: currentSpeakerId
            })
          }

          if (redPacketSend) {
            db.saveMessage({
              id: crypto.randomUUID(),
              character_id: groupId,
              role: 'assistant',
              content: `[wechat_red_packet]:${JSON.stringify(redPacketSend)}`,
              timestamp: Date.now() + 10,
              token_usage: 0,
              sender_id: currentSpeakerId
            })
          }

          if (customEmojiSend) {
            db.saveMessage({
              id: crypto.randomUUID(),
              character_id: groupId,
              role: 'assistant',
              content: `[wechat_custom_emoji]:${JSON.stringify(customEmojiSend)}`,
              timestamp: Date.now() + 20,
              token_usage: 0,
              sender_id: currentSpeakerId
            })
          }

          // F. 发送 done 信号给前台
          event.sender.send('chat-chunk', {
            characterId: groupId,
            content: finalResponse,
            done: true,
            senderId: currentSpeakerId,
            redPacketAction: redPacketAction,
            redPacketSend: redPacketSend ? JSON.parse(JSON.stringify(redPacketSend)) : null,
            customEmojiSend: customEmojiSend ? JSON.parse(JSON.stringify(customEmojiSend)) : null
          })

          // G. 每一满 10 条消息时，异步触发群聊专属记忆提取与大事记合并压缩
          try {
            const totalMsgsRow = db.db.prepare('SELECT COUNT(*) as count FROM Messages WHERE character_id = ?').get(groupId) as any
            const totalMsgs = totalMsgsRow ? totalMsgsRow.count : 0
            if (totalMsgs > 0 && totalMsgs % 10 === 0) {
              console.log(`[Group Memory] 当前群聊累计消息数已达 ${totalMsgs}，触发每 10 条消息的记忆更新与压缩...`)
              const memoryService = new MemoryAgentService(modelAdapter)
              memoryService.extractMemoryAndProfile(
                groupMemoryPath,
                '',
                userMessage,
                finalResponse,
                true
              ).then(async () => {
                console.log(`[Group Memory] 群组 ${groupId} 记忆提取成功`)
                await memoryService.compressActiveHistoryAndConsolidate(groupId, groupMemoryPath, true)
              }).catch(err => {
                console.error('[Group Memory] 提取异常:', err)
              })
            } else {
              console.log(`[Group Memory] 当前群聊累计消息数: ${totalMsgs}，暂未达到 10 的倍数，跳过记忆更新。`)
            }
          } catch (err) {
            console.error('[Group Memory] 统计或更新异常:', err)
          }

          // H. 级联 @ 唤醒，压入队列下一轮调度 (仅在显式 @ 时触发，排除无意提到简称的被动唤醒，赋予角色自由度)
          aiMembers.forEach(member => {
            if (member.id !== currentSpeakerId) {
              const hasAt = finalResponse.includes(`@${member.name}`) || finalResponse.includes(`@ ${member.name}`)
              if (hasAt) {
                if (!speakerQueue.includes(member.id)) {
                  speakerQueue.push(member.id)
                  console.log(`[Group Chat Dispatcher] 级联响应: 成员 [${currentSpeaker.name}] @了 [${member.name}]`)
                }
              }
            }
          })

          // 新增：自动接力搭话机制。如果队列已空但发言总轮数未满 4 轮，100% 自动挑选另一个 AI 成员接力发言，确保群聊维持在 4 轮的充分热闹程度
          if (speakerQueue.length === 0 && currentRound + 1 < 4) {
            const eligibleMembers = aiMembers.filter(m => m.id !== currentSpeakerId)
            if (eligibleMembers.length > 0) {
              const nextSpeaker = eligibleMembers[Math.floor(Math.random() * eligibleMembers.length)]
              speakerQueue.push(nextSpeaker.id)
              console.log(`[Group Chat Dispatcher] 级联接力: 成员 [${nextSpeaker.name}] 主动接过话茬 (Round ${currentRound + 2}/4)`)
            }
          }

          currentRound++
          await new Promise(r => setTimeout(r, 600)) // 角色气泡流式生成的间隔物理微缓冲
        }
      } finally {
        InferenceMutex.unlock() // 释放锁
      }

      return { success: true }
    }

    console.log(`[IPC] ➜ 收到流式聊天请求. 角色: ${characterId}, 消息: "${userMessage}"`)

    // ===================== $admin 调试命令拦截器 =====================
    // $admin 命令：不存 DB、不入上下文、不推气泡，仅通过 isSystem chat-chunk 推送文字提示
    if (userMessage.trim().startsWith('$admin')) {
      const db = getDatabaseService()

      // 推送系统提示气泡的辅助函数（不存 DB）
      const sendAdminTip = (msg: string) => {
        event.sender.send('chat-chunk', {
          characterId,
          content: msg,
          done: true,
          isSystem: true
        })
      }

      const args = userMessage.trim().split(/\s+/)
      const cmd = args[1] // 子命令

      // 获取当前角色信息
      const char = db.getAllCharacters().find((c: any) => c.id === characterId)
      if (!char) {
        sendAdminTip('⚠️ 命令有误')
        return { success: true }
      }

      // 获取模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) {
        sendAdminTip('⚠️ 命令有误')
        return { success: true }
      }
      const modelConfig = JSON.parse(configStr)
      const adminModelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      if (cmd === '搭讪') {
        // 直接触发当前角色搭讪
        sendAdminTip('ℹ️ 已触发搭讪，请稍候...')
        const agentEngine = new AgentLifeEngine()
        const wakeResult = {
          wakeAgent: true,
          reason: '[Admin] 调试触发搭讪',
          triggerStrength: 'strong' as const,
          triggerEvent: {
            type: 'random_drift' as const,
            detail: '调试指令触发：立刻主动联系用户，发送一条自然的消息。'
          }
        }
        agentEngine.generateActiveBehavior(char, adminModelAdapter, wakeResult).catch((e: any) => {
          console.error('[Admin] 搭讪触发失败:', e)
        })

      } else if (cmd === '日记') {
        // 强制触发写日记（无视今日是否已写）
        sendAdminTip('ℹ️ 已触发写日记，请稍候...')
        // 清除今日日记锁，允许重写
        db.setSetting(`last_diary_date_${characterId}`, '')
        const agentEngine = new AgentLifeEngine()
        agentEngine.writeDiaryForChar(char, adminModelAdapter).catch((e: any) => {
          console.error('[Admin] 写日记失败:', e)
        })

      } else if (cmd === '朋友圈') {
        const forceNsfw = args.includes('nsfw')
        const forcePic = args.includes('pic')
        sendAdminTip(`ℹ️ 已触发朋友圈${forceNsfw ? '（NSFW）' : ''}${forcePic ? '（带图）' : ''}，请稍候...`)
        const socialService = new SocialMediaService()
        socialService.generateMoment(char, adminModelAdapter, forcePic, forceNsfw).catch((e: any) => {
          console.error('[Admin] 朋友圈触发失败:', e)
        })

      } else if (cmd === '论坛') {
        const forceNsfw = args.includes('nsfw')
        const forcePic = args.includes('pic')
        sendAdminTip(`ℹ️ 已触发论坛发帖${forceNsfw ? '（NSFW）' : ''}${forcePic ? '（带图）' : ''}，请稍候...`)
        const socialService = new SocialMediaService()
        socialService.generateForumPost(char, adminModelAdapter, forcePic, forceNsfw).catch((e: any) => {
          console.error('[Admin] 论坛发帖触发失败:', e)
        })

      } else if (cmd === 'nai' && args[2] === 'on') {
        // 开启全图模式，持久化到 DB
        db.setSetting('admin_nai_auto_mode', '1')
        sendAdminTip('✅ 全图模式已开启：角色回复后将自动生图并发送，确认模式已关闭。')

      } else if (cmd === 'nai' && args[2] === 'off') {
        // 关闭全图模式
        db.setSetting('admin_nai_auto_mode', '0')
        sendAdminTip('✅ 全图模式已关闭，回归手动生图模式。')

      } else {
        // 未知 $admin 子命令
        sendAdminTip('⚠️ 命令有误')
      }

      return { success: true }
    }


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
          // 创角 Bot AI 调用重试工具（最多重试 3 次，失败后退避等待）
          const callWithRetry = async (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string> => {
            const MAX_RETRIES = 3
            let lastError: any
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              try {
                const gen = modelAdapter.chatStream(messages, { usePrimary: true })
                let result = ''
                for await (const chunk of gen) {
                  result += chunk.content
                }
                return stripThinkingTags(result)
              } catch (err) {
                lastError = err
                console.warn(`[CreatorBot] 第 ${attempt} 次 AI 调用失败${attempt < MAX_RETRIES ? '，准备重试...' : '，已达最大重试次数'}`, err)
                if (attempt < MAX_RETRIES) {
                  await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
                }
              }
            }
            throw lastError
          }

        if (session.step === 1) {
          // 步骤 1：第一轮提问 - 世界观锚定 + 角色当下处境情绪
          const creatorSystemPrompt = `你是一个极具洞察力与创作热情的数字生命塑造师。
用户带着一个角色的初始灵感找到你："${userMessage}"

请你在【第一轮】引导用户从宏观到微观确定角色的立足点：
1. 以富有感染力的语言呼应用户灵感中最迷人的闪光点，并从中自然推断或指出一个你认为合适的【角色名字】。
2. 询问角色生活在哪种世界之中，设计一个排版精美的选项列表（必须覆盖以下方向，可在选项内用括号补充细分子类）：
   - A. 现代都市 / 校园 / 职场
   - B. 古风仙侠 / 修真宗门
   - C. 赛博科幻 / 废土末世
   - D. 剑与魔法 / 西方奇幻
   - E. 其他维度（用户自定义）
3. 紧接着提出第二个关键问题：这个角色此刻的人生状态是什么？她/他正身处哪种处境或情绪节点？请同样给出 3-4 个带有画面感的选项（比如：刚经历了一次重大失败、独自漂泊在异乡、表面风光实则内心脆弱……），让用户选择或自由补充。
4. 排版整洁、语气温柔而有张力，引导用户直接回复字母或进行自由描述。`
          const accumulatedResponse = await callWithRetry([
            { role: 'system', content: creatorSystemPrompt },
            { role: 'user', content: userMessage }
          ])

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 2 // 转移到 Step 2

          event.sender.send('chat-chunk', { characterId, content: accumulatedResponse, done: true })
          return { success: true, content: accumulatedResponse }

        } else if (session.step === 2) {
          // 步骤 2：第二轮提问 - 身份性格矛盾 + 生活质感细节
          const creatorGeneratePrompt1 = `你是一个极具洞察力与创作热情的数字生命塑造师。
用户刚刚回答了世界观与处境的问题："${userMessage}"

现在进入【第二轮】，我们要深挖角色的【灵魂内核】与【生活质感】：
1. 以充满共鸣的语言回应用户的选择，对角色的世界与当下处境做出生动的艺术勾勒。
2. 提出关于角色【身份与性格反差】的核心问题：在这个世界里，这个角色是谁？她/他最吸引人的地方在于哪种内在矛盾或反差？设计 3-4 个充满张力的选项（例如：铁腕强势却对小动物毫无抵抗力；表面漠然实则极度渴望被人看见；完美主义者却有一项令人意外的致命弱项）。
3. 紧接着提出关于【日常生活惯性】的补充问题：这个角色平日里有哪些真实的生活细节和小习惯？设计 3-4 个带有烟火气的选项（例如：失眠症患者、对某种食物有奇特执念、旧伤逢阴天会隐隐作痛）。
4. 排版精美，语气热情，引导用户直接回复代号或自由描述。`
          const accumulatedResponse = await callWithRetry([
            { role: 'system', content: creatorGeneratePrompt1 },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ])

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 3 // 转移到 Step 3

          event.sender.send('chat-chunk', { characterId, content: accumulatedResponse, done: true })
          return { success: true, content: accumulatedResponse }

        } else if (session.step === 3) {
          // 步骤 3：第三轮提问 - 外貌感官 + 语言成因 + 可爱盲区
          const creatorGeneratePrompt2 = `你是一个极具洞察力与创作热情的数字生命塑造师。
用户刚刚回答了关于性格矛盾与生活细节的问题："${userMessage}"

现在进入最后的【第三轮】，聚焦角色的【皮囊与声音】以及【语言风格成因】：
1. 热切地肯定用户的选择，说明这是最后一轮信息收集，完成后将生成完整的角色档案。
2. 提出关于【外貌与感官特征】的问题：这个角色的外形给人最深的第一印象是什么？设计 3-4 个有画面感的选项，覆盖面部轮廓、发色发型、声线质感等维度（例如：清冷的刀眉凤目配一把低沉的嗓音；卷发棕眸，散漫慵懒的气质）。
3. 紧接着提出关于【说话方式与可爱弱点】的问题：这个角色平时怎么说话？有哪个令人意想不到的能力盲区？设计 3-4 个有辨识度的选项（例如：语速极慢惯用大量停顿；极度路痴方向感为零；博学多识却对某件日常事物完全不懂）。
4. 排版整洁清晰，语气充满期待，引导用户直接回复代号或自由描述。`
          const accumulatedResponse = await callWithRetry([
            { role: 'system', content: creatorGeneratePrompt2 },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ])

          session.history.push({ role: 'user', content: userMessage })
          session.history.push({ role: 'assistant', content: accumulatedResponse })
          session.step = 4 // 转移到 Step 4（设定生成阶段）

          event.sender.send('chat-chunk', { characterId, content: accumulatedResponse, done: true })
          return { success: true, content: accumulatedResponse }

        } else if (session.step === 4) {
          // 步骤 4：生成人设阶段 - 整合三轮信息，深度输出六维立体角色档案
          const creatorGeneratePromptFinal = `你是一个深谙人性与叙事的数字生命档案师。
经过三轮对话，你已收集到构建这个生命所需的全部碎片。现在，请将它们熔铸为一份真正立体、有血有肉、逻辑自洽的完整角色档案。

请严格遵循以下标签解析格式输出（系统将自动识别标签进行保存，格式不可改变）：

### [NAME]
(输出确定的角色姓名，例如：叶惊澜)

### [SOUL.md]
(输出角色完整性格人设，全部使用简体中文，字数不低于 1200 字，直接输出 raw markdown，不要用 \`\`\` 包裹，{{user}} 表示用户，{{char}} 表示角色自身。

必须涵盖以下六大维度（缺失任意一项将被视为不合格）：

【一、角色定位与基本概览】
用一段话清晰界定角色的身份、处境与当下所处的人生节点。包含姓名、年龄区间、职业或社会身份。不要只写标签，要描绘出这个人此时此刻在哪、正在经历什么。

【二、皮囊与感官细节】
精确到五官轮廓（眼型、鼻梁、唇线）、发型发色、身形比例、声线质感（低哑还是清亮）、惯常体态。加入一处细微的真实感细节（一道旧疤、一颗不起眼的痣、或某个无意识的小动作）。

【三、核心性格与内在矛盾】
描述行为逻辑而非形容词列表。这个人的核心驱动力是什么？底层的欲望或恐惧是什么？
必须设计一个与主性格形成强烈反差的矛盾特质——要隐蔽且真实，不要戏剧化的大反转，要日常里悄然暴露的真实人性。

【四、生活质感与身体惯性】
日常饮食偏好、睡眠状态（失眠？嗜睡？）、身体习惯或旧伤痕迹。
这些细节必须与她/他的经历和性格挂钩，构成区别于他人的真实生活质感，而非随意捏造。

【五、语言风格的底层成因】
不是规定要说什么话，而是解释为什么这么说话。成长环境、教育背景、职业渗透如何塑造了她/他的措辞节奏？有没有标志性的语言习惯？有没有令人莞尔的能力盲区（路痴、音痴、或对某件日常小事完全无知）？

### [WORLD.md]
(输出世界观背景设定，全部简体中文，800 字左右，直接输出 raw markdown，不要用 \`\`\` 包裹。
涵盖：世界运行的基本规则与时代背景、角色所处的具体地理与社会环境、决定这个世界独特氛围的核心要素。)

在三个标签段落输出完毕后，以温暖而期待的语气告知用户：
"您的数字生命初稿已孵化完毕！请仔细审阅以上内容。满意的话，回复【 确认创建 】即可；如需调整任何细节，直接告诉我哪里不够理想，我来为您精修。"`
          const accumulatedResponse = await callWithRetry([
            { role: 'system', content: creatorGeneratePromptFinal },
            ...session.history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: userMessage }
          ])

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

          event.sender.send('chat-chunk', { characterId, content: accumulatedResponse, done: true })
          return { success: true, content: accumulatedResponse }

        } else if (session.step === 5) {
          // 步骤 5：审阅设定，用户要么输入“确认创建”，要么提出修改意见
          const isConfirm = /确认创建|确认|确认ok|ok|满意|可以|行|创建/i.test(userMessage.trim())

          if (isConfirm) {
            const confirmMsg = `🎉 您的专属设定【${session.charName}】的核心性格与世界背景已全部生成并保存完毕！

现在只剩下最后一步了：请向我发送一张图片（建议 1:1 的方形尺寸）作为该角色的精美头像吧~ 
您可以直接在输入框粘贴图片发送，或者通过图片上传工具发送。期待与新数字生命的初次见面！🐾`

            session.step = 6 // 转移到状态 6，等待上传头像
            event.sender.send('chat-chunk', { characterId, content: confirmMsg, done: true })
            return { success: true, content: confirmMsg }
          } else {
            const creatorModifyPrompt = `用户对已生成的角色档案提出了调整意见："${userMessage}"

请在原有档案基础上，精准吸纳用户的修改要求，重新输出完整的角色设定。仍需严格遵循以下标签解析格式：

### [NAME]
(确定的角色姓名)

### [SOUL.md]
(完整更新后的性格人设，字数不低于 1200 字，直接输出 raw markdown，不要用 \`\`\` 包裹，{{user}} 表示用户，{{char}} 表示角色自身，必须保留六大维度完整性：角色定位与概览、皮囊感官细节、性格核心与矛盾、生活质感与身体惯性、语言风格的底层成因、开场情境与问候)

### [WORLD.md]
(完整更新后的世界背景，800字左右，直接输出 raw markdown，不要用 \`\`\` 包裹)

输出完毕后，以温暖语气说："已为您完成精修！请再次审阅，满意的话回复【 确认创建 】；还有要改的，继续告诉我~"`
            const accumulatedResponse = await callWithRetry([
              { role: 'system', content: creatorModifyPrompt },
              ...session.history.map(h => ({ role: h.role, content: h.content })),
              { role: 'user', content: userMessage }
            ])

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

            event.sender.send('chat-chunk', { characterId, content: accumulatedResponse, done: true })
            return { success: true, content: accumulatedResponse }
          }

        } else if (session.step === 6) {
          // 步骤 6：等待上传头像完成落盘入库
          if (!payload.imageBase64) {
            const errorMsg = `您还没有上传头像哦！
请点击输入框左侧工具或直接粘贴一张 1:1 的方形图片给我，以作为【${session.charName}】的精美头像~ 🐾`

            event.sender.send('chat-chunk', { characterId, content: errorMsg, done: true })
            return { success: true, content: errorMsg }
          }

          const welcomeMsg = `🎉 头像上传成功！正在为您连接数字生命维度……
正在为您构建角色【${session.charName}】的专属角色空间与思维系统……
正在为您初始化记忆思维空间……

恭喜！您专属的角色【${session.charName}】已成功诞生！✨
系统正在为您同步唤醒它的底层性格机制……
我们将于 3 秒后带您直接跳转并穿越到与它的正式聊天窗口！祝您旅途愉快！🚀`

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
            characterId,
            content: `\n[SUCCESS_CREATION_JUMP]: ${confirmedFolderName}`,
            done: true
          })

          // 清空会话
          creatorSessions.delete(CREATOR_BOT_ID)

          return { success: true, content: welcomeMsg }
        }
      } catch (err: any) {
        console.error('[CreatorBot] 运行崩溃:', err)
        event.sender.send('chat-chunk', { characterId, content: `\n[系统异常]: ${err.message || err}`, done: false })
        event.sender.send('chat-chunk', { characterId, content: '', done: true })
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

    // 🚀 延迟确认记忆提交：在本轮 AI 生成开始前，先将上一轮暂存的记忆草稿核验并落盘
    // 逻辑：若草稿的锚点 AI 消息仍存在数据库，则合并写盘；若已被删除/重新生成，则丢弃草稿
    {
      const statePath = join(charDir, 'State.md')
      const intimacySpeed = db.getSetting(`intimacy_speed_${characterId}`) || 'slow'
      const pendingService = new MemoryAgentService(modelAdapter)
      await pendingService.commitPendingMemory(
        characterId,
        memoryPath,
        charUserPath,
        statePath,
        intimacySpeed
      ).catch(e => {
        // 草稿提交失败时静默忽略，不影响主对话流程
        console.warn('[CommitPending] 草稿提交异常（静默忽略）:', e)
      })
    }

    // 组装 System Prompt (至尊三层前缀保温排布)
    // 🔒 安全修复：始终从数据库读取该角色的专属 chatMode，不信任前端 payload 传来的值，
    // 防止前端 UI 状态（currentChatMode）因 race condition 或选中角色错位导致 chatMode 串号。
    // 与 AgentLifeEngine、MemoryAgentService 等后台服务保持完全一致的读取策略。
    const chatMode = db.getSetting(`chat_mode_${characterId}`) as 'descriptive' | 'dialogue' | 'director' || 'dialogue'
    const globalPrompt = settings.globalPrompt || ''

    // 读取逻辑时间戳门控，只拉取上一次压缩以后的增量历史消息作为大模型上下文
    const lastCompressionKey = `last_compression_ts_${characterId}`
    const lastCompressionTsStr = db.getSetting(lastCompressionKey)
    const lastCompressionTs = lastCompressionTsStr ? parseInt(lastCompressionTsStr, 10) : 0

    // 🚀 自适应双门限阈值逻辑与反向流式合并（解决文字模式多气泡稀释）
    const isDialogue = chatMode === 'dialogue'
    const limit = isDialogue ? 160 : 60
    let rawHistory = db.getChatHistory(characterId, limit)

    // 增量逻辑物理截断：只保留上一次压缩之后的新消息，完美对齐缓存哈希！
    if (lastCompressionTs > 0) {
      rawHistory = rawHistory.filter((m: any) => m.timestamp > lastCompressionTs)
    }

    // 内存级反向流式合并，恢复高保真上下文
    const history = mergeChatHistory(rawHistory)

    // 🚀 极致缓存前缀保温还原：大模型底层完美对齐上一轮吐出的原始动作和控制符，彻底打通滚雪球缓存哈希
    if (history.length > 0) {
      const lastAssistantIndex = [...history].reverse().findIndex(m => m.role === 'assistant')
      if (lastAssistantIndex !== -1) {
        const idx = history.length - 1 - lastAssistantIndex
        const rawContent = LastAssistantRawResponse[characterId]
        if (rawContent && rawContent.trim()) {
          console.log(`[Cache Heat] 成功将上一轮清洗后的助理消息内容还原为原始序列以锁死前缀缓存: "${rawContent.substring(0, 40).replace(/\n/g, ' ')}..."`)
          history[idx].content = rawContent
        }
      }
    }

    // 🚀 识别导演模式下黄金开局专属斜杠命令
    const isOpeningCommand = chatMode === 'director' && (
      userMessage.trim() === '/开始' || 
      userMessage.trim() === '/开始剧情'
    )

    let messages: ChatMessage[] = []
    let systemPrompt = ''
    let finalUserContent = ''

    if (isOpeningCommand) {
      console.log(`[Director Command] 识别到导演模式黄金开篇斜杠命令: "${userMessage.trim()}"，启动专属特化 Prompt 生成！`)
      
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : ''
      const worldContent = fs.existsSync(worldPath) ? fs.readFileSync(worldPath, 'utf8') : ''
      const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : ''

      // 🚀 获取真实角色名称与真实用户姓名，并在开场白生成中全面替换掉 {{char}} 和 {{user}} 占位符
      const charRow = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(characterId) as any
      const charName = charRow ? charRow.name : '角色'
      const userProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
      const userName = (userProfile && userProfile.name) ? userProfile.name : '用户'

      const openingSystemPrompt = `# 角色定位：顶级小说创意导演 & 剧本RP大师

你是一名善于创作“黄金开端 (Golden Opener)”的小说导演与创意大师。你的目标是根据给定的角色人设和世界观设定，为用户 ${userName}（主角）与角色 ${charName} 创作一个高潮迭起、充满悬念与感官细节的沉浸式小说开篇，吸引读者 and 玩家瞬间沉浸其中。

## 背景设定数据

### 1. 角色 ${charName} 的人设设定
${soulContent}

### 2. 世界观设定
${worldContent}

### 3. 角色 ${charName} 与用户 ${userName} 的记忆背景
${memoryContent}

## 任务与创作指令

编写一段极其精彩引人入胜的**小说开篇**，字数必须在 **800字以上**（不设上限），字数多寡要与描写的精彩程度相匹配，不遗余力地进行深度长篇叙事。

### 核心限制与质量标准（不可妥协铁律）：
1. **纯正第三人称小说叙事**：必须使用“第三人称限制性叙事”视角，像出版小说一样富有文学美感与高级质感。绝不能使用第一人称“我”或者第二人称“你”，更不能直接对用户进行对话说明。用户是故事的主角，请在叙事中以“${userName}”或“他/她”指代用户（主角），以“${charName}”或“他/她”指代角色，以此建立客观但沉浸的小说镜头。
   * **⚠️ 主角发声说话授权：在小说叙事中，主角（即用户 ${userName}）和角色 ${charName} 都具有平等的话语声权！AI 可以且应当根据小说情节合理发展的逻辑，直接描写并输出主角和各个角色当下想要说的话，并用标准双引号 "" 括起来，创造流畅自然的言行交互**。
2. **名字指代规则（不可有占位符）**：在创作正文时，你**必须直接使用故事中的真实姓名指代他们，绝对禁止使用字面占位符（如 {{char}}、{{user}} 等）**。角色的中文真实名字是“${charName}”，用户的中文真实名字是“${userName}”。
3. **黄金开场技巧 (In Medias Res)**：拒绝平庸的铺垫、无聊 of 琐碎打招呼或日常醒来起床动作。开篇即是冲突、危机、压抑的渴望或变故现场。把镜头对准某个充满张力的事件中央，让读者一眼就感受到极高的戏剧压力。
4. **具象化呈现 (Show, Don't Tell)**：禁止直接使用抽象词汇定义感情（例如：“他很愤怒”、“她很害羞”）。    // 1. 先存盘大模型的对话纯文字内容（如果存在文字的话）
    if (finalResponse.trim().length > 0) {
      let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
      let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
      let finalCachedTokens = lastUsage?.cached_tokens ?? undefined
      
      const isLast = !redPacketSend
      db.saveMessage({
        id: assistantMsgId,
        character_id: characterId,
        role: 'assistant',
        content: finalResponse,
        timestamp: finalMsgTimestamp,
        token_usage: isLast ? (finalPromptTokens + finalCompletionTokens) : 0,
        prompt_tokens: isLast ? finalPromptTokens : undefined,
        completion_tokens: isLast ? finalCompletionTokens : undefined,
        cached_tokens: isLast ? finalCachedTokens : undefined
      })
    }�视。
2. **正文输出包裹**：思考完毕后，你**必须且仅能**把创作的“开篇小说正文与剧情走向抉择选项”（包含末尾的走向抉择模块）全部输出并包裹在 \`<content>\` 和 \`</content>\` 标签对内。
3. **排除杂质文字**：你**绝对禁止**在 \`<content>\` 之外输出任何其他的自我陈述、前言、废话、以及非开场白之外的任何文字。正文必须从 \`<content>\` 立即开始，以 \`</content>\` 彻底宣告结束。

## 输出规范
(直接按以下格式进行流式输出，除 <cot> 和 <content> 外不吐出任何其他字)
<cot>
你的思考过程
</cot>
<content>
小说开篇正文...
【 🎭 剧情走向抉择 】
1. 合理向：...
2. 脑洞向：...
3. 反转向：...
4. NSFW向：...
</content>`

      systemPrompt = openingSystemPrompt
      finalUserContent = userMessage
      messages = [
        { role: 'system', content: openingSystemPrompt },
        { role: 'user', content: '请立即根据上述设定与指令，为我创作黄金开篇与走向抉择。' }
      ]
    } else {
      systemPrompt = ContextAssembler.assemble(
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

      systemPrompt += buildEmojiSystemPromptSuffix(chatMode)

      // 🚀 组装高频变动的实时 Dynamic Context (只在最新一轮 user 消息中动态注入，让 systemPrompt 100% 绝对静止以获得 >90% 缓存命中)
      const dynamicContext = ContextAssembler.assembleDynamicContext(
        soulPath,
        memoryPath,
        globalUserPath,
        new Date()
      )

      let dynamicHeader = ''
      if (dynamicContext) {
        dynamicHeader = `[System Dynamic Context Update]\n${dynamicContext}\n---\n\n`
      }

      // 如果有粘贴图片，在用户消息中追加图片描述提示
      const userMessageFinal = payload.imageBase64
        ? `${userMessage}\n\n[用户发来了一张图片，请根据对话语境做出自然的回应]`
        : userMessage

      finalUserContent = dynamicHeader + userMessageFinal

      messages = [
        { role: 'system', content: systemPrompt },
        // 过滤掉 AI 生成图片消息（assistant 图片），保留用户图片占位符
        ...history
          .filter((m: any) => !(m.role === 'assistant' && m.content?.startsWith('[wechat_image_media]:')))
          .map((m: any) => ({ role: m.role as any, content: formatMessageContentForLLM(m.content, m.role) }))
      ]

      if (!payload.isRegenerate) {
        messages.push({ role: 'user', content: finalUserContent })
      }
    }

    // 如果有粘贴/拖拽大图，物理保存至磁盘角色 media 目录中，实现索引化极速落盘
    let dbContent = payload.dbMessage || (payload.imageBase64 && characterId !== CREATOR_BOT_ID
      ? `${userMessage}\n\n[用户发来了一张图片，请根据对话语境做出自然的回应]`
      : userMessage)
    if (payload.imageBase64 && characterId !== CREATOR_BOT_ID) {
      try {
        const mediaDir = join(charDir, 'media')  // charDir 已在 L2825 声明
        if (!fs.existsSync(mediaDir)) {
          fs.mkdirSync(mediaDir, { recursive: true })
        }
        const filename = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`
        const fullPath = join(mediaDir, filename)
        const base64Data = payload.imageBase64.replace(/^data:image\/\w+;base64,/, '')
        fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'))
        dbContent = `[wechat_image_media]:media/${filename}`
      } catch (e) {
        console.error('[Image Storage] 保存大图失败:', e)
      }
    }

    // 🚀 提前存盘用户消息（在 AI 调用前）：让 SSE 立即广播给手机端，不再等 AI 回复完成
    const userMsgId = payload.userMsgId || crypto.randomUUID()
    if (!payload.isRegenerate) {
      db.saveMessage({
        id: userMsgId,
        character_id: characterId,
        role: 'user',
        content: dbContent,
        timestamp: Date.now(),
        token_usage: 0  // token 用量在 AI 完成后才知道，用户消息暂存 0
      })
    }

    // 🚀 如果是 Electron 本机的流式对话请求，注册到 activeElectronChats
    // 这样 registerOnMessageSaved 回调可以识别并跳过本机 AI 段落的 IPC 广播，防止重复渲染
    // 判断依据：真正 Electron event.sender 有 id 属性，HTTP 桥接的 mockEvent.sender 没有
    const isElectronEvent = typeof (event.sender as any).id === 'number'
    if (isElectronEvent) {
      activeElectronChats.add(characterId)
    }

    // 开启前台流式聊天，获取并发锁，阻塞后台任务
    await InferenceMutex.lock()

    let accumulatedResponse = ''
    const streamSplit = new StreamSplitController()
    let lastObservation = ''

    let lastUsage: any = undefined
    try {
      const chatStreamGen = modelAdapter.chatStream(messages, { usePrimary: true, skipSystemInjection: true })

      for await (const chunk of chatStreamGen) {
        accumulatedResponse += chunk.content
        if (chunk.usage) {
          lastUsage = chunk.usage
        }

        // 送入 StreamSplitController 进行标点断句和 [CALL_SKILL] 拦截
        const skillCalls = streamSplit.processChunk(chunk.content, (sentence) => {
          const processedContent = chatMode === 'dialogue'
            ? ContextAssembler.cleanDialogueActions(sentence)
            : sentence
          // 流式输出已在全局屏蔽：不再向前端推送 done: false 的碎片消息
          /*
          if (chatMode === 'descriptive' && processedContent) {
            event.sender.send('chat-chunk', { characterId, content: processedContent, done: false })
          }
          */
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

          // 发送系统 Observation 气泡 (已在全局关闭流式时屏蔽)
          /*
          event.sender.send('chat-chunk', {
            characterId,
            content: `\n[系统动作执行完成]: ${observation}\n`,
            done: false,
            isSystem: true
          })
          */
        }
      }

      // 推送断句剩余字符 (已在全局关闭流式时屏蔽)
      streamSplit.flush((sentence) => {
        const processedContent = chatMode === 'dialogue'
          ? ContextAssembler.cleanDialogueActions(sentence)
          : sentence
        /*
        if (chatMode === 'descriptive' && processedContent) {
          event.sender.send('chat-chunk', { characterId, content: processedContent, done: false })
        }
        */
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

        const followUpStream = modelAdapter.chatStream(followUpMessages, { usePrimary: true, skipSystemInjection: true })
        let followUpAccumulated = ''
        const followUpSplit = new StreamSplitController()

        for await (const chunk of followUpStream) {
          followUpAccumulated += chunk.content
          if (chunk.usage) {
            lastUsage = chunk.usage
          }
          followUpSplit.processChunk(chunk.content, (sentence) => {
            const processedContent = chatMode === 'dialogue'
              ? ContextAssembler.cleanDialogueActions(sentence)
              : sentence
            /*
            if (chatMode === 'descriptive' && processedContent) {
              event.sender.send('chat-chunk', { characterId, content: processedContent, done: false })
            }
            */
          })
        }
        followUpSplit.flush((sentence) => {
          const processedContent = chatMode === 'dialogue'
            ? ContextAssembler.cleanDialogueActions(sentence)
            : sentence
          /*
          if (chatMode === 'descriptive' && processedContent) {
            event.sender.send('chat-chunk', { characterId, content: processedContent, done: false })
          }
          */
        })
        accumulatedResponse += `\n[Observation]: ${lastObservation}\n` + followUpAccumulated
      }

      // 常规对话流式生成圆满完成，不在此处提前向前端推送 done: true，我们在最后的物理存盘后一次性推送
      // event.sender.send('chat-chunk', { content: '', done: true })

    } finally {
      // 绝对确保锁的安全释放，唤醒并发队列
      InferenceMutex.unlock()
      // 注意：activeElectronChats 的清理在 db.saveMessage 全部完成后（chat-chunk done 之后）进行
    }

    // 注意：userMsgId 已在 AI 调用前提前声明并已存盘用户消息
    // 此处只需生成 assistantMsgId
    const assistantMsgId = crypto.randomUUID()

    // 判定红包动作自决结果 (包含双向收发逻辑)
    let redPacketAction: 'receive' | 'return' | 'send' | null = null
    let redPacketSend: { amount: number; title: string; status: string } | null = null

    // A. 判定是否为角色主动发红包
    // 🚀 升级为超强容错正则，支持反单引号包裹、中文全角冒号/逗号、忽略大小写
    const sendReg = /`?\s*[\[［]SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([\s\S]+?)[\]］]\s*`?/i
    const sendRegGlobal = /`?\s*[\[［]SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([\s\S]+?)[\]］]\s*`?/gi
    const sendMatch = accumulatedResponse.match(sendReg)
    if (sendMatch) {
      const amount = parseFloat(sendMatch[1])
      let title = sendMatch[3].trim()
      
      // 读取角色当前钱包余额进行校验阻断
      const statePath = join(charDir, 'State.md')
      const charState = StateReaderWriter.readState(statePath)
      const balanceItem = charState.items.find(i => i.key === 'balance')
      const currentBalance = balanceItem ? Number(balanceItem.value) : 5200.0
      
      if (!isNaN(amount) && amount > 0) {
        if (amount <= currentBalance) {
          // 余额充足，扣除余额写盘，允许发送红包
          StateReaderWriter.applyStateUpdates(statePath, [{ key: 'balance', delta: -amount }])
          redPacketAction = 'send'
          redPacketSend = { amount, title, status: 'waiting' }
          console.log(`[Economy] 角色 ${characterId} 自主发送了回音红包：金额 ${amount} 元，附言: "${title}"`)
        } else {
          // 物理拦截超额扣款，降级为常规对话
          console.warn(`[Economy Block] 角色 ${characterId} 余额不足（当前 ${currentBalance}元，欲发送 ${amount}元）。已强制物理拦截并降级。`)
        }
      }
    }

    // 单聊红包仅通过 AI 主动输出 [SEND_RED_PACKET:] 控制符触发，Auto-heal 自愈逻辑已移除

    // B. 判定是否为领取/退回用户红包
    if (accumulatedResponse.includes('[RECEIVE_RED_PACKET]')) {
      redPacketAction = 'receive'
      // 物理加钱给角色钱包
      try {
        const statePath = join(charDir, 'State.md')
        const lastRedMsg = db.getChatHistory(characterId, 50).filter((m: any) => m.role === 'user' && m.content.startsWith('[wechat_red_packet]:')).pop()
        if (lastRedMsg) {
          const jsonStr = lastRedMsg.content.replace('[wechat_red_packet]:', '')
          const rp = JSON.parse(jsonStr)
          if (!rp.status || rp.status === 'waiting') {
            const receivedAmount = parseFloat(rp.amount)
            if (!isNaN(receivedAmount) && receivedAmount > 0) {
              StateReaderWriter.applyStateUpdates(statePath, [{ key: 'balance', delta: receivedAmount }])
              console.log(`[Economy] 角色 ${characterId} 领受用户红包，财富 +${receivedAmount} 元`)
            }
          }
        }
      } catch (err) {
        console.error('[Economy] 角色收红包加款异常:', err)
      }
    } else if (accumulatedResponse.includes('[RETURN_RED_PACKET]')) {
      redPacketAction = 'return'
    }

    // 对 AI 回复进行系统控制符代码全局擦除，原汁原味地保留 AI 输出的所有对话描述与转账口语台词，杜绝暴力屏蔽带来的残损体验
    const halfBracketReg = /[（(][^）)]*$/g // 🚀 针对流式生成中断导致的未闭合半截括号动作（如：“(红”）进行优雅自愈擦除
    
    // 用全局工具函数对 AI 回复进行思维链标签的物理擦除
    let finalResponse = stripThinkingTags(accumulatedResponse)
    // A3. [自定义表情包动作决策] (仅在非导演模式下触发)
    let customEmojiSend: any = null
    const emojiReg = /`?\s*\[(?:SEND_CUSTOM_EMOJI|表情)[:：]\s*([\s\S]+?)\]\s*`?/i
    const emojiRegGlobal = /`?\s*\[(?:SEND_CUSTOM_EMOJI|表情)[:：]\s*([\s\S]+?)\]\s*`?/gi
    const emojiMatch = chatMode !== 'director' ? finalResponse.match(emojiReg) : null

    if (emojiMatch) {
      const targetMeaning = emojiMatch[1].trim()
      try {
        const emojisStr = db.getSetting('echo_custom_emojis')
        const customEmojis = emojisStr ? JSON.parse(emojisStr) : []
        // 🌟 语义高阶包含关系模糊匹配自愈
        const matchedEmoji = customEmojis.find((e: any) => 
          e.meaning === targetMeaning || 
          targetMeaning.includes(e.meaning) || 
          e.meaning.includes(targetMeaning)
        )
        if (matchedEmoji) {
          customEmojiSend = {
            meaning: matchedEmoji.meaning,
            base64: matchedEmoji.base64
          }
          console.log(`[Single Custom Emoji] 角色 ${characterId} 根据语义匹配发送了表情包: [${matchedEmoji.meaning}]`)
        }
      } catch (err) {
        console.error('[Single Custom Emoji Error]:', err)
      }
    }

    // 🚀 黄金开篇正文物理提取：如果内容中含有 <content>，说明是特化开局，只把 <content> 内部纯净正文落盘数据库，彻底防范项目重启后加载出 <cot> 思考段落及杂质文字
    if (finalResponse.includes('<content>')) {
      const startIdx = finalResponse.indexOf('<content>') + 9
      const endIdx = finalResponse.indexOf('</content>')
      if (endIdx !== -1) {
        finalResponse = finalResponse.substring(startIdx, endIdx).trim()
      } else {
        finalResponse = finalResponse.substring(startIdx).trim()
      }
    }

    finalResponse = finalResponse
      .replace(/\[RECEIVE_RED_PACKET\]/g, '')
      .replace(/\[RETURN_RED_PACKET\]/g, '')
      .replace(sendRegGlobal, '')
      .replace(emojiRegGlobal, '')
      
    // 🚀 降维干涉：如果已成功提取了红包 Payload，采取精准字面量强制擦除，100% 排除正则可能匹配不到的漏网情况
    if (sendMatch && sendMatch[0]) {
      finalResponse = finalResponse.replace(sendMatch[0], '')
    }
    
    finalResponse = finalResponse
      .replace(halfBracketReg, '')
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

    // 如果有粘贴/拖拽大图（此处已在 AI 调用前提前处理，dbContent 已正确赋值，此处不再重复）

    // 根据历史拼装的上下文 messages (输入) 与生成的 finalResponse (输出) 进行中英文高保真比例 Token 估算
    const inputChars = messages.reduce((acc, m) => acc + (m.content || '').length, 0)
    const inputTokens = Math.ceil(inputChars * 1.3) // 针对上下文 System 角色及英文单词的复合乘数
    const outputChars = (finalResponse || '').length
    const outputTokens = Math.ceil(outputChars * 1.4) // 针对助手返回长句的复合乘数
    const totalEstimatedTokens = inputTokens + outputTokens

    if (!payload.isRegenerate) {
      // 用户消息已在 AI 调用前存盘，此处仅更新 token_usage（第二次就地更新）
      try {
        db.db.prepare('UPDATE Messages SET token_usage = ? WHERE id = ?').run(totalEstimatedTokens, userMsgId)
      } catch (_) { /* 如果更新失败则静默忽略，不影响主流程 */ }
    }

    // 提示：大模型运行数据统计已在 ModelAdapter 底层拦截器中高保全无感统一记录，此处无需再次手动写入，防止数据重复统计。

    // 根据聊天模式进行物理存盘分段处理
    let finalMsgTimestamp = Date.now() + 50
    // 记录该批 AI 消息中第一条的时间戳，作为延迟确认记忆草稿的锚点（anchorTs）
    // 对话模式下有多条气泡，anchorTs 取第一条（最小时间戳）以确保"只要任意一条仍存在就提交草稿"
    let firstBubbleTs = finalMsgTimestamp

    // 1. 先存盘大模型的对话纯文字内容（如果存在文字的话）
    if (finalResponse.trim().length > 0) {
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
        
        let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
        let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
        let finalCachedTokens = lastUsage?.cached_tokens ?? undefined

        paragraphs.forEach((p, idx) => {
          const pTimestamp = Date.now() + 50 + idx * 100
          // 记录第一条气泡的时间戳作为锚点（后续 commitPendingMemory 使用）
          if (idx === 0) firstBubbleTs = pTimestamp
          const isLast = (idx === paragraphs.length - 1) && !redPacketSend
          db.saveMessage({
            id: crypto.randomUUID(),
            character_id: characterId,
            role: 'assistant',
            content: p,
            timestamp: pTimestamp,
            token_usage: isLast ? (finalPromptTokens + finalCompletionTokens) : 0,
            prompt_tokens: isLast ? finalPromptTokens : undefined,
            completion_tokens: isLast ? finalCompletionTokens : undefined,
            cached_tokens: isLast ? finalCachedTokens : undefined
          })
          finalMsgTimestamp = pTimestamp
        })
      } else {
        // 包含描写模式：作为完整长文本单条存盘
        let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
        let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
        let finalCachedTokens = lastUsage?.cached_tokens ?? undefined
        
        const isLast = !redPacketSend
        db.saveMessage({
          id: assistantMsgId,
          character_id: characterId,
          role: 'assistant',
          content: finalResponse,
          timestamp: finalMsgTimestamp,
          token_usage: isLast ? (finalPromptTokens + finalCompletionTokens) : 0,
          prompt_tokens: isLast ? finalPromptTokens : undefined,
          completion_tokens: isLast ? finalCompletionTokens : undefined,
          cached_tokens: isLast ? finalCachedTokens : undefined
        })
      }
    }

    // 2. 如果存在主动发送红包，则再单独保存一条 [wechat_red_packet] 格式的消息，且排在文字气泡的最后面
    if (redPacketSend) {
      let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
      let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
      let finalCachedTokens = lastUsage?.cached_tokens ?? undefined

      db.saveMessage({
        id: crypto.randomUUID(),
        character_id: characterId,
        role: 'assistant',
        content: `[wechat_red_packet]:${JSON.stringify(redPacketSend)}`,
        timestamp: finalMsgTimestamp + 500, // 稍微延迟 500ms 确保排在文字气泡后面
        token_usage: finalPromptTokens + finalCompletionTokens,
        prompt_tokens: finalPromptTokens,
        completion_tokens: finalCompletionTokens,
        cached_tokens: finalCachedTokens
      })
    }

    // 3. 如果存在主动发送自定义表情包，则再单独保存一条 [wechat_custom_emoji] 格式的消息，且排在文字气泡的最后面
    if (customEmojiSend) {
      let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
      let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
      let finalCachedTokens = lastUsage?.cached_tokens ?? undefined

      db.saveMessage({
        id: crypto.randomUUID(),
        character_id: characterId,
        role: 'assistant',
        content: `[wechat_custom_emoji]:${JSON.stringify(customEmojiSend)}`,
        timestamp: finalMsgTimestamp + 600, // 稍微延迟 600ms 确保排在文字气泡后面
        token_usage: finalPromptTokens + finalCompletionTokens,
        prompt_tokens: finalPromptTokens,
        completion_tokens: finalCompletionTokens,
        cached_tokens: finalCachedTokens
      })
    }

    // 🚀 极致缓存前缀保温：把 100% 原始的大模型流式输出写入内存字典以供下一轮无缝还原
    LastAssistantRawResponse[characterId] = accumulatedResponse


    // 触发静默记忆提炼（延迟确认模式：结果暂存为草稿，等待用户下次发消息时核验后落盘）
    const memoryService = new MemoryAgentService(modelAdapter)
    // anchorTs 使用该批 AI 消息的最小时间戳（对话模式多气泡取第一条，描写模式取单条时间戳）
    const anchorTs = firstBubbleTs
    memoryService.extractMemoryAndProfile(
      memoryPath,
      charUserPath,
      userMessage,
      finalResponse,
      false,    // isGroup
      anchorTs  // 锚点时间戳
    ).then(async (pendingDiff) => {
      if (pendingDiff) {
        // 将草稿序列化存入 Settings 表，等待用户下次发消息时提交落盘
        db.setSetting(`pending_memory_diff_${characterId}`, JSON.stringify(pendingDiff))
        console.log(`[MemoryService] 记忆草稿已暂存，anchorTs=${anchorTs}`)
      }
      // 归并压缩仍立即运行（基于历史总条数触发，与单条消息无关）
      await memoryService.compressActiveHistoryAndConsolidate(characterId, memoryPath)
    }).catch(err => {
      console.error('[MemoryService] 提取异常:', err)
    })

    let finalPromptTokens = lastUsage?.prompt_tokens ?? inputTokens
    let finalCompletionTokens = lastUsage?.completion_tokens ?? outputTokens
    let finalCachedTokens = lastUsage?.cached_tokens ?? undefined

    event.sender.send('chat-chunk', {
      characterId,
      content: finalResponse,
      done: true,
      messageId: assistantMsgId,
      redPacketAction: redPacketAction,   // 携带领取/退回决策，供前端红包状态更新
      prompt_tokens: finalPromptTokens,
      completion_tokens: finalCompletionTokens,
      cached_tokens: finalCachedTokens
    })

    // 所有 db.saveMessage 已完成，现在安全清理 activeElectronChats
    if (isElectronEvent) {
      activeElectronChats.delete(characterId)
    }

    return {
      success: true,
      content: finalResponse,
      messageId: assistantMsgId, // 🚀 携带真实消息 ID
      redPacketAction: redPacketAction,
      redPacketSend: redPacketSend ? JSON.parse(JSON.stringify(redPacketSend)) : null,
      prompt_tokens: finalPromptTokens,
      completion_tokens: finalCompletionTokens,
      cached_tokens: finalCachedTokens
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

  // 14. 触发做梦反思进化测试 (防挫败与 Patch DREAM.md 测试) IPC 通道
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
      const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive'
      const isDialogue = chatMode === 'dialogue'
      const limit = isDialogue ? 20 : 5
      const rawHistory = db.getChatHistory(characterId, limit)
      const recentHistory = isDialogue ? mergeChatHistory(rawHistory).slice(0, 5) : rawHistory
      await reviewService.reviewAndPatch(folderName, characterId, recentHistory, modelAdapter)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.0.1 获取亲密度速率设置
  ipcMain.handle('get-intimacy-speed', async (_, payload: { characterId: string }) => {
    try {
      const db = getDatabaseService()
      const speed = db.getSetting(`intimacy_speed_${payload.characterId}`) || 'slow'
      return { success: true, speed }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.0.2 保存亲密度速率设置
  ipcMain.handle('save-intimacy-speed', async (_, payload: { characterId: string; speed: 'slow' | 'fast' }) => {
    try {
      const db = getDatabaseService()
      db.setSetting(`intimacy_speed_${payload.characterId}`, payload.speed)
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

      // 🚀 广播事件通知多端联动清除聊天窗口
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('chat-window-cleared', { characterId })
      }
      const ssePayload = {
        channel: 'chat-window-cleared',
        data: { characterId }
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

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

      // E. 重置专属 State.md 为出厂初始状态，但特意保留原有的钱包余额数值，防止物理清空历史时资产丢失
      const statePath = join(storageManager.getBaseDir(), folderName, 'State.md')
      let preservedBalance = 5200.0
      if (fs.existsSync(statePath)) {
        try {
          const currentState = StateReaderWriter.readState(statePath)
          const balanceItem = currentState.items.find(i => i.key === 'balance')
          if (balanceItem && (typeof balanceItem.value === 'number' || typeof balanceItem.value === 'string')) {
            const val = Number(balanceItem.value)
            if (!isNaN(val)) {
              preservedBalance = val
            }
          }
        } catch (e) {
          console.error('[Clear History] 读取原有钱包余额失败，降级为出厂默认值:', e)
        }
      }

      const newState = StateReaderWriter.getInitialState()
      const newBalanceItem = newState.items.find(i => i.key === 'balance')
      if (newBalanceItem) {
        newBalanceItem.value = preservedBalance
      }
      StateReaderWriter.writeState(statePath, newState)

      // F. 清除 SQLite 中跟此角色关联的所有 Settings 属性（如时间戳、朋友圈计数器、日记时间戳等）
      db.clearCharacterSettings(characterId)
      try {
        db.db.prepare('DELETE FROM Settings WHERE key = ?').run(`last_schedule_goals_msg_count_${characterId}`)
      } catch (_) {}

      // F1. 明确删除 pending_memory_diff 记忆草稿（不依赖 LIKE 模糊匹配，100% 确保清除；
      //     若清空后立即对话，commitPendingMemory 仍持有旧草稿，会将被删的记忆重新落盘）
      try {
        db.db.prepare('DELETE FROM Settings WHERE key = ?').run(`pending_memory_diff_${characterId}`)
      } catch (_) {}

      // G. 清空 Diary.md 日记文件（角色自省写下的日记，会被 ContextAssembler 读取并注入
      //    System Prompt，不清除则角色会通过"日记"感知到已被删除的历史内容）
      storageManager.writeCharacterFile(folderName, 'Diary.md', '')

      // H. 清空 SUMMARY.md 大事记（对话历史压缩精华，会在 checkAndUpdateScheduleAndGoals
      //    重建日程/目标时直接读取并作为 Prompt 上下文；群聊清空有处理，单聊此前漏清）
      const summaryInitContent = `<!--\n{\n  "summary": ""\n}\n-->\n# 对话大事记 (History Summary)\n\n暂无大事记`
      storageManager.writeCharacterFile(folderName, 'SUMMARY.md', summaryInitContent)

      // I. 清除进程内存级 raw response 缓存（保存上一轮 AI 原始输出，用于前缀缓存保温；
      //    不清除则下次对话可能把旧内容还原进 history[idx]，造成隐性上下文污染）
      delete LastAssistantRawResponse[characterId]

      console.log(`[IPC] 物理清空角色 [${folderName}] 的历史消息、记忆、日记、大事记、State.md、画像和 Settings 参数全部完成！`)

      // 🚀 广播事件通知多端联动彻底清空历史与记忆
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('history-memory-cleared', { characterId })
      }
      const ssePayload = {
        channel: 'history-memory-cleared',
        data: { characterId }
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.21 手动一键强行重新规划拟真日程与长期目标
  ipcMain.handle('force-update-schedule-goals', async (_, payload: { characterId: string; folderName: string; target?: 'schedule' | 'goals' | 'both' }) => {
    try {
      const { characterId, folderName, target = 'both' } = payload
      const db = getDatabaseService()

      // 获取大模型配置
      const settingsStr = db.getSetting('model_config')
      if (!settingsStr) {
        return { success: false, error: '未配置全局大模型参数' }
      }
      const modelConfig = JSON.parse(settingsStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      const memoryPath = join(baseDir, folderName, 'Memory.md')

      const memoryService = new MemoryAgentService(modelAdapter)
      await memoryService.checkAndUpdateScheduleAndGoals(memoryPath, modelAdapter, true, target)

      // 读取最新生成的日程和目标内容返回给前端，以便即时流畅渲染
      const scheduleContent = fs.existsSync(join(baseDir, folderName, 'Schedule.md'))
        ? fs.readFileSync(join(baseDir, folderName, 'Schedule.md'), 'utf8')
        : '暂无日程'
      const goalsContent = fs.existsSync(join(baseDir, folderName, 'Goals.md'))
        ? fs.readFileSync(join(baseDir, folderName, 'Goals.md'), 'utf8')
        : '暂无长期目标'

      return {
        success: true,
        scheduleContent,
        goalsContent
      }
    } catch (e: any) {
      console.error('[IPC] 强制更新日程与目标失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 15.25 清除群聊历史和记忆（物理彻底清空群组历史、Memory.md 与 SUMMARY.md）
  ipcMain.handle('clear-group-history-and-memory', async (_, payload: { groupId: string }) => {
    try {
      const { groupId } = payload
      const db = getDatabaseService()

      // A. 清空 SQLite 聊天历史记录
      db.deleteChatHistory(groupId)

      // B. 重置窗口清除时间戳为 0
      db.setSetting('clear_chat_at_' + groupId, '0')

      // C. 清空 Memory.md 记忆文件为出厂初始状态
      const groupDir = join(app.getPath('userData'), 'groups', groupId)
      if (!fs.existsSync(groupDir)) {
        fs.mkdirSync(groupDir, { recursive: true })
      }
      
      const memoryInitContent = `<!--\n{\n  "stm": [],\n  "ltm": {}\n}\n-->\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n暂无短期记忆。\n\n## 长期记忆 (Long-Term Memory)\n暂无长期记忆。`
      fs.writeFileSync(join(groupDir, 'Memory.md'), memoryInitContent, 'utf8')

      // D. 清空 SUMMARY.md 大事记文件为初始状态
      const summaryInitContent = `<!--\n{\n  "summary": ""\n}\n-->\n# 群聊共同经历大事记 (Group History Summary)\n\n暂无大事记`
      fs.writeFileSync(join(groupDir, 'SUMMARY.md'), summaryInitContent, 'utf8')

      console.log(`[IPC] 群聊 [${groupId}] 物理清空聊天记录、Memory.md 记忆与 SUMMARY.md 大事记成功！`)

      // 🚀 广播事件通知多端联动彻底清空群聊历史
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('history-memory-cleared', { characterId: groupId })
      }
      const ssePayload = {
        channel: 'history-memory-cleared',
        data: { characterId: groupId }
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 物理清空群聊记录失败:', e)
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
      // 🚀 广播通知其他局域网客户端与电脑端记忆文件已更新，触发秒级同步
      const memoryBroadcast = { folderName: payload.folderName, fileName: 'Memory.md', content: payload.content }
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('character-file-updated', memoryBroadcast)
      }
      const memorySse = {
        channel: 'character-file-updated',
        data: memoryBroadcast
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(memorySse)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

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

  // 19.2 AI 手动提炼角色专属画像 (USER.md) IPC 通道
  ipcMain.handle('consolidate-character-user', async (_, payload: { characterId: string; folderName: string }) => {
    try {
      const { characterId, folderName } = payload
      const db = getDatabaseService()

      // 获取大模型配置
      const settingsStr = db.getSetting('model_config')
      if (!settingsStr) {
        return { success: false, error: '未配置全局大模型参数' }
      }
      const modelConfig = JSON.parse(settingsStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      const charUserPath = join(baseDir, folderName, 'USER.md')

      const memoryService = new MemoryAgentService(modelAdapter)
      const content = await memoryService.consolidateCharacterUserFacts(
        charUserPath,
        characterId,
        folderName,
        modelAdapter
      )

      return { success: true, content }
    } catch (e: any) {
      console.error('[IPC] 提炼角色专属画像失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 19.3 AI 手动一键提炼记忆 (Memory.md) IPC 通道
  ipcMain.handle('consolidate-character-memory', async (_, payload: { characterId: string; folderName: string }) => {
    try {
      const { characterId, folderName } = payload
      const db = getDatabaseService()

      // 获取大模型配置
      const settingsStr = db.getSetting('model_config')
      if (!settingsStr) {
        return { success: false, error: '未配置全局大模型参数' }
      }
      const modelConfig = JSON.parse(settingsStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      const storageManager = new CharacterStorageManager()
      const baseDir = storageManager.getBaseDir()
      const memoryPath = join(baseDir, folderName, 'Memory.md')

      const memoryService = new MemoryAgentService(modelAdapter)
      const content = await memoryService.consolidateCharacterMemoryFacts(
        memoryPath,
        characterId,
        folderName,
        modelAdapter
      )

      return { success: true, content }
    } catch (e: any) {
      console.error('[IPC] 提炼角色记忆失败:', e)
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

  // 14. 异步读取本地 media 图片资源并转为 Base64（含元数据自动读取）
  ipcMain.handle('read-image-media', async (_, payload: { folderName: string; mediaPath: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      const fullPath = join(charDir, payload.mediaPath)
      if (fs.existsSync(fullPath)) {
        const fileBuffer = fs.readFileSync(fullPath)
        const ext = extname(fullPath).toLowerCase()
        const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
        
        let meta: any = null
        const jsonPath = fullPath.replace(ext, '.json')
        if (fs.existsSync(jsonPath)) {
          try {
            const rawMeta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
            meta = {
              filename: basename(fullPath),
              relativePath: payload.mediaPath,
              prompt: rawMeta.prompt || '',
              negativePrompt: rawMeta.negativePrompt || '',
              dimensions: rawMeta.dimensions || 'portrait',
              createdAt: rawMeta.createdAt || fs.statSync(fullPath).mtimeMs,
              prefixType: rawMeta.prefixType || (payload.mediaPath.includes('social_') ? 'social' : payload.mediaPath.includes('proactive_') ? 'proactive' : 'chat')
            }
          } catch (_) {}
        }

        return { 
          success: true, 
          base64: `data:${mimeType};base64,${fileBuffer.toString('base64')}`,
          meta 
        }
      }
      return { success: false, error: '文件不存在' }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15. 持久化保存会话元数据（免打扰/置顶/隐藏等）到 SQLite
  ipcMain.handle('save-conversation-meta', async (_, payload: { characterId: string; pinned?: boolean; unread?: number; muted?: boolean; hidden?: boolean }) => {
    try {
      const db = getDatabaseService()
      db.setSetting(`meta_${payload.characterId}`, JSON.stringify(payload))
      
      // 广播给所有客户端（包括通过 SSE 长连接的手机端）
      mainWindow?.webContents.send('conversation-meta-updated', payload)
      
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message || e }
    }
  })

  // 15.5 物理打开角色所在的本地专属配置文件夹
  ipcMain.handle('open-character-folder', async (_, payload: { folderName: string }) => {
    try {
      const storageManager = new CharacterStorageManager()
      const charDir = join(storageManager.getBaseDir(), payload.folderName)
      if (fs.existsSync(charDir)) {
        await shell.openPath(charDir)
        return { success: true }
      }
      return { success: false, error: '本地角色专属文件夹未创建或已被移动' }
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
      
      const chatMode = db.getSetting(`chat_mode_${payload.characterId}`) || 'descriptive'
      const isDialogue = chatMode === 'dialogue'
      const limit = isDialogue ? 30 : 10
      const rawHistory = db.getChatHistory(payload.characterId, limit)
      const history = isDialogue ? mergeChatHistory(rawHistory) : rawHistory
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

  // 17.5 删除单篇日记 IPC 通道（按标题日期精准定位，从 Diary.md 物理抹除对应段落）
  ipcMain.handle('delete-diary-entry', async (_, payload: { folderName: string; date: string }) => {
    try {
      const { folderName, date } = payload
      const storageManager = new CharacterStorageManager()
      const diaryPath = join(storageManager.getBaseDir(), folderName, 'Diary.md')

      if (!fs.existsSync(diaryPath)) {
        return { success: true } // 文件不存在，视为已删除
      }

      const raw = fs.readFileSync(diaryPath, 'utf8')

      // 按 ###+ 标题将日记分割为各段，过滤掉标题中含有目标 date 的段落
      // 段落格式：### 📓 YYYY-M-D HH:MM\n日记正文...
      const sections = raw.split(/(?=^#{2,}\s+)/m)
      const filtered = sections.filter(sec => {
        const firstLine = sec.split('\n')[0] || ''
        // 若该段标题包含目标 date 字符串则删除
        return !firstLine.includes(date)
      })

      fs.writeFileSync(diaryPath, filtered.join(''), 'utf8')
      console.log(`[IPC] 日记条目已删除: folderName=${folderName}, date=${date}`)
      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 删除日记条目失败:', e)
      return { success: false, error: e.message || e }
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
          'User-Agent': 'EchoPlatform/1.0.3 (Desktop AI Roleplay Platform)'
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

      // 获取大模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const modelConfig = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      // 每次随机找最多 3 个有聊天记录的不同活跃角色各生成 1 条朋友圈
      const characters = db.getAllCharacters()
      const activeChars = characters.filter(c => {
        if (db.getChatHistory(c.id, 1).length === 0) return false
        
        const metaStr = db.getSetting(`meta_${c.id}`)
        if (metaStr) {
          try {
            const meta = JSON.parse(metaStr)
            if (meta.muted) return false
          } catch (_) {}
        }
        return true
      })
      
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

      // 获取大模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const modelConfig = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      // 每次随机找最多 3 个有聊天记录的不同活跃角色各生成 1 篇论坛帖子
      const characters = db.getAllCharacters()
      const activeChars = characters.filter(c => {
        if (db.getChatHistory(c.id, 1).length === 0) return false
        
        const metaStr = db.getSetting(`meta_${c.id}`)
        if (metaStr) {
          try {
            const meta = JSON.parse(metaStr)
            if (meta.muted) return false
          } catch (_) {}
        }
        return true
      })

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


      const posts = db.getAllForumPosts(50)
      return { success: true, cached: false, posts, newCount: newPosts.length }

    } catch (e: any) {
      console.error('[IPC] 刷新论坛帖子异常:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 生图调试接口 (100% 触发文图朋友圈/论坛，零活跃角色自动 Fallback 兜底)
  ipcMain.handle('trigger-image-debug', async (_, payload: { type: 'moment' | 'forum' }) => {
    try {
      const db = getDatabaseService()
      
      // 获取大模型配置
      const configStr = db.getSetting('model_config')
      if (!configStr) throw new Error('未配置全局大模型')
      const modelConfig = JSON.parse(configStr)
      const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary)

      // 优先从活跃角色里随机选取最多 3 个，若无则自动兜底从全量角色里挑
      const characters = db.getAllCharacters()
      let activeChars = characters.filter(c => db.getChatHistory(c.id, 1).length > 0)
      if (activeChars.length === 0) {
        activeChars = characters
      }
      
      if (activeChars.length === 0) {
        return { success: true, moments: [], posts: [], error: '系统暂无任何角色数据' }
      }

      activeChars.sort(() => Math.random() - 0.5)
      const targetChars = activeChars.slice(0, 3)

      const socialMedia = new SocialMediaService()
      
      if (payload.type === 'moment') {
        const newMoments: any[] = []
        for (const char of targetChars) {
          const m = await socialMedia.generateMoment(char, modelAdapter, true) // forceDraw = true
          if (m) newMoments.push(m)
        }
        const moments = db.getAllMoments(50)
        for (const m of moments) {
          m.comments = db.getMomentComments(m.id)
          m.likes_list = db.getMomentLikes(m.id)
          m.isFavorited = db.isFavoriteExist('moment', m.id)
        }
        return { success: true, moments, newCount: newMoments.length }
      } else {
        const newPosts: any[] = []
        for (const char of targetChars) {
          const p = await socialMedia.generateForumPost(char, modelAdapter, true) // forceDraw = true
          if (p) newPosts.push(p)
        }
        const posts = db.getAllForumPosts(50)
        return { success: true, posts, newCount: newPosts.length }
      }
    } catch (e: any) {
      console.error('[IPC] 生图调试异常:', e)
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

      // 🚀 删除朋友圈动态后，秒级通知多端联动重新加载
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('social-moment-updated')
      }
      const ssePayload = {
        channel: 'social-moment-updated',
        data: {}
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

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

      // 🚀 删除论坛帖子后，秒级通知多端联动重新加载
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('social-forum-updated')
      }
      const ssePayload = {
        channel: 'social-forum-updated',
        data: {}
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

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
        socialMedia.evaluateSocialInteraction(moment, 'moment', modelAdapter).catch((err: any) => {
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
        socialMedia.evaluateSocialInteraction(post, 'forum_post', modelAdapter).catch((err: any) => {
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

      // 🚀 核心注入：为收藏的朋友圈和论坛帖子自动关联并查询最新的实时互动数据
      for (const fav of favorites) {
        if (fav.type === 'moment') {
          try {
            const moment = db.db.prepare('SELECT * FROM Moments WHERE id = ?').get(fav.target_id) as any
            if (moment) {
              fav.likes = moment.likes
              fav.liked = moment.liked
              fav.likes_list = db.getMomentLikes(fav.target_id)
              fav.comments = db.getMomentComments(fav.target_id)
            } else {
              fav.likes = 0
              fav.liked = 0
              fav.likes_list = []
              fav.comments = []
            }
          } catch (e) {
            console.error(`[Favorite-Moment] 获取关联朋友圈互动失败: ${fav.target_id}`, e)
            fav.likes = 0
            fav.liked = 0
            fav.likes_list = []
            fav.comments = []
          }
        } else if (fav.type === 'forum') {
          try {
            const post = db.db.prepare('SELECT * FROM ForumPosts WHERE id = ?').get(fav.target_id) as any
            if (post) {
              fav.views = post.views
              fav.replies_count = post.replies_count
              fav.comments = db.getForumComments(fav.target_id)
            } else {
              fav.views = 0
              fav.replies_count = 0
              fav.comments = []
            }
          } catch (e) {
            console.error(`[Favorite-Forum] 获取关联帖子互动失败: ${fav.target_id}`, e)
            fav.views = 0
            fav.replies_count = 0
            fav.comments = []
          }
        }
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
          const deletedMsgId = history[i].id
          db.db.prepare('DELETE FROM Messages WHERE id = ?').run(deletedMsgId)
          deleteCount++

          // 🚀 重新回复物理擦除旧消息后，立即同步广播给多端联动删除气泡以保障时序一致性
          if (mainWindow && !mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.send('message-deleted', { characterId: payload.characterId, messageId: deletedMsgId })
          }
          const ssePayload = {
            channel: 'message-deleted',
            data: { characterId: payload.characterId, messageId: deletedMsgId }
          }
          for (const client of sseClients) {
            try {
              client.write(`data: ${JSON.stringify(ssePayload)}\n\n`)
            } catch (_) {
              sseClients.delete(client)
            }
          }
        } else {
          break
        }
      }

      if (deleteCount === 0) {
        throw new Error('最后一条消息并非角色回复，无法要求重答。')
      }

      // 清除该角色的待确认记忆草稿（旧回复已被擦除，其对应的草稿无需再落盘；新回复完成后会产生新草稿）
      try {
        db.db.prepare('DELETE FROM Settings WHERE key = ?').run(`pending_memory_diff_${payload.characterId}`)
        console.log(`[regenerate-reply] 清除角色 ${payload.characterId} 的记忆草稿。`)
      } catch (_) {}

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
      // 🚀 广播通知其他局域网客户端与电脑端角色状态已被用户手动修改，触发秒级同步刷新
      const stateBroadcast = { characterId: payload.folderName, updates: [] }
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('character-state-updated', stateBroadcast)
      }
      const stateSse = {
        channel: 'character-state-updated',
        data: stateBroadcast
      }
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify(stateSse)}\n\n`)
        } catch (_) {
          sseClients.delete(client)
        }
      }

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
      const order = ['intimacy', 'mood']
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
          const maxVal = item.max ?? (payload.key === 'balance' ? 999999999 : 100)
          let finalVal = isNaN(val) ? minVal : Math.max(minVal, Math.min(maxVal, val))
          if (payload.key === 'balance') {
            finalVal = Math.round(finalVal * 100) / 100
          }
          item.value = finalVal
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
      if (['intimacy', 'mood'].includes(payload.key)) {
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
  ipcMain.handle('save-general-settings', async (_, payload: { show_schedule: boolean; show_goals: boolean; cron_frequency: string; enable_music?: boolean; lan_mapping_enabled?: boolean; lan_mapping_port?: number; enable_token_stats?: boolean; descriptive_min_words?: number; director_min_words?: number }) => {
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
        const parsed = JSON.parse(genConfigStr)
        // 🚀 向下兼容默认字数兜底
        if (parsed.descriptive_min_words === undefined) parsed.descriptive_min_words = 500
        if (parsed.director_min_words === undefined) parsed.director_min_words = 800
        return { success: true, config: parsed }
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
          lan_mapping_port: 6868,
          enable_token_stats: true,
          descriptive_min_words: 500, // 🚀 动作描写模式默认最低500字
          director_min_words: 800     // 🚀 导演模式默认最低800字
        }
      }
    } catch (e: any) {
      console.error('[IPC] 读取通用配置失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 11. 读取首次使用协议同意状态
  ipcMain.handle('get-agreement-status', async () => {
    try {
      const db = getDatabaseService()
      const accepted = db.getSetting('agreement_accepted') === 'true'
      return { success: true, accepted }
    } catch (e: any) {
      console.error('[IPC] 读取协议状态失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 12. 保存协议同意状态
  ipcMain.handle('save-agreement-status', async () => {
    try {
      const db = getDatabaseService()
      db.setSetting('agreement_accepted', 'true')
      return { success: true }
    } catch (e: any) {
      console.error('[IPC] 保存协议状态失败:', e)
      return { success: false, error: e.message || e }
    }
  })

  // 13. 不同意协议，强力退出程序
  ipcMain.handle('exit-app', () => {
    app.quit()
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

// 局域网极简 IPC 桥接服务器全局实例与心跳定时器句柄
let ipcBridgeServerInstance: http.Server | null = null;
let ipcBridgeHeartbeatInterval: NodeJS.Timeout | null = null;

// 实时开启/重启局域网映射静态服务器
// 统一的 IPC 桥接与 SSE 网络请求拦截分流处理器，实现单端口 6868 闭环
function handleIpcBridgeRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  // 1. 处理 CORS 跨域请求（同源模式下可作为安全兼容项保留）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. 预检请求 (OPTIONS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /api/events — SSE 持久推送通道
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/events')) {
    // 解析客户端最后收到的消息 id（断线重连时浏览器自动携带）
    const rawLastId = req.headers['last-event-id']
    const lastReceivedId = rawLastId ? parseInt(rawLastId as string, 10) : -1

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // 防止 nginx/反向代理缓冲 SSE 数据包
      'Access-Control-Allow-Origin': '*'
    })
    res.write(': sse-connected\n\n')
    sseClients.add(res)

    // 补发断线期间错过的消息：仅补发 id > lastReceivedId（严格大于，杜绝重复）
    if (lastReceivedId >= 0 && sseMessageBuffer.length > 0) {
      const missed = sseMessageBuffer.filter(m => m.id > lastReceivedId)

      // 🚀 核心自愈去重折叠：对于同一条聊天消息（相同的 data.id），在极速重连时只需补发最新、最完整的一条，
      // 彻底消除客户端在短时间内同时收到同一条消息的多段流式片段而引发的“包含误杀去重”和“异步队列时序错乱”的重大BUG！
      const collapsed: SseBufferedMsg[] = []
      const seenMsgIds = new Set<string>()

      // 从后往前遍历，确保对同一个 data.id 只保留最新（即自增 id 最大）的那一条
      for (let i = missed.length - 1; i >= 0; i--) {
        const item = missed[i]
        const msgId = item.data?.id

        if (item.channel === 'receive-message' && msgId) {
          if (seenMsgIds.has(msgId)) {
            // 已经是较旧的流式段落，直接丢弃
            continue
          }
          seenMsgIds.add(msgId)
        }
        collapsed.unshift(item)
      }

      if (collapsed.length > 0) {
        // 🚀 极致仿真时延与防沾包：开启后台异步协程发送补偿队列，每条消息之间加上 60ms 的物理延迟，
        // 物理切分并避免 TCP 沾包，确保前端 EventSource 有序、间隔触发 onmessage，完美配合 dialogue 播放队列模拟真人多气泡连续发送体验！
        (async () => {
          for (const m of collapsed) {
            try {
              res.write(m.raw)
              await new Promise(resolve => setTimeout(resolve, 60))
            } catch (_) {
              break // 连接若被切断，安全退出
            }
          }
          console.log(`[SSE] 断线重连折叠补偿发送完成: 原始 ${missed.length} 条, 折叠后补发 ${collapsed.length} 条 (id > ${lastReceivedId})`)
        })()
      }
    }

    // 每 20 秒发送一次 SSE comment 心跳包（": ping"），防止路由器/NAT/iOS 系统因 TCP 长时间无活动而强制回收连接
    // 浏览器收到 comment 行会直接丢弃，不触发 onmessage，对业务完全透明
    const heartbeatTimer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        // 写入失败说明连接已断，清理资源
        clearInterval(heartbeatTimer);
        sseClients.delete(res);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeatTimer);
      sseClients.delete(res);
    });
    return true;
  }


  // ====== 新增：GET /api/music/download 内存零落地音乐流式下载接口 ======
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/music/download')) {
    (async () => {
      try {
        console.log('[Music Server] 收到网页端音乐流式下载请求，正在解析元数据...');
        const parsedUrl = new URL(req.url!, `http://${req.headers.host}`);
        const songmid = parsedUrl.searchParams.get('songmid') || '';
        const name = parsedUrl.searchParams.get('name') || '未知歌曲';
        const singer = parsedUrl.searchParams.get('singer') || '群星';
        const albumName = parsedUrl.searchParams.get('albumName') || '';
        const imgUrl = parsedUrl.searchParams.get('imgUrl') || '';
        const lyricText = parsedUrl.searchParams.get('lyricText') || '';
        const playUrl = parsedUrl.searchParams.get('url') || '';
        const quality = parsedUrl.searchParams.get('quality') || '320k';

        if (!playUrl) {
          throw new Error('未提供有效音频源链接，下载终止。');
        }

        console.log(`[Music Server] 准备下载: ${singer} - ${name}，音质: ${quality}，图片: ${imgUrl}`);

        const downloadBuffer = (urlStr: string): Promise<Buffer> => {
          return new Promise((resolve, reject) => {
            if (!urlStr || !urlStr.startsWith('http')) {
              reject(new Error('非法的网络下载 URL'));
              return;
            }
            const client = urlStr.startsWith('https') ? https : http;
            client.get(urlStr, (downloadRes: any) => {
              if (downloadRes.statusCode === 302 || downloadRes.statusCode === 301) {
                downloadBuffer(downloadRes.headers.location!).then(resolve).catch(reject);
                return;
              }
              if (downloadRes.statusCode !== 200) {
                reject(new Error(`下载请求失败，HTTP Code ${downloadRes.statusCode}`));
                return;
              }
              const chunks: Buffer[] = [];
              downloadRes.on('data', (c: any) => chunks.push(c));
              downloadRes.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
          });
        };

        // 1. 并发流式拉取音频 Buffer 与图片 Buffer
        console.log('[Music Server] 正在从 CDN 流式拉取音频原始二进制数据...');
        const audioPromise = downloadBuffer(playUrl);
        const picPromise = imgUrl ? downloadBuffer(imgUrl).catch(() => undefined) : Promise.resolve(undefined);

        const [audioBuffer, picBuffer] = await Promise.all([audioPromise, picPromise]);
        console.log(`[Music Server] 音频抓取成功！大小: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);

        // 2. 物理零残存中转：在宿主机的临时文件夹下写入元数据，随后读取输出并物理删除
        const tempFolder = app.getPath('temp');
        const ext = quality === 'flac' ? '.flac' : '.mp3';
        const tempFilename = `echo_music_temp_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`;
        const tempPath = path.join(tempFolder, tempFilename);

        fs.writeFileSync(tempPath, audioBuffer);

        // 3. 对 MP3 格式无损注入 ID3v2 标签元数据
        if (ext === '.mp3') {
          console.log('[Music Server] 正在向 MP3 物理注入歌手、歌词、专辑名与高清封面元数据...');
          Mp3Id3Writer.write(tempPath, {
            title: name,
            artist: singer,
            album: albumName,
            lyrics: lyricText || undefined,
            picBuffer: picBuffer || undefined
          });
        }

        // 4. 读取写入完成 of the final tagged audio
        const taggedBuffer = fs.readFileSync(tempPath);
        
        // 5. 异步删除临时文件
        try {
          fs.unlinkSync(tempPath);
        } catch (_) {}

        // 6. 流式输出音频附件
        const sanitizedFilename = `${singer} - ${name}${ext}`.replace(/[\\/:*?"<>|]/g, '');
        const encodedFilename = encodeURIComponent(sanitizedFilename);

        console.log(`[Music Server] 注入打标成功！正在向用户客户端流式输出附件: ${sanitizedFilename}`);
        
        res.writeHead(200, {
          'Content-Type': ext === '.flac' ? 'audio/flac' : 'audio/mpeg',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodedFilename}`,
          'Content-Length': taggedBuffer.length,
          'Cache-Control': 'no-cache'
        });
        res.end(taggedBuffer);
        console.log('[Music Server] 音乐文件附件网络流输出完毕！Perfect！🐾');

      } catch (err: any) {
        console.error('[Music Server] 流式下载音频发生致命崩溃异常:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
      }
    })().catch(e => {
      console.error('[Music Server] 异步自执行任务内部崩溃:', e);
    });
    return true;
  }

  // ====== 新增：GET /api/backups/export 内存零落地打包流式下载接口 ======
  if (req.method === 'GET' && req.url && req.url.startsWith('/api/backups/export')) {
    try {
      console.log('[Backup Server] 收到跨网流式备份导出请求，正在扫描核心物理目录...');
      const userDataPath = app.getPath('userData');
      const backupDirs = ['database', 'characters', 'config', 'groups', 'EchoMusicSources'];
      const filesToPack: Array<{ relativePath: string; content: string }> = [];

      // 递归读取核心目录
      const traverseDirectory = (currentDir: string, relativeRoot: string) => {
        if (!fs.existsSync(currentDir)) return;
        const items = fs.readdirSync(currentDir);
        for (const item of items) {
          const fullPath = path.join(currentDir, item);
          const relPath = path.join(relativeRoot, item);
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            traverseDirectory(fullPath, relPath);
          } else if (stat.isFile()) {
            const contentBuffer = fs.readFileSync(fullPath);
            filesToPack.push({
              relativePath: relPath,
              content: contentBuffer.toString('base64')
            });
          }
        }
      };

      for (const dir of backupDirs) {
        const fullDir = path.join(userDataPath, dir);
        traverseDirectory(fullDir, dir);
      }

      const backupData = {
        version: app.getVersion(),
        timestamp: Date.now(),
        files: filesToPack
      };

      console.log(`[Backup Server] 扫描完毕，共打包 ${filesToPack.length} 个文件。正在执行内存 Gzip 压缩...`);
      const jsonStr = JSON.stringify(backupData);
      const compressedBuffer = zlib.gzipSync(Buffer.from(jsonStr, 'utf-8'));

      console.log(`[Backup Server] 压缩顺利完成！大小: ${(compressedBuffer.length / 1024 / 1024).toFixed(2)} MB。正在写入流式 Response 附件...`);
      
      const safeDateStr = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="EchoBackup_${safeDateStr}.echo"`,
        'Content-Length': compressedBuffer.length,
        'Cache-Control': 'no-cache'
      });
      res.end(compressedBuffer);
      console.log('[Backup Server] 备份文件流式输出完毕，Perfect！🐾');
    } catch (err: any) {
      console.error('[Backup Server] 导出备份流发生致命异常:', err);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
    }
    return true;
  }

  // ====== 新增：POST /api/backups/import 跨网流式备份包上传恢复接口 ======
  if (req.method === 'POST' && req.url && req.url.startsWith('/api/backups/import')) {
    console.log('[Backup Server] 收到跨网流式备份导入请求，正在接收数据流...');
    const chunks: Buffer[] = [];
    
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', async () => {
      try {
        const fileBuffer = Buffer.concat(chunks);
        console.log(`[Backup Server] 二进制数据流接收成功，共 ${(fileBuffer.length / 1024).toFixed(2)} KB。开始执行内存 Gzip 解压...`);

        let decompressedData: string;
        try {
          decompressedData = zlib.gunzipSync(fileBuffer).toString('utf-8');
        } catch (decompressErr) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: '解压备份数据包失败，文件可能已损坏或格式不正确' }));
          return;
        }

        let backupObj: any;
        try {
          backupObj = JSON.parse(decompressedData);
        } catch (jsonErr) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: '解析备份包配置文件 JSON 格式错误' }));
          return;
        }

        if (!backupObj || !Array.isArray(backupObj.files)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: '非法的备份文件结构，未找到有效的文件列表' }));
          return;
        }

        console.log(`[Backup Server] 验证成功！备份包含 ${backupObj.files.length} 个文件。开始执行物理级灾备覆盖写盘...`);

        const userDataPath = app.getPath('userData');
        const backupDirs = ['database', 'characters', 'config', 'groups', 'EchoMusicSources'];

        // 🚀 物理重置数据库单例（释放 SQLite 文件句柄锁）
        resetDatabaseService();

        // 两阶段安全事务防灾：重命名现有文件夹到临时备份
        const backupTimestamp = Date.now();
        const tempRestoreBackupDir = path.join(userDataPath, `temp_restore_backup_${backupTimestamp}`);
        fs.mkdirSync(tempRestoreBackupDir, { recursive: true });

        const movedDirs: string[] = [];
        try {
          for (const dir of backupDirs) {
            const oldDirPath = path.join(userDataPath, dir);
            if (fs.existsSync(oldDirPath)) {
              const destPath = path.join(tempRestoreBackupDir, dir);
              fs.renameSync(oldDirPath, destPath);
              movedDirs.push(dir);
            }
          }
        } catch (moveErr: any) {
          // 移动现有目录失败，回滚
          for (const dir of movedDirs) {
            const tempPath = path.join(tempRestoreBackupDir, dir);
            const oldDirPath = path.join(userDataPath, dir);
            if (fs.existsSync(tempPath)) {
              fs.renameSync(tempPath, oldDirPath);
            }
          }
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: `备份现有数据失败（物理文件可能被占用）: ${moveErr.message}` }));
          return;
        }

        // 依次解密并写入物理文件
        try {
          for (const fileItem of backupObj.files) {
            if (!fileItem.relativePath || typeof fileItem.content !== 'string') continue;
            
            // 路径安全防越界校验
            const normalizedPath = path.normalize(fileItem.relativePath);
            if (normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath)) {
              throw new Error(`非法的安全越界文件路径: ${fileItem.relativePath}`);
            }

            const firstDir = normalizedPath.split(path.sep)[0];
            if (!backupDirs.includes(firstDir)) {
              continue; // 忽略不属于备份目录的文件
            }

            const targetFilePath = path.join(userDataPath, normalizedPath);
            const targetFileDir = path.dirname(targetFilePath);

            if (!fs.existsSync(targetFileDir)) {
              fs.mkdirSync(targetFileDir, { recursive: true });
            }

            const outBuffer = Buffer.from(fileItem.content, 'base64');
            fs.writeFileSync(targetFilePath, outBuffer);
          }
        } catch (writeErr: any) {
          console.error('[Backup Server] 写入物理文件异常，触发防灾级回滚恢复中...', writeErr);
          // 清理写入的不完整文件夹
          for (const dir of backupDirs) {
            const currentPath = path.join(userDataPath, dir);
            if (fs.existsSync(currentPath)) {
              fs.rmSync(currentPath, { recursive: true, force: true });
            }
          }
          // 恢复原有的临时备份
          for (const dir of movedDirs) {
            const tempPath = path.join(tempRestoreBackupDir, dir);
            const oldDirPath = path.join(userDataPath, dir);
            if (fs.existsSync(tempPath)) {
              fs.renameSync(tempPath, oldDirPath);
            }
          }
          fs.rmSync(tempRestoreBackupDir, { recursive: true, force: true });

          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: `写入恢复数据出错（数据已安全回退还原）: ${writeErr.message || String(writeErr)}` }));
          return;
        }

        // 成功，清理临时安全防灾文件夹
        try {
          fs.rmSync(tempRestoreBackupDir, { recursive: true, force: true });
        } catch (_) {}

        console.log('[Backup Server] 数据解压缩与物理还原覆盖全面成功！向前端广播重启...');
        
        // 广播通知前端
        broadcastToSse('docker-restore-success', { success: true });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, message: '备份还原成功！服务器即将在 1.5 秒后完成热重启！🐾' }));

        // 延迟 1.5 秒自动执行热重启
        setTimeout(() => {
          app.relaunch();
          app.exit(0);
        }, 1500);

      } catch (err: any) {
        console.error('[Backup Server] 流式上传备份处理发生致命崩溃:', err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
      }
    });
    return true;
  }

  // 3. 处理 /api/ipc POST 路由
  if (req.method === 'POST' && req.url && req.url.startsWith('/api/ipc')) {
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
    return true;
  }

  return false;
}

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
      // 🚀 核心自适应：如果请求是以 /api/ 开头的 API 接口，直接由 IPC 桥接处理器进行拦截和分流处理，完美融合为一个端口！
      if (req.url && req.url.startsWith('/api/')) {
        if (handleIpcBridgeRequest(req, res)) {
          return;
        }
      }

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
  // 优雅停用老实例
  stopIpcBridgeServer();

  try {
    const server = http.createServer((req, res) => {
      if (handleIpcBridgeRequest(req, res)) {
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
      ipcBridgeHeartbeatInterval = setInterval(() => {
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

    ipcBridgeServerInstance = server;
  } catch (e) {
    console.error('[IPC Bridge Server] 启动局域网桥接服务器致命异常:', e);
  }
}

// 优雅停用局域网极简 IPC 桥接服务器
export function stopIpcBridgeServer() {
  if (ipcBridgeHeartbeatInterval) {
    clearInterval(ipcBridgeHeartbeatInterval);
    ipcBridgeHeartbeatInterval = null;
  }
  if (ipcBridgeServerInstance) {
    try {
      ipcBridgeServerInstance.close();
      console.log('[IPC Bridge Server] 局域网桥接服务器已成功安全退役。🐾');
    } catch (_) {}
    ipcBridgeServerInstance = null;
  }
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

  // 启动微信个人号托管守护服务 (若开启)
  try {
    WeChatService.getInstance().startService()
  } catch (error) {
    console.error('微信服务挂载启动异常:', error)
  }


  // 启动局域网 IPC 桥接服务器，支持通过 Settings 数据库动态自定义端口
  try {
    const db = getDatabaseService()
    
    // 级联事件广播总线：当有任何新消息保存到 SQLite 数据库时，双路并发广播给所有端
    db.registerOnMessageSaved((msg) => {
      // 判断晢语次是否是 本机 Electron 正在流式处理的 AI 对话回复
      // 若是，桌面端已通过 chat-chunk 渲染，跳过 IPC 广播防止重复气泡
      const isElectronAssistantMsg = msg.role === 'assistant' && activeElectronChats.has(msg.character_id)
      
      // 路径 1：Electron 桌面端（透过 ipcRenderer 监听）
      // 第一条：如果是本机 Electron 正在流式处理的 AI 回复（dialogue 展开分次存盘），则跳过，防止重复渲染
      if (!isElectronAssistantMsg && mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('receive-message', msg)
      }
      // 路径 2：局域网 Web 端 / 手机端（透过 SSE 监听）始终广播
      broadcastToSse('receive-message', msg)
    })

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

  // 启动局域网静态文件托管 Web 服务器（由常规设置中的局域网映射设定启动，Docker下强制在6868启动）
  try {
    const db = getDatabaseService()
    const genConfigStr = db.getSetting('general_config')
    let lanPort = 6868
    let lanEnabled = false
    if (genConfigStr) {
      try {
        const config = JSON.parse(genConfigStr)
        if (config.lan_mapping_enabled) {
          lanPort = Number(config.lan_mapping_port) || 6868
          lanEnabled = true
        }
      } catch (_) {}
    }
    
    // 🚀 Docker 部署环境下：强制启动局域网托管静态服务，端口固定为 6868
    if (process.env.DOCKER_MODE === 'true') {
      lanEnabled = true
      lanPort = 6868
    }

    if (lanEnabled) {
      startLanMappingServer(lanPort)
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

// 🚀 极致退役防死锁：应用退出前，百分之百强制关闭局域网自托管与桥接服务器并物理注销心跳定时器！
// 这将彻底排空 Node.js 事件循环里的活跃网络监听和定时器句柄，确保进程能瞬间优雅自然释放，从根源上彻底斩断僵尸进程（Zombie Process）顽疾！
app.on('before-quit', () => {
  console.log('[App] 收到退出信号，开始物理销毁全局常驻组件及局域网桥接服务...')
  stopLanMappingServer()
  stopIpcBridgeServer()
})

function getResourcesPath(): string {
  // 无论是否打包，均统一通过相对路径访问 asar 包内或开发环境下的 resources 目录，确保 native 模块能顺畅读取
  return join(__dirname, '../../resources');
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
  tray.setToolTip('Echo - 回音');

  // 建立极致纯净的原生托盘上下文菜单（非 Mac 平台下的首选）
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

  if (process.platform === 'darwin') {
    // 🚀 Mac 平台特有升级：爱心右侧绝对不要显示时间
    tray.setTitle('');
  }

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    targetWindow.show();
    targetWindow.focus();
  });
}
