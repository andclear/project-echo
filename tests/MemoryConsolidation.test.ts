import { describe, test, expect } from 'vitest'

describe('记忆一键整理提炼 JSON 正则解析与容错拦截测试', () => {
  test('1. 应当能完美识别并解析带有 ```json 块的 AI 响应', () => {
    const rawAiResponse = `
这里是整理好的记忆，请收下：
\`\`\`json
{
  "stm": ["{{user}}与{{char}}探讨了音乐"],
  "ltm": {
    "兴趣偏好": "{{user}}喜欢后摇"
  }
}
\`\`\`
祝您体验愉快！
`
    let jsonText = rawAiResponse.trim()
    const jsonMatch = jsonText.match(/```json([\s\S]*?)```/)
    let extracted = ''
    if (jsonMatch && jsonMatch[1]) {
      extracted = jsonMatch[1].trim()
    } else {
      const plainMatch = jsonText.match(/```([\s\S]*?)```/)
      if (plainMatch && plainMatch[1]) {
        extracted = plainMatch[1].trim()
      }
    }

    const parsed = JSON.parse(extracted)
    expect(parsed.stm.length).toBe(1)
    expect(parsed.stm[0]).toBe('{{user}}与{{char}}探讨了音乐')
    expect(parsed.ltm['兴趣偏好']).toBe('{{user}}喜欢后摇')
  })

  test('2. 应当能完美识别并解析带有普通 \`\`\` 块的 AI 响应', () => {
    const rawAiResponse = `
\`\`\`
{
  "stm": ["{{user}}喜欢苹果"],
  "ltm": {
    "生日": "9月10日"
  }
}
\`\`\`
`
    let jsonText = rawAiResponse.trim()
    const jsonMatch = jsonText.match(/```json([\s\S]*?)```/)
    let extracted = ''
    if (jsonMatch && jsonMatch[1]) {
      extracted = jsonMatch[1].trim()
    } else {
      const plainMatch = jsonText.match(/```([\s\S]*?)```/)
      if (plainMatch && plainMatch[1]) {
        extracted = plainMatch[1].trim()
      }
    }

    const parsed = JSON.parse(extracted)
    expect(parsed.stm.length).toBe(1)
    expect(parsed.stm[0]).toBe('{{user}}喜欢苹果')
    expect(parsed.ltm['生日']).toBe('9月10日')
  })
})
