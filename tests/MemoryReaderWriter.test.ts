import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryReaderWriter } from '../src/main/utils/MemoryReaderWriter';

describe('MemoryReaderWriter 单元测试', () => {
  const testDir = path.join(__dirname, '../tests_temp_memory');
  const memoryFile = path.join(testDir, 'Memory.md');

  beforeEach(() => {
    // 创建测试临时目录
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // 递归清理测试临时文件及目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('1. 读取不存在的文件时，自动初始化物理默认数据且结构合规', () => {
    expect(fs.existsSync(memoryFile)).toBe(false);
    
    const data = MemoryReaderWriter.readMemory(memoryFile);
    
    // 验证物理初始化
    expect(fs.existsSync(memoryFile)).toBe(true);
    expect(data.stm).toEqual([]);
    expect(data.ltm).toEqual({});

    const fileContent = fs.readFileSync(memoryFile, 'utf-8');
    expect(fileContent).toContain('<!--');
    expect(fileContent).toContain('-->');
    expect(fileContent).toContain('# 角色记忆存储区');
    expect(fileContent).toContain('## 短期记忆 (STM)');
    expect(fileContent).toContain('*暂无短期记忆*');
  });

  it('2. 能够正确读取和写入长期记忆与短期记忆，并同步动态渲染 Markdown 自然语言区', () => {
    const stm = ['今天和用户聊到了回音平台的设计', '用户计划明天去深圳出差'];
    const ltm = {
      '用户生日': '9月10日',
      '用户姓名': '杨越',
      '沟通偏好': '喜欢直接和简短的回复'
    };

    MemoryReaderWriter.writeMemory(memoryFile, stm, ltm);

    // 重新读取并验证
    const data = MemoryReaderWriter.readMemory(memoryFile);
    expect(data.stm).toEqual(stm);
    expect(data.ltm).toEqual(ltm);

    // 物理文本验证，确保大模型绝不参与底盘渲染以防写坏
    const rawText = fs.readFileSync(memoryFile, 'utf-8');
    expect(rawText).toContain('<!--');
    expect(rawText).toContain('-->');
    expect(rawText).toContain('- 今天和用户聊到了回音平台的设计');
    expect(rawText).toContain('- 用户计划明天去深圳出差');
    expect(rawText).toContain('- **用户生日**：9月10日');
    expect(rawText).toContain('- **沟通偏好**：喜欢直接和简短的回复');
  });

  it('3. 短期记忆 (STM) 高频滚动队列容量硬上限 50 条 (先进先出 FIFO)', () => {
    // 模拟连续追加 60 条新短期记忆 facts
    for (let i = 1; i <= 60; i++) {
      MemoryReaderWriter.pushSTM(memoryFile, `记忆事实条目 #${i}`);
    }

    const data = MemoryReaderWriter.readMemory(memoryFile);
    // 验证容量截断上限
    expect(data.stm.length).toBe(50);
    // 验证先进先出剔除 (最老的 10 条已被移出，前台应该保留 11 到 60)
    expect(data.stm[0]).toBe('记忆事实条目 #11');
    expect(data.stm[49]).toBe('记忆事实条目 #60');

    // 物理落盘验证
    const rawText = fs.readFileSync(memoryFile, 'utf-8');
    expect(rawText).not.toContain('记忆事实条目 #10');
    expect(rawText).toContain('记忆事实条目 #11');
    expect(rawText).toContain('记忆事实条目 #60');
  });

  it('4. 长期记忆 (LTM) 增量单条修改与同步渲染', () => {
    MemoryReaderWriter.updateLTM(memoryFile, '音乐口味', '偏爱后摇与轻音乐');
    MemoryReaderWriter.updateLTM(memoryFile, '用户姓名', '杨越老师'); // 覆盖写

    const data = MemoryReaderWriter.readMemory(memoryFile);
    expect(data.ltm['音乐口味']).toBe('偏爱后摇与轻音乐');
    expect(data.ltm['用户姓名']).toBe('杨越老师');

    const rawText = fs.readFileSync(memoryFile, 'utf-8');
    expect(rawText).toContain('- **音乐口味**：偏爱后摇与轻音乐');
    expect(rawText).toContain('- **用户姓名**：杨越老师');
  });

  it('5. 用户直接手工修改底部 Markdown 文本时，读取时应当能够智能检测、以降级 Markdown 为准，并全自动写盘对齐纠偏 JSON 块', () => {
    const stm = ['原汁原味的短期记忆 #1'];
    const ltm = {
      '原有生日': '10月24日',
      '原有名字': '李华'
    };

    // 1. 正常写入物理文件
    MemoryReaderWriter.writeMemory(memoryFile, stm, ltm);

    // 2. 模拟用户手工在外部修改底部的 Markdown 内容（比如修改了生日，修改了短期记忆）
    const customContent = `<!--
{
  "stm": [
    "原汁原味的短期记忆 #1"
  ],
  "ltm": {
    "原有生日": "10月24日",
    "原有名字": "李华"
  }
}
-->

# 角色记忆存储区

## 短期记忆 (STM)
- 用户今天心情非常好并且喜欢唱歌了！

## 长期记忆 (LTM)
- **原有生日**：12月25日
- **原有名字**：李明
- **新增偏好**：超级爱编程
`;
    fs.writeFileSync(memoryFile, customContent, 'utf-8');

    // 3. 调用 readMemory，应该能检测到不一致，并以 Markdown 内容为最高优先准则读取
    const data = MemoryReaderWriter.readMemory(memoryFile);

    // 验证读取出来的是否是手工改动后的 Markdown 记忆，而不是旧的 JSON
    expect(data.stm).toEqual(['用户今天心情非常好并且喜欢唱歌了！']);
    expect(data.ltm['原有生日']).toBe('12月25日');
    expect(data.ltm['原有名字']).toBe('李明');
    expect(data.ltm['新增偏好']).toBe('超级爱编程');

    // 4. 验证物理文件此时是否已经实现了“智能对齐”，上面的 JSON 注释应该已经自动自愈成了最新的内容！
    const selfHealedContent = fs.readFileSync(memoryFile, 'utf-8');
    expect(selfHealedContent).toContain('"原有生日": "12月25日"');
    expect(selfHealedContent).toContain('"原有名字": "李明"');
    expect(selfHealedContent).toContain('"新增偏好": "超级爱编程"');
    expect(selfHealedContent).toContain('"用户今天心情非常好并且喜欢唱歌了！"');
  });
});
