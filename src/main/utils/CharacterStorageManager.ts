import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { pinyin } from 'pinyin'
import crypto from 'crypto'

export interface SaveCharacterResult {
  folderName: string
  folderPath: string
}

export class CharacterStorageManager {
  private baseDir: string

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      this.baseDir = customBaseDir
    } else {
      try {
        // 生产与开发环境放置在 userData/characters 下
        this.baseDir = path.join(app.getPath('userData'), 'characters')
      } catch (e) {
        // 兜底，以满足 Vitest 单元测试运行在无 Electron 进程的环境中
        this.baseDir = path.join(process.cwd(), 'Echo-UserData-Test', 'characters')
      }
    }

    // 确保基础目录存在
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true })
    }
  }

  /**
   * 获取当前基础路径
   */
  public getBaseDir(): string {
    return this.baseDir
  }

  /**
   * 将中文转换为纯小写、去空格、去特殊字符的拼音
   */
  public convertToPinyin(name: string): string {
    if (!name || !name.trim()) {
      return this.getUuidFallback()
    }
    
    try {
      const converted = pinyin(name, { style: 'normal' })
      if (!Array.isArray(converted) || converted.length === 0) {
        return this.getUuidFallback()
      }
      
      const pinyinStr = converted
        .map((item) => (Array.isArray(item) && item[0] ? item[0] : ''))
        .join('')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '') // 只保留小写字母与数字
        
      return pinyinStr || this.getUuidFallback()
    } catch (e) {
      console.error('[StorageManager] Pinyin conversion error, fallback to UUID:', e)
      return this.getUuidFallback()
    }
  }

  /**
   * 生成一个 8 位的 UUID 字符串作为兜底名称
   */
  private getUuidFallback(): string {
    return crypto.randomUUID().substring(0, 8)
  }

  /**
   * 获取唯一不重复的文件夹名称（流水号防覆盖冲突保障）
   */
  public getUniqueFolderName(folderName: string): string {
    let sanitized = folderName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!sanitized) {
      sanitized = this.getUuidFallback()
    }

    let currentFolder = sanitized
    let counter = 1
    
    // 如果已经存在，则自动追加流水号 _1, _2 等，直至不存在为止
    while (fs.existsSync(path.join(this.baseDir, currentFolder))) {
      currentFolder = `${sanitized}_${counter}`
      counter++
    }
    
    return currentFolder
  }

  /**
   * 将角色的所有文件写入专属物理路径
   */
  public saveCharacter(
    folderName: string,
    avatarBuffer: Buffer | Uint8Array,
    soulContent: string,
    worldContent: string
  ): SaveCharacterResult {
    // 再次过滤文件夹名
    const sanitizedFolder = folderName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    const folderPath = path.join(this.baseDir, sanitizedFolder)

    // 确保角色主目录存在
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }

    // 确保静态资源 assets 目录存在
    const assetsPath = path.join(folderPath, 'assets')
    if (!fs.existsSync(assetsPath)) {
      fs.mkdirSync(assetsPath, { recursive: true })
    }

    // 1. 写入头像 avatar.png
    fs.writeFileSync(path.join(folderPath, 'avatar.png'), avatarBuffer)

    // 2. 写入性格设定 Soul.md
    fs.writeFileSync(path.join(folderPath, 'Soul.md'), soulContent.trim(), 'utf8')

    // 3. 写入世界设定 World.md
    fs.writeFileSync(path.join(folderPath, 'World.md'), worldContent.trim(), 'utf8')

    // 4. 写入初始化 Memory.md
    const memoryInitContent = `<!--
{
  "stm": [],
  "ltm": {}
}
-->
# 记忆存储区

## 短期记忆 (Short-Term Memory)
暂无短期记忆。

## 长期记忆 (Long-Term Memory)
暂无长期记忆。`
    fs.writeFileSync(path.join(folderPath, 'Memory.md'), memoryInitContent, 'utf8')

    // 5. 写入初始化 Diary.md
    const diaryInitContent = `# 角色日记

暂无日记记录。`
    fs.writeFileSync(path.join(folderPath, 'Diary.md'), diaryInitContent, 'utf8')

    // 5.5 写入初始化 DREAM.md (自省避坑进化补丁)
    const dreamInitContent = `# 梦境自省反思与进化补丁

## 专属避坑准则与习惯修正
暂无梦境自省事实与避坑规则沉淀。`
    fs.writeFileSync(path.join(folderPath, 'DREAM.md'), dreamInitContent, 'utf8')

    console.log(`[StorageManager] 角色 [${sanitizedFolder}] 的物理存储与专属 DREAM.md 落盘成功: ${folderPath}`)
    
    return {
      folderName: sanitizedFolder,
      folderPath
    }
  }

  /**
   * 读取角色文件内容
   */
  public readCharacterFile(folderName: string, fileName: string): string {
    const filePath = path.join(this.baseDir, folderName, fileName)
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8')
    }
    return ''
  }

  /**
   * 写入更新角色文件
   */
  public writeCharacterFile(folderName: string, fileName: string, content: string): void {
    const filePath = path.join(this.baseDir, folderName, fileName)
    fs.writeFileSync(filePath, content, 'utf8')
  }
}
