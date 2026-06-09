import { describe, it, expect } from 'vitest'
import { cleanContentForLLM, formatUserImageForLLM, mergeChatHistory } from '../src/main/utils/ChatHistoryMerger'

describe('ChatHistoryMerger 图片描述与降维转换测试', () => {
  describe('cleanContentForLLM 降维提取测试', () => {
    it('对于包含画面描述的 wechat_image_media 消息，应正确提取描述并返回 [图片消息: 描述]', () => {
      const input = '[wechat_image_media]:media/drawing_123.png[image_desc:一只可爱的三花猫在草地上玩毛线球]'
      const result = cleanContentForLLM(input)
      expect(result).toBe('[图片消息: 一只可爱的三花猫在草地上玩毛线球]')
    })

    it('对于不包含描述的 wechat_image_media 消息，应退回返回 [图片消息]', () => {
      const input = '[wechat_image_media]:media/drawing_123.png'
      const result = cleanContentForLLM(input)
      expect(result).toBe('[图片消息]')
    })

    it('对于普通文本消息，应正常返回', () => {
      const input = '你好，今天天气不错'
      const result = cleanContentForLLM(input)
      expect(result).toBe('你好，今天天气不错')
    })
  })

  describe('formatUserImageForLLM 叙事转换测试', () => {
    it('对于包含画面描述的用户图片消息，应返回 (用户发来了一张图片，画面里是：描述)', () => {
      const input = '[wechat_image_media]:media/drawing_123.png[image_desc:一只可爱的三花猫在草地上玩毛线球]'
      const result = formatUserImageForLLM(input)
      expect(result).toBe('（用户发来了一张图片，画面里是：一只可爱的三花猫在草地上玩毛线球）')
    })

    it('对于不包含描述的用户图片消息，应退回返回 (用户发来了一张图片)', () => {
      const input = '[wechat_image_media]:media/drawing_123.png'
      const result = formatUserImageForLLM(input)
      expect(result).toBe('（用户发来了一张图片）')
    })

    it('对于非图片消息，应返回空字符串', () => {
      const input = '这是一句普通文本'
      const result = formatUserImageForLLM(input)
      expect(result).toBe('')
    })
  })
})
