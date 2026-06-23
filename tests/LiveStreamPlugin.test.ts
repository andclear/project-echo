import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock Electron
const testBaseDir = path.join(__dirname, 'temp_livestream_test')

const { mockIpcMain } = vi.hoisted(() => {
  return {
    mockIpcMain: {
      handle: vi.fn(),
      on: vi.fn()
    }
  }
})

vi.mock('electron', () => {
  return {
    app: {
      getAppPath: () => '/mock/app/path',
      getPath: (name: string) => {
        if (name === 'userData') {
          return testBaseDir
        }
        return '/tmp'
      }
    },
    ipcMain: mockIpcMain,
    BrowserWindow: {
      getAllWindows: () => [],
      getFocusedWindow: () => null
    }
  }
})

// Mock Database Service
const mockDb = {
  prepare: vi.fn().mockReturnValue({
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([])
  }),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getAllCharacters: vi.fn().mockReturnValue([])
}

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDb
  }
})

// Import LiveStreamPlugin
import { LiveStreamPlugin } from '../src/main/plugins/livestream'

describe('LiveStreamPlugin 单元测试', () => {
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

  it('应当能正常被实例化并正确初始化', () => {
    const plugin = new LiveStreamPlugin()
    expect(plugin.name).toBe('LiveStreamPlugin')
    
    // 初始化测试，验证它会创建对应的物理存储目录
    plugin.init()
    const livestreamDir = path.join(testBaseDir, 'plugins', 'livestream', 'characters')
    expect(fs.existsSync(livestreamDir)).toBe(true)
  })

  it('应当能正确注册所有的 IPC 通道', () => {
    const plugin = new LiveStreamPlugin()
    plugin.registerIpcHandlers()
    
    // 验证 ipcMain.handle 是否被多次调用以注册直播通道
    expect(mockIpcMain.handle).toHaveBeenCalled()
  })
})
