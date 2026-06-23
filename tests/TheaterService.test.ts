import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

// 1. Mock database service
const mockRun = vi.fn()
const mockPrepare = vi.fn().mockReturnValue({
  run: mockRun,
  get: vi.fn().mockReturnValue(undefined)
})
const mockDbService = {
  db: {
    prepare: mockPrepare
  },
  getSetting: vi.fn()
}

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  }
})

// 2. Mock electron app
const testBaseDir = path.join(__dirname, 'temp_theaters_test')
vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn().mockImplementation((name) => {
        if (name === 'userData') {
          return testBaseDir
        }
        return '/tmp'
      })
    }
  }
})

// 3. Import TheaterService
import { TheaterService } from '../src/main/plugins/theater/TheaterService'

describe('TheaterService 剧本导入与导出单元测试', () => {
  beforeAll(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testBaseDir, { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true })
    }
  })

  it('应当能正常导出剧本题材为 Gzip 二进制包，并能重新还原导入', () => {
    const service = new TheaterService()

    // 1. 模拟物理剧本包
    const themeId = 'test_theme_game'
    const themeDir = path.join(testBaseDir, 'plugins', 'theater', themeId)
    fs.mkdirSync(themeDir, { recursive: true })

    const mockThemeJson = {
      id: themeId,
      name: '测试剧本',
      description: '一个用于单元测试的剧本',
      world_settings: '世界规则：测试专用。',
      scenario: '故事开局：突发单元测试。',
      status_bars: [{ name: 'HP', value: 100 }],
      relations: [{ source: '小明', target: '小红', relation: '朋友' }]
    }
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(mockThemeJson, null, 2), 'utf8')

    // 模拟封面
    const mockCoverBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' // 1x1 png
    const cleanCoverBytes = Buffer.from(mockCoverBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    fs.writeFileSync(path.join(themeDir, 'cover.png'), cleanCoverBytes)

    // 模拟角色结构
    const charBaseDir = path.join(themeDir, 'characters')
    fs.mkdirSync(charBaseDir, { recursive: true })

    // 角色1: 小明 (普通角色)
    const xiaomingDir = path.join(charBaseDir, 'xiaoming')
    fs.mkdirSync(xiaomingDir, { recursive: true })
    fs.writeFileSync(path.join(xiaomingDir, 'meta.json'), JSON.stringify({ name: '小明', gender: '男', age: '18' }), 'utf8')
    fs.writeFileSync(path.join(xiaomingDir, 'Soul.md'), '性格开朗', 'utf8')
    fs.writeFileSync(path.join(xiaomingDir, 'Appearance.md'), '### Appearance Tags\n1boy, short hair\n', 'utf8')
    
    const mockAvatarBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const cleanAvatarBytes = Buffer.from(mockAvatarBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
    fs.writeFileSync(path.join(xiaomingDir, 'avatar.png'), cleanAvatarBytes)

    // 2. 导出测试
    const buffer = service.exportThemeToBuffer(themeId)
    expect(buffer).toBeInstanceOf(Buffer)

    // 解压验证数据
    const decompressed = zlib.gunzipSync(buffer).toString('utf8')
    const packData = JSON.parse(decompressed)
    expect(packData.version).toBe('1.0.0')
    expect(packData.theme.name).toBe('测试剧本')
    expect(packData.coverBase64).toContain('data:image/png;base64,')
    expect(packData.characters.length).toBe(1)
    expect(packData.characters[0].name).toBe('小明')
    expect(packData.characters[0].avatarBase64).toContain('data:image/png;base64,')

    // 3. 导入测试 (使用刚才导出的二进制 buffer)
    const importRes = service.importThemeFromBuffer(buffer)
    expect(importRes.success).toBe(true)
    expect(importRes.id).toBeDefined()
    expect(importRes.id).not.toBe(themeId)

    const newThemeId = importRes.id!
    const newThemeDir = path.join(testBaseDir, 'plugins', 'theater', newThemeId)

    // 验证新生成的物理目录和核心文件
    expect(fs.existsSync(newThemeDir)).toBe(true)
    expect(fs.existsSync(path.join(newThemeDir, 'theme.json'))).toBe(true)
    expect(fs.existsSync(path.join(newThemeDir, 'cover.png'))).toBe(true)

    const importedThemeJson = JSON.parse(fs.readFileSync(path.join(newThemeDir, 'theme.json'), 'utf8'))
    expect(importedThemeJson.id).toBe(newThemeId)
    expect(importedThemeJson.name).toBe('测试剧本')

    // 验证角色还原
    const newCharDir = path.join(newThemeDir, 'characters', 'xiaoming')
    expect(fs.existsSync(newCharDir)).toBe(true)
    expect(fs.existsSync(path.join(newCharDir, 'meta.json'))).toBe(true)
    expect(fs.existsSync(path.join(newCharDir, 'Soul.md'))).toBe(true)
    expect(fs.existsSync(path.join(newCharDir, 'Appearance.md'))).toBe(true)
    expect(fs.existsSync(path.join(newCharDir, 'avatar.png'))).toBe(true)

    // 验证数据库 prepare run 是否被调用
    expect(mockPrepare).toHaveBeenCalled()
    expect(mockRun).toHaveBeenCalled()
  })
})
