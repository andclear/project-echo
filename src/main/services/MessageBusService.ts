/**
 * MessageBusService - 消息总线服务（系统级消息推送核心）
 *
 * 职责：
 * 1. 接收业务层（AI 执行器、生命引擎、微信服务等）的消息发布请求
 * 2. 将消息原子写入 SQLite，附带 round_id / seq / msg_type
 * 3. 更新 ConversationMeta 表的 unread 和 last_msg_ts（数据库端权威自增）
 * 4. 通过两条独立通道精确推送：
 *    - Electron IPC 通道：mainWindow.webContents.send('echo:message', msg)
 *    - SSE 通道：SseManager.broadcast('echo:message', msg)
 * 5. 向前端推送 unread 更新事件：echo:unread-update
 *
 * 设计原则：
 * - 全局唯一单例，所有业务模块统一调用此服务
 * - 消息只由此服务存储和分发，杜绝其他地方直接操作 db.saveMessage + 推送
 * - 精确一次（Exactly-Once）语义：每条消息有全局唯一 UUID，前端用 ID Set 去重
 * - 不再使用任何流式输出（chat-chunk）
 */

import { BrowserWindow } from 'electron'
import crypto from 'crypto'
import { getDatabaseService } from '../db/database'
import { SseManager } from './SseManager'

// ────────────────────────────────────────────────────────────
// 消息类型定义
// ────────────────────────────────────────────────────────────

/** 消息类型枚举 */
export type MessageType = 'text' | 'red_packet' | 'image' | 'custom_emoji' | 'diary' | 'system'

/** 会话元数据结构 */
export interface ConversationMeta {
  character_id: string
  unread: number
  pinned: boolean
  muted: boolean
  hidden: boolean
  last_msg_ts: number
}

/** 核心消息结构（数据库存储 + 网络传输共用） */
export interface EchoMessage {
  /** 消息唯一 ID（UUID v4）*/
  id: string
  /** 轮次 ID：同一次对话交互中用户消息和 AI 回复共享同一个 round_id */
  round_id: string
  /** 轮次内序号（从 0 开始，保证 dialogue 多气泡有序）*/
  seq: number
  /** 所属会话 ID（单聊=角色ID，群聊=群ID）*/
  character_id: string
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system'
  /** 消息类型，用于前端分发渲染 */
  msg_type: MessageType
  /** 消息内容（文字消息为纯文本，其他类型为 JSON 字符串） */
  content: string
  /** 消息时间戳（毫秒）*/
  timestamp: number
  /** Token 消耗（总量） */
  token_usage?: number
  /** 提示词 Token 数 */
  prompt_tokens?: number
  /** 生成 Token 数 */
  completion_tokens?: number
  /** 缓存命中 Token 数 */
  cached_tokens?: number
  /** 发送者 ID（群聊中标识具体发言的角色 ID，用户消息为 'user'）*/
  sender_id?: string
  /** 是否为角色主动搭讪消息（1=是，不参与连续气泡合并）*/
  is_proactive?: number
  // ──── 以下字段不存入 DB，仅在推送 payload 中携带 ────
  /** 红包动作（领取/退回/发出），由业务层在发布时附加 */
  redPacketAction?: 'receive' | 'return' | 'send' | null
  /** 自定义表情包发送信息 */
  customEmojiSend?: { meaning: string; base64: string } | null
}

/** 发布选项 */
export interface PublishOptions {
  /**
   * 消息来源设备标识。
   * 'electron' = 来自本机 Electron 用户操作
   * 'sse_client' = 来自局域网手机/Web 端
   * 不设置 = 来自内部服务（生命引擎/微信等），双路推送
   */
  fromDevice?: 'electron' | 'sse_client' | string
  /**
   * 是否跳过 Electron IPC 推送
   * 用于用户消息（用户消息已在前端 UI 显示，无需再推送）
   */
  skipElectronPush?: boolean
  /**
   * 是否跳过 SSE 推送
   * 用于纯 Electron 端操作，不需要通知局域网客户端的情况
   */
  skipSsePush?: boolean
  /**
   * 是否跳过未读计数更新（用于用户自己发的消息）
   */
  skipUnreadUpdate?: boolean
}

// ────────────────────────────────────────────────────────────
// MessageBusService 主类
// ────────────────────────────────────────────────────────────

export class MessageBusService {
  private static instance: MessageBusService | null = null

  /** 获取 BrowserWindow 的回调（延迟绑定，避免循环依赖）*/
  private getMainWindow: (() => BrowserWindow | null) | null = null

  /**
   * 全局串行分发队列。
   * 所有 dispatch / dispatchBatch 调用都追加到此 Promise 链末尾，
   * 保证在任何并发场景（AgentLifeEngine Promise.all / 多路 publishBatch）下，
   * echo:message 推送严格按入队顺序单线执行，绝不交叉。
   */
  private dispatchQueue: Promise<void> = Promise.resolve()

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): MessageBusService {
    if (!MessageBusService.instance) {
      MessageBusService.instance = new MessageBusService()
    }
    return MessageBusService.instance
  }

  /**
   * 绑定 BrowserWindow 获取函数（在 createWindow 后调用）
   */
  bindMainWindow(getWindow: () => BrowserWindow | null): void {
    this.getMainWindow = getWindow
  }

  // ──────────────────────────────────────────────
  // 核心发布 API
  // ──────────────────────────────────────────────

  /**
   * 发布单条消息（原子存盘 + 多端推送）
   *
   * @param msg     完整的消息对象（id 若未提供则自动生成）
   * @param options 发布选项
   */
  publish(msg: EchoMessage, options: PublishOptions = {}): void {
    // 确保 id 存在
    if (!msg.id) {
      msg.id = crypto.randomUUID()
    }

    // 1. 原子写入 SQLite
    this.saveToDatabase(msg)

    // 2. 更新会话元数据（未读计数 + 最近消息时间戳）
    if (!options.skipUnreadUpdate && msg.role !== 'user') {
      this.updateConversationMeta(msg.character_id, msg.timestamp)
    } else if (msg.role === 'user') {
      // 用户消息也更新 last_msg_ts，但不增加 unread
      this.updateLastMsgTs(msg.character_id, msg.timestamp)

      // 用户主动聊天时，物理取消该角色的待执行搭讪计划
      try {
        const dbLocal = getDatabaseService()
        dbLocal.setSetting(`active_plan_timestamp_${msg.character_id}`, '')
        dbLocal.setSetting(`active_plan_reason_${msg.character_id}`, '')
        dbLocal.setSetting(`active_plan_event_${msg.character_id}`, '')
        dbLocal.setSetting(`active_plan_strength_${msg.character_id}`, '')
      } catch (err) {
        console.error(`[MessageBus] 取消待执行搭讪计划异常:`, err)
      }
    }

    // 3. 多端推送
    this.dispatch(msg, options)
  }

  /**
   * 批量发布消息（同一 round_id 内的多条消息，按 seq 有序）
   * 原子存盘 + 按 seq 顺序有序推送
   *
   * @param msgs    同一轮次的消息列表（必须已按 seq 排好序）
   * @param options 发布选项
   */
  publishBatch(msgs: EchoMessage[], options: PublishOptions = {}): void {
    if (msgs.length === 0) return

    const db = getDatabaseService()

    // 批量原子写入（使用 SQLite 事务保证全部成功或全部回滚）
    try {
      const insertBatch = db.db.transaction(() => {
        for (const msg of msgs) {
          if (!msg.id) msg.id = crypto.randomUUID()
          this.saveToDatabase(msg)
        }
      })
      insertBatch()
    } catch (err) {
      console.error('[MessageBusService] 批量存盘失败:', err)
      return
    }

    // 更新会话元数据（取批次中最大时间戳）
    const lastTs = Math.max(...msgs.map(m => m.timestamp))
    const hasAssistantMsg = msgs.some(m => m.role !== 'user')
    if (!options.skipUnreadUpdate && hasAssistantMsg) {
      this.updateConversationMeta(msgs[0].character_id, lastTs)
    } else {
      this.updateLastMsgTs(msgs[0].character_id, lastTs)
    }

    // 用户主动聊天时，物理取消该角色的待执行搭讪计划
    const hasUserMsg = msgs.some(m => m.role === 'user')
    if (hasUserMsg) {
      try {
        const charId = msgs[0].character_id
        db.setSetting(`active_plan_timestamp_${charId}`, '')
        db.setSetting(`active_plan_reason_${charId}`, '')
        db.setSetting(`active_plan_event_${charId}`, '')
        db.setSetting(`active_plan_strength_${charId}`, '')
      } catch (err) {
        console.error(`[MessageBus] 批量取消待执行搭讪计划异常:`, err)
      }
    }

    // 按 seq 顺序有序推送（interval 50ms 防止 TCP 粘包，保证前端收到顺序正确）
    this.dispatchBatch(msgs, options)
  }

  // ──────────────────────────────────────────────
  // ConversationMeta API（数据库端权威存取）
  // ──────────────────────────────────────────────

  /**
   * 获取指定会话的元数据
   */
  getConversationMeta(characterId: string): ConversationMeta {
    const db = getDatabaseService()
    return db.getConversationMeta(characterId)
  }

  /**
   * 获取所有会话的元数据（启动时前端全量加载用）
   */
  getAllConversationMeta(): ConversationMeta[] {
    const db = getDatabaseService()
    return db.getAllConversationMeta()
  }

  /**
   * 将指定会话的未读计数清零（用户打开会话时调用）
   */
  clearUnread(characterId: string): void {
    const db = getDatabaseService()
    db.setConversationMetaField(characterId, 'unread', 0)

    // 推送清零事件给 Electron 前端
    this.sendToElectron('echo:unread-update', { characterId, unread: 0 })
    // 同时广播给 SSE 客户端（如果手机端也在同一会话）
    SseManager.getInstance().broadcast('echo:unread-update', { characterId, unread: 0 })
  }

  /**
   * 更新会话置顶/静音/隐藏状态
   */
  setConversationMeta(characterId: string, meta: Partial<Omit<ConversationMeta, 'character_id' | 'unread' | 'last_msg_ts'>>): void {
    const db = getDatabaseService()
    if (meta.pinned !== undefined) db.setConversationMetaField(characterId, 'pinned', meta.pinned ? 1 : 0)
    if (meta.muted !== undefined) db.setConversationMetaField(characterId, 'muted', meta.muted ? 1 : 0)
    if (meta.hidden !== undefined) db.setConversationMetaField(characterId, 'hidden', meta.hidden ? 1 : 0)
  }

  // ──────────────────────────────────────────────
  // 工具方法
  // ──────────────────────────────────────────────

  /**
   * 创建标准 EchoMessage（辅助工厂方法，减少业务层样板代码）
   */
  static createMessage(params: {
    characterId: string
    role: 'user' | 'assistant' | 'system'
    content: string
    msgType?: MessageType
    roundId?: string
    seq?: number
    senderId?: string
    isProactive?: number
    tokenUsage?: number
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
  }): EchoMessage {
    return {
      id: crypto.randomUUID(),
      round_id: params.roundId || crypto.randomUUID(),
      seq: params.seq ?? 0,
      character_id: params.characterId,
      role: params.role,
      msg_type: params.msgType ?? 'text',
      content: params.content,
      timestamp: Date.now(),
      token_usage: params.tokenUsage ?? 0,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      cached_tokens: params.cachedTokens,
      sender_id: params.senderId,
      is_proactive: params.isProactive ?? 0
    }
  }

  // ──────────────────────────────────────────────
  // 私有方法
  // ──────────────────────────────────────────────

  /**
   * 将消息写入 SQLite
   * 提取了非 DB 字段（redPacketAction、customEmojiSend），只存纯数据
   */
  private saveToDatabase(msg: EchoMessage): void {
    const db = getDatabaseService()
    db.saveMessage({
      id: msg.id,
      character_id: msg.character_id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      token_usage: msg.token_usage ?? 0,
      prompt_tokens: msg.prompt_tokens,
      completion_tokens: msg.completion_tokens,
      cached_tokens: msg.cached_tokens,
      sender_id: msg.sender_id,
      is_proactive: msg.is_proactive ?? 0,
      round_id: msg.round_id,
      seq: msg.seq,
      msg_type: msg.msg_type
    })
  }

  /**
   * 更新会话元数据（未读+1，last_msg_ts 更新）
   * 仅对 assistant 消息调用
   */
  private updateConversationMeta(characterId: string, timestamp: number): void {
    const db = getDatabaseService()
    const newUnread = db.incrementUnread(characterId, timestamp)

    // 推送未读数更新给所有端
    this.sendToElectron('echo:unread-update', { characterId, unread: newUnread })
    SseManager.getInstance().broadcast('echo:unread-update', { characterId, unread: newUnread })
  }

  /**
   * 仅更新 last_msg_ts（用户消息，不增加 unread）
   */
  private updateLastMsgTs(characterId: string, timestamp: number): void {
    const db = getDatabaseService()
    db.setConversationMetaField(characterId, 'last_msg_ts', timestamp)
  }

  /**
   * 向单个端分发消息（根据 options 决定推送路径）
   * 所有推送通过全局 dispatchQueue 串行化，保证消息绝对不会交叉乱序
   */
  private dispatch(msg: EchoMessage, options: PublishOptions): void {
    const { skipElectronPush = false, skipSsePush = false } = options
    // 单条消息排队等待前置 batch 完成后再推送，保证全局有序
    this.dispatchQueue = this.dispatchQueue.then(() => {
      if (!skipElectronPush) this.sendToElectron('echo:message', msg)
      if (!skipSsePush) SseManager.getInstance().broadcast('echo:message', msg)
    }).catch(err => {
      // 单次推送异常不中断后续队列
      console.error('[MessageBusService] dispatch 推送异常:', err)
    })
  }

  /**
   * 批量有序分发（按 seq 顺序，50ms 间隔保证前端接收顺序正确）
   * 通过 dispatchQueue 串行排队，与其他 dispatch/dispatchBatch 调用绝对不交叉
   */
  private dispatchBatch(msgs: EchoMessage[], options: PublishOptions): void {
    const { skipElectronPush = false, skipSsePush = false } = options
    // 将本次批量分发追加到全局队列末尾，等待前置分发全部完成后才开始
    this.dispatchQueue = this.dispatchQueue.then(async () => {
      for (const msg of msgs) {
        if (!skipElectronPush) this.sendToElectron('echo:message', msg)
        if (!skipSsePush) SseManager.getInstance().broadcast('echo:message', msg)
        // 50ms 间隔：保证前端按顺序接收并处理，防止 TCP 粘包与渲染乱序
        if (msgs.length > 1) {
          await new Promise<void>(resolve => setTimeout(resolve, 50))
        }
      }
    }).catch(err => {
      // 批次推送异常不中断后续队列
      console.error('[MessageBusService] dispatchBatch 推送异常:', err)
    })
  }

  /**
   * 安全地向 Electron BrowserWindow 发送 IPC 事件
   * 使用原始的 webContents.send（不经任何猴子补丁）
   */
  private sendToElectron(channel: string, data: any): void {
    if (!this.getMainWindow) return
    const win = this.getMainWindow()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}
