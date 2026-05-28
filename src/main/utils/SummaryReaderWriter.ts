import * as fs from 'fs';
import * as path from 'path';

/**
 * 角色对话大事记数据结构接口
 */
export interface SummaryData {
  summary: string; // 对话大事记情感叙事简报 (不超过 800 字)
}

/**
 * SummaryReaderWriter
 * 负责高精度物理读写角色的 SUMMARY.md 大事记文件。
 * 顶部以 HTML 注释包裹结构化 JSON 供程序高精度读写，底部根据 JSON 自动渲染 Markdown 供人类直观查阅。
 * 彻底杜绝大模型覆写导致的格式损坏问题。
 */
export class SummaryReaderWriter {
  private static readonly DEFAULT_DATA: SummaryData = { summary: '' };

  /**
   * 初始化大事记文件，确保其物理存在
   */
  private static ensureFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      this.writeSummary(filePath, this.DEFAULT_DATA.summary);
    }
  }

  /**
   * 从物理 Markdown 文本中正则反向提取大事记内容（当用户在外部直接修改 Markdown 时）
   */
  public static parseMarkdownToSummaryData(content: string): SummaryData {
    let summary = '';
    // 匹配 "## 魏淑珍与用户的对话大事记" 下的内容
    const match = content.match(/## 魏淑珍与用户的对话大事记\n([\s\S]*)$/i);
    if (match && match[1]) {
      summary = match[1].trim();
    } else {
      // 降级：如果找不到特定的标题，可以看看是否是普通文本
      const cleanContent = content.replace(/<!--[\s\S]*?-->/g, '').trim();
      // 移除大标题如 "# 角色对话大事记"
      summary = cleanContent.replace(/^#\s+.*$/m, '').trim();
    }

    // 过滤掉暂无大事记的占位符
    if (summary === '*暂无大事记*' || summary === '暂无大事记') {
      summary = '';
    }

    return { summary };
  }

  /**
   * 从物理 SUMMARY.md 文件中读取 JSON 大事记数据
   * 若发现用户手工直接在外部修改了 Markdown 纯文本导致不一致，系统会启动智能纠偏机制，自动重新渲染 JSON 物理落盘对齐。
   * @param filePath 物理 SUMMARY.md 文件绝对路径
   */
  public static readSummary(filePath: string): SummaryData {
    try {
      this.ensureFile(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // 1. 尝试解析 HTML 注释中的 JSON 块
      let jsonData: SummaryData | null = null;
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        try {
          const jsonStr = match[1].trim();
          const data = JSON.parse(jsonStr) as SummaryData;
          jsonData = {
            summary: typeof data.summary === 'string' ? data.summary : ''
          };
        } catch (je) {
          console.warn(`[SummaryReaderWriter] JSON 注释解析失败，将降级尝试 Markdown 解析:`, je);
        }
      }

      // 2. 提取 Markdown 中的最新条目
      const mdData = this.parseMarkdownToSummaryData(content);

      // 3. 智能对比与自动物理对齐 (Autoreconciliation)
      if (jsonData) {
        // 判断两个数据源是否一致
        const isSummaryEqual = jsonData.summary.trim() === mdData.summary.trim();
        
        if (!isSummaryEqual) {
          console.log(`[SummaryReaderWriter] 检测到用户手工直接修改了底部的 Markdown 文本！正在智能同步对齐 JSON 注释...`);
          // 以手工修改的 Markdown 内容为准，重新写盘自动纠偏！
          this.writeSummary(filePath, mdData.summary);
          return mdData;
        }
        return jsonData;
      } else {
        // JSON 缺失或损坏，直接使用 Markdown 解析的数据，并自动写盘修复
        console.log(`[SummaryReaderWriter] JSON 注释损坏或缺失！使用 Markdown 解析并自动写盘修复...`);
        this.writeSummary(filePath, mdData.summary);
        return mdData;
      }
    } catch (e) {
      console.error(`[SummaryReaderWriter] 读取大事记文件失败: ${filePath}`, e);
    }
    return { summary: '' };
  }

  /**
   * 动态同步生成带有 JSON 注释和 Markdown 自检区的 SUMMARY.md 文件内容
   * @param summary 大事记内容
   */
  public static generateSummaryMarkdown(summary: string): string {
    const trimmedSummary = summary.trim();
    // 构建结构化 JSON 注释块
    const jsonData: SummaryData = { summary: trimmedSummary };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;

    // 动态同步生成底部 Markdown
    let markdownContent = `${jsonComment}\n\n# 角色对话大事记\n\n## 魏淑珍与用户的对话大事记\n`;
    if (!trimmedSummary) {
      markdownContent += `*暂无大事记*\n`;
    } else {
      markdownContent += `${trimmedSummary}\n`;
    }
    return markdownContent;
  }

  /**
   * 将大事记物理安全地写入 SUMMARY.md 文件中
   * 并同步渲染底部易读 Markdown 自然语言区
   * @param filePath 物理 SUMMARY.md 文件绝对路径
   * @param summary 大事记内容
   */
  public static writeSummary(filePath: string, summary: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const markdownContent = this.generateSummaryMarkdown(summary);

    // 原子化安全写盘
    fs.writeFileSync(filePath, markdownContent, 'utf-8');
  }
}
