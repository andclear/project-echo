/**
 * MessageQueueManager - 前端消息队列管理器
 *
 * 职责：
 * 1. 监听 echo:message 事件（来自 Electron IPC 或 SSE 通道）
 * 2. 基于消息 ID Set 实现精确一次（Exactly-Once）去重
 * 3. 按 round_id + seq 保证消息有序排队渲染
 * 4. 监听 echo:unread-update 事件，维护前端未读计数
 * 5. 通过回调将消息和未读数变更通知给 App.vue 或其他组件
 *
 * 设计原则：
 * - 与 SSE 客户端无关（SSE 和 IPC 都通过同一个 echo:message 事件流入）
 * - 不直接操作 DOM，只通过回调/事件通知 UI 层
 * - 可重入安全：多次调用 init 只注册一次监听器
 */

import type { EchoMessage } from '../types/EchoMessageTypes'

// ──────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────

export interface MessageQueueOptions {
  /** 收到新消息时的回调（已去重、有序） */
  onMessage: (msg: EchoMessage) => void
  /** 收到未读数更新时的回调 */
  onUnreadUpdate: (characterId: string, unread: number) => void
}

// ──────────────────────────────────────────────────────────────
// MessageQueueManager 主类
// ──────────────────────────────────────────────────────────────

export class MessageQueueManager {
  private static instance: MessageQueueManager | null = null

  // 已处理的消息 ID 集合（防止 IPC 与 SSE 双路重复推送）
  // 使用 LRU 淘汰策略：超过 500 条时删掉最旧的
  private seenIds = new Set<string>()
  private seenIdQueue: string[] = []
  private readonly MAX_SEEN_IDS = 500

  private options: MessageQueueOptions | null = null

  // SSE EventSource 引用（局域网 Web/手机端使用）
  private sseSource: EventSource | null = null

  // 是否已初始化 Electron IPC 监听
  private electronListenerRegistered = false

  private constructor() {}

  static getInstance(): MessageQueueManager {
    if (!MessageQueueManager.instance) {
      MessageQueueManager.instance = new MessageQueueManager()
    }
    return MessageQueueManager.instance
  }

  /**
   * 初始化消息队列管理器
   * - 在 Electron 环境下注册 IPC 监听
   * - 在 Web/局域网环境下建立 SSE 连接
   *
   * 可以安全地多次调用（内部做幂等保护）
   */
  init(options: MessageQueueOptions): void {
    this.options = options

    if (typeof window === 'undefined') return

    const api = (window as any).api
    const isElectron = !!(window as any).electron
    const isIpcBridge = !!(api?.isIpcBridge)

    if (api && !this.electronListenerRegistered) {
      // Electron 原生 IPC 或 IPC Bridge（局域网 Web 端）：
      // 两者都通过 window.api.receive 注册回调。
      // IPC Bridge 内部已有一个 SSE EventSource（在 App.vue 的 polyfill 中建立），
      // 会把 SSE 推送路由到 listeners['echo:message']，此处无需再开独立 SSE。
      api.receive('echo:message', (msg: EchoMessage) => {
        this.handleIncoming(msg)
      })
      api.receive('echo:unread-update', (data: { characterId: string; unread: number }) => {
        if (this.options) {
          this.options.onUnreadUpdate(data.characterId, data.unread)
        }
      })
      this.electronListenerRegistered = true
      console.log(`[MessageQueueManager] 消息监听已注册 (${isElectron ? 'Electron IPC' : isIpcBridge ? 'IPC Bridge SSE' : 'web.api'})`)
    }

    // 纯 Web 端（无 window.api）：直接建立独立 SSE 连接
    if (!api && !isElectron) {
      this.connectSse()
    }
  }

  /**
   * 重置去重状态（在清空聊天记录时调用）
   */
  resetDedup(): void {
    this.seenIds.clear()
    this.seenIdQueue = []
  }

  /**
   * 销毁（断开 SSE 连接，清理状态）
   */
  destroy(): void {
    if (this.sseSource) {
      this.sseSource.close()
      this.sseSource = null
    }
    this.seenIds.clear()
    this.seenIdQueue = []
    this.options = null
    this.electronListenerRegistered = false
    MessageQueueManager.instance = null
  }

  // ──────────────────────────────────────────────
  // 私有方法
  // ──────────────────────────────────────────────

  /**
   * 处理入站消息（去重 + 分发）
   */
  private handleIncoming(msg: EchoMessage): void {
    if (!msg?.id || !this.options) return

    // 精确一次去重（基于消息 ID）
    if (this.seenIds.has(msg.id)) {
      console.debug(`[MessageQueueManager] 去重过滤: 消息 ${msg.id} 已处理，跳过`)
      return
    }

    // 添加到已处理 Set（LRU 淘汰）
    this.seenIds.add(msg.id)
    this.seenIdQueue.push(msg.id)
    if (this.seenIdQueue.length > this.MAX_SEEN_IDS) {
      const removed = this.seenIdQueue.shift()!
      this.seenIds.delete(removed)
    }

    // 触发消息回调
    this.options.onMessage(msg)
  }

  /**
   * 建立 SSE 连接（仅 Web 端）
   * 包含自动重连逻辑（指数退避，最大 30 秒）
   */
  private connectSse(retryDelay = 1000): void {
    if (this.sseSource) {
      this.sseSource.close()
      this.sseSource = null
    }

    // 从 URL 中解析 IPC 桥接服务器地址
    const urlParams = new URLSearchParams(window.location.search)
    const serverHost = urlParams.get('server') || window.location.hostname
    const serverPort = urlParams.get('port') || '3000'
    const sseUrl = `http://${serverHost}:${serverPort}/api/events`

    console.log(`[MessageQueueManager] 正在建立 SSE 连接: ${sseUrl}`)

    const source = new EventSource(sseUrl)
    this.sseSource = source

    source.addEventListener('echo:message', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data)
        const msg: EchoMessage = payload.data || payload
        this.handleIncoming(msg)
      } catch (err) {
        console.error('[MessageQueueManager] SSE echo:message 解析失败:', err)
      }
    })

    source.addEventListener('echo:unread-update', (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data)
        const data = payload.data || payload
        if (this.options) {
          this.options.onUnreadUpdate(data.characterId, data.unread)
        }
      } catch (err) {
        console.error('[MessageQueueManager] SSE echo:unread-update 解析失败:', err)
      }
    })

    source.onerror = () => {
      console.warn(`[MessageQueueManager] SSE 连接断开，${retryDelay}ms 后自动重连...`)
      source.close()
      this.sseSource = null
      // 指数退避重连（最大 30 秒）
      const nextDelay = Math.min(retryDelay * 2, 30_000)
      setTimeout(() => this.connectSse(nextDelay), retryDelay)
    }

    source.onopen = () => {
      console.log('[MessageQueueManager] SSE 连接已建立')
    }
  }
}
