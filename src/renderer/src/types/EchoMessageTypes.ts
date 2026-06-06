/**
 * EchoMessageTypes - 前端共享的消息类型定义
 *
 * 与 main/services/MessageBusService.ts 中的类型保持同步。
 * 前端不直接引用 main 进程代码，故在此单独定义。
 */

/** 消息类型枚举 */
export type MessageType = 'text' | 'red_packet' | 'image' | 'custom_emoji' | 'diary' | 'system'

/** 核心消息结构（与后端 EchoMessage 完全对应） */
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
  /** Token 消耗（总量）*/
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
  /** 红包动作（领取/退回/发出），仅在推送 payload 中携带 */
  redPacketAction?: 'receive' | 'return' | 'send' | null
  /** 自定义表情包发送信息，仅在推送 payload 中携带 */
  customEmojiSend?: { meaning: string; base64: string } | null
}

/** 会话元数据结构 */
export interface ConversationMeta {
  character_id: string
  unread: number
  pinned: boolean
  muted: boolean
  hidden: boolean
  last_msg_ts: number
}

/** unread-update 事件 payload */
export interface UnreadUpdatePayload {
  characterId: string
  unread: number
}
