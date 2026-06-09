import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { migrateLegacyUserProfile, performEmojiBase64DecoupleMigration } from '../src/main/utils/MigrationHelper'
import { NovelWriterService } from '../src/main/services/NovelWriterService'
import { ModelAdapter } from '../src/main/models/ModelAdapter'
import { UserProfileReaderWriter } from '../src/main/utils/UserProfileReaderWriter'

// Mock Electron
vi.mock('electron', () => {
  const path = require('path')
  const testTempDir = path.join(__dirname, '../tests_temp_migration_safety')
  return {
    __esModule: true,
    app: {
      name: 'project-echo',
      getPath: (name: string) => {
        return testTempDir
      },
      setPath: (name: string, path: string) => {}
    },
    shell: {
      openExternal: () => {}
    },
    BrowserWindow: class {
      static getAllWindows = () => []
      static getFocusedWindow = () => null
      on = () => {}
      loadURL = () => {}
      loadFile = () => {}
      hide = () => {}
      show = () => {}
      minimize = () => {}
      maximize = () => {}
      unmaximize = () => {}
      isMaximized = () => false
      close = () => {}
    },
    ipcMain: {
      handle: () => {},
      on: () => {}
    },
    Menu: {
      buildFromTemplate: () => ({})
    },
    Tray: class {
      setToolTip = () => {}
      setContextMenu = () => {}
      on = () => {}
    },
    nativeImage: {
      createFromPath: () => ({})
    },
    dialog: {
      showSaveDialog: () => ({ canceled: true }),
      showOpenDialog: () => ({ canceled: true })
    },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080 } }),
      getAllDisplays: () => []
    }
  }
})

// 模拟临时测试文件夹路径
const testTempDir = path.join(__dirname, '../tests_temp_migration_safety')

// 建立可操作的 mock 数据库状态变量
let mockSettings: Record<string, string> = {}
let mockCharacters: any[] = []
let mockBindings: Record<string, string> = {}
let mockGroups: Record<string, any> = {}
let mockMessagesForEmoji: any[] = []
let mockDbUpdatedRows: Record<string, string> = {}
let mockNovels: any[] = []

const mockDbService = {
  getSetting: (key: string) => mockSettings[key] || null,
  setSetting: (key: string, val: string) => {
    mockSettings[key] = val
  },
  getActiveNovelId: (characterId: string) => mockSettings[`current_active_novel_id_${characterId}`] || null,
  getNovelChapterCountByNovelId: (novelId: string) => 1,
  getAllCharacters: () => mockCharacters,
  getGroupChat: (id: string) => mockGroups[id] || null,
  getProfileBinding: (id: string) => mockBindings[id] || null,
  setProfileBinding: (id: string, pid: string) => {
    mockBindings[id] = pid
  },
  db: {
    prepare: (sql: string) => {
      return {
        all: (arg1?: any) => {
          if (sql.includes('SELECT id, content FROM Messages')) {
            return mockMessagesForEmoji
          }
          if (sql.includes('SELECT * FROM Novels')) {
            // 模拟 Novels 表
            if (sql.includes('id = ?')) {
              return mockNovels.find(n => n.id === arg1) || null
            }
            return mockNovels
          }
          if (sql.includes('Characters')) {
            return mockCharacters
          }
          return []
        },
        get: (arg1?: any) => {
          if (sql.includes('SELECT * FROM Novels WHERE id = ?')) {
            return mockNovels.find(n => n.id === arg1) || null
          }
          if (sql.includes('SELECT name FROM Characters')) {
            const char = mockCharacters.find(c => c.id === arg1)
            return char ? { name: char.name } : null
          }
          if (sql.includes('SELECT timestamp FROM Messages')) {
            // 返回最后一条消息
            return { timestamp: 5000 }
          }
          if (sql.includes('SELECT MAX(dialogue_end_ts)')) {
            return { maxTs: 3000 }
          }
          return null
        },
        run: (content: string, id: string) => {
          mockDbUpdatedRows[id] = content
        }
      }
    },
    transaction: (fn: Function) => {
      return () => fn()
    }
  }
}

// Mock 数据库连接
vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  }
})

describe('老数据迁移与安全性自愈回归单测套件', () => {
  beforeEach(() => {
    mockSettings = {}
    mockCharacters = []
    mockBindings = {}
    mockGroups = {}
    mockMessagesForEmoji = []
    mockDbUpdatedRows = {}
    mockNovels = []

    if (!fs.existsSync(testTempDir)) {
      fs.mkdirSync(testTempDir, { recursive: true })
    }
  })

  afterEach(() => {
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true })
    }
  })

  test('1. 老人设卡 V5 同步迁移、自愈绑定与幂等锁校验', () => {
    const configDir = path.join(testTempDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })

    // 1.1 写入一个老用户 USER.md
    const legacyUserPath = path.join(configDir, 'USER.md')
    const mockUserMdContent = `<!--\n{\n  "name": "李莲",\n  "age": "23"\n}\n-->\n# 设定\n我的设定细节内容。`
    fs.writeFileSync(legacyUserPath, mockUserMdContent, 'utf8')

    // 写入一个待绑定的老单聊角色
    mockCharacters = [{ id: 'lingyue', name: '凌月', folder_name: 'LingYue' }]

    // 确认迁移前状态
    expect(fs.existsSync(legacyUserPath)).toBe(true)
    expect(mockBindings['lingyue']).toBeUndefined()
    expect(mockSettings['legacy_user_profile_migration_done_v5']).toBeUndefined()

    // 1.2 执行首次 V5 迁移
    migrateLegacyUserProfile()

    // 验证物理文件迁移成功，原 USER.md 已物理删除，移到了 user_profiles/lilian_1.md
    expect(fs.existsSync(legacyUserPath)).toBe(false)
    const targetFilePath = path.join(configDir, 'user_profiles', 'lilian_1.md')
    expect(fs.existsSync(targetFilePath)).toBe(true)

    const migratedContent = fs.readFileSync(targetFilePath, 'utf8')
    expect(migratedContent).toContain('李莲')
    expect(migratedContent).toContain('我的设定细节内容。')

    // 验证数据库静默绑定关系自动建立成功
    expect(mockBindings['lingyue']).toBe('lilian_1')
    // 验证 V5 幂等标记已成功物理写回 Settings
    expect(mockSettings['legacy_user_profile_migration_done_v5']).toBe('1')

    // 1.3 验证幂等性防护：用户之后主动更改了绑定关系（比如改绑为 lilian_new，或者解绑）
    mockBindings['lingyue'] = 'lilian_new'
    
    // 再次调用迁移，因为有 legacy_user_profile_migration_done_v5 标记，必须直接退出，且不能覆盖修改用户的绑定
    migrateLegacyUserProfile()
    expect(mockBindings['lingyue']).toBe('lilian_new')

    // 1.4 验证缺失 USER.md 时的绑定自愈补救防线
    // 清理已完成状态，模拟没有 USER.md 但 user_profiles 下已有文件的老升级设备
    mockSettings = {}
    mockBindings = {}
    expect(fs.existsSync(legacyUserPath)).toBe(false) // USER.md 不存在

    // 执行迁移自愈
    migrateLegacyUserProfile()
    
    // 验证：虽然没有 USER.md，但由于 user_profiles 里有 lilian_1.md，单聊角色依然被自愈绑定到了该人设上！
    expect(mockBindings['lingyue']).toBe('lilian_1')
    expect(mockSettings['legacy_user_profile_migration_done_v5']).toBe('1')
  })

  test('2. 微信表情包消息 V4 脱水及破图自愈补写物理文件校验', () => {
    // 2.1 注入带有 base64 大字段的自定义表情消息
    mockMessagesForEmoji = [
      {
        id: 'msg_emoji_1',
        content: `[wechat_custom_emoji]:{"id":"emoji_abc","meaning":"吃惊","base64":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}`
      }
    ]

    const emojisDir = path.join(testTempDir, 'custom_emojis')
    const expectedFilePath = path.join(emojisDir, 'emoji_abc.png')

    // 确认脱水前状态
    expect(fs.existsSync(expectedFilePath)).toBe(false)
    expect(mockSettings['emoji_base64_migration_done_v4']).toBeUndefined()

    // 2.2 执行 V4 瘦身迁移
    performEmojiBase64DecoupleMigration()

    // 验证物理补写成功：即使本地无此文件，也会根据 Base64 还原补写物理文件到磁盘，防止了破图
    expect(fs.existsSync(expectedFilePath)).toBe(true)
    const fileBuf = fs.readFileSync(expectedFilePath)
    // 验证能正确解码写入
    expect(fileBuf.length).toBeGreaterThan(0)

    // 验证数据库脱水成功，base64 字段被物理剔除，只保留了 metadata
    const updatedContent = mockDbUpdatedRows['msg_emoji_1']
    expect(updatedContent).toContain('[wechat_custom_emoji]:')
    expect(updatedContent).toContain('"meaning":"吃惊"')
    expect(updatedContent).not.toContain('base64')

    // 验证 V4 成功标记已被记录
    expect(mockSettings['emoji_base64_migration_done_v4']).toBe('1')
  })

  test('3. AI 写手小说起跑自愈判定不误伤老小说校验', () => {
    const characterId = 'test_char'
    mockSettings[`current_active_novel_id_${characterId}`] = 'novel_active_uuid'
    
    // Novels 表中有一条记录，说明小说已经物理落地
    mockNovels = [
      { id: 'novel_active_uuid', character_id: characterId, title: '测试小说', start_ts: 0 }
    ]

    // 模拟老用户未清空状态，novel_start_ts_character 配置缺失，解析默认值为 0
    mockSettings[`novel_start_ts_${characterId}`] = '0'

    const service = new NovelWriterService({} as ModelAdapter)

    // 调用被测试的私有自检方法
    const res = (service as any).getOrDetectActiveNovel(characterId)

    // 验证：由于 startTsVal === 0，系统必须认定旧小说依然有效，不能把 needNewBook 设为 true（否则会误判定为已被物理清空而建新书卷）
    expect(res.needInsert).toBe(false)
    expect(res.activeNovelId).toBe('novel_active_uuid')
    expect(res.startTs).toBe(0)
  })
})
