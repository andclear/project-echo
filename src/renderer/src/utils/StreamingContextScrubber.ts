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

  // 新增：中括号控制符丢弃状态
  private inBracket: boolean = false;
  private currentBracketBuffer: string = '';
  private inDiscardBracket: boolean = false;

  // 新增：提取模式与正文标签定位状态机
  private extractMode: boolean = false;
  private hasSeenContentStart: boolean = false;
  private hasSeenContentEnd: boolean = false;

  // 需要完全隐式丢弃其“内部所有内容”的标签集合
  private readonly discardSpanTags = new Set([
    'memory-context',
    'system-note',
    'thought',
    'image_prompt',
    'image_desc',
    'cot',
    'think',
    'thinking'
  ]);

  /**
   * 接收增量流式 Chunk，经过状态机过滤后，返回安全无标签外泄的干净内容
   * @param chunk 增量数据块
   */
  public scrub(chunk: string): string {
    let output = '';
    
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];

      // 1. XML 标签丢弃区间具有最高优先级，防止被中括号逻辑误拦截
      if (this.inDiscardSpan) {
        this.buffer += char;
        const endTag = `</${this.discardTag}>`;
        if (this.buffer.endsWith(endTag)) {
          this.inDiscardSpan = false;
          this.discardTag = '';
          this.buffer = '';
        }
        continue;
      }

      // 2. 处理中括号红包/转账控制符的跨 Chunk 流式丢弃
      if (this.inDiscardBracket) {
        if (char === ']') {
          this.inDiscardBracket = false;
          this.inBracket = false;
          this.currentBracketBuffer = '';
        }
        continue;
      }

      if (char === '[') {
        this.inBracket = true;
        this.currentBracketBuffer = '[';
        continue;
      }

      if (this.inBracket) {
        this.currentBracketBuffer += char;
        const lowerBuf = this.currentBracketBuffer.toLowerCase();
        
        // 如果检测到包含发红包、收红包、退红包等系统控制符前缀，立即切入丢弃状态，吃掉后续字符
        if (
          lowerBuf.startsWith('[send_red_packet') ||
          lowerBuf.startsWith('[receive_red_packet') ||
          lowerBuf.startsWith('[return_red_packet')
        ) {
          this.inDiscardBracket = true;
          continue;
        }

        if (char === ']') {
          this.inBracket = false;
          // 若不是系统控制符，说明是常规的小说动作描写中括号（如 [笑]），直接安全放行输出
          output += this.currentBracketBuffer;
          this.currentBracketBuffer = '';
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
          
          // 🚀 物理提取特定正文标签定位
          if (fullTag === 'content') {
            this.hasSeenContentStart = true;
            continue;
          }
          if (fullTag === '/content') {
            this.hasSeenContentEnd = true;
            continue;
          }

          if (this.discardSpanTags.has(fullTag)) {
            this.inDiscardSpan = true;
            this.discardTag = fullTag;
            this.buffer = '';
          }
          continue;
        } else {
          this.currentTagBuffer += char;
          continue;
        }
      }

      // 普通聊天正文文本，安全放行
      if (this.extractMode) {
        // 如果开启了特定内容提取模式，仅在成功定位起始标签且未遭遇结束标签时才允许输出
        if (this.hasSeenContentStart && !this.hasSeenContentEnd) {
          output += char;
        }
      } else {
        output += char;
      }
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

    this.inBracket = false;
    this.currentBracketBuffer = '';
    this.inDiscardBracket = false;

    // 🚀 重置提取模式状态
    this.extractMode = false;
    this.hasSeenContentStart = false;
    this.hasSeenContentEnd = false;
  }

  /**
   * 设置提取模式
   */
  public setExtractMode(enabled: boolean): void {
    this.extractMode = enabled;
  }
}
