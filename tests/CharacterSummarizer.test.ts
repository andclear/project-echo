import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 注入 Mock
const mockDbService = {
  getSetting: vi.fn().mockReturnValue(JSON.stringify({
    primary: {
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-3.5-turbo'
    },
    enableSecondary: false
  })),
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

import { CharacterSummarizer } from '../src/main/utils/CharacterSummarizer'

describe('CharacterSummarizer 提炼总结测试', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = global.fetch
    // Mock global.fetch 返回正常的大模型回复
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [
            {
              message: {
                content: '```markdown\n# 提炼设定\n测试内容\n```'
              }
            }
          ],
          usage: {
            total_tokens: 100
          }
        })
      })
    }) as any
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('应该能够成功提炼角色设定', async () => {
    const cardData = {
      name: '新婚',
      description: '一个测试角色',
      personality: '温柔',
      first_mes: '你好',
      scenario: '在家里'
    }

    const summary = await CharacterSummarizer.summarize(cardData)
    expect(summary).toBeDefined()
    expect(summary.soul).toContain('提炼设定')
  })
})
