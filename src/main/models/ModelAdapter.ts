import { getDatabaseService } from '../db/database'
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter'
import { join } from 'path'

export type ModelProviderType = 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'gemini'

export interface ModelConfig {
  provider: ModelProviderType
  baseUrl: string
  apiKey?: string
  model: string
  supportsSystem?: boolean // 是否支持 system 角色，默认为 true
  temperature?: number // 新增：可精细调节的温度参数 (0.0 到 2.0)
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatChunk {
  content: string
  done: boolean
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    cached_tokens?: number
  }
}

export interface ChatResponse {
  content: string
  tokenUsage?: number
}

export interface ChatOptions {
  usePrimary?: boolean
  useSecondary?: boolean
  skipSystemInjection?: boolean // 是否跳过所有全局提示词与时间感知等背景 System 注入，用于纯净低消耗连通性测试
  characterId?: string
  characterName?: string
}


/**
 * 统一的大模型服务提供商适配接口
 */
export interface IModelProvider {
  chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse>
  chatStream(config: ModelConfig, messages: ChatMessage[]): AsyncGenerator<ChatChunk, void, unknown>
}

// 统一的商业级 User-Agent 强注入头
export const COMMON_HEADERS = {
  'User-Agent': 'EchoPlatform/1.0.3 (Desktop AI Roleplay Platform)'
}

/**
 * 助手工具：将不支持 system 模式的消息进行平滑降级合并
 * 策略：提取所有 system 消息内容拼装为 [系统指令：xxx]\n\n，融入到首个 user 消息前。若无 user 消息则自动转换为 user。
 */
export function mergeSystemMessage(messages: ChatMessage[]): ChatMessage[] {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  if (systemMsgs.length === 0) {
    return messages
  }

  const systemContent = systemMsgs.map((m) => m.content).join('\n')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

  const firstUserIndex = nonSystemMsgs.findIndex((m) => m.role === 'user')
  if (firstUserIndex !== -1) {
    const updatedMessages = [...nonSystemMsgs]
    const originalContent = updatedMessages[firstUserIndex].content
    updatedMessages[firstUserIndex] = {
      ...updatedMessages[firstUserIndex],
      content: `[系统指令：${systemContent}]\n\n${originalContent}`
    }
    return updatedMessages
  } else {
    // 降级：如果不存在 user 消息，将 system 消息转义为 user 消息插在最前列
    return [{ role: 'user', content: systemContent }, ...nonSystemMsgs]
  }
}

/**
 * OpenAI 兼容协议适配器
 */
export class OpenAIProvider implements IModelProvider {
  public async chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse> {
    const finalMessages = config.supportsSystem === false ? mergeSystemMessage(messages) : messages
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...COMMON_HEADERS
    }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    const payload: Record<string, any> = {
      model: config.model,
      messages: finalMessages,
      stream: false
    }

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API 响应错误 (${response.status}): ${errText}`)
    }

    const result = await response.json()
    const content = result.choices?.[0]?.message?.content || ''
    const tokenUsage = result.usage?.total_tokens || 0

    return { content, tokenUsage }
  }

  public async *chatStream(
    config: ModelConfig,
    messages: ChatMessage[]
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const finalMessages = config.supportsSystem === false ? mergeSystemMessage(messages) : messages
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...COMMON_HEADERS
    }
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    const payload: Record<string, any> = {
      model: config.model,
      messages: finalMessages,
      stream: true,
      stream_options: {
        include_usage: true
      }
    }

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI Stream 响应错误 (${response.status}): ${errText}`)
    }

    if (!response.body) {
      throw new Error('未获取到响应流数据')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed === 'data: [DONE]') {
            yield { content: '', done: true }
            return
          }

          if (trimmed.startsWith('data:')) {
            const rawJson = trimmed.substring(5).trim()
            try {
              const parsed = JSON.parse(rawJson)
              const content = parsed.choices?.[0]?.delta?.content || ''
              const usage = parsed.usage ? {
                prompt_tokens: parsed.usage.prompt_tokens,
                completion_tokens: parsed.usage.completion_tokens,
                total_tokens: parsed.usage.total_tokens,
                cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens
              } : undefined

              if (content || usage) {
                yield { content, done: false, usage }
              }
            } catch (e) {
              // 容错处理
            }
          }
        }
      }

      if (buffer.trim() && buffer.trim().startsWith('data:')) {
        const trimmed = buffer.trim()
        if (trimmed !== 'data: [DONE]') {
          const rawJson = trimmed.substring(5).trim()
          try {
            const parsed = JSON.parse(rawJson)
            const content = parsed.choices?.[0]?.delta?.content || ''
            const usage = parsed.usage ? {
              prompt_tokens: parsed.usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens,
              total_tokens: parsed.usage.total_tokens,
              cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens
            } : undefined

            if (content || usage) {
              yield { content, done: false, usage }
            }
          } catch (_) {}
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * Anthropic Claude 协议适配器
 */
export class AnthropicProvider implements IModelProvider {
  /**
   * 将 messages 中禁用的 system 消息提炼到顶层
   */
  private preparePayload(config: ModelConfig, messages: ChatMessage[], stream: boolean) {
    const systemMsgs = messages.filter((m) => m.role === 'system')
    const system = systemMsgs.length > 0 ? systemMsgs.map((m) => m.content).join('\n') : undefined
    const remainingMessages = messages.filter((m) => m.role !== 'system')

    const payload: Record<string, any> = {
      model: config.model,
      messages: remainingMessages,
      system,
      max_tokens: 4096, // Anthropic 强制需要 max_tokens 参数
      stream
    }

    if (config.temperature !== undefined) {
      payload.temperature = config.temperature
    }

    return payload
  }

  public async chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
      ...COMMON_HEADERS
    }

    const payload = this.preparePayload(config, messages, false)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Anthropic API 响应错误 (${response.status}): ${errText}`)
    }

    const result = await response.json()
    // Anthropic 官方响应体结构为：content: [{ type: "text", text: "..." }]
    const content = result.content?.[0]?.text || ''
    const tokenUsage = (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0)

    return { content, tokenUsage }
  }

  public async *chatStream(
    config: ModelConfig,
    messages: ChatMessage[]
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/messages`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey || '',
      'anthropic-version': '2023-06-01',
      ...COMMON_HEADERS
    }

    const payload = this.preparePayload(config, messages, true)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Anthropic Stream 响应错误 (${response.status}): ${errText}`)
    }

    if (!response.body) {
      throw new Error('未获取到响应流数据')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          // Anthropic 流的每行可能格式为：data: {"type": "content_block_delta", ...}
          if (trimmed.startsWith('data:')) {
            const rawJson = trimmed.substring(5).trim()
            try {
              const parsed = JSON.parse(rawJson)
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                yield { content: parsed.delta.text, done: false }
              } else if (parsed.type === 'message_stop') {
                yield { content: '', done: true }
              }
            } catch (e) {
              // 容错
            }
          }
        }
      }

      if (buffer.trim() && buffer.trim().startsWith('data:')) {
        const trimmed = buffer.trim()
        const rawJson = trimmed.substring(5).trim()
        try {
          const parsed = JSON.parse(rawJson)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { content: parsed.delta.text, done: false }
          }
        } catch (_) {}
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * DeepSeek 专属通道驱动
 */
export class DeepSeekProvider extends OpenAIProvider {
  /**
   * 重载以进行 baseUrl 默认值规整
   */
  public override async chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse> {
    const updatedConfig = { ...config }
    if (!updatedConfig.baseUrl) {
      updatedConfig.baseUrl = 'https://api.deepseek.com'
    }
    return super.chat(updatedConfig, messages)
  }

  public override async *chatStream(
    config: ModelConfig,
    messages: ChatMessage[]
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const updatedConfig = { ...config }
    if (!updatedConfig.baseUrl) {
      updatedConfig.baseUrl = 'https://api.deepseek.com'
    }
    yield* super.chatStream(updatedConfig, messages)
  }
}

/**
 * Gemini 兼容协议驱动
 */
export class GeminiProvider extends OpenAIProvider {
  /**
   * 重载以进行 baseUrl 默认值规整为 Google OpenAI 兼容端点
   */
  public override async chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse> {
    const updatedConfig = { ...config }
    if (!updatedConfig.baseUrl) {
      updatedConfig.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
    }
    return super.chat(updatedConfig, messages)
  }

  public override async *chatStream(
    config: ModelConfig,
    messages: ChatMessage[]
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const updatedConfig = { ...config }
    if (!updatedConfig.baseUrl) {
      updatedConfig.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
    }
    yield* super.chatStream(updatedConfig, messages)
  }
}

/**
 * Ollama 本地服务适配器
 */
export class OllamaProvider implements IModelProvider {
  public async chat(config: ModelConfig, messages: ChatMessage[]): Promise<ChatResponse> {
    const finalMessages = config.supportsSystem === false ? mergeSystemMessage(messages) : messages
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/chat`

    const payload: Record<string, any> = {
      model: config.model,
      messages: finalMessages,
      stream: false
    }

    if (config.temperature !== undefined) {
      payload.options = {
        temperature: config.temperature
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...COMMON_HEADERS
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Ollama API 响应错误 (${response.status}): ${errText}`)
    }

    const result = await response.json()
    const content = result.message?.content || ''
    const tokenUsage = (result.prompt_eval_count || 0) + (result.eval_count || 0)

    return { content, tokenUsage }
  }

  public async *chatStream(
    config: ModelConfig,
    messages: ChatMessage[]
  ): AsyncGenerator<ChatChunk, void, unknown> {
    const finalMessages = config.supportsSystem === false ? mergeSystemMessage(messages) : messages
    const url = `${config.baseUrl.replace(/\/$/, '')}/api/chat`

    const payload: Record<string, any> = {
      model: config.model,
      messages: finalMessages,
      stream: true
    }

    if (config.temperature !== undefined) {
      payload.options = {
        temperature: config.temperature
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...COMMON_HEADERS
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Ollama Stream 响应错误 (${response.status}): ${errText}`)
    }

    if (!response.body) {
      throw new Error('未获取到响应流数据')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          try {
            const parsed = JSON.parse(trimmed)
            const content = parsed.message?.content || ''
            const isDone = parsed.done || false
            if (content) {
              yield { content, done: isDone }
            } else if (isDone) {
              yield { content: '', done: true }
            }
          } catch (e) {
            // 忽略非完整 JSON 行
          }
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim())
          const content = parsed.message?.content || ''
          const isDone = parsed.done || false
          yield { content, done: isDone }
        } catch (_) {}
      }
    } finally {
      reader.releaseLock()
    }
  }
}

/**
 * 适配器工厂模式静态注册表
 */
export class ProviderFactory {
  private static providers: Record<ModelProviderType, IModelProvider> = {
    openai: new OpenAIProvider(),
    anthropic: new AnthropicProvider(),
    deepseek: new DeepSeekProvider(),
    ollama: new OllamaProvider(),
    gemini: new GeminiProvider()
  }

  public static getProvider(providerType: ModelProviderType): IModelProvider {
    const provider = this.providers[providerType]
    if (!provider) {
      // 容错，默认退回使用 OpenAI 兼容协议
      return this.providers['openai']
    }
    return provider
  }
}

/**
 * 核心 ModelAdapter 门面组合类
 */
export class ModelAdapter {
  private primary: ModelConfig
  private secondary?: ModelConfig

  constructor(primary: ModelConfig, secondary?: ModelConfig) {
    this.primary = primary
    
    // 动态检查全局 model_config 中是否启用了辅助大模型。
    // 在 Vitest 单测环境中，直接无条件信任传入的辅助配置。
    let isSecondaryEnabled = false
    if (process.env.VITEST) {
      isSecondaryEnabled = !!secondary
    } else {
      try {
        const db = getDatabaseService()
        const configStr = db.getSetting('model_config')
        if (configStr) {
          const settings = JSON.parse(configStr)
          isSecondaryEnabled = !!settings.enableSecondary
        }
      } catch (_) {}
    }

    if (isSecondaryEnabled) {
      this.secondary = secondary
    } else {
      this.secondary = undefined
    }
  }

  /**
   * 获取当前应该请求的模型配置（处理辅助模型切换与兜底逻辑）
   * 默认逻辑：其他所有的AI调用，优先使用辅助模型，如果没有配置辅助模型，则使用主模型
   */
  private getTargetConfig(options?: ChatOptions): ModelConfig {
    if (options?.usePrimary) {
      return this.primary
    }
    if (options?.useSecondary) {
      return this.secondary || this.primary
    }
    // 默认兜底路由：优先使用辅助模型 (如果配置了的话)
    if (this.secondary) {
      return this.secondary
    }
    return this.primary
  }

  /**
   * 自动从 SQLite 读取全局提示词，并前置拼接注入到 system 消息中
   */
  private injectGlobalPrompt(messages: ChatMessage[]): ChatMessage[] {
    try {
      const db = getDatabaseService()
      const configStr = db.getSetting('model_config')
      if (configStr) {
        const settings = JSON.parse(configStr)
        const globalPrompt = settings.globalPrompt?.trim()
        if (globalPrompt) {
          // 深度克隆以避免修改外部 messages
          const cloned = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
          
          // 1. 在第一个 system 消息的双端进行锁死注入（符合用户要求“附加在提示器最前面”的物理原则）
          const systemIdx = cloned.findIndex((m) => m.role === 'system')
          if (systemIdx !== -1) {
            // 采用 Prompt 强效双端锁死注入策略：
            // 1. 开头注入：符合物理“最前端”的声明
            // 2. 末尾强化：在长 prompt 末尾利用近因效应进行高优先级强化，彻底解决长文本注意力衰减导致被模型忽略的问题
            const originalContent = cloned[systemIdx].content
            cloned[systemIdx].content = `${globalPrompt}\n\n${originalContent}\n\n## 全局高优先级核心指令 (GLOBAL HIGH-PRIORITY RULES)\n【请务必绝对且无条件遵从以下全局高优先级指令，其优先级高于上述任何性格人设和背景设定描述】：\n${globalPrompt}`
          } else {
            cloned.unshift({ role: 'system', content: globalPrompt })
          }

          return cloned
        }
      }
    } catch (error) {
      console.error('[ModelAdapter] 注入全局提示词异常:', error)
    }
    return messages
  }

  /**
   * 运行时全自动拦截替换 {{user}} 和 <user> 为用户在全局画像中设定的真实姓名
   */
  private replaceUserPlaceholders(messages: ChatMessage[]): ChatMessage[] {
    try {
      let userName = '' // 无任何硬编码兜底默认值
      let globalUserPath = ''
      try {
        const { app } = require('electron')
        if (app) {
          globalUserPath = join(app.getPath('userData'), 'config', 'USER.md')
        }
      } catch (e) {
        // 非 Electron 环境或单测环境，避免崩溃
      }

      if (globalUserPath) {
        const profile = UserProfileReaderWriter.readGlobalProfile(globalUserPath)
        if (profile && profile.name) {
          userName = profile.name
        }
      }

      // 对 messages 进行深拷贝并执行字符串全局替换
      const cloned = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
      for (const msg of cloned) {
        if (msg.content) {
          // 替换 {{user}} 和 <user> 为真实姓名
          msg.content = msg.content.replace(/{{user}}/g, userName)
          msg.content = msg.content.replace(/<user>/g, userName)
        }
      }
      return cloned
    } catch (error) {
      console.error('[ModelAdapter] 替换用户占位符失败:', error)
    }
    return messages
  }

  /**
   * 运行时全自动拦截替换 {{char}} 和 <char> 为角色的真实姓名
   */
  private replaceCharacterPlaceholders(messages: ChatMessage[], options?: ChatOptions): ChatMessage[] {
    try {
      let charName = ''
      
      // 1. 优先从 options 中获取
      if (options?.characterName) {
        charName = options.characterName
      }
      
      // 2. 其次通过 options 中的 characterId 从数据库检索
      if (!charName && options?.characterId) {
        try {
          const db = getDatabaseService()
          const char = db.getAllCharacters().find(c => c.id === options.characterId)
          if (char && char.name) {
            charName = char.name
          }
        } catch (_) {}
      }
      
      // 3. 再次，通过 System Prompt 智能推导提取角色姓名 (零摩擦智能识别)
      if (!charName) {
        const systemMsg = messages.find((m) => m.role === 'system')
        if (systemMsg && systemMsg.content) {
          // 正则 1: 识别 ## SOUL.md \n # 角色姓名
          const soulMatch = systemMsg.content.match(/## SOUL\.md[^\n]*\s*\n#\s*([^\n\r#]+)/)
          if (soulMatch && soulMatch[1]) {
            charName = soulMatch[1].trim()
          }
          
          // 正则 2: 兜底识别 You are (角色名)
          if (!charName) {
            const youAreMatch = systemMsg.content.match(/You are ([^\n\.\#\:\!]+)[\.\!]/i)
            if (youAreMatch && youAreMatch[1]) {
              charName = youAreMatch[1].trim()
            }
          }
        }
      }

      if (charName) {
        // 对 messages 进行深拷贝并执行字符串全局替换
        const cloned = JSON.parse(JSON.stringify(messages)) as ChatMessage[]
        for (const msg of cloned) {
          if (msg.content) {
            // 替换 {{char}} 和 <char> 为角色姓名
            msg.content = msg.content.replace(/{{char}}/g, charName)
            msg.content = msg.content.replace(/<char>/g, charName)
          }
        }
        return cloned
      }
    } catch (error) {
      console.error('[ModelAdapter] 替换角色占位符失败:', error)
    }
    return messages
  }

  /**
   * 自动在 System Prompt 中注入极其精确的当前现实时间戳与时段感知提示，消除 AI 时间紊乱
   */
  private injectCurrentTimePrompt(messages: ChatMessage[]): ChatMessage[] {
    try {
      const date = new Date()
      const dayNamesCN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
      const dayNamesEN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ]
      
      const dayNameCN = dayNamesCN[date.getDay()]
      const dayNameEN = dayNamesEN[date.getDay()]
      const monthName = monthNames[date.getMonth()]
      const day = date.getDate()
      const year = date.getFullYear()
      
      const hours = String(date.getHours()).padStart(2, '0')
      
      // 精准的中文时段感知
      const hourNum = date.getHours()
      let timeOfDay = ''
      if (hourNum >= 5 && hourNum < 9) timeOfDay = '清晨'
      else if (hourNum >= 9 && hourNum < 12) timeOfDay = '上午'
      else if (hourNum >= 12 && hourNum < 14) timeOfDay = '中午'
      else if (hourNum >= 14 && hourNum < 18) timeOfDay = '下午'
      else if (hourNum >= 18 && hourNum < 21) timeOfDay = '傍晚'
      else if (hourNum >= 21 && hourNum < 24) timeOfDay = '晚上'
      else timeOfDay = '深夜'
      
      const dateStrEN = `${dayNameEN}, ${monthName} ${day}, ${year} ${hours}:00 (Hour-level accuracy)`
      const dateStrCN = `${year}年${date.getMonth() + 1}月${day}日 ${dayNameCN} 【时段：${timeOfDay}】 ${hours}时`
      
      const timePrompt = `\n\n【现实世界精准时间感知系统 (Current Real-world Timestamp)】
* 提示：当前用户身处的物理现实世界时间是：
  - 中文时间：${dateStrCN}
  - 英文时间：${dateStrEN}
  - 时段属性：【${timeOfDay}】
* 绝对准则：请你必须以这个当前时间为最高权威，极其智能、精准地去理解用户说的话（如“下午好”、“今晚吃什么”、“现在几点了”、“昨天那件事”等）。在与他交流时，务必展现出完全真实的时空感，千万不要发生下午说成晚上等时间混乱的 AI 紊乱 Bug！`

      const updated = [...messages]
      const systemIndex = updated.findIndex(m => m.role === 'system')
      if (systemIndex !== -1) {
        updated[systemIndex] = {
          ...updated[systemIndex],
          content: updated[systemIndex].content + timePrompt
        }
      } else {
        updated.unshift({
          role: 'system',
          content: `You are an AI character. Keep spatial and temporal awareness.` + timePrompt
        })
      }
      return updated
    } catch (error) {
      console.error('[ModelAdapter] 注入现实时间戳失败:', error)
    }
    return messages;
  }

  private preprocessRedPackets(messages: ChatMessage[]): ChatMessage[] {
    try {
      // 🚀 核心过滤 1：物理过滤掉聊天上下文中的日记消息 [character_diary]，防止大模型产生 Few-shot 格式污染与自吐 JSON 紊乱 Bug
      const filtered = messages.filter(m => m.content && !m.content.startsWith('[character_diary]:'))
      
      // 深度拷贝以避免修改外部消息对象
      const cloned = JSON.parse(JSON.stringify(filtered)) as ChatMessage[]
      for (const msg of cloned) {
        if (msg.content && msg.content.startsWith('[wechat_red_packet]:')) {
          try {
            const jsonStr = msg.content.replace('[wechat_red_packet]:', '')
            const packet = JSON.parse(jsonStr)
            const amount = packet.amount
            const title = packet.title || '大吉大利'
            
            // 🚀 核心自愈 2：将机械冰冷的“系统提示”红包指令重构为沉浸式的角色扮演第三人称动作描写
            // 彻底干掉 Few-shot 复读偏置，避免角色一旦开始发红包就陷入无限连环发送的死循环
            if (msg.role === 'user') {
              // 用户发给角色的红包 —— 保留在上下文，让角色知道"收到过红包"
              msg.content = `（用户给你发送了一个金额为 ${amount} 元的红包，附言："${title}"）`
            } else if (msg.role === 'assistant') {
              // 角色发给用户的红包 —— 改为系统历史注记，保留记忆但不以动作描写形式出现（避免 Few-shot 示范）
              msg.content = `[历史记录：你曾给用户发送了一个${amount} 元的红包，附言"${title}"。这是已发生的过去事件，当前无需重复发送。]`
            }
          } catch (_) {
            // 容错兜底
          }
        }
      }
      // 过滤掉 content 被置空的消息（即角色发出的红包消息，已被物理剔除出上下文）
      return cloned.filter(m => m.content !== '')
    } catch (error) {
      console.error('[ModelAdapter] 消息上下文预处理失败:', error)
    }
    return messages
  }

  /**
   * 非流式对话请求
   */
  public async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ChatResponse> {
    let processedMessages = this.preprocessRedPackets(messages)
    if (!options?.skipSystemInjection) {
      processedMessages = this.injectGlobalPrompt(processedMessages)
      processedMessages = this.injectCurrentTimePrompt(processedMessages)
      processedMessages = this.replaceUserPlaceholders(processedMessages)
      processedMessages = this.replaceCharacterPlaceholders(processedMessages, options)
    }
    const config = this.getTargetConfig(options)
    const provider = ProviderFactory.getProvider(config.provider)
    const res = await provider.chat(config, processedMessages)
    
    // 全自动无缝拦截并异步物理记入 ModelStats 数据库表，确保 100% 捕获后台所有自主大模型调用
    try {
      const db = getDatabaseService()
      const role = (options?.usePrimary || (!options?.useSecondary && !this.secondary)) ? 'primary' : 'secondary'
      db.recordModelCall(role, config.model, res.tokenUsage || 0)
    } catch (err: any) {
      console.error('[ModelAdapter] 自动计入 ModelStats 失败:', err.message)
    }

    return res
  }

  /**
   * 流式对话请求
   */
  public async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncGenerator<ChatChunk, void, unknown> {
    let processedMessages = this.preprocessRedPackets(messages)
    if (!options?.skipSystemInjection) {
      processedMessages = this.injectGlobalPrompt(processedMessages)
      processedMessages = this.injectCurrentTimePrompt(processedMessages)
      processedMessages = this.replaceUserPlaceholders(processedMessages)
      processedMessages = this.replaceCharacterPlaceholders(processedMessages, options)
    }
    const config = this.getTargetConfig(options)
    const provider = ProviderFactory.getProvider(config.provider)

    let fullContent = ''
    let finalUsage: any = undefined
    try {
      for await (const chunk of provider.chatStream(config, processedMessages)) {
        if (chunk.content) {
          fullContent += chunk.content
        }
        if (chunk.usage) {
          finalUsage = chunk.usage
        }
        yield chunk
      }
    } finally {
      // 只要产生流式大模型调用，不管是否异常或中途切断，均物理强制精准入账
      try {
        const db = getDatabaseService()
        // 自动精确匹配主副模型身份
        const role = (options?.usePrimary || (!options?.useSecondary && !this.secondary)) ? 'primary' : 'secondary'
        
        // 优先使用真实的使用指标进行记账
        const recordedTokens = finalUsage?.total_tokens ?? Math.max(1, Math.ceil(
          (messages.reduce((sum, m) => sum + (m.content?.length || 0), 0) + fullContent.length) * 1.4
        ))
        
        db.recordModelCall(role, config.model, recordedTokens)
      } catch (err: any) {
        console.error('[ModelAdapter] 流式拦截自动记账异常:', err.message)
      }
    }
  }
}
