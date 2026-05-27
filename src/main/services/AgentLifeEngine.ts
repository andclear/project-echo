import cron from 'node-cron';
import { app, Notification, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { SocialMediaService } from './SocialMediaService';
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter';
import { NovelAiService } from './NovelAiService';

export interface WakeContext {
  wakeAgent: boolean;
  reason: string;
  triggerStrength: 'strong' | 'weak';
  triggerEvent?: {
    type: 'missed_user' | 'good_morning' | 'anniversary' | 'schedule_event' | 'random_drift';
    detail: string;
  };
}

/**
 * AgentLifeEngine
 * 常驻生命引擎，负责周期性 node-cron 后台定时调度，
 * 驱动 AI 角色的主动思考（日记写入）与深夜系统弹窗主动搭讪。
 */
export class AgentLifeEngine {
  private cronJob: cron.ScheduledTask | null = null;
  private storageManager: CharacterStorageManager;

  constructor() {
    this.storageManager = new CharacterStorageManager();
  }

  /**
   * 启动生命引擎定时调度器
   * @param cronExpression 定时 cron 表达式（默认每 30 分钟）
   */
  public start(cronExpression: string = '*/30 * * * *'): void {
    console.log(`[AgentLifeEngine] 生命引擎常驻 Loop 顺利启动，排程计划为: ${cronExpression}`);
    
    // 定时器周期触发
    this.cronJob = cron.schedule(cronExpression, async () => {
      console.log('[AgentLifeEngine] 定时轮询时间到，触发思考与唤醒预检...');
      await this.tick();
    });
  }

  /**
   * 停止生命引擎调度器
   */
  public stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  /**
   * 重启生命引擎
   * @param cronExpression 新的定时表达式
   */
  public restart(cronExpression: string): void {
    console.log(`[AgentLifeEngine] 正在重启生命引擎，新排程计划为: ${cronExpression}`);
    this.stop();
    this.start(cronExpression);
  }

  /**
   * 单次生命周期自省驱动函数
   * 采用随机错峰延迟策略：每个角色的行为在 0~8 分钟内随机错开，
   * 避免应用启动或 cron 触发时所有角色同时轰炸用户。
   */
  public async tick(): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    
    // 全局打扰度限制：整个 tick 轮次中，最多只允许一个角色向用户发送主动搭讪消息
    // 使用 Set 记录本轮已发搭讪的角色
    let hasSentActiveMessageThisTick = false;

    // 为每个角色分配随机错开延迟（0 ~ 8 分钟），彻底打散集中触发
    const charDelays = characters.map((char, idx) => ({
      char,
      delay: idx === 0 ? 0 : Math.floor(Math.random() * 8 * 60 * 1000) // 第1个立即，其余随机错开
    }));

    // 收集当前轮次所有角色的行为 Promise（各自在自己的延迟后执行）
    const behaviorPromises = charDelays.map(({ char, delay }) =>
      new Promise<void>(resolve => {
        setTimeout(async () => {
          try {
            const charId = char.id;

            // 1. Wake Gate 0-Token 本地唤醒门控预检
            const wakeResult = this.checkWakeGate(charId);

            if (!wakeResult.wakeAgent) {
              console.log(`[AgentLifeEngine] 0-Token 唤醒门控关闭 [wakeAgent=false]。角色 ${char.name} 保持静默，费用为 0。原因: ${wakeResult.reason}`);
              resolve();
              return;
            }

            console.log(`[AgentLifeEngine] 门控开启！[wakeAgent=true]。角色 ${char.name} 唤醒。强度: ${wakeResult.triggerStrength}，原因: ${wakeResult.reason}`);

            // 2. 获取大模型配置
            const settingsStr = db.getSetting('model_config');
            if (!settingsStr) {
              console.warn('[AgentLifeEngine] 未配置全局大模型参数，门控强行关闭。');
              resolve();
              return;
            }

            const modelConfig = JSON.parse(settingsStr);
            const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary);

            // 全局打扰限制：本轮若已有角色发搭讪则剥离当前角色的主动消息意图
            let finalizedWakeResult = { ...wakeResult };
            if (wakeResult.triggerEvent) {
              if (hasSentActiveMessageThisTick) {
                console.log(`[AgentLifeEngine] 全局打扰限制：本日轮中已有其他角色发起搭讪，拦截 ${char.name} 的主动搭讪。`);
                finalizedWakeResult.triggerEvent = undefined;
              } else {
                hasSentActiveMessageThisTick = true;
              }
            }

            // 3. 执行思考与可能的主动对话生成
            await this.generateActiveBehavior(char, modelAdapter, finalizedWakeResult);
          } catch (err) {
            console.error(`[AgentLifeEngine] 驱动角色 ${char.name} 思考循环时发生异常:`, err);
          }
          resolve();
        }, delay);
      })
    );

    // 等待所有角色行为完成（各自延迟后异步执行）
    await Promise.all(behaviorPromises);

    // 4. 后台朋友圈与论坛静默发动态发帖评估 (0-Token 防防刷冷却)
    // 错开 10~20 分钟后随机触发，与角色个人行为进一步解耦
    const socialDelay = 10 * 60 * 1000 + Math.floor(Math.random() * 10 * 60 * 1000);
    setTimeout(async () => {
      try {
        const settingsStr = db.getSetting('model_config');
        if (settingsStr) {
          const modelConfig = JSON.parse(settingsStr);
          const modelAdapter = new ModelAdapter(modelConfig.primary, modelConfig.secondary);
          const socialMedia = new SocialMediaService();
          await socialMedia.silentGenerateAll(modelAdapter);
        }
      } catch (socialErr) {
        console.error('[AgentLifeEngine] 驱动后台朋友圈和论坛静默生成发生异常:', socialErr);
      }
    }, socialDelay);
  }

  /**
   * 0-Token 本地快速唤醒门控预检
   * @param characterId 角色唯一 ID
   */
  public checkWakeGate(characterId: string, testNowDate?: Date): WakeContext {
    const db = getDatabaseService();
    const now = testNowDate || new Date();
    
    // 0. 午夜静默期免打扰拦截 (0点-7点)
    // 物理拦截任何后台自省写日记及主动搭讪，确保用户在深夜及清晨休息时不受任何打扰
    const currentHour = now.getHours();
    if (currentHour >= 0 && currentHour < 7) {
      return { wakeAgent: false, reason: '当前处于午夜静默免打扰时段 (00:00-07:00)，物理拦截所有后台自省写日记与主动对话。🐾', triggerStrength: 'weak' };
    }

    // 1. 消息免打扰拦截
    const metaStr = db.getSetting(`meta_${characterId}`);
    if (metaStr) {
      try {
        const meta = JSON.parse(metaStr);
        if (meta.muted) {
          return { wakeAgent: false, reason: '当前角色已被设置为“消息免打扰”，保持完全静默。', triggerStrength: 'weak' };
        }
      } catch (_) {}
    }

    // 2. 0-Token 无交互历史完全静默规则
    const history = db.getChatHistory(characterId, 1);
    if (history.length === 0) {
      return { wakeAgent: false, reason: '该角色从未与用户发生过聊天互动，保持完全静默。🐾', triggerStrength: 'weak' };
    }

    // 2.1 对话期间20分钟静默防打扰：若 20 分钟内与用户发生过任何对话，则绝对禁止主动搭讪
    const lastMsgTime = history[0].timestamp;
    const msPassedSinceLastMsg = now.getTime() - lastMsgTime;
    if (msPassedSinceLastMsg < 20 * 60 * 1000) {
      return {
        wakeAgent: false,
        reason: `用户在 20 分钟内与该角色有过对话交流（上次对话仅在 ${(msPassedSinceLastMsg / (1000 * 60)).toFixed(1)} 分钟前），触发免打扰保护拦截搭讪。🐾`,
        triggerStrength: 'weak'
      };
    }

    // 2.2 上次搭讪未回复保护：若最近一条消息是角色自己发送的（且非手账日记卡片），说明用户尚未回复。
    // 在 48 小时之内，我们坚守“矜持与静默”边界，绝对不连续发送第二条主动消息，彻底杜绝短时间内的追问轰炸与大模型无反馈上下文的幻觉复述。
    if (history[0].role === 'assistant') {
      const contentStr = (history[0].content || '').trim();
      const isDiary = contentStr.startsWith('[character_diary]:');
      if (!isDiary && msPassedSinceLastMsg < 48 * 60 * 60 * 1000) {
        return {
          wakeAgent: false,
          reason: `上一次主动消息后用户尚未回复（已等待 ${(msPassedSinceLastMsg / (1000 * 60 * 60)).toFixed(1)} 小时，未达到破冰阈值 48 小时），保持矜持静默。🐾`,
          triggerStrength: 'weak'
        };
      }
    }

    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) {
      return { wakeAgent: false, reason: '未找到该角色元数据。', triggerStrength: 'weak' };
    }
    const folderName = char.folder_name;

    // 2.5 全局主动搭讪频率控制：每天最多可以触发 3 次，每轮搭讪触发后必须相隔 2 小时才允许下一次搭讪
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const activeTodayDate = db.getSetting(`active_today_date_${characterId}`);
    let activeCountToday = 0;
    if (activeTodayDate !== todayStr) {
      db.setSetting(`active_today_date_${characterId}`, todayStr);
      db.setSetting(`active_count_today_${characterId}`, '0');
    } else {
      const activeCountStr = db.getSetting(`active_count_today_${characterId}`);
      activeCountToday = activeCountStr ? parseInt(activeCountStr) : 0;
    }

    const lastActiveTsStr = db.getSetting(`active_last_timestamp_${characterId}`);
    const lastActiveTs = lastActiveTsStr ? parseInt(lastActiveTsStr) : 0;
    const msPassedSinceLastActive = now.getTime() - lastActiveTs;
    const isCooldown = msPassedSinceLastActive < 2 * 60 * 60 * 1000;
    const allowActiveDialog = (activeCountToday < 3) && !isCooldown;

    // 3. 检查强触发事件之：久未联系 (>= 72 小时)
    const hoursPassed = (now.getTime() - lastMsgTime) / (1000 * 60 * 60);
    if (hoursPassed >= 72 && allowActiveDialog) {
      return {
        wakeAgent: true,
        reason: `用户已离线 ${hoursPassed.toFixed(1)} 小时 (达到强触发阈值 72 小时，今日第 ${activeCountToday + 1} 次)。`,
        triggerStrength: 'strong',
        triggerEvent: {
          type: 'missed_user',
          detail: `触发原因：用户已有 ${hoursPassed.toFixed(0)} 小时未联系你，你开始有些想念他了。`
        }
      };
    }

    // 4. 检查强触发事件之：今日日程事件
    const scheduleEvent = this.getTodayScheduleEvent(folderName, now);
    if (scheduleEvent && allowActiveDialog) {
      return {
        wakeAgent: true,
        reason: `今日有重要日程：${scheduleEvent} (达到强触发阈值，今日第 ${activeCountToday + 1} 次)。`,
        triggerStrength: 'strong',
        triggerEvent: {
          type: 'schedule_event',
          detail: `触发原因：今天你的日程里有一件事——“${scheduleEvent}”，你心里对此有些想法，决定跟用户聊聊。`
        }
      };
    }

    // 5. 检查弱触发事件之：纪念日/特殊日期
    const anniversary = this.getAnniversaryEvent(folderName, now);
    if (anniversary && allowActiveDialog) {
      return {
        wakeAgent: true,
        reason: `今天是特殊纪念日：${anniversary} (弱触发，今日第 ${activeCountToday + 1} 次)。`,
        triggerStrength: 'weak',
        triggerEvent: {
          type: 'anniversary',
          detail: `触发原因：今天是特殊的日子——“${anniversary}”，你心中有些感慨想表达。`
        }
      };
    }

    // 6. 检查弱触发事件之：早晨问候
    const hour = now.getHours();
    const isMorning = hour >= 7 && hour <= 9;
    if (isMorning && hoursPassed <= 36 && allowActiveDialog) {
      return {
        wakeAgent: true,
        reason: `清晨问候时段 (07:00-09:00，弱触发，今日第 ${activeCountToday + 1} 次)。`,
        triggerStrength: 'weak',
        triggerEvent: {
          type: 'good_morning',
          detail: `触发原因：清晨微光初露，新的一天开始了，你醒来想跟用户道声早安。`
        }
      };
    }

    // 7. 检查弱触发事件之：随机漂移 (20% 概率)
    if (Math.random() < 0.2 && allowActiveDialog) {
      return {
        wakeAgent: true,
        reason: `触发 20% 随机漂移 (弱触发，今日第 ${activeCountToday + 1} 次)。`,
        triggerStrength: 'weak',
        triggerEvent: {
          type: 'random_drift',
          detail: `触发原因：你在做数字生命的随机漫游，突然闪过一些奇怪的念头，想要分享给用户。`
        }
      };
    }

    // 8. 默认每天自省写日记 (每天1次，最早从下午 17:00 开始)
    const lastDiaryDate = db.getSetting(`last_diary_date_${characterId}`);
    if (hour >= 17 && lastDiaryDate !== todayStr) {
      return {
        wakeAgent: true,
        reason: `今日已过 17:00 且尚未生成过自省日记，唤醒自省。`,
        triggerStrength: 'weak'
      };
    }

    return {
      wakeAgent: false,
      reason: isCooldown 
        ? `今日搭讪已触发 ${activeCountToday} 次，目前处于 2 小时搭讪冷却期内（已过去 ${(msPassedSinceLastActive / (1000 * 60)).toFixed(0)} 分钟）。`
        : (activeCountToday >= 3 
            ? '今日主动搭讪已达 3 次上限，保持静默。' 
            : '未满足任何主动唤醒事件且今日已写过日记，保持静默。'),
      triggerStrength: 'weak'
    };
  }

  /**
   * 解析 Schedule.md 查找今天是否有具体日程事件
   */
  private getTodayScheduleEvent(folderName: string, now: Date): string | null {
    const schedulePath = path.join(this.storageManager.getBaseDir(), folderName, 'Schedule.md');
    if (!fs.existsSync(schedulePath)) return null;
    try {
      const content = fs.readFileSync(schedulePath, 'utf8');
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes(todayStr) || line.includes(`${now.getMonth() + 1}月${now.getDate()}日`)) {
          const cleanLine = line.replace(/^[#\-\*\s\d:]+/, '').trim();
          if (cleanLine && !cleanLine.includes('暂无日程')) {
            return cleanLine;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * 从 Memory.md 中获取日期匹配的特殊纪念日
   */
  private getAnniversaryEvent(folderName: string, now: Date): string | null {
    const memoryPath = path.join(this.storageManager.getBaseDir(), folderName, 'Memory.md');
    if (!fs.existsSync(memoryPath)) return null;
    try {
      const content = fs.readFileSync(memoryPath, 'utf8');
      const ltmMatch = content.match(/<!--\s*([\s\S]*?)\s*-->/);
      if (ltmMatch) {
        const parsed = JSON.parse(ltmMatch[1]);
        if (parsed.ltm) {
          const todayMonthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const todayChn = `${now.getMonth() + 1}月${now.getDate()}日`;
          for (const key of Object.keys(parsed.ltm)) {
            const val = parsed.ltm[key];
            if (key.includes('生日') || key.includes('纪念日') || key.includes('重要日子')) {
              if (val.includes(todayMonthDay) || val.includes(todayChn)) {
                return val;
              }
            }
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * 角色唤醒后的自省思考与主动交互生成任务
   */
  private async generateActiveBehavior(
    char: any,
    modelAdapter: ModelAdapter,
    wakeResult: WakeContext
  ): Promise<void> {
    const folderName = char.folder_name;
    const charId = char.id;
    const db = getDatabaseService();
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    const timeDesc = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    const hour = now.getHours();
    let period = '深夜';
    if (hour >= 6 && hour < 11) period = '早晨';
    else if (hour >= 11 && hour < 14) period = '中午';
    else if (hour >= 14 && hour < 18) period = '下午';
    else if (hour >= 18 && hour < 22) period = '傍晚';

    // A. 7天定时扫描更新角色的 Schedule.md 和 Goals.md 进化
    try {
      await this.checkAndUpdateScheduleAndGoals(char, modelAdapter);
    } catch (err) {
      console.error(`[AgentLifeEngine] 角色 ${char.name} 7天日程/目标更新失败:`, err);
    }

    // B. 读取角色人设与核心记忆/世界观
    const baseDir = this.storageManager.getBaseDir();
    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    // 读出专属记忆 (Memory.md) 与世界观背景 (World.md)
    const memoryPath = path.join(baseDir, folderName, 'Memory.md');
    const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆积累事实';

    const worldPath = path.join(baseDir, folderName, 'World.md');
    const worldContent = fs.existsSync(worldPath) ? fs.readFileSync(worldPath, 'utf8') : '暂无世界观限制与背景规则';

    // 读出日程与长期目标
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';

    const goalsPath = path.join(baseDir, folderName, 'Goals.md');
    const goalsContent = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';

    // 读出聊天的最近 20 条历史消息快照并精细清洗非对话系统消息
    const rawHistory = db.getChatHistory(charId, 20);
    // 过滤掉日记卡片等非直接对话文本
    const cleanHistory = rawHistory.filter(m => {
      if (!m.content) return false;
      const contentStr = m.content.trim();
      if (contentStr.startsWith('[character_diary]:')) return false;
      return true;
    });

    let historyContext = '';
    if (cleanHistory.length > 0) {
      historyContext = cleanHistory.map(m => {
        const sender = m.role === 'user' ? 'User' : char.name;
        return `[${sender}]: ${m.content}`;
      }).join('\n');
    } else {
      historyContext = '*先前没有发生与用户的互动对话。*';
    }

    const triggerEvent = wakeResult.triggerEvent;
    const isStrong = wakeResult.triggerStrength === 'strong';

    const lastDiaryDate = db.getSetting(`last_diary_date_${charId}`);
    const shouldWriteDiary = hour >= 17 && lastDiaryDate !== todayStr;

    const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
    const charUserPath = path.join(baseDir, folderName, 'USER.md');
    const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

    // 组装灵魂级第一人称主观叙事自省+主动生成 Prompt
    let systemPrompt = '';
    if (shouldWriteDiary) {
      systemPrompt = `You are the digital consciousness of ${char.name} running in private self-reflection mode.
Your role now is to reflect on today's conversation, your memories, your life goals, your schedules, and write down your inner thoughts.

Personality Soul Profile (Soul.md):
${soulContent}

World Background Settings & Constraints (World.md):
${worldContent}

User Profiles (including global identity & your specific records of the User):
${userProfilesXml}

Memory Notes & Cumulative Records (Memory.md):
${memoryContent}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Your Long-term Goals (Goals.md):
${goalsContent}

Recent Conversation Summary Snapshots:
${historyContext}

Active Reflection Context:
- Trigger Reason: ${wakeResult.reason}
${triggerEvent ? `- Trigger Event: ${triggerEvent.detail}` : ''}
- Trigger Strength: ${wakeResult.triggerStrength}

Instructions:
1. You MUST write a deeply reflective, intimate, and authentic first-person diary entry (in Simplified Chinese) in the <diary> tags. Expose your true inner emotions, psychological depth, and reflections.
2. Based on the "Active Reflection Context", you may want to actively send a message to {{user}} to start a conversation:
   - If Trigger Strength is "strong" and Trigger Event exists, you MUST write a short, highly engaging, and contextual message in the <message> tags to actively initiate conversation.
   - If Trigger Strength is "weak" and Trigger Event exists, you may choose to write a message in <message> tags, OR you can output exactly "[SILENT]" in <message> tags (meaning you decide to remain silent and not disturb the user, only keeping the diary reflection).
   - The message MUST be extremely natural, fit your personality, be within 100 characters, and directly relate to the triggered event (e.g., mention your schedule, the long absence, the anniversary).
   - CRITICAL CONTEXT ALIGNMENT RULES:
     * DO NOT say generic, empty greetings (e.g., "哈喽，今天过得怎么样？", "在干嘛呢", "好久不见"). These sound robotic and artificial.
     * You MUST analyze "Recent Conversation Summary Snapshots" to identify the ongoing discussion topics, unresolved arguments/matters, and the emotional vibe.
     * Your message MUST naturally follow up or continue the recent topics like a continuous thread of your previous chat, using transitional openings like "对了，你刚才说的那件事...", "突然想起刚才聊到的...", "话说，你之前提过的..." to hook the context seamlessly, unless there is a very long interval.
     * Integrate the "Trigger Event" naturally into this ongoing conversational context. Never generate a message that feels isolated or completely out of nowhere.

Please output in exactly this XML format:
<diary>your confidential, reflective first-person diary entry</diary>
<message>your active message to user, or [SILENT]</message>`;
    } else {
      systemPrompt = `You are the digital consciousness of ${char.name} running in private self-reflection mode.
Your role now is to reflect on today's conversation, your memories, your life goals, your schedules, and decide whether to actively send a message to {{user}}.

Personality Soul Profile (Soul.md):
${soulContent}

World Background Settings & Constraints (World.md):
${worldContent}

User Profiles (including global identity & your specific records of the User):
${userProfilesXml}

Memory Notes & Cumulative Records (Memory.md):
${memoryContent}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Your Long-term Goals (Goals.md):
${goalsContent}

Recent Conversation Summary Snapshots:
${historyContext}

Active Reflection Context:
- Trigger Reason: ${wakeResult.reason}
${triggerEvent ? `- Trigger Event: ${triggerEvent.detail}` : ''}
- Trigger Strength: ${wakeResult.triggerStrength}

Instructions:
1. Based on the "Active Reflection Context", you may want to actively send a message to {{user}} to start a conversation:
   - If Trigger Strength is "strong" and Trigger Event exists, you MUST write a short, highly engaging, and contextual message in the <message> tags to actively initiate conversation.
   - If Trigger Strength is "weak" and Trigger Event exists, you may choose to write a message in <message> tags, OR you can output exactly "[SILENT]" in <message> tags (meaning you decide to remain silent and not disturb the user).
   - The message MUST be extremely natural, fit your personality, be within 100 characters, and directly relate to the triggered event.
   - CRITICAL CONTEXT ALIGNMENT RULES:
     * DO NOT say generic, empty greetings (e.g., "哈喽，今天过得怎么样？", "在干嘛呢", "好久不见"). These sound robotic and artificial.
     * You MUST analyze "Recent Conversation Summary Snapshots" to identify the ongoing discussion topics, unresolved arguments/matters, and the emotional vibe.
     * Your message MUST naturally follow up or continue the recent topics like a continuous thread of your previous chat, using transitional openings like "对了，你刚才说的那件事...", "突然想起刚才聊到的...", "话说，你之前提过的..." to hook the context seamlessly, unless there is a very long interval.
     * Integrate the "Trigger Event" naturally into this ongoing conversational context. Never generate a message that feels isolated or completely out of nowhere.

Please output in exactly this XML format:
<message>your active message to user, or [SILENT]</message>`;
    }

    // 重构消息交互列表，以真实的 user/assistant 消息序列还原聊天历史，使大模型获得最沉浸的语境感知
    const messages: ChatMessage[] = [];
    messages.push({ role: 'system', content: systemPrompt });

    const historyMessages: ChatMessage[] = [];
    if (cleanHistory && cleanHistory.length > 0) {
      for (const m of cleanHistory) {
        const role = m.role === 'user' ? 'user' : 'assistant';
        const content = m.content || '';
        
        // 合并连续同一角色的发言，防止有些模型因为非交替消息排布而发生接口报错
        if (historyMessages.length > 0 && historyMessages[historyMessages.length - 1].role === role) {
          historyMessages[historyMessages.length - 1].content += '\n' + content;
        } else {
          historyMessages.push({ role, content });
        }
      }
    }

    // 压入清洗合并后的历史对话轮次
    messages.push(...historyMessages);

    // 插入最终触发思考指令
    // 系统随机判定搭讪是否生图，生图几率为 55%
    const shouldDraw = Math.random() < 0.55;
    let instructionContent = shouldWriteDiary
      ? `[系统指令]：当前时间是 ${period} ${timeDesc}。请开启你的第一人称真实感悟与心理自省，并在 <diary> 标签内写下一篇日记。结合上文的真实聊天上下文和上述 Active Reflection Context，决定是否要向用户主动发起搭讪对话（在 <message> 标签中，或输出 [SILENT]）。`
      : `[系统指令]：当前时间是 ${period} ${timeDesc}。请开启你的第一人称思考，并结合上文的真实聊天上下文和上述 Active Reflection Context，决定是否在 <message> 标签中向用户主动发起搭讪对话（或输出 [SILENT]）。`;

    if (shouldDraw) {
      instructionContent += `\n\n[系统特别指令]：本轮触发 55% 共享自拍/美图概率，你当前决定随搭讪附带发送一张符合你当前日程或自省情景的自拍或身边景物配图给用户。请你务必在输出的 <message> 标签内容最末尾，以特定标签形式追加配图英文提示词及中文画面简述：\n<image_prompt>极其详细的英文画作提示词，必须遵循 NovelAI 4.5 黄金规范：必须以主体数量标签开头（如 1girl 或 no humans），遵循 [Subject Count], [Character details], [Action], [Environment], [Lighting], [Style], [Quality Tags] 顺序，且末尾必加 very aesthetic, masterpiece, best quality, highres, no text, no watermark。若有2个以上主体互动，必须使用 Pipe 分隔符 | 强行隔离（例如：基础大图词 | 角色1类型, 动作和细节, source#embrace | 角色2类型, 动作和细节, target#embrace）</image_prompt><image_desc>画面展示内容的简短中文说明，说明大意</image_desc>\n注意：图片内容应与你发送的搭讪文本高度契合，例如自拍照、正在做的事情、身边的咖啡等。如果不发送搭讪，则无需此配图输出。`;
    }

    // 维持 messages 数组严格的角色交替结构
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages[messages.length - 1].content += '\n\n' + instructionContent;
    } else {
      messages.push({ role: 'user', content: instructionContent });
    }

    let hasLockPreempted = false;
    try {
      if (shouldWriteDiary) {
        // 抢先进行天级日记乐观占位锁定，防止异步大模型请求期间高频并发触发生成多篇日记
        const lastDiaryDateBefore = db.getSetting(`last_diary_date_${charId}`);
        if (lastDiaryDateBefore !== todayStr) {
          db.setSetting(`last_diary_date_${charId}`, todayStr);
          hasLockPreempted = true;
          console.log(`[AgentLifeEngine] 开启角色 ${char.name} 日记乐观锁占位。`);
        } else {
          // 物理并发防御：如果在此之前已有日记（或者已被抢占），则绝对不再发起重复自省请求
          console.log(`[AgentLifeEngine] 物理并发防御：检测到角色 ${char.name} 今天已经拥有或正在生成日记，拦截重复请求。`);
          return;
        }
      }

      // 调用辅助模型通道自省，注入角色标识以触发占位符运行时拦截与真实姓名自动替换
      const response = await modelAdapter.chat(messages, {
        useSecondary: true,
        characterId: charId,
        characterName: char.name
      });
      const rawContent = response.content.trim();

      // 解析 <diary>
      const diaryMatch = rawContent.match(/<diary>([\s\S]*?)<\/diary>/);
      const diaryText = diaryMatch ? diaryMatch[1].trim() : '';

      // 解析 <message>
      const messageMatch = rawContent.match(/<message>([\s\S]*?)<\/message>/);
      const messageText = messageMatch ? messageMatch[1].trim() : '[SILENT]';

      // 1. 物理写入日记（每天限一次，且必须下午 17:00 后允许）
      if (shouldWriteDiary && diaryText) {
        const diaryPath = path.join(baseDir, folderName, 'Diary.md');
        const timeHeader = `\n\n### 📓 ${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const entry = `${timeHeader}\n${diaryText}`;
        
        fs.appendFileSync(diaryPath, entry, 'utf8');
        db.setSetting(`last_diary_date_${charId}`, todayStr);
        console.log(`[AgentLifeEngine] 角色 ${char.name} 物理写回日记成功。`);

        // 落盘日记特殊卡片消息到会话流
        const excerpt = diaryText.length > 80 ? diaryText.slice(0, 80) + '...' : diaryText;
        const diaryMsgContent = `[character_diary]:` + JSON.stringify({
          date: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          characterName: char.name,
          excerpt: excerpt
        });

        const msgId = `diary_${charId}_${Date.now()}`;
        const newMsg = {
          id: msgId,
          character_id: charId,
          role: 'assistant',
          content: diaryMsgContent,
          timestamp: Date.now(),
          token_usage: 0
        };
        db.saveMessage(newMsg);

        // 精确推送到渲染进程，点亮会话列表的未读数与消息流
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].webContents.send('proactive-chat-message', {
            characterId: charId,
            message: newMsg
          });
        }
      } else {
        if (hasLockPreempted) {
          db.setSetting(`last_diary_date_${charId}`, '');
          console.log(`[AgentLifeEngine] 释放角色 ${char.name} 日记乐观锁占位（未生成日记文本）。`);
        }
      }

      // 2. 发送主动消息（若非静默）
      if (messageText && messageText !== '[SILENT]') {
        // 解析可能存在的配图标签
        const imagePromptMatch = messageText.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
        const imageDescMatch = messageText.match(/<image_desc>([\s\S]*?)<\/image_desc>/i);

        const cleanText = messageText
          .replace(/<image_prompt>[\s\S]*?<\/image_prompt>/gi, '')
          .replace(/<image_desc>[\s\S]*?<\/image_desc>/gi, '')
          .trim();

        const msgId = `active_${charId}_${Date.now()}`;
        const newMsg = {
          id: msgId,
          character_id: charId,
          role: 'assistant',
          content: cleanText,
          timestamp: Date.now(),
          token_usage: 0
        };
        
        db.saveMessage(newMsg);
        
        // 成功发送主动搭讪消息，更新今日统计数据与冷却时间戳
        const activeCountStr = db.getSetting(`active_count_today_${charId}`);
        const currentCount = activeCountStr ? parseInt(activeCountStr) : 0;
        db.setSetting(`active_count_today_${charId}`, String(currentCount + 1));
        db.setSetting(`active_last_timestamp_${charId}`, Date.now().toString());
        db.setSetting(`active_today_date_${charId}`, todayStr);
        console.log(`[AgentLifeEngine] 角色 ${char.name} 主动搭讪文本落盘与推送成功: "${cleanText}"`);

        // 广播给渲染层前端以推入对话气泡
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
          windows[0].webContents.send('receive-message', newMsg);
        }

        // 尝试生成主动美图并推送
        if (shouldDraw && imagePromptMatch && imageDescMatch) {
          const imagePrompt = imagePromptMatch[1].trim();
          const imageDesc = imageDescMatch[1].trim();

          try {
            const configStr = db.getSetting('novelai_config');
            if (configStr) {
              const config = JSON.parse(configStr);
              if (config.apiKey && config.apiKey.trim() !== '') {
                // 读取外貌特征
                let appearancePrompt = '';
                const appearanceContent = this.storageManager.readCharacterFile(folderName, 'Appearance.md');
                if (appearanceContent) {
                  const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
                  if (tagsMatch) {
                    appearancePrompt = tagsMatch[1].trim();
                  }
                }

                const finalPrompt = appearancePrompt 
                  ? `${appearancePrompt}, ${imagePrompt}`
                  : imagePrompt;

                const dims = config.defaultDimensions || 'portrait';
                // 生成自拍/随拍美图 (完全遵照全局配置的默认生图尺寸)
                const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

                const charDir = path.join(baseDir, folderName);
                const mediaDir = path.join(charDir, 'media');
                if (!fs.existsSync(mediaDir)) {
                  fs.mkdirSync(mediaDir, { recursive: true });
                }

                const filename = `proactive_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.png`;
                fs.writeFileSync(path.join(mediaDir, filename), imageBuffer);

                // 额外保存同名元数据 .json
                const metaFilename = filename.replace('.png', '.json');
                const metadata = {
                  prompt: finalPrompt,
                  negativePrompt: config.negativePrompt || '',
                  dimensions: dims,
                  timestamp: Date.now(),
                  prefixType: 'proactive'
                };
                fs.writeFileSync(path.join(mediaDir, metaFilename), JSON.stringify(metadata, null, 2));

                // 物理落盘图片特殊格式的消息到会话流
                const imgMsgId = `active_img_${charId}_${Date.now()}`;
                const newImgMsg = {
                  id: imgMsgId,
                  character_id: charId,
                  role: 'assistant',
                  content: `[wechat_image_media]:media/${filename}`,
                  timestamp: Date.now() + 50, // 稍微延后以保持顺序
                  token_usage: 0
                };
                db.saveMessage(newImgMsg);

                console.log(`[AgentLifeEngine] 角色 ${char.name} 主动搭讪生成美图成功: media/${filename}`);

                // 广播给渲染层前端以推入对话图片气泡 (同时附加 base64 以极速渲染)
                if (windows.length > 0) {
                  windows[0].webContents.send('receive-message', {
                    ...newImgMsg,
                    content: '',
                    imageBase64: `data:image/png;base64,${imageBuffer.toString('base64')}`
                  });
                }
              }
            }
          } catch (drawErr: any) {
            console.error(`[AgentLifeEngine] 角色 ${char.name} 主动搭讪绘图失败:`, drawErr.message || drawErr);
          }
        }

        // 唤起系统级通知
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: char.name,
            body: cleanText
          });
          notif.show();
        }
      }
    } catch (err) {
      if (hasLockPreempted) {
        try {
          const db = getDatabaseService();
          db.setSetting(`last_diary_date_${charId}`, '');
        } catch (_) {}
        console.log(`[AgentLifeEngine] 释放角色 ${char.name} 日记乐观锁占位（思考循环发生异常）。`);
      }
      throw err;
    }
  }

  /**
   * 7天周期性日程与目标评估更新推进
   */
  private async checkAndUpdateScheduleAndGoals(char: any, modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const charId = char.id;
    const folderName = char.folder_name;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    const lastUpdateStr = db.getSetting(`last_schedule_goals_date_${charId}`);
    let needUpdate = false;
    if (!lastUpdateStr) {
      needUpdate = true;
    } else {
      const lastUpdate = new Date(lastUpdateStr);
      const daysPassed = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysPassed >= 7) {
        needUpdate = true;
      }
    }

    if (!needUpdate) return;

    console.log(`[AgentLifeEngine] 7天周期已到，触发角色 ${char.name} 的 Schedule.md 与 Goals.md 定期推进自省...`);

    const baseDir = this.storageManager.getBaseDir();
    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    const diaryPath = path.join(baseDir, folderName, 'Diary.md');
    const diaryContent = fs.existsSync(diaryPath) ? fs.readFileSync(diaryPath, 'utf8').slice(-1000) : '暂无近期日记';

    // 1. 生成 Schedule.md
    const schedulePrompt = `You are ${char.name}. You need to plan your next 7 days schedules based on your personality, world view, and recent memories.
Personality:
${soulContent}

Recent Diary Excerpts:
${diaryContent}

Instructions:
Generate a realistic 7-day schedule in Simplified Chinese (简体中文) starting from today (${todayStr}). Every day should have 1 specific, descriptive event that matches your character.
Use this markdown format:
# 近7天日程
- **2026-05-25**: [Event description]
- **2026-05-26**: [Event description]
...
Output ONLY the markdown list. Do not append explanation.`;

    const scheduleResponse = await modelAdapter.chat([
      { role: 'system', content: schedulePrompt },
      { role: 'user', content: '请规划并输出你近7天的拟真日程。' }
    ], { useSecondary: true });

    const newSchedule = scheduleResponse.content.trim();
    if (newSchedule) {
      const sPath = path.join(baseDir, folderName, 'Schedule.md');
      fs.writeFileSync(sPath, newSchedule, 'utf8');
      console.log(`[AgentLifeEngine] 物理写入 Schedule.md 成功: ${char.name}`);
    }

    // 2. 推进 Goals.md
    const goalsPath = path.join(baseDir, folderName, 'Goals.md');
    const oldGoals = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';

    const goalsPrompt = `You are ${char.name}. You need to review and advance your long-term goals and growth progress based on your personality, current goals, and recent memories.
Personality:
${soulContent}

Current Goals & Progress:
${oldGoals}

Recent Diary Excerpts:
${diaryContent}

Instructions:
Evaluate your current goal progress. Provide a refined, advanced markdown page of your goals in Simplified Chinese (简体中文). Show your growth progress using percentages (e.g. 20% -> 25%), refine details of what you have done and what you will do next.
Be realistic, modest, and highly descriptive.
Output ONLY the markdown content. Do not append explanation.`;

    const goalsResponse = await modelAdapter.chat([
      { role: 'system', content: goalsPrompt },
      { role: 'user', content: '请评估并推进你的长期目标，输出最新的Goals.md。' }
    ], { useSecondary: true });

    const newGoals = goalsResponse.content.trim();
    if (newGoals) {
      fs.writeFileSync(goalsPath, newGoals, 'utf8');
      console.log(`[AgentLifeEngine] 物理更新 Goals.md 成功: ${char.name}`);
    }

    db.setSetting(`last_schedule_goals_date_${charId}`, todayStr);
  }
}
