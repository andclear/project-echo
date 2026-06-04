import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import crypto from 'crypto'
import { NovelWriterService } from '../src/main/services/NovelWriterService'
import { ModelAdapter } from '../src/main/models/ModelAdapter'
import { CharacterStorageManager } from '../src/main/utils/CharacterStorageManager'

// Mock Electron
vi.mock('electron', () => {
  return {
    app: {
      getPath: () => '/tmp/echo-tests-mock-novel'
    },
    BrowserWindow: {
      getAllWindows: () => []
    }
  }
})

// Mock Database Service
let mockSettings: Record<string, string> = {}
let mockChapters: any[] = []
let mockChapterContent: Record<string, string> = {}
let mockMessages: any[] = []
let mockChapterCount = 0

const mockDbService = {
  getSetting: (key: string) => mockSettings[key] || null,
  setSetting: (key: string, val: string) => { mockSettings[key] = val },
  getNovelChapterCount: () => mockChapterCount,
  getNovelChapters: () => mockChapters,
  getNovelChapterContent: (id: string) => ({ content: mockChapterContent[id] || '' }),
  sumMessageTokensSince: () => 2000, // 默认模拟新增 2000 token
  insertNovelChapter: (ch: any) => {
    mockChapters.push(ch)
    mockChapterContent[ch.id] = ch.content
    mockChapterCount++
  },
  updateNovelChapterContent: (id: string, content: string, summary: string, title: string) => {
    const ch = mockChapters.find(c => c.id === id)
    if (ch) {
      ch.content = content
      ch.summary = summary
      ch.title = title
      mockChapterContent[id] = content
    }
  },
  db: {
    prepare: (sql: string) => {
      return {
        get: () => {
          if (sql.includes('Messages') && sql.includes('role')) {
            return mockMessages.some(m => m.role === 'assistant') ? { 1: 1 } : null
          }
          if (sql.includes('Characters')) {
            return { id: 'test_char', name: '测试角色', folder_name: 'TestChar' }
          }
          return null
        },
        all: () => mockMessages
      }
    }
  }
}

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  }
})

describe('NovelWriterService 自动章节生成与改编服务测试', () => {
  const testCharId = 'test_char'
  const testFolderName = 'TestChar'
  let storageManager: CharacterStorageManager
  let charPath: string

  beforeEach(() => {
    mockSettings = {}
    mockChapters = []
    mockChapterContent = {}
    mockMessages = []
    mockChapterCount = 0

    storageManager = new CharacterStorageManager()
    charPath = path.join(storageManager.getBaseDir(), testFolderName)

    if (!fs.existsSync(charPath)) {
      fs.mkdirSync(charPath, { recursive: true })
    }

    fs.writeFileSync(path.join(charPath, 'Soul.md'), '# 灵魂\n核心人设：水之歌剧院的明星。', 'utf8')
    fs.writeFileSync(path.join(charPath, 'World.md'), '# 世界观\n世界观设定。', 'utf8')
    fs.writeFileSync(path.join(charPath, 'USER.md'), '# 画像\n角色视角下的用户画像。', 'utf8')
  })

  afterEach(() => {
    if (fs.existsSync(charPath)) {
      fs.rmSync(charPath, { recursive: true, force: true })
    }
  })

  test('1. 章节解析 (parseChapterOutput) 提取标题与正文测试', () => {
    const mockModelAdapter = {} as ModelAdapter
    const service = new NovelWriterService(mockModelAdapter)

    const rawOutput = `这只是一段正文描述。\n\n### TITLE: 命运的邂逅`
    const res = (service as any).parseChapterOutput(rawOutput, 1)
    expect(res.title).toBe('命运的邂逅')
    expect(res.content).toBe('这只是一段正文描述。')

    const rawOutputAlt = `章节标题: 晨曦微光\n这只是一段正文描述。`
    const resAlt = (service as any).parseChapterOutput(rawOutputAlt, 2)
    expect(resAlt.title).toBe('晨曦微光')
    expect(resAlt.content).toBe('这只是一段正文描述。')
  })

  test('2. 首章触发条件与生成流程测试', async () => {
    // 开启 AI 写手
    mockSettings[`novel_enabled_${testCharId}`] = '1'
    mockSettings[`chat_mode_${testCharId}`] = 'dialogue'

    // 注入一条包含助理的消息
    mockMessages = [
      { id: '1', role: 'user', content: '你好', timestamp: 1000 },
      { id: '2', role: 'assistant', content: '你好，我是芙宁娜。', timestamp: 2000 }
    ]

    const mockModelAdapter = {
      chat: vi.fn().mockImplementation(async (msgs: any[]) => {
        const sysMsg = msgs.find(m => m.role === 'system')?.content || ''
        if (sysMsg.includes('提炼助手')) {
          return { content: '首章故事摘要。' }
        }
        if (sysMsg.includes('拆分专家')) {
          return { content: 'NO_SPLIT' }
        }
        if (sysMsg.includes('网文润色专家')) {
          const userMsg = msgs.find(m => m.role === 'user')?.content || ''
          const rawMatch = userMsg.match(/【待润色的章节原文】\n([\s\S]+?)\n\n请直接输出/)
          const raw = rawMatch ? rawMatch[1].trim() : '第一章小说的完整正文。'
          return { content: raw }
        }
        return { content: '第一章小说的完整正文。\n### TITLE: 歌剧院之始', tokenUsage: 500 }
      })
    } as unknown as ModelAdapter

    const service = new NovelWriterService(mockModelAdapter)
    await service.checkAndGenerateChapter(testCharId)

    // 检查是否插入了第 1 章
    expect(mockChapterCount).toBe(1)
    expect(mockChapters[0].chapter_index).toBe(1)
    expect(mockChapters[0].title).toBe('歌剧院之始')
    expect(mockChapters[0].summary).toBe('首章故事摘要。')
    expect(mockChapters[0].content).toBe('第一章小说的完整正文。')
    expect(mockSettings[`last_novel_chapter_end_ts_${testCharId}`]).toBe('2000')
  })

  test('3. 续章 token 累加触发测试', async () => {
    mockSettings[`novel_enabled_${testCharId}`] = '1'
    mockSettings[`chat_mode_${testCharId}`] = 'dialogue' // 阈值 1500
    mockSettings[`last_novel_chapter_end_ts_${testCharId}`] = '2000'

    // 已有一章
    mockChapters = [
      { id: 'ch_1', character_id: testCharId, chapter_index: 1, title: '第一章', summary: '摘要1', created_at: 1000 }
    ]
    mockChapterCount = 1

    // 新的交互消息，内容加长以达到 1500 tokens 的阈值条件 (1500 / 1.3 ≈ 1150个汉字)
    mockMessages = [
      { id: '3', role: 'user', content: '今天天气不错，适合出去散步聊天放松心情。'.repeat(100), timestamp: 3000 },
      { id: '4', role: 'assistant', content: '确实，非常适合去歌剧院看演出呢，我已经准备好了。'.repeat(100), timestamp: 4000 }
    ]

    const mockModelAdapter = {
      chat: vi.fn().mockImplementation(async (msgs: any[]) => {
        const sysMsg = msgs.find(m => m.role === 'system')?.content || ''
        if (sysMsg.includes('提炼助手')) {
          return { content: '第二章故事摘要。' }
        }
        if (sysMsg.includes('拆分专家')) {
          return { content: 'NO_SPLIT' }
        }
        if (sysMsg.includes('网文润色专家')) {
          const userMsg = msgs.find(m => m.role === 'user')?.content || ''
          const rawMatch = userMsg.match(/【待润色的章节原文】\n([\s\S]+?)\n\n请直接输出/)
          const raw = rawMatch ? rawMatch[1].trim() : '第二章小说的完整正文。'
          return { content: raw }
        }
        return { content: '第二章小说的完整正文。\n### TITLE: 晴空之下', tokenUsage: 600 }
      })
    } as unknown as ModelAdapter

    const service = new NovelWriterService(mockModelAdapter)
    await service.checkAndGenerateChapter(testCharId)

    // 检查是否插入了第 2 章
    expect(mockChapterCount).toBe(2)
    expect(mockChapters[1].chapter_index).toBe(2)
    expect(mockChapters[1].title).toBe('晴空之下')
    expect(mockChapters[1].summary).toBe('第二章故事摘要。')
    expect(mockSettings[`last_novel_chapter_end_ts_${testCharId}`]).toBe('4000')
  })
})
