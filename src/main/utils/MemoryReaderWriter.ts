import * as fs from 'fs';
import * as path from 'path';

/**
 * 角色记忆数据结构接口
 */
export interface MemoryData {
  stm: string[]; // 短期记忆滚动数组 (Max 50)
  ltm: Record<string, string>; // 长期记忆持久化键值对
}

/**
 * MemoryReaderWriter
 * 负责高精度物理读写角色的 Memory.md 记忆文件。
 * 顶部以 HTML 注释包裹结构化 JSON 供程序高精度读写，底部根据 JSON 自动渲染 Markdown 供人类直观查阅。
 * 彻底杜绝大模型覆写导致的格式损坏问题。
 */
export class MemoryReaderWriter {
  private static readonly DEFAULT_DATA: MemoryData = { stm: [], ltm: {} };
  private static readonly MAX_STM_SIZE = 50;

  /**
   * 初始化记忆文件，确保其物理存在
   */
  private static ensureFile(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      this.writeMemory(filePath, this.DEFAULT_DATA.stm, this.DEFAULT_DATA.ltm);
    }
  }

  /**
   * 从物理 Markdown 文本中正则反向提取短期与长期记忆条目（当用户在外部直接修改 Markdown 时）
   */
  public static parseMarkdownToMemoryData(content: string): MemoryData {
    const stm: string[] = [];
    const ltm: Record<string, string> = {};

    // 1. 提取 STM (支持中文与英文标题的粗粒度检索)
    const stmMatch = content.match(/## 短期记忆 \(STM\)([\s\S]*?)(## 长期记忆|$)/i);
    if (stmMatch && stmMatch[1]) {
      const lines = stmMatch[1].split('\n');
      for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.startsWith('-')) {
          const fact = cleanLine.substring(1).trim();
          if (fact && !fact.includes('暂无短期记忆') && !fact.includes('暂无长期记忆')) {
            stm.push(fact);
          }
        }
      }
    }

    // 2. 提取 LTM
    const ltmMatch = content.match(/## 长期记忆 \(LTM\)([\s\S]*)$/i);
    if (ltmMatch && ltmMatch[1]) {
      const lines = ltmMatch[1].split('\n');
      for (const line of lines) {
        const cleanLine = line.trim();
        if (cleanLine.startsWith('-')) {
          // 匹配 - **键**：值 或 - **键**: 值
          const itemMatch = cleanLine.match(/^-\s*\*\*(.*?)\*\*[:：](.*)$/);
          if (itemMatch) {
            const key = itemMatch[1].trim();
            const val = itemMatch[2].trim();
            if (key && val) {
              ltm[key] = val;
            }
          }
        }
      }
    }

    return { stm, ltm };
  }

  /**
   * 从物理 Memory.md 文件中读取 JSON 记忆数据
   * 若发现用户手工直接在外部修改了 Markdown 纯文本导致不一致，系统会启动智能纠偏机制，自动重新渲染 JSON 物理落盘对齐。
   * @param filePath 物理 Memory.md 文件绝对路径
   */
  public static readMemory(filePath: string): MemoryData {
    try {
      this.ensureFile(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // 1. 尝试解析 HTML 注释中的 JSON 块
      let jsonData: MemoryData | null = null;
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        try {
          const jsonStr = match[1].trim();
          const data = JSON.parse(jsonStr) as MemoryData;
          jsonData = {
            stm: Array.isArray(data.stm) ? data.stm : [],
            ltm: typeof data.ltm === 'object' && data.ltm !== null ? data.ltm : {}
          };
        } catch (je) {
          console.warn(`[MemoryReaderWriter] JSON 注释解析失败，将降级尝试 Markdown 解析:`, je);
        }
      }

      // 2. 提取 Markdown 中的最新条目
      const mdData = this.parseMarkdownToMemoryData(content);

      // 3. 智能对比与自动物理对齐 (Autoreconciliation)
      if (jsonData) {
        // 判断两个数据源是否一致
        const isStmEqual = JSON.stringify(jsonData.stm) === JSON.stringify(mdData.stm);
        const isLtmEqual = JSON.stringify(jsonData.ltm) === JSON.stringify(mdData.ltm);
        
        if (!isStmEqual || !isLtmEqual) {
          console.log(`[MemoryReaderWriter] 检测到用户手工直接修改了底部的 Markdown 文本！正在智能同步对齐 JSON 注释...`);
          // 以手工修改的 Markdown 内容为准，重新写盘自动纠偏！
          this.writeMemory(filePath, mdData.stm, mdData.ltm);
          return mdData;
        }
        return jsonData;
      } else {
        // JSON 缺失或损坏，直接使用 Markdown 解析的数据，并自动写盘修复
        console.log(`[MemoryReaderWriter] JSON 注释损坏或缺失！使用 Markdown 解析并自动写盘修复...`);
        this.writeMemory(filePath, mdData.stm, mdData.ltm);
        return mdData;
      }
    } catch (e) {
      console.error(`[MemoryReaderWriter] 读取记忆文件失败: ${filePath}`, e);
    }
    return { stm: [], ltm: {} };
  }

  /**
   * 将短期与长期记忆物理安全地写入 Memory.md 文件中
   * 并同步渲染底部易读 Markdown 自然语言区
   * @param filePath 物理 Memory.md 文件绝对路径
   * @param stm 短期记忆数组
   * @param ltm 长期记忆键值对
   */
  /**
   * 动态同步生成带有 JSON 注释和 Markdown 自检区的 Memory.md 文件内容
   * @param stm 短期记忆数组
   * @param ltm 长期记忆键值对
   */
  public static generateMemoryMarkdown(stm: string[], ltm: Record<string, string>): string {
    // 在写入前，对短期记忆进行溢出切片保护
    const boundedSTM = stm.slice(-this.MAX_STM_SIZE);
    
    // 构建结构化 JSON 注释块
    const jsonData: MemoryData = { stm: boundedSTM, ltm };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;

    // 动态同步生成底部 Markdown
    let markdownContent = `${jsonComment}\n\n# 角色记忆存储区\n\n## 短期记忆 (STM)\n`;
    if (boundedSTM.length === 0) {
      markdownContent += `*暂无短期记忆*\n`;
    } else {
      boundedSTM.forEach((fact) => {
        markdownContent += `- ${fact}\n`;
      });
    }

    markdownContent += `\n## 长期记忆 (LTM)\n`;
    const keys = Object.keys(ltm);
    if (keys.length === 0) {
      markdownContent += `*暂无长期记忆*\n`;
    } else {
      keys.forEach((key) => {
        markdownContent += `- **${key}**：${ltm[key]}\n`;
      });
    }
    return markdownContent;
  }

  /**
   * 将短期与长期记忆物理安全地写入 Memory.md 文件中
   * 并同步渲染底部易读 Markdown 自然语言区
   * @param filePath 物理 Memory.md 文件绝对路径
   * @param stm 短期记忆数组
   * @param ltm 长期记忆键值对
   */
  public static writeMemory(filePath: string, stm: string[], ltm: Record<string, string>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const markdownContent = this.generateMemoryMarkdown(stm, ltm);

    // 原子化安全写盘
    fs.writeFileSync(filePath, markdownContent, 'utf-8');
  }

  /**
   * 向短期记忆 (STM) 队列追加一条陈述性偏好，并实现 50 条滚动裁剪 (FIFO)
   * @param filePath 物理 Memory.md 绝对路径
   * @param fact 陈述句事实
   */
  public static pushSTM(filePath: string, fact: string): void {
    const memory = this.readMemory(filePath);
    // 自动附加写入日期前缀，让 AI 读取时能感知该条记忆的时效性，避免相对时间词（明天/下周）永久冻结
    const now = new Date();
    const dateTag = `[${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}]`;
    memory.stm.push(`${dateTag} ${fact.trim()}`);
    
    // 如果超过 50 条上限，截取最新 50 条 (FIFO)
    if (memory.stm.length > this.MAX_STM_SIZE) {
      memory.stm = memory.stm.slice(-this.MAX_STM_SIZE);
    }
    
    this.writeMemory(filePath, memory.stm, memory.ltm);
  }

  /**
   * 更新或增加一条长期记忆 (LTM) 键值对，并同步落盘
   * @param filePath 物理 Memory.md 绝对路径
   * @param key 长期偏好键
   * @param val 长期偏好值
   */
  public static updateLTM(filePath: string, key: string, val: string): void {
    const memory = this.readMemory(filePath);
    memory.ltm[key.trim()] = val.trim();
    this.writeMemory(filePath, memory.stm, memory.ltm);
  }
}
