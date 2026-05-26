import { describe, test, expect } from 'vitest';
import { StreamSplitController } from '../src/main/utils/StreamSplitController';

describe('StreamSplitController 标点断句流式拦截控制器测试', () => {
  
  test('正常文本标点断句切片测试', () => {
    const controller = new StreamSplitController();
    const sentences: string[] = [];
    
    // 模拟流式输入 chunks
    const chunk1 = '你好！今天天气真';
    const chunk2 = '好啊。你觉得呢？我';
    const chunk3 = '正在写代码。';
    
    const skills1 = controller.processChunk(chunk1, (s) => sentences.push(s));
    expect(sentences).toEqual(['你好！']);
    expect(skills1).toEqual([]);
    
    const skills2 = controller.processChunk(chunk2, (s) => sentences.push(s));
    expect(sentences).toEqual(['你好！', '今天天气真好啊。', '你觉得呢？']);
    expect(skills2).toEqual([]);
    
    const skills3 = controller.processChunk(chunk3, (s) => sentences.push(s));
    expect(sentences).toEqual(['你好！', '今天天气真好啊。', '你觉得呢？', '我正在写代码。']);
    expect(skills3).toEqual([]);
    
    controller.flush((s) => sentences.push(s));
    // 确保没有多余残留
    expect(sentences.length).toBe(4);
  });

  test('[CALL_SKILL: ...] 专属技能调用拦截与剔除测试', () => {
    const controller = new StreamSplitController();
    const sentences: string[] = [];
    
    // 模拟流中夹杂了技能动作
    const chunk = '我很乐意为你点歌。[CALL_SKILL: play-music {"song": "富士山下"}] 祝你听歌愉快！\n';
    
    const skills = controller.processChunk(chunk, (s) => sentences.push(s));
    
    // 验证技能调用指令成功被完整截获并从正文中剔除
    expect(skills).toEqual(['play-music {"song": "富士山下"}']);
    // 验证聊天正文句子输出已完全剔除了 [CALL_SKILL: ...]，只有常规普通话
    expect(sentences).toEqual(['我很乐意为你点歌。', '祝你听歌愉快！']);
  });
});
