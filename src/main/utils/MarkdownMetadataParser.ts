/**
 * 从 Memory.md 的 Markdown 正文中解析出结构化的 stm (短期记忆) 和 ltm (长期记忆)
 * 兼容用户手动编辑时可能留下的各种不规范空格或中英文冒号等。
 *
 * @param markdown 前端传来的纯 Markdown 文本内容
 */
export function parseMemoryMd(markdown: string): { stm: string[]; ltm: Record<string, string> } {
  const stm: string[] = [];
  const ltm: Record<string, string> = {};

  // 辅助函数：提取 Markdown 中指定 ## 标题下的所有非空行内容
  const getSectionLines = (title: string): string[] => {
    const lines = markdown.split(/\r?\n/);
    let inSection = false;
    const sectionLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
        if (inSection) {
          break; // 进入了下一个章节，停止收集
        }
        if (trimmed.includes(title)) {
          inSection = true;
        }
        continue;
      }
      if (inSection && trimmed !== '') {
        sectionLines.push(trimmed);
      }
    }
    return sectionLines;
  };

  // 1. 解析短期记忆 (短期记忆为简单的无序列表 "- xxx")
  const stmLines = getSectionLines('短期记忆');
  for (const line of stmLines) {
    if (line.startsWith('- ')) {
      const val = line.substring(2).trim();
      if (val) stm.push(val);
    }
  }

  // 2. 解析长期记忆 (长期记忆为 "- **键**：值" 或 "- 键: 值" 格式的列表)
  const ltmLines = getSectionLines('长期记忆');
  for (const line of ltmLines) {
    if (line.startsWith('- ')) {
      const rawContent = line.substring(2).trim();
      // 支持中文冒号“：”或英文冒号“:”分隔
      const colonIdx = rawContent.indexOf('：') !== -1 ? rawContent.indexOf('：') : rawContent.indexOf(':');
      if (colonIdx !== -1) {
        let key = rawContent.substring(0, colonIdx).trim();
        const value = rawContent.substring(colonIdx + 1).trim();
        // 剥离 Markdown 粗体标记 **
        if (key.startsWith('**') && key.endsWith('**')) {
          key = key.slice(2, -2).trim();
        }
        if (key && value) {
          ltm[key] = value;
        }
      }
    }
  }

  return { stm, ltm };
}

/**
 * 从 USER.md 的 Markdown 正文中解析出结构化的专属画像事实列表 (character_specific_facts)
 *
 * @param markdown 前端传来的纯 Markdown 文本内容
 */
export function parseUserMd(markdown: string): string[] {
  const facts: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      if (inSection) break; // 进入下一个章节，结束提取
      if (trimmed.includes('专属画像事实') || trimmed.includes('Facts')) {
        inSection = true;
      }
      continue;
    }
    if (inSection && trimmed.startsWith('- ')) {
      const val = trimmed.substring(2).trim();
      if (val) facts.push(val);
    }
  }
  return facts;
}
