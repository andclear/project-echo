import { describe, test, expect } from 'vitest';
import { StreamingContextScrubber } from '../src/renderer/src/utils/StreamingContextScrubber';

describe('StreamingContextScrubber 前端流式 Scrubber 过滤状态机测试', () => {
  
  test('常规文本无阻碍放行测试', () => {
    const scrubber = new StreamingContextScrubber();
    const chunk = '你好，今天天气不错。';
    const output = scrubber.scrub(chunk);
    expect(output).toBe('你好，今天天气不错。');
  });

  test('<memory-context> 及其内部内容 100% 被隐式丢弃测试', () => {
    const scrubber = new StreamingContextScrubber();
    
    // 模拟大模型输出带有思维链与记忆标签的整段
    const rawText = '好的，<memory-context>[System note: 用户喜欢吉他]</memory-context>我为你推荐吉他乐曲。';
    const output = scrubber.scrub(rawText);
    
    // 验证记忆上下文及标签本身全部被隐式擦除
    expect(output).toBe('好的，我为你推荐吉他乐曲。');
  });

  test('跨 Chunk 匹配截断边界场景测试', () => {
    const scrubber = new StreamingContextScrubber();
    
    // 标签跨越 chunk 边界截断
    const chunk1 = '好的，我记住了。<memory-con';
    const chunk2 = 'text>[System Info] 用户喜欢编程</memory-';
    const chunk3 = 'context>我们接下来谈谈 TypeScript。';
    
    const out1 = scrubber.scrub(chunk1);
    const out2 = scrubber.scrub(chunk2);
    const out3 = scrubber.scrub(chunk3);
    
    expect(out1).toBe('好的，我记住了。');
    expect(out2).toBe('');
    expect(out3).toBe('我们接下来谈谈 TypeScript。');
  });
});
