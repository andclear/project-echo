import { describe, it, expect } from 'vitest'
import { cleanContentForLLM, formatUserImageForLLM, mergeChatHistory, formatHistoryWithTimeGaps } from '../src/main/utils/ChatHistoryMerger'

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

  describe('formatHistoryWithTimeGaps 历史时间相对间距插帧测试', () => {
    it('当相邻消息的发生间隔小于 2 小时，消息内容不应该被修改', () => {
      const baseTime = Date.now()
      const history = [
        { role: 'user', content: '消息一', timestamp: baseTime },
        { role: 'assistant', content: '消息二', timestamp: baseTime + 30 * 60 * 1000 } // 30分钟后
      ]
      const formatted = formatHistoryWithTimeGaps(history)
      expect(formatted[0].content).toBe('消息一')
      expect(formatted[1].content).toBe('消息二')
    })

    it('当相邻消息间隔大于等于 2 小时且小于 24 小时，应插入小时流逝标签', () => {
      const baseTime = Date.now()
      const history = [
        { role: 'user', content: '消息一', timestamp: baseTime },
        { role: 'assistant', content: '消息二', timestamp: baseTime + 3.5 * 60 * 60 * 1000 } // 3.5小时后
      ]
      const formatted = formatHistoryWithTimeGaps(history)
      expect(formatted[0].content).toBe('消息一')
      expect(formatted[1].content).toContain('[时空流逝：相隔 3 小时后]\n')
    })

    it('当相邻消息间隔大于等于 24 小时，应插入天数流逝标签', () => {
      const baseTime = Date.now()
      const history = [
        { role: 'user', content: '消息一', timestamp: baseTime },
        { role: 'assistant', content: '消息二', timestamp: baseTime + 50 * 60 * 60 * 1000 } // 50小时后，即 2 天多
      ]
      const formatted = formatHistoryWithTimeGaps(history)
      expect(formatted[0].content).toBe('消息一')
      expect(formatted[1].content).toContain('[时空流逝：相隔 2 天后]\n')
    })
  })
})
