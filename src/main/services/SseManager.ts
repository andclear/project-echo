/**
 * SseManager - SSE 客户端连接管理器
 *
 * 职责：
 * 1. 管理所有 SSE 客户端连接的生命周期（连接/断开/心跳）
 * 2. 维护环形消息缓冲区（最近 100 条纯业务消息，用于断线重连补偿）
 * 3. 向所有已连接客户端广播消息
 * 4. 处理断线重连时的消息补偿（按 sseSeq 精确补发）
 *
 * 设计原则：
 * - 只存储真实业务消息（echo:message），绝不存储内部信号
 * - 全局唯一单例，由 MessageBusService 调用
 */

import * as http from 'http'

// SSE 缓冲区条目结构
export interface SseBufferEntry {
  sseSeq: number       // 全局自增序号，客户端用于断线重连时请求补偿
  eventType: string    // 事件类型（目前固定为 'echo:message'）
  data: any            // 消息 payload（JSON 可序列化对象）
  raw: string          // 已序列化的 SSE 帧，复用避免重复序列化
}

// SSE 缓冲区最大容量
const SSE_BUFFER_MAX = 100

// 心跳间隔（毫秒）
const HEARTBEAT_INTERVAL_MS = 20_000

export class SseManager {
  private static instance: SseManager | null = null

  // 已连接的 SSE 客户端集合（http.ServerResponse）
  private clients = new Set<http.ServerResponse>()

  // 环形消息缓冲区（只存业务消息）
  private buffer: SseBufferEntry[] = []

  // 全局自增序号
  private seqCounter = 0

  // 心跳定时器
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private constructor() {
    this.startHeartbeat()
  }

  /**
   * 获取单例实例
   */
  static getInstance(): SseManager {
    if (!SseManager.instance) {
      SseManager.instance = new SseManager()
    }
    return SseManager.instance
  }

  /**
   * 添加新的 SSE 客户端连接
   * 连接后立即发送欢迎帧和断线期间错过的消息（补偿）
   */
  addClient(res: http.ServerResponse, lastReceivedSeq: number = -1): void {
    // 监听 socket 错误事件，防止异步写入出错导致 Node.js 进程未捕获异常而崩溃
    res.on('error', (err) => {
      console.warn('[SseManager] 客户端连接发生异常错误，自动清理:', err.message)
      this.removeClient(res)
    })

    // 🚀 禁用 Nagle 算法：强迫 TCP 协议栈无延迟即时发送微小数据包，保障局域网即时推送
    if (res.socket) {
      res.socket.setNoDelay(true)
    }

    // 设置 SSE 响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // 防止 nginx/反向代理缓冲 SSE 数据包
      'Access-Control-Allow-Origin': '*'
    })

    // 发送连接确认帧
    res.write(': sse-connected\n\n')

    // 注册客户端
    this.clients.add(res)

    // 断线重连补偿：发送错过的业务消息
    this.sendMissedMessages(res, lastReceivedSeq)

    console.log(`[SseManager] 新客户端已连接。当前连接数: ${this.clients.size}`)
  }

  /**
   * 移除已断开的 SSE 客户端
   */
  removeClient(res: http.ServerResponse): void {
    this.clients.delete(res)
    console.log(`[SseManager] 客户端已断开。当前连接数: ${this.clients.size}`)
  }

  /**
   * 向所有已连接客户端广播一条业务消息
   * 同时写入缓冲区，供后续断线重连使用
   *
   * @param eventType 事件类型名（前端 window.api.receive 监听的通道名）
   * @param data      消息数据（会被 JSON 序列化）
   * @returns         本次广播的 sseSeq（全局序号）
   */
  broadcast(eventType: string, data: any): number {
    const seq = ++this.seqCounter
    const payload = JSON.stringify({ eventType, data, sseSeq: seq })
    // SSE 帧格式：id: <seq>\nevent: <type>\ndata: <json>\n\n
    const raw = `id: ${seq}\nevent: ${eventType}\ndata: ${payload}\n\n`

    // 只有持久化业务消息才写入缓冲区（echo:message）
    // echo:unread-update 是实时信号，不需要补偿，避免重连后收到过期未读数
    if (eventType === 'echo:message') {
      this.buffer.push({ sseSeq: seq, eventType, data, raw })
      if (this.buffer.length > SSE_BUFFER_MAX) {
        this.buffer.shift()
      }
    }

    // 推送给所有客户端，写入失败的客户端视为已断开，自动移除
    const deadClients: http.ServerResponse[] = []
    for (const client of this.clients) {
      try {
        client.write(raw)
      } catch (_) {
        deadClients.push(client)
      }
    }
    for (const dead of deadClients) {
      this.clients.delete(dead)
    }

    return seq
  }

  /**
   * 获取当前连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size
  }

  /**
   * 获取缓冲区中 sseSeq > lastReceivedSeq 的所有消息
   * 用于断线重连补偿查询（不包含心跳、内部信号等）
   */
  getMissedEntries(lastReceivedSeq: number): SseBufferEntry[] {
    return this.buffer.filter(entry => entry.sseSeq > lastReceivedSeq)
  }

  /**
   * 销毁单例，停止心跳（仅用于应用退出时清理）
   */
  destroy(): void {
    this.stopHeartbeat()
    for (const client of this.clients) {
      try { client.end() } catch (_) {}
    }
    this.clients.clear()
    SseManager.instance = null
  }

  // ──────────── 私有方法 ────────────

  /**
   * 启动心跳定时器
   * 每 20 秒向所有客户端发送 SSE comment 心跳包（: ping）
   * 浏览器收到 comment 行会直接丢弃，不触发 onmessage，对业务透明
   * 作用：防止路由器/NAT/iOS 系统因 TCP 长时间无活动而强制断开连接
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const deadClients: http.ServerResponse[] = []
      for (const client of this.clients) {
        try {
          client.write(': ping\n\n')
        } catch (_) {
          deadClients.push(client)
        }
      }
      for (const dead of deadClients) {
        this.clients.delete(dead)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /**
   * 停止心跳定时器
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /**
   * 向指定客户端发送断线期间错过的消息（异步，60ms 间隔，防 TCP 粘包）
   */
  private sendMissedMessages(res: http.ServerResponse, lastReceivedSeq: number): void {
    if (lastReceivedSeq < 0 || this.buffer.length === 0) return

    const missed = this.getMissedEntries(lastReceivedSeq)
    if (missed.length === 0) return

    console.log(`[SseManager] 断线重连补偿：补发 ${missed.length} 条消息（sseSeq > ${lastReceivedSeq}）`)

    // 异步发送，每条消息之间 60ms 间隔，避免 TCP 粘包
    ;(async () => {
      for (const entry of missed) {
        if (!this.clients.has(res)) break  // 若客户端已断开，终止发送
        try {
          res.write(entry.raw)
          await new Promise(resolve => setTimeout(resolve, 60))
        } catch (_) {
          this.clients.delete(res)
          break
        }
      }
    })()
  }
}
