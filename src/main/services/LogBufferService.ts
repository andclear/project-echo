import { WebContents } from 'electron'

export interface ConsoleLogEntry {
  type: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
}

/**
 * LogBufferService
 * 物理劫持主进程全局 console.log/warn/error，内存 Ring Buffer 缓冲最近 500 条日志，
 * 支持前台按需订阅推送、防卡顿文本截断以及敏感 API 密钥脱敏清洗。
 */
export class LogBufferService {
  private static instance: LogBufferService
  private logBuffer: ConsoleLogEntry[] = []
  private readonly MAX_LOGS = 500
  private initialized = false
  private subscriberWebContents: WebContents | null = null

  // 原始 console 引用
  private originalLog!: (...args: any[]) => void
  private originalWarn!: (...args: any[]) => void
  private originalError!: (...args: any[]) => void

  private constructor() {}

  public static getInstance(): LogBufferService {
    if (!LogBufferService.instance) {
      LogBufferService.instance = new LogBufferService()
    }
    return LogBufferService.instance
  }

  /**
   * 初始化并全局物理劫持 console
   */
  public init(): void {
    if (this.initialized) return

    this.originalLog = console.log
    this.originalWarn = console.warn
    this.originalError = console.error

    // 重写 console.log
    console.log = (...args: any[]) => {
      this.originalLog(...args)
      this.pushLog('info', args)
    }

    // 重写 console.warn
    console.warn = (...args: any[]) => {
      this.originalWarn(...args)
      this.pushLog('warn', args)
    }

    // 重写 console.error
    console.error = (...args: any[]) => {
      this.originalError(...args)
      this.pushLog('error', args)
    }

    this.initialized = true
    console.log('[LogBuffer] 主进程全局 console 日志劫持拦截服务成功启动，环形队列缓冲 500 条！')
  }

  /**
   * 订阅实时日志推送
   */
  public subscribe(webContents: WebContents): void {
    this.subscriberWebContents = webContents
  }

  /**
   * 取消订阅实时日志推送
   */
  public unsubscribe(): void {
    this.subscriberWebContents = null
  }

  /**
   * 获取所有缓存的历史日志
   */
  public getLogs(): ConsoleLogEntry[] {
    return [...this.logBuffer]
  }

  /**
   * 写入并处理日志
   */
  private pushLog(type: 'info' | 'warn' | 'error', args: any[]): void {
    try {
      // 1. 将所有入参拼接为一行字符串
      let message = args
        .map(arg => {
          if (arg === null) return 'null'
          if (arg === undefined) return 'undefined'
          if (arg instanceof Error) {
            return arg.stack || arg.message || String(arg)
          }
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2)
            } catch (_) {
              return String(arg)
            }
          }
          return String(arg)
        })
        .join(' ')

      // 2. 敏感数据脱敏（针对 SiliconFlow, OpenAI 各种常见 API Key 格式及 Bearer 认证头进行正则过滤）
      message = message
        .replace(/(sk-[a-zA-Z0-9]{20,})/gi, 'sk-***')
        .replace(/(Bearer\s+[a-zA-Z0-9_\-\.]{15,})/gi, 'Bearer ***')
        .replace(/(key=[a-zA-Z0-9_\-\.]{15,})/gi, 'key=***')

      // 3. 超长日志文本截断，防止渲染大字符时前端内存暴涨卡死（单条限制 1000 字符）
      if (message.length > 1000) {
        message = message.substring(0, 1000) + '... (已截断超长日志)'
      }

      const entry: ConsoleLogEntry = {
        type,
        message,
        timestamp: Date.now()
      }

      this.logBuffer.push(entry)

      // 4. 环形队列截断
      if (this.logBuffer.length > this.MAX_LOGS) {
        this.logBuffer.shift()
      }

      // 5. 若有活动订阅者，触发实时 IPC 广播
      if (this.subscriberWebContents) {
        try {
          const isDestroyed = typeof this.subscriberWebContents.isDestroyed === 'function'
            ? this.subscriberWebContents.isDestroyed()
            : false
          if (!isDestroyed) {
            this.subscriberWebContents.send('new-log-broadcast', entry)
          }
        } catch (_) {
          this.subscriberWebContents = null
        }
      }
    } catch (err) {
      // 出错时退回使用最原始输出，绝不卡死系统
      this.originalError('[LogBuffer] 日志推入缓冲区异常:', err)
    }
  }
}
