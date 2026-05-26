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
   * 从物理 Memory.md 文件中读取 JSON 记忆数据
   * @param filePath 物理 Memory.md 文件绝对路径
   */
  public static readMemory(filePath: string): MemoryData {
    try {
      this.ensureFile(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // 正则匹配 <!-- 与 --> 之间的 JSON 块
      const match = content.match(/<!--([\s\S]*?)-->/);
      if (match && match[1]) {
        const jsonStr = match[1].trim();
        const data = JSON.parse(jsonStr) as MemoryData;
        return {
          stm: Array.isArray(data.stm) ? data.stm : [],
          ltm: typeof data.ltm === 'object' && data.ltm !== null ? data.ltm : {}
        };
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
  public static writeMemory(filePath: string, stm: string[], ltm: Record<string, string>): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

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
    memory.stm.push(fact.trim());
    
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
