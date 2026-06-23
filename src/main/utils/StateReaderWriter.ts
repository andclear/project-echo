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
   * 根据 Soul.md 包含的设定关键字，智能生成符合角色人设的初始钱包余额
   */
  private static generateInitialBalanceBySoul(filePath: string): number {
    const dir = path.dirname(filePath);
    const soulPath = path.join(dir, 'Soul.md');
    let economyLevel = 1; // 默认 1 档（自给自足）
    
    if (fs.existsSync(soulPath)) {
      try {
        const soulContent = fs.readFileSync(soulPath, 'utf8').toLowerCase();
        
        // 3 档：财务自由 / 霸道总裁 / 豪门
        if (
          soulContent.includes('总裁') || 
          soulContent.includes('千金') || 
          soulContent.includes('富豪') || 
          soulContent.includes('富有') || 
          soulContent.includes('神豪') || 
          soulContent.includes('财务自由') || 
          soulContent.includes('豪门')
        ) {
          economyLevel = 3;
        } 
        // 0 档：贫困窘迫 / 穷学生 / 流浪
        else if (
          soulContent.includes('贫困') || 
          soulContent.includes('窘迫') || 
          soulContent.includes('穷学生') || 
          soulContent.includes('流浪') || 
          soulContent.includes('负债') || 
          soulContent.includes('拮据')
        ) {
          economyLevel = 0;
        } 
        // 2 档：财务小康 / 白领 / 中产 / 店主
        else if (
          soulContent.includes('小康') || 
          soulContent.includes('中产') || 
          soulContent.includes('老板') || 
          soulContent.includes('富裕')
        ) {
          economyLevel = 2;
        }
      } catch (_) {}
    }
    
    // 根据经济等级生成初始随机余额
    switch (economyLevel) {
      case 0: // 3,000 ~ 8,000 元
        return Math.floor(3000 + Math.random() * 5000);
      case 2: // 200,000 ~ 300,000 元
        return Math.floor(200000 + Math.random() * 100000);
      case 3: // 1,000,000 ~ 1,500,000 元
        return Math.floor(1000000 + Math.random() * 500000);
      case 1: // 8,000 ~ 30,000 元
      default:
        return Math.floor(8000 + Math.random() * 22000);
    }
  }

  /**
   * 初始化 State.md 默认初始状态
   */
  public static getInitialState(): CharacterState {
    return {
      items: [
        { key: "intimacy",   label: "亲密度", value: 20, emoji: "❤️", min: 0, max: 100, type: 'number' },
        { key: "mood",       label: "心情",   value: 72, emoji: "😊", min: 0, max: 100, type: 'number' },
        { 
          key: "balance",    
          label: "钱包余额", 
          value: 5200.0, 
          emoji: "🪙", 
          min: 0, 
          type: 'number', 
          meaning: "该数字生命角色在虚拟世界的流动资产", 
          rule: "当用户给角色发红包、购买礼物时余额增加；角色自主发送红包时余额扣减" 
        },
        { key: "salary_base", label: "收支基数", value: 0.00, emoji: "💵", min: 0, type: 'number' },
        { key: "salary_period", label: "收支周期", value: "none", emoji: "⏱️", type: 'text' },
        { key: "salary_desc", label: "资金来源", value: "不定期自动增资", emoji: "📝", type: 'text' }
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
      // 根据 Soul 设定动态调整初始余额值
      const balanceItem = init.items.find(i => i.key === 'balance');
      if (balanceItem) {
        balanceItem.value = this.generateInitialBalanceBySoul(filePath);
      }
      this.writeState(filePath, init);
      return init;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      const match = raw.match(/<!--\s*([\s\S]*?)\s*-->/);
      if (match) {
        const state = JSON.parse(match[1]);

        // 极致无感向下兼容：物理过滤掉任何已有的 energy 属性项，实现彻底的精力值退役
        state.items = state.items.filter((i: any) => i.key !== 'energy');

        let needWrite = false;
        // 向后兼容补齐：若读取的 State 中缺少 mood 字段，自动为其补齐
        let hasMood = state.items.some((i: any) => i.key === 'mood');
        if (!hasMood) {
          state.items.push({ key: "mood", label: "心情", value: 72, emoji: "😊", min: 0, max: 100, type: 'number' });
          needWrite = true;
        }

        // 向后兼容补齐：若读取的 State 中缺少 balance 字段，自动为其补齐
        let hasBalance = state.items.some((i: any) => i.key === 'balance');
        if (!hasBalance) {
          state.items.push({
            key: "balance",
            label: "钱包余额",
            value: this.generateInitialBalanceBySoul(filePath),
            emoji: "🪙",
            min: 0,
            type: 'number',
            meaning: "该数字生命角色在虚拟世界的流动资产",
            rule: "当用户给角色发红包、购买礼物时余额增加；角色自主发送红包时余额扣减"
          });
          needWrite = true;
        }

        // 向后兼容补齐：若缺少 salary_base, salary_period, salary_desc 字段，自动为其补齐
        let hasSalaryBase = state.items.some((i: any) => i.key === 'salary_base');
        if (!hasSalaryBase) {
          state.items.push({ key: "salary_base", label: "收支基数", value: 0.00, emoji: "💵", min: 0, type: 'number' });
          needWrite = true;
        }
        let hasSalaryPeriod = state.items.some((i: any) => i.key === 'salary_period');
        if (!hasSalaryPeriod) {
          state.items.push({ key: "salary_period", label: "收支周期", value: "none", emoji: "⏱️", type: 'text' });
          needWrite = true;
        }
        let hasSalaryDesc = state.items.some((i: any) => i.key === 'salary_desc');
        if (!hasSalaryDesc) {
          state.items.push({ key: "salary_desc", label: "资金来源", value: "不定期自动增资", emoji: "📝", type: 'text' });
          needWrite = true;
        }

        if (needWrite) {
          this.writeState(filePath, state);
        }
        return state;
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
    if (item.key === 'balance') {
      return `- **${item.emoji} ${item.label} (${item.key})**：${item.value} (范围：${item.min ?? 0}-无上限)${meaningSuffix}${ruleSuffix}`;
    } else {
      return `- **${item.emoji} ${item.label} (${item.key})**：${item.value} (范围：${item.min ?? 0}-${item.max ?? 100})${meaningSuffix}${ruleSuffix}`;
    }
  }
}).join('\n')}

*最后更新时间：${state.last_updated}*`;
    let processedContent = mdContent;
    try {
      const folderName = path.basename(path.dirname(filePath));
      const { UserProfileReaderWriter } = require('./UserProfileReaderWriter');
      const userName = UserProfileReaderWriter.getUserNameByFolder(folderName);
      processedContent = UserProfileReaderWriter.replaceUserNameToPlaceholder(mdContent, userName);
    } catch (_) {}
    fs.writeFileSync(filePath, processedContent, 'utf8');
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
          const maxVal = item.max ?? (item.key === 'balance' ? 9999999999999 : 100);
          const currentVal = typeof item.value === 'number' ? item.value : (Number(item.value) || 0);
          
          let finalVal = currentVal;
          if (update.value !== undefined && update.value !== null && update.value !== '') {
            // 绝对值更新模式 (大模型直接指明当前绝对数值)
            const targetVal = Number(update.value);
            if (!isNaN(targetVal)) {
              finalVal = Math.max(minVal, Math.min(maxVal, targetVal));
            }
          } else if (update.delta !== undefined && update.delta !== null) {
            // 相对值更新模式 (大模型给出了 delta 增减值)
            const deltaVal = Number(update.delta);
            if (!isNaN(deltaVal)) {
              finalVal = Math.max(minVal, Math.min(maxVal, currentVal + deltaVal));
            }
          }
          
          if (item.key === 'balance') {
            item.value = Math.round(finalVal * 100) / 100;
          } else {
            item.value = finalVal;
          }
        }
      }
    }
    state.last_updated = new Date().toISOString().split('T')[0];
    this.writeState(filePath, state);
    return state;
  }
}
