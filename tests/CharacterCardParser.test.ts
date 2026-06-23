import { describe, it, expect } from 'vitest'
import { CharacterCardParser } from '../src/main/utils/CharacterCardParser'

describe('CharacterCardParser 角色卡解析器测试', () => {
  
  it('应当能完美解析合法的 SillyTavern V2 PNG 角色卡 Buffer', () => {
    // 1. 构建 PNG 文件签名
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 2. 构建符合 SillyTavern V2 标准的 JSON 数据
    const characterData = {
      data: {
        name: '芙宁娜',
        description: '枫丹的水神，戏剧张力十足，内心温柔但表面傲娇。',
        personality: '高傲，戏剧化，敏感，渴望被认可',
        scenario: '在沫芒宫的会客室与旅行者对话',
        first_mes: '哦？又有新观众慕名而来了吗？好吧，尽情欢呼吧！',
        mes_example: '<user>: 你好，芙宁娜\n<model>: 哼，见到本芙宁娜大人，还不快献上你的掌声？'
      }
    }

    const base64Text = Buffer.from(JSON.stringify(characterData)).toString('base64')
    
    // 3. 构建 tEXt Chunk Data：Keyword ('chara') + null byte (0x00) + base64 text
    const keywordBuffer = Buffer.from('chara', 'ascii')
    const nullByte = Buffer.from([0x00])
    const textBuffer = Buffer.from(base64Text, 'utf8')
    const tEXtData = Buffer.concat([keywordBuffer, nullByte, textBuffer])

    // 4. 构建 tEXt Chunk: Length (4 bytes) + Type ('tEXt', 4 bytes) + Data (tEXtData) + CRC (4 bytes)
    const tEXtLength = Buffer.alloc(4)
    tEXtLength.writeUInt32BE(tEXtData.length)
    const tEXtType = Buffer.from('tEXt', 'ascii')
    const tEXtCrc = Buffer.alloc(4) // 填充占位 CRC
    const tEXtChunk = Buffer.concat([tEXtLength, tEXtType, tEXtData, tEXtCrc])

    // 5. 构建 IEND Chunk: Length (0, 4 bytes) + Type ('IEND', 4 bytes) + CRC (4 bytes)
    const iendLength = Buffer.alloc(4)
    const iendType = Buffer.from('IEND', 'ascii')
    const iendCrc = Buffer.alloc(4)
    const iendChunk = Buffer.concat([iendLength, iendType, iendCrc])

    // 6. 组装成完整的 mock PNG 字节流
    const mockPngBuffer = Buffer.concat([signature, tEXtChunk, iendChunk])

    // 7. 执行解析验证
    const result = CharacterCardParser.parseFromBuffer(mockPngBuffer)

    expect(result).toBeDefined()
    expect(result.name).toBe('芙宁娜')
    expect(result.personality).toContain('高傲')
    expect(result.first_mes).toContain('新观众')
  })

  it('传入非 PNG 签名数据时，应当抛出特定的格式异常', () => {
    const invalidBuffer = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    
    expect(() => {
      CharacterCardParser.parseFromBuffer(invalidBuffer)
    }).toThrow('无效的图片格式：不是标准的 PNG 图片')
  })

  it('如果没有找到 chara 节点，应当抛出未找到数据的异常', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    
    // 构建一个 Keyword 不是 chara 的 tEXt 块 (如 'author')
    const keywordBuffer = Buffer.from('author', 'ascii')
    const nullByte = Buffer.from([0x00])
    const textBuffer = Buffer.from('Antigravity', 'utf8')
    const tEXtData = Buffer.concat([keywordBuffer, nullByte, textBuffer])

    const tEXtLength = Buffer.alloc(4)
    tEXtLength.writeUInt32BE(tEXtData.length)
    const tEXtType = Buffer.from('tEXt', 'ascii')
    const tEXtCrc = Buffer.alloc(4)
    const tEXtChunk = Buffer.concat([tEXtLength, tEXtType, tEXtData, tEXtCrc])

    const iendLength = Buffer.alloc(4)
    const iendType = Buffer.from('IEND', 'ascii')
    const iendCrc = Buffer.alloc(4)
    const iendChunk = Buffer.concat([iendLength, iendType, iendCrc])

    const mockPngBuffer = Buffer.concat([signature, tEXtChunk, iendChunk])

    expect(() => {
      CharacterCardParser.parseFromBuffer(mockPngBuffer)
    }).toThrow('在 PNG 角色卡中未找到 keyword 为 "ccv3" 或 "chara" 的人设数据块')
  })

  it('应当能完美解析合法的 SillyTavern V3 PNG 角色卡 Buffer', () => {
    // 1. 构建 PNG 文件签名
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // 2. 构建符合 SillyTavern V3 标准的 JSON 数据
    const characterDataV3 = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '纳西妲',
        description: '须弥的草神，内心睿智、善良且热爱子民。',
        personality: '聪慧，善解人意，充满好奇心',
        scenario: '在净善宫中与旅行者进行心灵层面的交流',
        first_mes: '你好，我是纳西妲。你也是来听我讲故事的吗？',
        mes_example: '<user>: 你好，小吉祥草王\n<model>: 叫我纳西妲就好啦，我们是朋友，不是吗？'
      }
    }

    const base64Text = Buffer.from(JSON.stringify(characterDataV3)).toString('base64')
    
    // 3. 构建 tEXt Chunk Data：Keyword ('ccv3') + null byte (0x00) + base64 text
    const keywordBuffer = Buffer.from('ccv3', 'ascii')
    const nullByte = Buffer.from([0x00])
    const textBuffer = Buffer.from(base64Text, 'utf8')
    const tEXtData = Buffer.concat([keywordBuffer, nullByte, textBuffer])

    // 4. 构建 tEXt Chunk: Length (4 bytes) + Type ('tEXt', 4 bytes) + Data (tEXtData) + CRC (4 bytes)
    const tEXtLength = Buffer.alloc(4)
    tEXtLength.writeUInt32BE(tEXtData.length)
    const tEXtType = Buffer.from('tEXt', 'ascii')
    const tEXtCrc = Buffer.alloc(4) // 填充占位 CRC
    const tEXtChunk = Buffer.concat([tEXtLength, tEXtType, tEXtData, tEXtCrc])

    // 5. 构建 IEND Chunk
    const iendLength = Buffer.alloc(4)
    const iendType = Buffer.from('IEND', 'ascii')
    const iendCrc = Buffer.alloc(4)
    const iendChunk = Buffer.concat([iendLength, iendType, iendCrc])

    // 6. 组装成完整的 mock PNG 字节流
    const mockPngBuffer = Buffer.concat([signature, tEXtChunk, iendChunk])

    // 7. 执行解析验证
    const result = CharacterCardParser.parseFromBuffer(mockPngBuffer)

    expect(result).toBeDefined()
    expect(result.name).toBe('纳西妲')
    expect(result.personality).toContain('聪慧')
    expect(result.first_mes).toContain('听我讲故事')
  })
})
