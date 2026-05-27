import { ChatChunk } from '../models/ModelAdapter';

/**
 * StreamSplitController
 * 负责主进程的流式响应标点断句与专属技能调用 [CALL_SKILL: ...] 的精准拦截过滤。
 */
export class StreamSplitController {
  private buffer: string = '';
  private isSkillCollecting: boolean = false;
  private skillBuffer: string = '';

  // 标点断句集合，支持中文和英文的句末标点以及换行
  private readonly splitPuncts = new Set(['。', '！', '？', '\n', '~', '!', '?']);

  /**
   * 逐个处理大模型流式输出的 chunk 并进行切片和拦截
   * @param chunk 大模型响应块
   * @param onSentence 成功断句时的回调（已自动过滤掉技能调用标识）
   * @returns 截获到的完整技能调用指令列表，例如 ["play-music {\"song\": \"...\"}"]
   */
  public processChunk(
    chunk: string,
    onSentence: (sentence: string) => void
  ): string[] {
    const extractedSkills: string[] = [];
    
    // 遍历当前 chunk 的每一个字符
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i];

      // 1. 检测技能调用起始标识 [CALL_SKILL:
      if (!this.isSkillCollecting) {
        this.buffer += char;
        
        // 检查缓冲区尾部是否匹配 "[CALL_SKILL:"
        if (this.buffer.endsWith('[CALL_SKILL:')) {
          this.isSkillCollecting = true;
          this.skillBuffer = '';
          // 从缓冲区中移除 "[CALL_SKILL:"，防止其污染聊天气泡
          this.buffer = this.buffer.slice(0, -'[CALL_SKILL:'.length);
        }
      } else {
        // 2. 处于技能指令收集状态
        if (char === ']') {
          // 收集结束，提取出完整的技能指令
          this.isSkillCollecting = false;
          extractedSkills.push(this.skillBuffer.trim());
          this.skillBuffer = '';
        } else {
          this.skillBuffer += char;
        }
      }
    }

    // 3. 对普通缓冲区 buffer 进行标点断句处理
    let searchIdx = 0;
    while (searchIdx < this.buffer.length) {
      const char = this.buffer[searchIdx];
      if (this.splitPuncts.has(char)) {
        // 截断出完整的句子（包含该标点本身）
        const sentence = this.buffer.slice(0, searchIdx + 1);
        
        // 🚀 核心优化：保留可能存在的换行符，不要粗暴地使用 trim() 将其剥离，否则流式渲染时换行符会彻底丢失！
        // 仅 trim 掉首尾的普通水平空白字符，若包含换行符则予以高保真显式保留传输
        let processed = sentence.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
        
        if (processed) {
          onSentence(processed);
        }
        // 刷新缓冲区
        this.buffer = this.buffer.slice(searchIdx + 1);
        searchIdx = 0; // 重置索引重新扫描
      } else {
        searchIdx++;
      }
    }

    return extractedSkills;
  }

  /**
   * 当流式对话完全结束时，清空并推送缓冲区中剩余的内容
   * @param onSentence 句子推送回调
   */
  public flush(onSentence: (sentence: string) => void): void {
    let processed = this.buffer.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    if (processed) {
      onSentence(processed);
    }
    this.buffer = '';
    this.isSkillCollecting = false;
    this.skillBuffer = '';
  }
}
