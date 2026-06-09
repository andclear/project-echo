/**
 * 级联反向流式拼合器：将数据库中连续的、时间相近的角色分段气泡，融合成单条高密度大消息
 */
export function mergeChatHistory(history: any[]): any[] {
  if (!history || history.length === 0) return [];

  const merged: any[] = [];
  let currentMsg: any = null;

  // 逆向排序为从旧到新进行合并
  const sorted = [...history].reverse();

  for (const msg of sorted) {
    if (!currentMsg) {
      currentMsg = { ...msg };
    } else if (
      currentMsg.role === msg.role &&
      msg.role === 'assistant' &&
      !msg.is_proactive &&         // 搭讪消息不参与合并（自身不被吸收进上一条）
      !currentMsg.is_proactive &&  // 上一条是搭讪消息时也不吸收后续消息
      (msg.timestamp - currentMsg.timestamp < 15000) // 15秒内连续的多气泡，判定为同一条消息的分段
    ) {
      // 融合成单条消息并换行拼接
      currentMsg.content = currentMsg.content + '\n' + msg.content;
      currentMsg.timestamp = msg.timestamp; // 保持最新时间戳
      if (msg.token_usage) {
        currentMsg.token_usage = (currentMsg.token_usage || 0) + msg.token_usage;
      }
    } else {
      merged.push(currentMsg);
      currentMsg = { ...msg };
    }
  }

  if (currentMsg) {
    merged.push(currentMsg);
  }

  // 反转回原汁原味的从新到旧的顺序
  return merged.reverse();
}

/**
 * 将消息内容格式化为适合外围大模型输入（如朋友圈、日程生成、记忆提取）的轻量纯文本，
 * 彻底过滤 Base64 图片大字段以及红包等特殊 JSON 格式，保障 Token 处于安全水位。
 */
export function cleanContentForLLM(content: string): string {
  if (!content) return '';
  const trimmed = content.trim();
  
  // 1. 自定义表情包净化：只提取 meaning 属性，剥离 Base64 大字段
  if (trimmed.startsWith('[wechat_custom_emoji]:')) {
    try {
      const jsonStr = trimmed.substring('[wechat_custom_emoji]:'.length);
      const emoji = JSON.parse(jsonStr);
      return `[表情: ${emoji.meaning || '自定义表情'}]`;
    } catch (_) {
      return '[表情]';
    }
  }
  
  // 2. 微信红包净化
  if (trimmed.startsWith('[wechat_red_packet]:')) {
    try {
      const jsonStr = trimmed.substring('[wechat_red_packet]:'.length);
      const rp = JSON.parse(jsonStr);
      return `[微信红包: ${rp.title || '发红包啦'} (${rp.amount || 0}元)]`;
    } catch (_) {
      return '[微信红包]';
    }
  }

  // 3. 绘图或图片消息净化：避免包含 Base64 的旧图片记录进入
  if (trimmed.startsWith('[wechat_image_media]:')) {
    const descMatch = trimmed.match(/\[image_desc:(.*?)\]/)
    if (descMatch && descMatch[1]) {
      return `[图片消息: ${descMatch[1]}]`
    }
    return '[图片消息]';
  }

  // 4. 日记卡片消息净化
  if (trimmed.startsWith('[character_diary]:')) {
    return '[日记分享]';
  }

  // 5. 单条消息字符保护（超过 3000 字强制截断，以防极端情况下用户塞入超长日志撑爆 API）
  if (trimmed.length > 3000) {
    return trimmed.substring(0, 3000) + '... (内容过长已被截断)';
  }

  return trimmed;
}

/**
 * 辅助函数：将图片协议内容解析为对 LLM 友好的描述信息（用于微信、生活引擎、记忆服务等）
 * 如果有图片描述，返回 “（用户发来了一张图片，画面里是：描述）”
 * 如果无图片描述，返回 “（用户发来了一张图片）”
 */
export function formatUserImageForLLM(content: string): string {
  if (!content) return '';
  if (content.startsWith('[wechat_image_media]:')) {
    const descMatch = content.match(/\[image_desc:(.*?)\]/);
    if (descMatch && descMatch[1]) {
      return `（用户发来了一张图片，画面里是：${descMatch[1]}）`;
    }
    return '（用户发来了一张图片）';
  }
  return '';
}

export function formatHistoryWithTimeGaps(history: any[]): any[] {
  if (!history || history.length === 0) return [];
  const result: any[] = [];
  for (let i = 0; i < history.length; i++) {
    const current = { ...history[i] };
    if (i > 0) {
      const prev = history[i - 1];
      if (prev.timestamp && current.timestamp) {
        const gapMs = current.timestamp - prev.timestamp;
        if (gapMs >= 2 * 60 * 60 * 1000) { // 大于等于 2 小时
          const gapHours = gapMs / (1000 * 60 * 60);
          let gapTag = '';
          if (gapHours >= 24) {
            const gapDays = Math.floor(gapHours / 24);
            gapTag = `[时空流逝：相隔 ${gapDays} 天后]\n`;
          } else {
            gapTag = `[时空流逝：相隔 ${Math.floor(gapHours)} 小时后]\n`;
          }
          current.content = gapTag + current.content;
        }
      }
    }
    result.push(current);
  }
  return result;
}

