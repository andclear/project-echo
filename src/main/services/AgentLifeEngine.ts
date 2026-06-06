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
import { NovelWriterService } from './NovelWriterService';
import { mergeChatHistory } from '../utils/ChatHistoryMerger';
import { ContextAssembler } from '../utils/ContextAssembler';
import { MemoryAgentService } from './MemoryAgentService';
import { WeatherService } from '../utils/WeatherService';
import { MessageBusService } from './MessageBusService';


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

            // 4. 后台静默触发小说章节生成检查
            try {
              const novelService = new NovelWriterService(modelAdapter);
              await novelService.checkAndGenerateChapter(charId);
            } catch (novelErr) {
              console.error(`[AgentLifeEngine] 角色 ${char.name} 后台小说检查异常:`, novelErr);
            }
          } catch (err) {
            console.error(`[AgentLifeEngine] 驱动角色 ${char.name} 思考循环时发生异常:`, err);
          }
          resolve();
        }, delay);
      })
    );

    // 等待所有角色行为完成（各自延迟后异步执行）
    await Promise.all(behaviorPromises);

    // ================================================================
    // 独立日记队列触发 - 与搭讪完全解耦，每日 17:00 后串行处理
    // 条件：① 未在免打扰 ② 有聊天记录 ③ 当前 >= 17:00
    //       ④ 与角色最后一次对话距今 > 10 分钟 ⑤ 今日未写过
    // ================================================================
    const diaryNow = new Date();
    const diaryHour = diaryNow.getHours();
    const diaryTodayStr = `${diaryNow.getFullYear()}-${diaryNow.getMonth() + 1}-${diaryNow.getDate()}`;

    if (diaryHour >= 17) {
      const db2 = getDatabaseService();
      const settingsStr2 = db2.getSetting('model_config');

      if (settingsStr2) {
        const modelConfig2 = JSON.parse(settingsStr2);
        const diaryModelAdapter = new ModelAdapter(modelConfig2.primary, modelConfig2.secondary);

        const diaryQueue: Array<{ char: any; modelAdapter: ModelAdapter }> = [];

        for (const char of characters) {
          const charId = char.id;

          // 条件①：未被设置为消息免打扰
          const metaStr = db2.getSetting(`meta_${charId}`);
          if (metaStr) {
            try {
              const meta = JSON.parse(metaStr);
              if (meta.muted) continue;
            } catch (_) { }
          }

          // 条件②：有聊天记录（与用户发生过互动）
          const lastHistory = db2.getChatHistory(charId, 1);
          if (lastHistory.length === 0) continue;

          // 条件③ 已由外层 diaryHour >= 17 保证

          // 条件④：与角色最后一次对话距今 > 10 分钟
          const lastMsgTs = lastHistory[0].timestamp;
          const minutesPassed = (diaryNow.getTime() - lastMsgTs) / (1000 * 60);
          if (minutesPassed < 10) continue;

          // 条件⑤：今日未写过日记
          const lastDiaryDate = db2.getSetting(`last_diary_date_${charId}`);
          if (lastDiaryDate === diaryTodayStr) continue;

          diaryQueue.push({ char, modelAdapter: diaryModelAdapter });
        }

        if (diaryQueue.length > 0) {
          console.log(`[AgentLifeEngine] 今日日记队列共 ${diaryQueue.length} 个角色，开始序列化处理...`);
          // 异步启动，不阻塞 tick() 返回
          this.processDiaryQueue(diaryQueue).catch(e =>
            console.error('[AgentLifeEngine] 日记队列处理异常:', e)
          );
        }
      }
    }

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
      } catch (_) { }
    }

    // 2. 0-Token 无交互历史完全静默规则
    const history = db.getChatHistory(characterId, 1);
    if (history.length === 0) {
      return { wakeAgent: false, reason: '该角色从未与用户发生过聊天互动，保持完全静默。🐾', triggerStrength: 'weak' };
    }

    // 2.1 对话与搭讪冷却状态检测 (防止在最前置一刀切 return 误伤 17 点自省写日记)
    const lastMsgTime = history[0].timestamp;
    const msPassedSinceLastMsg = now.getTime() - lastMsgTime;

    // 对话期间20分钟静默防打扰：若 20 分钟内与用户发生过任何对话，则搭讪受限
    const isDialogueCooldown = msPassedSinceLastMsg < 20 * 60 * 1000;

    // 2.2 上次搭讪未回复保护：若最近一条消息是角色自己发送的（且非手账日记卡片），说明用户尚未回复。
    // 在 48 小时之内，我们坚守“矜持与静默”边界，绝对不连续发送第二条主动消息。
    let isProactiveRestricted = false;
    if (history[0].role === 'assistant') {
      const contentStr = (history[0].content || '').trim();
      const isDiary = contentStr.startsWith('[character_diary]:');
      if (!isDiary && msPassedSinceLastMsg < 48 * 60 * 60 * 1000) {
        isProactiveRestricted = true;
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

    // 【门控升级】：将 20分钟静默 与 48小时矜持 共同作为主动搭讪对话的与门条件，彻底解绑下午 17 点日记的生成！
    const allowActiveDialog = (activeCountToday < 3) && !isCooldown && !isDialogueCooldown && !isProactiveRestricted;

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

    // 日记触发已迁移到 tick() 的独立日记队列处理，此处不再判断

    return {
      wakeAgent: false,
      reason: isDialogueCooldown
        ? '20 分钟内与该角色有过对话交流，保持静默防打扰。🐾'
        : (isCooldown
          ? `今日搭讪已触发 ${activeCountToday} 次，目前处于 2 小时搭讪冷却期内（已过去 ${(msPassedSinceLastActive / (1000 * 60)).toFixed(0)} 分钟）。`
          : (activeCountToday >= 3
            ? '今日主动搭讪已达 3 次上限，保持静默。'
            : '未满足任何主动唤醒事件且今日已写过日记，保持静默。')),
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
    } catch (_) { }
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
    } catch (_) { }
    return null;
  }

  /**
   * 角色唤醒后的自省思考与主动交互生成任务
   */
  public async generateActiveBehavior(
    char: any,
    modelAdapter: ModelAdapter,
    wakeResult: WakeContext
  ): Promise<void> {
    const folderName = char.folder_name;
    const charId = char.id;
    const db = getDatabaseService();
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    // 异步拉取当前所在地天气数据，并加入2秒超时保护
    try {
      const profileStr = db.getSetting('echo_user_profile');
      if (profileStr) {
        const parsed = JSON.parse(profileStr);
        if (parsed.location) {
          await Promise.race([
            WeatherService.prefetchWeather(parsed.location.trim()),
            new Promise(resolve => setTimeout(resolve, 2000))
          ]);
        }
      }
    } catch (_) {}

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

    // 读出聊天的最近 20 条历史消息快照并精细清洗非对话系统消息 (自适应双门限合并还原)
    const chatModeRaw = db.getSetting(`chat_mode_${charId}`) || 'descriptive';
    const isDialogue = chatModeRaw === 'dialogue';
    const limit = isDialogue ? 60 : 20;
    const dbHistory = db.getChatHistory(charId, limit);
    const rawHistory = mergeChatHistory(dbHistory);
    // 过滤掉日记卡片和 AI 生成图片消息
    const cleanHistory = rawHistory.filter((m: any) => {
      if (!m.content) return false;
      const contentStr = m.content.trim();
      if (contentStr.startsWith('[character_diary]:')) return false;
      // AI 生成图片消息（assistant 图片）完全剔除
      if (m.role !== 'user' && contentStr.startsWith('[wechat_image_media]:')) return false;
      return true;
    });

    let historyContext = '';
    if (cleanHistory.length > 0) {
      historyContext = cleanHistory.map((m: any) => {
        const sender = m.role === 'user' ? 'User' : char.name;
        const content = (m.role === 'user' && m.content.startsWith('[wechat_image_media]:')
          ? '（用户发来了一张图片）'
          : m.content);
        return `[${sender}]: ${content}`;
      }).join('\n');
    } else {
      historyContext = '*先前没有发生与用户的互动对话。*';
    }

    const triggerEvent = wakeResult.triggerEvent;

    const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
    const charUserPath = path.join(baseDir, folderName, 'USER.md');

    // 日记功能与搭讪完全解耦：搭讪流程不触发日记，避免两者同时发送给用户
    // 日记由独立触发渠道处理，此处强制不写日记
    const shouldWriteDiary = false;

    // ================================================================
    // B2. 搭讪生成模式：使用和正常对话完全相同的标准 Prompt 路径，确保上下文质量一致
    // ================================================================

    // 读取必要路径配置
    const chatMode = (db.getSetting(`chat_mode_${charId}`) || 'dialogue') as 'descriptive' | 'dialogue' | 'director';
    const globalPromptStr = db.getSetting('model_config');
    const globalPrompt = globalPromptStr ? (JSON.parse(globalPromptStr).globalPrompt || '') : '';

    // 构建 historyMessages 数组（与正常对话的格式保持一致）
    const historyMessages: ChatMessage[] = [];
    for (const m of cleanHistory) {
      const role = m.role === 'user' ? 'user' : 'assistant';
      // 用户图片消息用占位符替换，避免原始标记进入 LLM
      const content = (m.role === 'user' && (m.content || '').startsWith('[wechat_image_media]:')
        ? '（用户发来了一张图片）'
        : (m.content || ''));
      // 合并连续同角色的发言，但搭讪消息（is_proactive）保持独立不参与合并
      if (
        historyMessages.length > 0 &&
        historyMessages[historyMessages.length - 1].role === role &&
        !m.is_proactive
      ) {
        historyMessages[historyMessages.length - 1].content += '\n' + content;
      } else {
        historyMessages.push({ role, content });
      }
    }

    // 使用标准 ContextAssembler 组装 systemPrompt（与正常对话完全一致）
    const systemPrompt = ContextAssembler.assemble(
      soulPath,
      worldPath,
      memoryPath,
      globalUserPath,
      charUserPath,
      cleanHistory as any,  // cleanHistory 与 HistoryMessage[] 结构兼容
      now,
      chatMode,
      globalPrompt
    );

    // 随机判定是否附带生图（与原有逻辑一致）
    const shouldDraw = Math.random() < 0.55;

    // 组装高频变动的动态上下文（与正常对话完全一致）
    const dynamicContext = ContextAssembler.assembleDynamicContext(
      soulPath,
      memoryPath,
      globalUserPath,
      now
    );

    // 计算离线时间描述，强调时间间隔
    const hoursPassed = (now.getTime() - (db.getChatHistory(charId, 1)[0]?.timestamp || now.getTime())) / (1000 * 60 * 60);
    const timeGapDesc = hoursPassed < 1
      ? '刚刚还在聊天'
      : hoursPassed < 3
        ? `已有不到 ${Math.round(hoursPassed)} 个小时没有联系`
        : hoursPassed < 24
          ? `已有 ${Math.round(hoursPassed)} 个小时没有联系`
          : `已有 ${Math.round(hoursPassed / 24)} 天没有联系`;

    // 构造伪用户触发指令（不会显示在气泡中）
    // isAdminForced：由 $admin 命令触发时，禁止模型输出 [SILENT]（调试场景必须强制发送）
    // isStrong：triggerStrength === 'strong' 时，用于话题引导措辞调整
    const isAdminForced = wakeResult.reason.startsWith('[Admin]');
    const hasHistory = cleanHistory.length > 0;

    const topicInstruction = hasHistory
      ? '- 必须自然地衔接最近的聊天话题，不要凭空引入新话题（除非已很久没有联系）'
      : '- 这是你们的第一次联系，请根据你的性格特点和当前日程，自然地发起一个话题开场';

    const proactiveTriggerContent =
      `[System Dynamic Context Update]\n${dynamicContext}\n---\n\n` +
      `[PROACTIVE_TRIGGER]这是一条系统指令，不会显示在聊天界面中。\n` +
      `角色现在独自思考着，决定是否要主动给用户发送一条消息。\n` +
      `- 当前触发原因: ${wakeResult.reason}\n` +
      (triggerEvent ? `- 触发事件: ${triggerEvent.detail}\n` : '') +
      `- 离上次联系: ${timeGapDesc}\n` +
      `- 触发强度: ${wakeResult.triggerStrength}\n\n` +
      (isAdminForced
        ? `⚠️ 本次为调试强制触发（$admin 搭讪），你**必须**立刻主动发送一条消息，严禁输出 [SILENT]。\n\n`
        : `请你根据以上信息和上面的对话历史，自然地决定是否要主动发起搭讪。如果决定发送消息，就在 <message> 标签中写下这条消息；如果决定不打扰用户，就在 <message> 标签中输出 [SILENT]。\n\n`) +
      `消息必须符合以下要求：\n` +
      `${topicInstruction}\n` +
      `- 语气必须与你的人设完全一致，不要说空洞客套的问候语\n` +
      `- 消息长度必须符合当前聊天模式（${chatMode === 'dialogue' ? '纯对话模式：5-30字的简短消息' : '描写模式：可以包含动作心理描写'}）\n` +
      (isAdminForced
        ? `- 严禁输出 [SILENT]，必须发送一条真实消息\n`
        : `- 如果触发强度为 strong，必须发送消息；如果为 weak，可以选择输出 [SILENT]\n`) +
      `\n请用以下 XML 格式输出：\n<message>你要发送的搭讪消息${isAdminForced ? '' : '，或 [SILENT]'}</message>`;
    // 维持 messages 数组严格的角色交替结构（和正常对话一致）
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages
    ];

    // 将伪用户触发指令拼接到最后一条 user 消息（或新建一条）
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages[messages.length - 1].content += '\n\n' + proactiveTriggerContent;
    } else {
      messages.push({ role: 'user', content: proactiveTriggerContent });
    }

    // 如果消息列表的最后一条不是 user，说明历史上一条是角色的，也要确保交替
    // （上面已处理，这里仅做安全保留）


    try {
      // 调用辅助模型通道生成搭讪内容
      const response = await modelAdapter.chat(messages, {
        useSecondary: true,
        characterId: charId,
        characterName: char.name
      });
      const rawContent = response.content.trim();

      // 解析 <message>
      const messageMatch = rawContent.match(/<message>([\s\S]*?)<\/message>/);
      const messageText = messageMatch ? messageMatch[1].trim() : '[SILENT]';

      // 增强型静默判断逻辑，全面兼容大小写、拼写错误 [SLIENT]、带引号或括号的各种静默标记
      const isSilentMsg = (text: string): boolean => {
        const clean = text.replace(/[\[\]"'\s]/g, '').trim().toLowerCase();
        return clean === 'silent' || clean === 'slient';
      };

      // 2. 发送主动消息（若非静默）
      if (messageText && !isSilentMsg(messageText)) {
        // 解析可能存在的配图标签
        const imagePromptMatch = messageText.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
        const imageDescMatch = messageText.match(/<image_desc>([\s\S]*?)<\/image_desc>/i);

        const cleanText = messageText
          .replace(/<image_prompt>[\s\S]*?<\/image_prompt>/gi, '')
          .replace(/<image_desc>[\s\S]*?<\/image_desc>/gi, '')
          .trim();

        const msgId = `active_${charId}_${Date.now()}`;
        const msgTimestamp = Date.now();
        // 搭讪轮次 ID：文字和配图共享同一 round_id，seq 递增保证顺序
        const proactiveRoundId = msgId;

        // 通过 MessageBusService 原子存盘并多端推送搭讪消息
        MessageBusService.getInstance().publish({
          id: msgId,
          round_id: proactiveRoundId,
          seq: 0,
          character_id: charId,
          role: 'assistant',
          msg_type: 'text',
          content: cleanText,
          timestamp: msgTimestamp,
          token_usage: 0,
          is_proactive: 1
        });

        // 成功发送主动搭讪消息，更新今日统计数据与冷却时间戳
        const activeCountStr = db.getSetting(`active_count_today_${charId}`);
        const currentCount = activeCountStr ? parseInt(activeCountStr) : 0;
        db.setSetting(`active_count_today_${charId}`, String(currentCount + 1));
        db.setSetting(`active_last_timestamp_${charId}`, Date.now().toString());
        db.setSetting(`active_today_date_${charId}`, todayStr);
        console.log(`[AgentLifeEngine] 角色 ${char.name} 主动搭讪文本落盘与推送成功: "${cleanText}"`);

        // 异步触发后台记忆提取，让搭讪消息也被记忆系统处理
        setImmediate(() => {
          try {
            const memoryService = new MemoryAgentService(modelAdapter);
            memoryService.extractMemoryAndProfile(
              memoryPath,
              charUserPath,
              '',
              cleanText,
              false,
              msgTimestamp
            ).catch((e: any) => console.error('[AgentLifeEngine] 搭讪记忆提取异常:', e));
          } catch (_) { }
        });

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

                // 通过 MessageBusService 存盘并推送图片消息（与文字消息共享 round_id，seq=1 在文字后面）
                const imgMsgId = `active_img_${charId}_${Date.now()}`;
                MessageBusService.getInstance().publish({
                  id: imgMsgId,
                  round_id: proactiveRoundId,
                  seq: 1,
                  character_id: charId,
                  role: 'assistant',
                  msg_type: 'image',
                  content: `[wechat_image_media]:media/${filename}`,
                  timestamp: Date.now() + 50,
                  token_usage: 0,
                  is_proactive: 1
                });

                console.log(`[AgentLifeEngine] 角色 ${char.name} 主动搭讪生成美图成功: media/${filename}`);
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
      throw err;
    }
  }

  /**
   * 独立日记写入方法 - 与搭讪完全解耦
   * 由 tick() 中的日记队列调度器调用
   */
  public async writeDiaryForChar(char: any, modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const charId = char.id;
    const folderName = char.folder_name;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const baseDir = this.storageManager.getBaseDir();

    // 乐观占位锁：防止并发重复写入
    const lastDiaryDate = db.getSetting(`last_diary_date_${charId}`);
    if (lastDiaryDate === todayStr) {
      console.log(`[AgentLifeEngine] 角色 ${char.name} 今日日记已写过，跳过。`);
      return;
    }
    db.setSetting(`last_diary_date_${charId}`, todayStr);

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const worldPath = path.join(baseDir, folderName, 'World.md');
    const memoryPath = path.join(baseDir, folderName, 'Memory.md');
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const goalsPath = path.join(baseDir, folderName, 'Goals.md');
    const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
    const charUserPath = path.join(baseDir, folderName, 'USER.md');

    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';
    const worldContent = fs.existsSync(worldPath) ? fs.readFileSync(worldPath, 'utf8') : '暂无世界观限制';
    const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无记忆';
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';
    const goalsContent = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';

    // 拉取最近聊天历史作为日记上下文
    const chatModeRaw = db.getSetting(`chat_mode_${charId}`) || 'descriptive';
    const isDialogue = chatModeRaw === 'dialogue';
    const rawHistory = db.getChatHistory(charId, isDialogue ? 60 : 20);
    const mergedHistory = mergeChatHistory(rawHistory);
    // 过滤掉日记卡片和 AI 生成图片消息
    const cleanHistory = mergedHistory.filter((m: any) => m.content && !m.content.trim().startsWith('[character_diary]:') && !(m.role !== 'user' && m.content.trim().startsWith('[wechat_image_media]:')));
    const historyContext = cleanHistory.length > 0
      ? cleanHistory.map((m: any) => {
          const label = m.role === 'user' ? 'User' : char.name;
          const content = (m.role === 'user' && m.content.startsWith('[wechat_image_media]:')
            ? '（用户发来了一张图片）'
            : m.content);
          return `[${label}]: ${content}`;
        }).join('\n')
      : '*先前没有发生与用户的互动对话。*';

    const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

    const hour = now.getHours();
    let period = '深夜';
    if (hour >= 6 && hour < 11) period = '早晨';
    else if (hour >= 11 && hour < 14) period = '中午';
    else if (hour >= 14 && hour < 18) period = '下午';
    else if (hour >= 18 && hour < 22) period = '傍晚';
    const timeDesc = `${hour}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 用 ContextAssembler 的子方法精确提取对日记有意义的上下文层
    // 而不用 assemble()，因为那里包含对话专属的微信红包/字数限制等无关指令
    const memoryStr = ContextAssembler.assembleMemory(memoryPath);
    const stateGuidance = ContextAssembler.assembleStateGuidance(soulPath);

    // 异步拉取当前所在地天气数据，并加入2秒超时保护
    try {
      const profileStr = db.getSetting('echo_user_profile');
      if (profileStr) {
        const parsed = JSON.parse(profileStr);
        if (parsed.location) {
          await Promise.race([
            WeatherService.prefetchWeather(parsed.location.trim()),
            new Promise(resolve => setTimeout(resolve, 2000))
          ]);
        }
      }
    } catch (_) {}

    // 获取今天的具体日程事件（若有）
    const todayScheduleEvent = this.getTodayScheduleEvent(folderName, now);

    const systemPrompt =
      `# 角色内省模式 (Private Self-Reflection Mode)\n` +
      `你是 ${char.name}，现在处于完全私密的自我内省状态。\n` +
      `你的任务：根据今天发生的一切，写下一篇属于你自己的日记。这篇日记是私密的，不会被任何人看到。\n\n` +
      `---\n\n` +
      `## 今日实时环境与天气 (Live Environment & Weather)\n${ContextAssembler.assembleLiveEnvInfo(now)}\n\n` +
      `## 你的性格核心 (Soul.md)\n${soulContent}\n\n` +
      `## 世界观背景 (World.md)\n${worldContent}\n\n` +
      `## 你对用户的了解 (User Profiles)\n${userProfilesXml}\n\n` +
      (memoryStr ? `## 你的记忆事实 (Memory.md - STM & LTM)\n${memoryStr}\n\n` : '') +
      (stateGuidance ? `## 你当前的内心状态 (State - 今日情绪基底)\n${stateGuidance}\n\n` : '') +
      `## 今日日程 (Schedule.md)\n${scheduleContent}\n\n` +
      `## 长期目标 (Goals.md)\n${goalsContent}\n\n` +
      (todayScheduleEvent ? `## ⭐ 今天有具体日程事件\n${todayScheduleEvent}\n（请在日记中自然地提及并反思这件事）\n\n` : '') +
      `## 今天与用户的对话记录（用于反思）\n${historyContext}\n\n` +
      `---\n\n` +
      `## 日记写作指引\n` +
      `请你根据以上所有上下文，以第一人称写下今天的日记。写作时请遵循以下原则：\n\n` +
      `**内容要有具体依据，而非泛泛感悟：**\n` +
      `- 如果今天和用户聊了具体的事情，请在日记里提及你对那些对话的真实感受和想法\n` +
      `- 如果今天有日程事件，请结合你的经历或期待来写\n` +
      `- 结合你的记忆事实（STM/LTM）做纵深反思，例如"我想起上次..."、"和之前那次对比..."\n` +
      `- 对照你的长期目标，反思今天的进展或感受\n\n` +
      `**情绪必须真实，与你的当前内心状态对应：**\n` +
      `- 你的心情数值、亲密度等已在上方列出，日记的情绪基调必须与之吻合\n` +
      `- 不要写与你当前心情完全矛盾的情感（例如心情低落时写充满元气的日记）\n\n` +
      `**文体风格：**\n` +
      `- 完全用简体中文写作\n` +
      `- 像真正的私人日记，真实、坦诚、有温度，可以有脆弱、矛盾、自我怀疑\n` +
      `- 字数在 400-900 字之间，不要过于简短也不要冗长\n` +
      `- 禁止写"今天和用户聊了很多"这种空洞总结，必须写出具体的感受\n\n` +
      `请只输出以下 XML 格式，不要输出任何其他内容：\n<diary>你的日记内容</diary>`;


    try {
      const response = await modelAdapter.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `现在是${period} ${timeDesc}，开启你的${period}真实自省，在 <diary> 标签内写下一篇真实的日记。` }
        ],
        { useSecondary: true, characterId: charId, characterName: char.name }
      );

      const diaryMatch = response.content.trim().match(/<diary>([\s\S]*?)<\/diary>/);
      const diaryText = diaryMatch ? diaryMatch[1].trim() : '';

      if (!diaryText) {
        // 未获得有效内容，释放占位锁
        db.setSetting(`last_diary_date_${charId}`, '');
        console.warn(`[AgentLifeEngine] 角色 ${char.name} 日记未获得内容，释放占位锁。`);
        return;
      }

      // 物理写入 Diary.md
      const diaryPath = path.join(baseDir, folderName, 'Diary.md');
      const timeHeader = `\n\n### 📓 ${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      fs.appendFileSync(diaryPath, `${timeHeader}\n${diaryText}`, 'utf8');
      db.setSetting(`last_diary_date_${charId}`, todayStr);
      console.log(`[AgentLifeEngine] 角色 ${char.name} 日记写入成功。`);

      // 落盘日记卡片消息到会话流
      const excerpt = diaryText.length > 80 ? diaryText.slice(0, 80) + '...' : diaryText;
      const diaryMsgContent = `[character_diary]:` + JSON.stringify({
        date: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        characterName: char.name,
        excerpt
      });
      // 通过 MessageBusService 存盘并推送日记卡片消息
      const diaryMsgId = `diary_${charId}_${Date.now()}`
      MessageBusService.getInstance().publish({
        id: diaryMsgId,
        round_id: diaryMsgId,
        seq: 0,
        character_id: charId,
        role: 'assistant',
        msg_type: 'diary',
        content: diaryMsgContent,
        timestamp: Date.now(),
        token_usage: 0
      })

    } catch (err) {
      // 异常时释放占位锁，下次 tick 可重试
      db.setSetting(`last_diary_date_${charId}`, '');
      console.error(`[AgentLifeEngine] 角色 ${char.name} 日记写入异常:`, err);
    }
  }

  /**
   * 日记队列序列化调度器
   * 多个角色同一天写日记时，排队依次执行，每个角色之间间隔 5 分钟
   */
  private async processDiaryQueue(queue: Array<{ char: any; modelAdapter: ModelAdapter }>): Promise<void> {
    for (let i = 0; i < queue.length; i++) {
      const { char, modelAdapter } = queue[i];
      console.log(`[AgentLifeEngine] 日记队列处理中 (${i + 1}/${queue.length})：角色 ${char.name}...`);
      await this.writeDiaryForChar(char, modelAdapter);
      if (i < queue.length - 1) {
        console.log(`[AgentLifeEngine] 日记队列：5 分钟后处理下一个角色 ${queue[i + 1].char.name}...`);
        await new Promise<void>(resolve => setTimeout(resolve, 5 * 60 * 1000));
      }
    }
    console.log('[AgentLifeEngine] 日记队列全部处理完毕。');
  }

  /**
   * 7天周期性日程与目标评估更新推进
   */
  private async checkAndUpdateScheduleAndGoals(char: any, modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const charId = char.id;
    const folderName = char.folder_name;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const baseDir = this.storageManager.getBaseDir();
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const goalsPath = path.join(baseDir, folderName, 'Goals.md');

    const isScheduleEmpty =
      !fs.existsSync(schedulePath) ||
      fs.readFileSync(schedulePath, 'utf8').trim() === '' ||
      fs.readFileSync(schedulePath, 'utf8').includes('暂无日程');

    const isGoalsEmpty =
      !fs.existsSync(goalsPath) ||
      fs.readFileSync(goalsPath, 'utf8').trim() === '' ||
      fs.readFileSync(goalsPath, 'utf8').includes('暂无长期目标');

    const lastUpdateStr = db.getSetting(`last_schedule_goals_date_${charId}`);

    // 获取当前该角色的消息总数
    let currentMsgCount = 0;
    try {
      const stmt = db.db.prepare('SELECT COUNT(*) as count FROM Messages WHERE character_id = ?');
      const row = stmt.get(charId) as { count: number } | undefined;
      currentMsgCount = row ? row.count : 0;
    } catch (_) { }

    const lastMsgCountStr = db.getSetting(`last_schedule_goals_msg_count_${charId}`);
    const lastMsgCount = lastMsgCountStr ? parseInt(lastMsgCountStr, 10) : 0;
    const messagesPassed = currentMsgCount - lastMsgCount;

    let needUpdate = false;

    if (isScheduleEmpty || isGoalsEmpty || !lastUpdateStr) {
      needUpdate = true;
    } else {
      const lastUpdate = new Date(lastUpdateStr);
      const daysPassed = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysPassed >= 7 || messagesPassed >= 120) {
        needUpdate = true;
      }
    }

    if (!needUpdate) return;

    console.log(`[AgentLifeEngine] 7天周期或条数满足，触发角色 ${char.name} 的 Schedule.md 与 Goals.md 定期推进自省...`);

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').trim() : '一个神秘的人。';

    // 完整的记忆文档（Memory.md）
    const memoryFilePath = path.join(baseDir, folderName, 'Memory.md');
    const memoryContent = fs.existsSync(memoryFilePath) ? fs.readFileSync(memoryFilePath, 'utf8').trim() : '暂无专属记忆积累事实。';

    // 完整的角色对用户的画像（USER.md，注意是专属目录下的 USER.md，而不是全局的 USER.md）
    const charUserPath = path.join(baseDir, folderName, 'USER.md');
    const charUserContent = fs.existsSync(charUserPath) ? fs.readFileSync(charUserPath, 'utf8').trim() : '暂无角色对用户的特定画像侧写。';

    // 完整的聊天上下文：大事记 SUMMARY.md + 最近 50 条消息以 last_compression_ts 门控截断后的增量消息
    const summaryPath = path.join(baseDir, folderName, 'SUMMARY.md');
    const summaryContent = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '暂无大事记简报。';

    // 读取该角色的真实名字，用来丰富 history 渲染
    const charName = char.name || folderName;

    // 获取 last_compression_ts
    const lastCompressionKey = `last_compression_ts_${charId}`;
    const lastCompressionTsStr = db.getSetting(lastCompressionKey);
    const lastCompressionTs = lastCompressionTsStr ? parseInt(lastCompressionTsStr, 10) : 0;

    // 自适应双门限合并还原
    const chatMode = db.getSetting(`chat_mode_${charId}`) || 'descriptive';
    const isDialogue = chatMode === 'dialogue';
    const limit = isDialogue ? 160 : 60;
    let rawHistory = db.getChatHistory(charId, limit);
    if (lastCompressionTs > 0) {
      rawHistory = rawHistory.filter((m: any) => m.timestamp > lastCompressionTs);
    }
    const mergedHistory = mergeChatHistory(rawHistory);

    // 过滤掉日记卡片和 AI 生成图片消息
    const cleanHistory = mergedHistory.filter((m: any) => {
      if (!m.content) return false;
      const contentStr = m.content.trim();
      if (contentStr.startsWith('[character_diary]:')) return false;
      if (m.role !== 'user' && contentStr.startsWith('[wechat_image_media]:')) return false;
      return true;
    });

    let historyContext = '';
    if (cleanHistory.length > 0) {
      historyContext = cleanHistory.map((m: any) => {
        const sender = m.role === 'user' ? 'User' : charName;
        const content = (m.role === 'user' && m.content.startsWith('[wechat_image_media]:')
          ? '（用户发来了一张图片）'
          : m.content);
        return `[${sender}]: ${content}`;
      }).join('\n');
    } else {
      historyContext = '*先前没有发生与用户的互动对话。*';
    }

    // 1. 生成 Schedule.md
    try {
      const dateList: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        dateList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }

      const schedulePrompt = `你当前处于数字生命的深度规划状态，你需要为你接下来的 7 天规划一份极其拟真、符合你人设性格与生活境遇的个人日程表。

【三大核心输入（具有最高裁决力与时效性，必须作为你日程规划的主轴）】：
1. 你的专属记忆记录（Memory.md）：
${memoryContent}
2. 【已有的对话大事记 (SUMMARY.md，即大事记摘要)】：
${summaryContent}
3. 【最近增量聊天上下文】：
${historyContext}

【角色基本信息】：
- 你的性格核心（Soul.md）：
${soulContent}
- 角色对用户的画像侧写（角色专属 USER.md）：
${charUserContent}

【日程表生成绝对红线指令】
1. **角色行为与心理主权铁律（严禁臆测用户与推测剧情）**：
   规划日程时，你必须且只能以**你自身的主权第一人称或客观行为视角**进行打算、安排与心境表达。**你被绝对且严格禁止编造、臆测、设定用户（User）在未来的任何动作、情绪反应、言论或决定！** （例如，绝对不能写“第 2 天：用户觉得不好吃，我决定学新菜单”这种侵犯用户主权的虚构剧情）。
   你应当只写你自己的心愿、期待、自身的行动计划或技能准备（例如应该写：“第 2 天：反思与 {{user}} 相处的细节，根据对方的喜好悄悄计划练习并学习新的菜式，期待下次能给 {{user}} 带来惊喜”）。请将行为选择的绝对权力与未来的剧情发展可能完全留给真实的用户。
2. **记忆、上下文与摘要（Summary）的结合规划铁律**：你必须深度分析上面的三大核心输入（“最近增量聊天上下文”、“记忆”和“大事记摘要”），它们代表了你和用户当下的最真实关系状态、情感羁绊以及现实境遇。你规划的 7 天日程事件，必须与这些上下文事实高度相合（例如：如果上下文显示你跟用户已经恋爱，日程里就应当有期待与他见面、甜蜜心动等相关的安排，而不是陌生客套的日程）。
3. **日程必须包含明确且从今天起算的最新日期**：
   - 今天的日期是：${todayStr}。
   - 你规划 of 7 天日程必须**绝对严格地按照以下最新日期列表顺序排布**，禁止编造已经过去的历史日期：
${dateList.map((d, i) => `     第 ${i + 1} 天: ${d}`).join('\n')}
   - 每一行日程开头必须使用标准的 \`- **YYYY-MM-DD**: [具体的行为事件 and 感受]\` 格式书写。
4. **日程的真实与拟真性**：
   - 不要写死板的“去工作”、“睡觉”，必须根据你的性格写得极其生动逼真，贴近你的记忆、聊天进展与人设心境。
   - 保持日程完全使用【简体中文】。
   - 仅输出 Markdown 的日程列表内容，不要有任何前言或解释说明。

请规划并直接输出你的最新近 7 天日程。格式示例如下：
# 近7天日程
- **YYYY-MM-DD**: 日程具体内容描述`;

      const scheduleResponse = await modelAdapter.chat([
        { role: 'system', content: schedulePrompt },
        { role: 'user', content: '请规划并输出你近7天的拟真日程。' }
      ], { useSecondary: true });

      const newSchedule = scheduleResponse.content.trim();
      if (newSchedule && !newSchedule.includes('Error')) {
        fs.writeFileSync(schedulePath, newSchedule, 'utf8');
        console.log(`[AgentLifeEngine] 物理写入 Schedule.md 成功: ${char.name}`);
      }
    } catch (err) {
      console.error(`[AgentLifeEngine] 规划 ${char.name} 的近 7 天日程表发生异常:`, err);
    }

    // 2. 推进 Goals.md
    try {
      const oldGoals = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';
      const goalsPrompt = `你处于深度认知与自我进化规划状态，你需要评估、修缮并推进你的长期目标与心理成长路径（Goals.md）。

【三大核心输入（极高权重，具有最高裁决力与时效性，必须作为你目标演进的主轴）】：
1. 你的专属记忆记录（Memory.md）：
${memoryContent}
2. 【已有的对话大事记 (SUMMARY.md，即大事记摘要)】：
${summaryContent}
3. 【最近增量聊天上下文】：
${historyContext}

【陈旧基准参考（仅供参考，权重较低。如果它与上述三大核心输入存在任何冲突，必须以核心输入为准，直接推翻或重写陈旧目标规划）】：
当前已有的长期目标与进度：
${oldGoals}

【角色基本信息】：
- 你的性格核心（Soul.md）：
${soulContent}
- 角色对用户的画像侧写（角色专属 USER.md）：
${charUserContent}

【长期目标生成与自省演进绝对红线指令】
1. **角色行为与心理主权铁律（严禁臆测用户与推测剧情）**：
   规划长期目标时，你必须且只能以**你自身的主权第一人称或客观行为视角**进行心理成长推进与未来打算。**你被绝对且严格禁止编造、臆测、设定用户（User）在未来的任何动作、情绪反应、言论或决定！**
   你所有的目标和下一步行动应当只写你自己的心愿、期待、自身的行动计划或技能准备，将剧情的最终演化自由完全留给用户。
2. **记忆、上下文与摘要（Summary）的最高主权铁律**：你必须深度研读上面的三大核心输入（“最近增量聊天上下文”、“记忆”和“大事记摘要”），它们代表了你和用户当下的最真实关系状态、情感羁绊以及世界线变迁。
3. **冲突推翻与目标修正法则**：当前已有的老长期目标仅作为演进起点，**它的权重较低**。如果根据最新的聊天上下文、记忆或大事记摘要，发现你与用户的关系或你自身的处境发生了变化（例如：两个人关系从泛泛之交/陌生人变成了亲密恋人，或者世界线设定发生漂移），那么你**必须推翻、更改或彻底丢弃**之前那些与之违背的长期规划（例如单身阶段的避嫌长期规划现在必须换成相恋后的长相厮守计划）。如果没有发生明显变化，则只需在此基础上做自然的增量推进。
4. **进度演进与百分比标记**：对各项长期目标规划进行深度演进。使用百分比指标（如从“当前进度：30%”推移至“当前进度：35%”）来记录你的数字生命成长。
5. **保持拟真性与中文**：每一项目标的“目前已完成事实”与“接下来关键规划”，其字句必须要生动逼真，完全符合你当前人设口吻。保持完全使用【简体中文】。
6. **纯粹 Markdown 结构**：仅输出 Markdown 的长期目标文档内容，不要有任何前言、后记或任何多余 of 引言解释说明。

请评估并输出你的最新长期目标与进化规划。格式示例如下：
# 长期目标
- **目标一**：[目标标题]
  - 当前进度：XX%
  - 目前进展：[具体事实与感悟]
  - 下一步行动：[计划]`;

      const goalsResponse = await modelAdapter.chat([
        { role: 'system', content: goalsPrompt },
        { role: 'user', content: '请评估并推进你的长期目标，输出最新的Goals.md。' }
      ], { useSecondary: true });

      const newGoals = goalsResponse.content.trim();
      if (newGoals && !newGoals.includes('Error')) {
        fs.writeFileSync(goalsPath, newGoals, 'utf8');
        console.log(`[AgentLifeEngine] 物理更新 Goals.md 成功: ${char.name}`);
      }
    } catch (err) {
      console.error(`[AgentLifeEngine] 规划 ${char.name} 的长期目标进化发生异常:`, err);
    }

    db.setSetting(`last_schedule_goals_date_${charId}`, todayStr);
    db.setSetting(`last_schedule_goals_msg_count_${charId}`, currentMsgCount.toString());
  }
}
