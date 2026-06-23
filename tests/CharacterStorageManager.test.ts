import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { CharacterStorageManager } from '../src/main/utils/CharacterStorageManager'
import path from 'path'
import fs from 'fs'

describe('CharacterStorageManager 物理存储与拼音处理测试', () => {
  const testBaseDir = path.join(__dirname, 'temp_test_characters')

  beforeAll(() => {
    // 确保测试前清理干净
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    // 测试结束后进行垃圾回收
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true })
    }
  })

  it('应当能正确地将中文转换为纯小写、去除空格与特殊字符的拼音', () => {
    const manager = new CharacterStorageManager(testBaseDir)
    
    // 朝阳由 pinyin 转换默认为 zhaoyang 或 chaoyang
    const py = manager.convertToPinyin('朝阳')
    expect(['zhaoyang', 'chaoyang']).toContain(py)
    
    expect(manager.convertToPinyin('张 三')).toBe('zhangsan')
    expect(manager.convertToPinyin('Fu Ning Na! 123')).toBe('funingna123')
    expect(manager.convertToPinyin('')).toHaveLength(8) // UUID 兜底长度为 8
  })

  it('应当在同名文件夹冲突时自动追加不冲突的流水号', () => {
    const manager = new CharacterStorageManager(testBaseDir)
    
    // 1. 无冲突时获取原名
    const name1 = manager.getUniqueFolderName('zhangsan')
    expect(name1).toBe('zhangsan')
    
    // 创建实体文件夹模拟文件系统中已被占用
    fs.mkdirSync(path.join(testBaseDir, 'zhangsan'), { recursive: true })
    
    // 2. 冲突时获取 zhangsan_1
    const name2 = manager.getUniqueFolderName('zhangsan')
    expect(name2).toBe('zhangsan_1')
    
    // 再次创建实体目录以制造连续冲突
    fs.mkdirSync(path.join(testBaseDir, 'zhangsan_1'), { recursive: true })
    
    // 3. 再次冲突获取 zhangsan_2
    const name3 = manager.getUniqueFolderName('zhangsan')
    expect(name3).toBe('zhangsan_2')
  })

  it('应当能够完整、安全地将角色相关文件写入磁盘', () => {
    const manager = new CharacterStorageManager(testBaseDir)
    const folderName = 'zhaoyang'
    const mockAvatar = Buffer.from('mock_png_avatar_bytes')
    const mockSoul = '# Character Personality\n性格傲娇而温柔'
    const mockWorld = '# World Settings\n原神枫丹沫芒宫'
    
    const result = manager.saveCharacter(folderName, mockAvatar, mockSoul, mockWorld)
    
    expect(result.folderName).toBe('zhaoyang')
    expect(result.folderPath).toBe(path.join(testBaseDir, 'zhaoyang'))
    
    // 验证物理路径下所有 5 个核心生命体文档是否全部落盘就绪
    const folderPath = result.folderPath
    expect(fs.existsSync(path.join(folderPath, 'avatar.png'))).toBe(true)
    expect(fs.readFileSync(path.join(folderPath, 'avatar.png')).toString()).toBe('mock_png_avatar_bytes')
    
    expect(fs.existsSync(path.join(folderPath, 'Soul.md'))).toBe(true)
    expect(fs.readFileSync(path.join(folderPath, 'Soul.md'), 'utf8')).toBe(mockSoul)

    expect(fs.existsSync(path.join(folderPath, 'World.md'))).toBe(true)
    expect(fs.readFileSync(path.join(folderPath, 'World.md'), 'utf8')).toBe(mockWorld)

    expect(fs.existsSync(path.join(folderPath, 'Memory.md'))).toBe(true)
    expect(fs.readFileSync(path.join(folderPath, 'Memory.md'), 'utf8')).toContain('"stm": []')

    expect(fs.existsSync(path.join(folderPath, 'Diary.md'))).toBe(true)
    expect(fs.readFileSync(path.join(folderPath, 'Diary.md'), 'utf8')).toContain('# 角色日记')

    // 检查 assets 目录是否创建成功
    expect(fs.existsSync(path.join(folderPath, 'assets'))).toBe(true)
  })
})
