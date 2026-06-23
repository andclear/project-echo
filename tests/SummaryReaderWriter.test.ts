import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SummaryReaderWriter } from '../src/main/utils/SummaryReaderWriter';

describe('SummaryReaderWriter 单元测试', () => {
  const testDir = path.join(__dirname, '../tests_temp_summary');
  const summaryFile = path.join(testDir, 'SUMMARY.md');

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
    expect(fs.existsSync(summaryFile)).toBe(false);
    
    const data = SummaryReaderWriter.readSummary(summaryFile);
    
    // 验证物理初始化
    expect(fs.existsSync(summaryFile)).toBe(true);
    expect(data.summary).toEqual('');

    const fileContent = fs.readFileSync(summaryFile, 'utf-8');
    expect(fileContent).toContain('<!--');
    expect(fileContent).toContain('-->');
    expect(fileContent).toContain('# 角色对话大事记');
    expect(fileContent).toContain('## 魏淑珍与用户的对话大事记');
    expect(fileContent).toContain('*暂无大事记*');
  });

  it('2. 能够正确读取和写入大事记，并同步动态渲染 Markdown 自然语言区', () => {
    const summary = '{{user}} 与 {{char}} 在相处中逐渐建立了深厚的友谊。{{user}} 分享了关于去深圳出差的事情，{{char}} 对此感到由衷的高兴。';

    SummaryReaderWriter.writeSummary(summaryFile, summary);

    // 重新读取并验证
    const data = SummaryReaderWriter.readSummary(summaryFile);
    expect(data.summary).toEqual(summary);

    // 物理文本验证
    const rawText = fs.readFileSync(summaryFile, 'utf-8');
    expect(rawText).toContain('<!--');
    expect(rawText).toContain('-->');
    expect(rawText).toContain('## 魏淑珍与用户的对话大事记');
    expect(rawText).toContain(summary);
  });

  it('3. 用户直接手工修改底部 Markdown 文本时，读取时应当能够智能检测、以降级 Markdown 为准，并全自动写盘对齐纠偏 JSON 块', () => {
    const initialSummary = '原有的大事记内容';

    // 1. 正常写入物理文件
    SummaryReaderWriter.writeSummary(summaryFile, initialSummary);

    // 2. 模拟用户手工在外部修改底部的 Markdown 内容
    const customContent = `<!--
{
  "summary": "原有的大事记内容"
}
-->

# 角色对话大事记

## 魏淑珍与用户的对话大事记
这是手工修改后的最新大事记内容，{{user}} 表达了对 {{char}} 的关心。
`;
    fs.writeFileSync(summaryFile, customContent, 'utf-8');

    // 3. 调用 readSummary，应该能检测到不一致，并以 Markdown 内容为最高优先准则读取
    const data = SummaryReaderWriter.readSummary(summaryFile);

    // 验证读取出来的是否是手工改动后的 Markdown 记忆，而不是旧的 JSON
    expect(data.summary).toEqual('这是手工修改后的最新大事记内容，{{user}} 表达了对 {{char}} 的关心。');

    // 4. 验证物理文件此时是否已经实现了“智能对齐”，上面的 JSON 注释应该已经自动自愈成了最新的内容！
    const selfHealedContent = fs.readFileSync(summaryFile, 'utf-8');
    expect(selfHealedContent).toContain('"summary": "这是手工修改后的最新大事记内容，{{user}} 表达了对 {{char}} 的关心。"');
  });
});
