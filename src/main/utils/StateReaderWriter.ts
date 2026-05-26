import * as path from 'path';
import * as fs from 'fs';

export interface StateItem {
  key: string;
  label: string;
  value: number | string;
  emoji: string;
  min?: number;
  max?: number;
  type?: 'number' | 'text';
  rule?: string;
  meaning?: string;
}

export interface CharacterState {
  items: StateItem[];
  last_updated: string;
}

export class StateReaderWriter {
  /**
   * 初始化 State.md 默认初始状态
   */
  public static getInitialState(): CharacterState {
    return {
      items: [
        { key: "intimacy",   label: "亲密度", value: 20, emoji: "❤️", min: 0, max: 100, type: 'number' },
        { key: "mood",       label: "心情",   value: 72, emoji: "😊", min: 0, max: 100, type: 'number' },
        { key: "energy",     label: "精力",   value: 45, emoji: "⚡", min: 0, max: 100, type: 'number' }
      ],
      last_updated: new Date().toISOString().split('T')[0]
    };
  }

  /**
   * 读取 State.md，若不存在则物理生成并返回初始值
   */
  public static readState(filePath: string): CharacterState {
    if (!fs.existsSync(filePath)) {
      const init = this.getInitialState();
      this.writeState(filePath, init);
      return init;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      const match = raw.match(/<!--\s*([\s\S]*?)\s*-->/);
      if (match) {
        return JSON.parse(match[1]);
      }
    } catch (_) {}
    return this.getInitialState();
  }

  /**
   * 写入 State.md
   */
  public static writeState(filePath: string, state: CharacterState): void {
    const jsonStr = JSON.stringify(state, null, 2);
    const mdContent = `<!--
${jsonStr}
-->
# 实时状态仪表盘

${state.items.map(item => {
  const ruleSuffix = item.rule ? ` (更新规则：${item.rule})` : '';
  const meaningSuffix = item.meaning ? ` (指标含义：${item.meaning})` : '';
  if (item.type === 'text') {
    return `- **${item.emoji} ${item.label} (${item.key})**：${item.value}${meaningSuffix}${ruleSuffix}`;
  } else {
    return `- **${item.emoji} ${item.label} (${item.key})**：${item.value} (范围：${item.min ?? 0}-${item.max ?? 100})${meaningSuffix}${ruleSuffix}`;
  }
}).join('\n')}

*最后更新时间：${state.last_updated}*`;
    fs.writeFileSync(filePath, mdContent, 'utf8');
  }

  /**
   * 累加 delta updates 并 clamp 写入 State.md
   */
  public static applyStateUpdates(filePath: string, updates: { key: string; delta?: number; value?: any }[]): CharacterState {
    const state = this.readState(filePath);
    for (const update of updates) {
      const item = state.items.find(i => i.key === update.key);
      if (item) {
        if (item.type === 'text') {
          // 纯文本状态栏更新：大模型可能会将新文本放入 update.value，也有可能误写在 update.delta 中
          const rawVal = update.value !== undefined ? update.value : update.delta;
          if (rawVal !== undefined && rawVal !== null) {
            item.value = String(rawVal).trim();
          }
        } else {
          // 数字型或未指定类型的数值型状态栏更新：支持绝对值覆盖与相对值累加增量两种模式
          const minVal = item.min ?? 0;
          const maxVal = item.max ?? 100;
          const currentVal = typeof item.value === 'number' ? item.value : (Number(item.value) || 0);
          
          if (update.value !== undefined && update.value !== null && update.value !== '') {
            // 绝对值更新模式 (大模型直接指明当前绝对数值)
            const targetVal = Number(update.value);
            if (!isNaN(targetVal)) {
              item.value = Math.max(minVal, Math.min(maxVal, targetVal));
            }
          } else if (update.delta !== undefined && update.delta !== null) {
            // 相对值更新模式 (大模型给出了 delta 增减值)
            const deltaVal = Number(update.delta);
            if (!isNaN(deltaVal)) {
              item.value = Math.max(minVal, Math.min(maxVal, currentVal + deltaVal));
            }
          }
        }
      }
    }
    state.last_updated = new Date().toISOString().split('T')[0];
    this.writeState(filePath, state);
    return state;
  }
}
