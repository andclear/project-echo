import fs from 'fs'

export interface CharacterCardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes?: string
  system_prompt?: string
  post_history_instructions?: string
  tags?: string[]
  creator?: string
  character_version?: string
  alternate_greetings?: string[]
  [key: string]: any
}

export class CharacterCardParser {
  /**
   * 解析 SillyTavern V2 角色卡 PNG 文件（从文件路径）
   */
  public static parseFromFile(filePath: string): CharacterCardData {
    const fileBuffer = fs.readFileSync(filePath)
    return this.parseFromBuffer(fileBuffer)
  }

  /**
   * 解析 SillyTavern 角色卡 PNG 数据（从二进制 Buffer/Uint8Array），支持 V3 格式并向下兼容 V2/V1 格式
   */
  public static parseFromBuffer(buffer: Buffer | Uint8Array): CharacterCardData {
    const dataBuffer = buffer instanceof Uint8Array ? Buffer.from(buffer) : buffer

    // 🚀 核心升级：高度容错，自动识别并直接解析导入的 JSON 格式角色卡文件
    try {
      const text = dataBuffer.toString('utf8').trim()
      if (text.startsWith('{') && text.endsWith('}')) {
        const parsedJson = JSON.parse(text)
        if (parsedJson) {
          if (parsedJson.data && typeof parsedJson.data === 'object' && parsedJson.data.name) {
            console.log(`[Parser] 成功直接解析 JSON 角色卡 (酒馆规格)，角色名称: ${parsedJson.data.name}`)
            return parsedJson.data as CharacterCardData
          } else if (parsedJson.name) {
            console.log(`[Parser] 成功直接解析 JSON 角色卡 (标准规格)，角色名称: ${parsedJson.name}`)
            return parsedJson as CharacterCardData
          }
        }
      }
    } catch (_) {
      // 容错：如果解析失败或不是 JSON 格式，则平滑放行，继续走标准的 PNG 角色卡解析逻辑
    }

    // 1. 验证 PNG 文件签名 (前 8 字节)
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (dataBuffer.length < 8 || !dataBuffer.subarray(0, 8).equals(pngSignature)) {
      throw new Error('无效的图片格式：不是标准的 PNG 图片')
    }

    let offset = 8 // 从签名后开始读取 Chunk
    let ccv3Text: string | null = null
    let charaText: string | null = null

    // 2. 遍历 PNG Chunk 块收集文本数据块 (tEXt)
    while (offset < dataBuffer.length) {
      if (offset + 8 > dataBuffer.length) {
        break // 剩余数据不足以包含 Length 和 Type
      }

      // 读取 Chunk 数据区长度 (4 字节，大端整型)
      const chunkLength = dataBuffer.readUInt32BE(offset)
      // 读取 Chunk 类型 (4 字节，ASCII)
      const chunkType = dataBuffer.toString('ascii', offset + 4, offset + 8)

      // 如果数据长度超出了文件大小，说明文件损坏
      if (offset + 12 + chunkLength > dataBuffer.length) {
        throw new Error(`PNG 文件 Chunk 损坏：${chunkType} 块长度超出文件范围`)
      }

      // 拦截文本数据块 (tEXt)
      if (chunkType === 'tEXt') {
        const dataStart = offset + 8
        const dataEnd = dataStart + chunkLength
        const chunkData = dataBuffer.subarray(dataStart, dataEnd)

        // tEXt 数据格式：Keyword (1-79 字节) + null 字节 (0x00) + Text
        const nullByteIndex = chunkData.indexOf(0x00)
        if (nullByteIndex !== -1) {
          const keyword = chunkData.toString('ascii', 0, nullByteIndex)
          
          if (keyword === 'ccv3') {
            ccv3Text = chunkData.toString('utf8', nullByteIndex + 1)
          } else if (keyword === 'chara') {
            charaText = chunkData.toString('utf8', nullByteIndex + 1)
          }
        }
      }

      // 如果遇到了 IEND 块，说明 PNG 图像块已全部结束
      if (chunkType === 'IEND') {
        break
      }

      // 指针向后移动：Length (4) + Type (4) + Data (chunkLength) + CRC (4)
      offset += 12 + chunkLength
    }

    // 3. 优先级决策与解析：优先处理 V3 格式，其次处理 V2/V1 格式
    if (ccv3Text) {
      try {
        // SillyTavern V3 规格使用 Base64 编码的 JSON
        const decodedText = Buffer.from(ccv3Text, 'base64').toString('utf8')
        const parsedJson = JSON.parse(decodedText)
        
        if (parsedJson && parsedJson.data) {
          console.log(`[Parser] 成功解析 SillyTavern V3 角色卡，角色名称: ${parsedJson.data.name}`)
          return parsedJson.data as CharacterCardData
        } else {
          throw new Error('V3 角色卡 JSON 中未包含有效的 data 属性')
        }
      } catch (e: any) {
        throw new Error(`解析 ccv3 节点 JSON 失败: ${e.message || e}`)
      }
    }

    if (charaText) {
      try {
        // SillyTavern V2 标准角色卡将 JSON 数据进行 Base64 编码
        const decodedText = Buffer.from(charaText, 'base64').toString('utf8')
        const parsedJson = JSON.parse(decodedText)
        
        // 适配 SillyTavern V2 数据结构：如果最外层是 { data: { ... } }，提取 data 节点
        if (parsedJson && parsedJson.data) {
          console.log(`[Parser] 成功解析 SillyTavern V2 角色卡，角色名称: ${parsedJson.data.name}`)
          return parsedJson.data as CharacterCardData
        } else if (parsedJson && parsedJson.name) {
          // 部分 V1 兼容格式或直接存放在根节点的卡片
          console.log(`[Parser] 成功解析 SillyTavern V1 角色卡，角色名称: ${parsedJson.name}`)
          return parsedJson as CharacterCardData
        } else {
          throw new Error('角色卡 JSON 中未包含有效的角色人设信息')
        }
      } catch (e: any) {
        throw new Error(`解析 chara 节点 JSON 失败: ${e.message || e}`)
      }
    }

    throw new Error('在 PNG 角色卡中未找到 keyword 为 "ccv3" 或 "chara" 的人设数据块')
  }
}
