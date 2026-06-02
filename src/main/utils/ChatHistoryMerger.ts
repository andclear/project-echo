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
