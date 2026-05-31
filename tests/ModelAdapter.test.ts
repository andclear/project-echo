import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 注入高精度 Mock 隔离 Electron 运行依赖与 C++ 数据库文件句柄
const mockDbService = {
  getSetting: vi.fn().mockReturnValue(null),
  recordModelCall: vi.fn(),
  getAllCharacters: vi.fn().mockReturnValue([])
}

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  }
})

vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp/echo-tests-mock')
    }
  }
})

import {
  ModelAdapter,
  ModelConfig,
  mergeSystemMessage,
  ProviderFactory,
  COMMON_HEADERS
} from '../src/main/models/ModelAdapter'

describe('ModelAdapter & Providers 深度重构测试', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('mergeSystemMessage 降级融合辅助函数', () => {
    it('不包含 system 消息时，消息应当原样返回', () => {
      const messages = [
        { role: 'user', content: 'hello' } as const,
        { role: 'assistant', content: 'hi' } as const
      ]
      const result = mergeSystemMessage([...messages])
      expect(result).toEqual(messages)
    })

    it('包含 system 消息且有 user 消息时，应将 system 消息注入到首条 user 消息前部', () => {
      const messages = [
        { role: 'system', content: 'you are a guide' } as const,
        { role: 'assistant', content: 'hi' } as const,
        { role: 'user', content: 'who are you?' } as const
      ]
      const result = mergeSystemMessage([...messages])
      expect(result.length).toBe(2)
      expect(result[0].role).toBe('assistant')
      expect(result[1].role).toBe('user')
      expect(result[1].content).toBe('[系统指令：you are a guide]\n\nwho are you?')
    })

    it('只有 system 消息且无 user 消息时，应将 system 消息作为 user 消息插在最前面', () => {
      const messages = [
        { role: 'system', content: 'you are a guide' } as const,
        { role: 'assistant', content: 'hi' } as const
      ]
      const result = mergeSystemMessage([...messages])
      expect(result.length).toBe(2)
      expect(result[0].role).toBe('user')
      expect(result[0].content).toBe('you are a guide')
      expect(result[1].role).toBe('assistant')
    })
  })

  describe('OpenAIProvider 适配器测试', () => {
    it('当 supportsSystem 为 false 时，应当在 fetch 请求前对 messages 执行融合合并且包含 UA 头', async () => {
      const mockResponse = {
        choices: [{ message: { content: '我已接收到带有降级系统指令的消息。' } }],
        usage: { total_tokens: 30 }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'openai',
        baseUrl: 'https://api.custom.com/v1',
        apiKey: 'sk-mock-key',
        model: 'custom-model',
        supportsSystem: false
      }

      const provider = ProviderFactory.getProvider('openai')
      const result = await provider.chat(config, [
        { role: 'system', content: '系统指令内容' },
        { role: 'user', content: '用户正文' }
      ])

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('https://api.custom.com/v1/chat/completions')
      
      const options = call[1] as RequestInit
      expect(options.method).toBe('POST')
      expect((options.headers as any)['Authorization']).toBe('Bearer sk-mock-key')
      expect((options.headers as any)['User-Agent']).toBe(COMMON_HEADERS['User-Agent'])

      const body = JSON.parse(options.body as string)
      expect(body.messages.length).toBe(1)
      expect(body.messages[0].role).toBe('user')
      expect(body.messages[0].content).toBe('[系统指令：系统指令内容]\n\n用户正文')
      
      expect(result.content).toBe('我已接收到带有降级系统指令的消息。')
      expect(result.tokenUsage).toBe(30)
    })

    it('应当能支持 OpenAI 风格的流式 Stream 增量解析', async () => {
      const encoder = new TextEncoder()
      const mockStream = {
        getReader() {
          let count = 0
          return {
            async read() {
              if (count === 0) {
                count++
                return {
                  done: false,
                  value: encoder.encode('data: {"choices": [{"delta": {"content": "今天天气"}}]}\n')
                }
              } else if (count === 1) {
                count++
                return {
                  done: false,
                  value: encoder.encode('data: {"choices": [{"delta": {"content": "真好。"}}]}\ndata: [DONE]\n')
                }
              } else {
                return { done: true, value: undefined }
              }
            },
            releaseLock() {}
          }
        }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: mockStream
        } as unknown as Response)
      })

      const config: ModelConfig = {
        provider: 'openai',
        baseUrl: 'https://api.custom.com/v1',
        apiKey: 'sk-mock-key',
        model: 'custom-model'
      }

      const provider = ProviderFactory.getProvider('openai')
      const generator = provider.chatStream(config, [{ role: 'user', content: '天气' }])

      const chunks = []
      for await (const chunk of generator) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(3)
      expect(chunks[0]).toEqual({ content: '今天天气', done: false })
      expect(chunks[1]).toEqual({ content: '真好。', done: false })
      expect(chunks[2]).toEqual({ content: '', done: true })
    })

    it('当包含 temperature 时，应当在请求体中正确携带', async () => {
      const mockResponse = {
        choices: [{ message: { content: '回复' } }]
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'openai',
        baseUrl: 'https://api.custom.com/v1',
        apiKey: 'sk-mock-key',
        model: 'custom-model',
        temperature: 0.7
      }

      const provider = ProviderFactory.getProvider('openai')
      await provider.chat(config, [{ role: 'user', content: '你好' }])

      const call = vi.mocked(global.fetch).mock.calls[0]
      const options = call[1] as RequestInit
      const body = JSON.parse(options.body as string)
      expect(body.temperature).toBe(0.7)
    })
  })

  describe('AnthropicProvider 适配器测试', () => {
    it('非流式请求应当正确将 system 剥离出 messages，并附加专属 headers', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: '你好，我是 Claude。' }],
        usage: { input_tokens: 10, output_tokens: 15 }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'claude-mock-key',
        model: 'claude-3-5-sonnet'
      }

      const provider = ProviderFactory.getProvider('anthropic')
      const result = await provider.chat(config, [
        { role: 'system', content: '你是一个专业的翻译官' },
        { role: 'user', content: '苹果' }
      ])

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('https://api.anthropic.com/v1/messages')

      const options = call[1] as RequestInit
      expect((options.headers as any)['x-api-key']).toBe('claude-mock-key')
      expect((options.headers as any)['anthropic-version']).toBe('2023-06-01')
      expect((options.headers as any)['User-Agent']).toBe(COMMON_HEADERS['User-Agent'])

      const body = JSON.parse(options.body as string)
      expect(body.system).toBe('你是一个专业的翻译官')
      expect(body.messages.length).toBe(1)
      expect(body.messages[0].role).toBe('user')
      expect(body.messages[0].content).toBe('苹果')

      expect(result.content).toBe('你好，我是 Claude。')
      expect(result.tokenUsage).toBe(25)
    })

    it('流式请求应当正确解析 content_block_delta 与 delta.text 字段', async () => {
      const encoder = new TextEncoder()
      const mockStream = {
        getReader() {
          let count = 0
          return {
            async read() {
              if (count === 0) {
                count++
                return {
                  done: false,
                  value: encoder.encode('data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Clau"}}\n')
                }
              } else if (count === 1) {
                count++
                return {
                  done: false,
                  value: encoder.encode('data: {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "de!"}}\ndata: {"type": "message_stop"}\n')
                }
              } else {
                return { done: true, value: undefined }
              }
            },
            releaseLock() {}
          }
        }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          body: mockStream
        } as unknown as Response)
      })

      const config: ModelConfig = {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'claude-mock-key',
        model: 'claude-3-5-sonnet'
      }

      const provider = ProviderFactory.getProvider('anthropic')
      const generator = provider.chatStream(config, [{ role: 'user', content: 'who' }])

      const chunks = []
      for await (const chunk of generator) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(3)
      expect(chunks[0]).toEqual({ content: 'Clau', done: false })
      expect(chunks[1]).toEqual({ content: 'de!', done: false })
      expect(chunks[2]).toEqual({ content: '', done: true })
    })

    it('当包含 temperature 时，应当在请求体中正确携带', async () => {
      const mockResponse = {
        content: [{ type: 'text', text: 'Claude 回复' }]
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'claude-mock-key',
        model: 'claude-3-5-sonnet',
        temperature: 0.8
      }

      const provider = ProviderFactory.getProvider('anthropic')
      await provider.chat(config, [{ role: 'user', content: '你好' }])

      const call = vi.mocked(global.fetch).mock.calls[0]
      const options = call[1] as RequestInit
      const body = JSON.parse(options.body as string)
      expect(body.temperature).toBe(0.8)
    })
  })

  describe('DeepSeekProvider 专属通道驱动测试', () => {
    it('当未传入 baseUrl 时，应当自动补充默认的 DeepSeek 官方 API 根端点', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'DeepSeek 官方回复' } }]
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'deepseek',
        baseUrl: '', // 留空，验证自动填充
        apiKey: 'ds-mock-key',
        model: 'deepseek-v4-flash'
      }

      const provider = ProviderFactory.getProvider('deepseek')
      const result = await provider.chat(config, [{ role: 'user', content: '你好' }])

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('https://api.deepseek.com/chat/completions')
      expect(result.content).toBe('DeepSeek 官方回复')
    })
  })

  describe('GeminiProvider 专属通道驱动测试', () => {
    it('当未传入 baseUrl 时，应当自动补充默认的 Google OpenAI 兼容根端点', async () => {
      const mockResponse = {
        choices: [{ message: { content: 'Gemini 官方回复' } }]
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'gemini',
        baseUrl: '', // 留空，验证自动填充
        apiKey: 'gemini-mock-key',
        model: 'gemini-1.5-pro'
      }

      const provider = ProviderFactory.getProvider('gemini')
      const result = await provider.chat(config, [{ role: 'user', content: '你好' }])

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
      expect(result.content).toBe('Gemini 官方回复')
    })
  })

  describe('OllamaProvider 本地适配器测试', () => {
    it('非流式请求正常执行并支持 supportsSystem: false 消息合并降级', async () => {
      const mockResponse = {
        message: { content: '本地大模型 Ollama 回复' },
        prompt_eval_count: 5,
        eval_count: 5
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5',
        supportsSystem: false
      }

      const provider = ProviderFactory.getProvider('ollama')
      const result = await provider.chat(config, [
        { role: 'system', content: '本地设定' },
        { role: 'user', content: '你好呀' }
      ])

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:11434/api/chat')

      const body = JSON.parse(call[1]?.body as string)
      expect(body.messages[0].content).toBe('[系统指令：本地设定]\n\n你好呀')
      expect(result.content).toBe('本地大模型 Ollama 回复')
      expect(result.tokenUsage).toBe(10)
    })

    it('当包含 temperature 时，应当在 options 中正确融入 temperature', async () => {
      const mockResponse = {
        message: { content: 'Ollama 回复' }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const config: ModelConfig = {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5',
        temperature: 0.5
      }

      const provider = ProviderFactory.getProvider('ollama')
      await provider.chat(config, [{ role: 'user', content: '你好' }])

      const call = vi.mocked(global.fetch).mock.calls[0]
      const body = JSON.parse(call[1]?.body as string)
      expect(body.options).toBeDefined()
      expect(body.options.temperature).toBe(0.5)
    })
  })

  describe('ModelAdapter 门面组合模式测试', () => {
    const primaryConfig: ModelConfig = {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'primary-key',
      model: 'gpt-4o'
    }

    const secondaryConfig: ModelConfig = {
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen'
    }

    it('当启用辅助模型且 useSecondary 为 true 时，应当精确路由至辅助模型', async () => {
      const mockResponse = {
        message: { content: '我是 Ollama 辅助服务' }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const adapter = new ModelAdapter(primaryConfig, secondaryConfig)
      const result = await adapter.chat([{ role: 'user', content: 'hello' }], { useSecondary: true })

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      expect(call[0]).toBe('http://localhost:11434/api/chat')
      expect(result.content).toBe('我是 Ollama 辅助服务')
    })

    it('应当在聊天时运行时拦截并成功替换 {{char}} 和 <char> 为真实角色姓名', async () => {
      const mockResponse = {
        choices: [{ message: { content: '我是被测试的回复。' } }],
        usage: { total_tokens: 15 }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      // 测试从 options.characterName 直接传入的情况
      const adapter = new ModelAdapter(primaryConfig)
      await adapter.chat(
        [
          { role: 'system', content: 'You are {{char}}' },
          { role: 'user', content: '你好 <char>' }
        ],
        { usePrimary: true, characterName: '芙宁娜', skipSystemInjection: false }
      )

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      const body = JSON.parse(call[1]?.body as string)
      
      const systemMsg = body.messages.find((m: any) => m.role === 'system')
      const userMsg = body.messages.find((m: any) => m.role === 'user')
      expect(systemMsg.content).toContain('You are 芙宁娜')
      expect(userMsg.content).toContain('你好 芙宁娜')
    })

    it('若 options 中未传入角色名，应当能够通过 System Prompt 中的 SOUL 头部智能正则推导并成功替换占位符', async () => {
      const mockResponse = {
        choices: [{ message: { content: '我是被测试的回复。' } }],
        usage: { total_tokens: 15 }
      }

      global.fetch = vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(mockResponse)
        } as Response)
      })

      const adapter = new ModelAdapter(primaryConfig)
      await adapter.chat(
        [
          { role: 'system', content: '## SOUL.md - Personality & Human-nature Core\n# 芙宁娜\nYou are {{char}}' },
          { role: 'user', content: '你好 <char>' }
        ],
        { usePrimary: true, skipSystemInjection: false }
      )

      expect(global.fetch).toHaveBeenCalledTimes(1)
      const call = vi.mocked(global.fetch).mock.calls[0]
      const body = JSON.parse(call[1]?.body as string)
      
      const systemMsg = body.messages.find((m: any) => m.role === 'system')
      const userMsg = body.messages.find((m: any) => m.role === 'user')
      expect(systemMsg.content).toContain('You are 芙宁娜')
      expect(userMsg.content).toContain('你好 芙宁娜')
    })
  })
})
