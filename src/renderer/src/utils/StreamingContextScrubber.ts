/**
 * StreamingContextScrubber
 * 前端流式 Scrubber 过滤状态机，专门用于防范大模型可能吐出的后台记忆标签和思维链外泄。
 * 能够完美处理跨 Chunk 边界匹配的场景。
 */
export class StreamingContextScrubber {
  private buffer: string = '';
  private inTag: boolean = false;
  private currentTagBuffer: string = '';
  
  // 记录是否处于特定需要丢弃整个内容区间的 Span 中
  private inDiscardSpan: boolean = false;
  private discardTag: string = '';

  // 需要完全隐式丢弃其“内部所有内容”的标签集合
  private readonly discardSpanTags = new Set(['memory-context', 'system-note', 'thought']);

  /**
   * 接收增量流式 Chunk，经过状态机过滤后，返回安全无标签外泄的干净内容
   * @param chunk 增量数据块
   */
  public scrub(chunk: string): string {
    let output = '';
    
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];

      if (this.inDiscardSpan) {
        // 处于完全丢弃内容的 Span 中，累加字符以便检测结束标签
        this.buffer += char;
        
        // 查找结束标签，例如 "</memory-context>"
        const endTag = `</${this.discardTag}>`;
        if (this.buffer.endsWith(endTag)) {
          this.inDiscardSpan = false;
          this.discardTag = '';
          // 结束标签本身也要丢弃，清空临时 buffer
          this.buffer = '';
        }
        continue;
      }

      if (char === '<') {
        this.inTag = true;
        this.currentTagBuffer = '';
        continue;
      }

      if (this.inTag) {
        if (char === '>') {
          this.inTag = false;
          const fullTag = this.currentTagBuffer.trim();
          
          // 判定是否是开始丢弃内容标签，如 "memory-context"
          if (this.discardSpanTags.has(fullTag)) {
            this.inDiscardSpan = true;
            this.discardTag = fullTag;
            this.buffer = '';
          }
          // 过滤所有 XML/HTML 标签本身，故在此不输出任何标签字符
          continue;
        } else {
          this.currentTagBuffer += char;
          continue;
        }
      }

      // 普通聊天正文文本，安全放行
      output += char;
    }

    return output;
  }

  /**
   * 重置状态机，以便在开启新对话时完全初始化
   */
  public reset(): void {
    this.buffer = '';
    this.inTag = false;
    this.currentTagBuffer = '';
    this.inDiscardSpan = false;
    this.discardTag = '';
  }
}
