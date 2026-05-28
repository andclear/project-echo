import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryReaderWriter } from '../src/main/utils/MemoryReaderWriter';
import { UserProfileReaderWriter } from '../src/main/utils/UserProfileReaderWriter';
import { SummaryReaderWriter } from '../src/main/utils/SummaryReaderWriter';
import { ContextAssembler, HistoryMessage } from '../src/main/utils/ContextAssembler';

describe('ContextAssembler 单元测试 (Prompt 前缀缓存极致保温)', () => {
  const testDir = path.join(__dirname, '../tests_temp');
  const soulFile = path.join(testDir, 'Soul.md');
  const worldFile = path.join(testDir, 'World.md');
  const memoryFile = path.join(testDir, 'Memory.md');
  const summaryFile = path.join(testDir, 'SUMMARY.md');
  const globalUserFile = path.join(testDir, 'global_USER.md');
  const charUserFile = path.join(testDir, 'char_USER.md');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    // 写入 Stable Tier 底座数据
    fs.writeFileSync(soulFile, '# Soul\n我是一个温和、专业的 AI 编程助手。', 'utf-8');
    fs.writeFileSync(worldFile, '# World\n回音平台是一个本地化桌面角色扮演系统。', 'utf-8');
    
    // 写入双轨记忆
    MemoryReaderWriter.writeMemory(memoryFile, ['短期记忆一', '短期记忆二'], { '用户的生日': '9月10日' });

    // 写入双轨画像
    UserProfileReaderWriter.writeGlobalProfile(globalUserFile, {
      name: '杨越',
      age: '28',
      occupation: '开发者',
      global_preferences: { '主题色': '极光绿' }
    });
    UserProfileReaderWriter.writeCharacterProfile(charUserFile, ['用户对本智能体很有礼貌']);

    // 写入大事记
    SummaryReaderWriter.writeSummary(summaryFile, '魏淑珍与用户在编程之余聊到了双通道记忆的设计。');
  });

  afterEach(() => {
    // 递归清理物理文件
    [soulFile, worldFile, memoryFile, summaryFile, globalUserFile, charUserFile].forEach((f) => {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    });
    if (fs.existsSync(testDir)) {
      fs.rmdirSync(testDir);
    }
  });

  it('1. 系统能够严格按照 Stable -> Context -> Volatile 三层结构装配 Prompt', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: '你好，杨宁宁' },
      { role: 'assistant', content: '你好呀，很高兴见到你。' }
    ];

    // 指定一个固定时间以便对齐验证
    const testDate = new Date('2026-05-23T12:00:00+08:00');

    const prompt = ContextAssembler.assemble(
      soulFile,
      worldFile,
      memoryFile,
      globalUserFile,
      charUserFile,
      history,
      testDate
    );

    // A. 验证 Stable Tier 处于最头部
    expect(prompt.startsWith('# SYSTEM IDENTITY & WORLD RULES (Stable Tier)')).toBe(true);
    expect(prompt).toContain('我是一个温和、专业的 AI 编程助手。');
    expect(prompt).toContain('回音平台是一个本地化桌面角色扮演系统。');
    expect(prompt).toContain('## 魏淑珍与用户的对话大事记');
    expect(prompt).toContain('魏淑珍与用户在编程之余聊到了双通道记忆的设计。');

    // B. 验证 Context Tier 处于中间
    expect(prompt).toContain('# DYNAMIC CONTEXT & MEMORY (Context Tier)');
    expect(prompt).toContain('<global-user-profile>');
    expect(prompt).toContain('- **姓名**：杨越');
    expect(prompt).toContain('<character-specific-user-profile>');
    expect(prompt).toContain('- 用户对本智能体很有礼貌');

    // 验证独立 Memory Notes
    const memoryStr = ContextAssembler.assembleMemory(memoryFile);
    expect(memoryStr).toContain('短期记忆一');
    expect(memoryStr).toContain('- **用户的生日**：9月10日');

    // C. 验证 Volatile Tier 处于最底部
    expect(prompt).toContain('# VOLATILE TRANSACTION & TIME (Volatile Tier)');
    
    // D. 验证时间戳已成功剥离出 System Prompt (极致保温)
    expect(prompt).not.toContain('Live Environment Info');
    
    // E. 验证独立时间感知组装方法功能完好
    const liveEnvInfo = ContextAssembler.assembleLiveEnvInfo(testDate);
    expect(liveEnvInfo).toContain('Live Environment Info');
    expect(liveEnvInfo).toContain('Saturday, May 23, 2026');
  });

  it('2. 验证前置缓存保温效果：当对话发生变动时，Stable 层的头部字节完全静止一致', () => {
    // 轮次一装配
    const turn1History: HistoryMessage[] = [{ role: 'user', content: '今天星期几？' }];
    const prompt1 = ContextAssembler.assemble(
      soulFile,
      worldFile,
      memoryFile,
      globalUserFile,
      charUserFile,
      turn1History,
      new Date('2026-05-23')
    );

    // 轮次二装配（消息变更，时间跨到天级，但头部 Stable 应当 100% 字节相同）
    const turn2History: HistoryMessage[] = [
      { role: 'user', content: '今天星期几？' },
      { role: 'assistant', content: '今天是星期六。' },
      { role: 'user', content: '谢谢，我知道了！' }
    ];
    const prompt2 = ContextAssembler.assemble(
      soulFile,
      worldFile,
      memoryFile,
      globalUserFile,
      charUserFile,
      turn2History,
      new Date('2026-05-23')
    );

    // 截取前面的 Stable Tier 进行对比，验证绝对一致以加热 KV 缓存
    const stablePart1 = prompt1.split('---')[0];
    const stablePart2 = prompt2.split('---')[0];
    
    expect(stablePart1).toEqual(stablePart2);
    expect(stablePart1).toContain('# Soul');
    expect(stablePart1).toContain('# World');
  });

  describe('3. cleanDialogueActions 纯对话风格物理过滤函数测试', () => {
    it('应完美去除中文小括号包裹的动作或旁白', () => {
      const input = '（头也不抬，继续整理药柜）说吧，哪里不舒服。';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('说吧，哪里不舒服。');
    });

    it('应完美去除英文小括号和多重括号包裹的内容', () => {
      const input = '你终于来了。(拍了拍手) 坐吧。(微笑)';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('你终于来了。 坐吧。'); // 多余空格会被修剪，但是内部的标点应该完好，这里后面会trim成合理间距
    });

    it('应完美去除中英文中括号、中英文大括号以及星号包裹的内容', () => {
      const input = '【心里想：真麻烦】[叹气]*轻轻递过去一杯水* 给你，喝点水吧。';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('给你，喝点水吧。');
    });

    it('如果整行只有动作描写，净化后应完美剔除该空行', () => {
      const input = '（整理了一下衣角）\n你今天过得怎么样？\n（笑了一笑）';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('你今天过得怎么样？');
    });

    it('若无动作描写，应保留原汁原味的自然文本并修剪两端空格', () => {
      const input = '  微信聊天风格挺好的，谢谢你！  ';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('微信聊天风格挺好的，谢谢你！');
    });

    it('应完美过滤中文双引号外的小说叙述性动作并仅留台词', () => {
      const input = '看一眼门口走进来的人，手上正在写处方，笔没停。“找到这里不容易吧？先坐，病历本自己翻到最后。说吧，什么情况。”';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('找到这里不容易吧？先坐，病历本自己翻到最后。说吧，什么情况。');
    });

    it('应完美过滤英文双引号外的小说叙述性动作并仅留台词', () => {
      const input = 'Looking at you with a slight grin. "How have you been lately?"';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('How have you been lately?');
    });

    it('当输入全被洗空时应智能剥离括号作为台词发出去作为兜底', () => {
      const input = '（微微叹气，头也不抬地整理着柜台上的药盒）';
      const output = ContextAssembler.cleanDialogueActions(input);
      expect(output).toBe('微微叹气，头也不抬地整理着柜台上的药盒');
    });
  });
});

