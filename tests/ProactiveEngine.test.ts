import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// 内存级高精度 mock 数据库
let mockSettings: Record<string, string> = {};
let mockHistory: any[] = [];
let mockCharacters: any[] = [];
let mockMoments: any[] = [];

// Mock 数据库服务，完全模拟 SQLite 的 prepare SQL 查询与 CRUD 接口，避开 native addon 编译版本冲突
const mockDbService = {
  db: {
    prepare: (sql: string) => {
      return {
        get: (...params: any[]) => {
          // 模拟: SELECT COUNT(*) as count FROM Moments WHERE character_id = ? AND timestamp >= ?
          if (sql.includes('SELECT COUNT(*) as count FROM Moments')) {
            const characterId = params[0];
            const minTimestamp = params[1];
            const count = mockMoments.filter(
              m => m.character_id === characterId && m.timestamp >= minTimestamp
            ).length;
            return { count };
          }
          return { count: 0 };
        },
        run: () => {
          return { changes: 1 };
        }
      };
    }
  },
  // 修复空字符串 fallback 到 null 的 mock 缺陷
  getSetting: (key: string) => mockSettings[key] !== undefined ? mockSettings[key] : null,
  setSetting: (key: string, val: string) => { mockSettings[key] = val; },
  getChatHistory: (characterId: string, limit: number) => {
    return mockHistory
      .filter(m => m.character_id === characterId)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  },
  getAllCharacters: () => mockCharacters,
  saveMessage: (msg: any) => {
    mockHistory.unshift(msg);
  },
  saveMoment: (moment: any) => {
    const idx = mockMoments.findIndex(m => m.id === moment.id);
    if (idx !== -1) {
      mockMoments[idx] = moment;
    } else {
      mockMoments.push(moment);
    }
  },
  setConversationMetaField: (characterId: string, field: string, value: any) => {
    // 留空防止 MessageBus 调用出错
  },
  getProfileBinding: (characterId: string) => {
    return null; // 防止日记后台流程抛出 TypeError: db.getProfileBinding is not a function
  },
  getConversationMeta: (characterId: string) => ({
    character_id: characterId,
    unread: 0,
    pinned: false,
    muted: false,
    hidden: false,
    last_msg_ts: Date.now()
  })
};

// 注入 mocks
vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  };
});

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => '/tmp/echo-tests-mock-proactive'
    },
    Notification: {
      isSupported: () => false
    },
    BrowserWindow: {
      getAllWindows: () => []
    }
  };
});

// Mock 大模型适配器，防止发出真实 API 调用
vi.mock('../src/main/models/ModelAdapter', () => {
  return {
    ModelAdapter: class MockModelAdapter {
      async chat() {
        return { content: '<message>你好啊！</message>' };
      }
      async *chatStream() {
        yield { content: '<message>你好啊！</message>' };
      }
    }
  };
});

// Mock AI写手，完全隔开无关的后台执行
vi.mock('../src/main/services/NovelWriterService', () => {
  return {
    NovelWriterService: class MockNovelWriterService {
      async checkAndGenerateChapter() {}
    }
  };
});

import { AgentLifeEngine } from '../src/main/services/AgentLifeEngine';
import { SocialMediaService } from '../src/main/services/SocialMediaService';
import { MessageBusService } from '../src/main/services/MessageBusService';
import { CharacterStorageManager } from '../src/main/utils/CharacterStorageManager';

describe('Echo 自主生命引擎重构 - 基于 Plan 逻辑校验测试', () => {
  const charId = 'test_character_life';
  const folderName = 'TestCharacterLife';
  let engine: AgentLifeEngine;
  let storageManager: CharacterStorageManager;
  let charPath: string;

  beforeEach(() => {
    // 开启虚拟定时器，防止测试用例之间异步 setTimeout 串流泄露
    vi.useFakeTimers();

    engine = new AgentLifeEngine();
    storageManager = new CharacterStorageManager();
    charPath = path.join(storageManager.getBaseDir(), folderName);

    // 清空内存数据库
    mockSettings = {};
    mockHistory = [];
    mockCharacters = [];
    mockMoments = [];

    // 默认注册自主生命全局默认参数
    mockDbService.setSetting('proactive_max_dialog_per_day', '2');
    mockDbService.setSetting('proactive_cooldown_hours', '3');
    mockDbService.setSetting('proactive_reserve_hours', '36');
    mockDbService.setSetting('social_max_moment_per_day', '1');
    mockDbService.setSetting('social_moment_min_interval_hours', '24');
    mockDbService.setSetting('social_max_forum_per_week', '2');

    // 必须 Mock 大模型参数，避免触发空校验强行 return 终止
    mockDbService.setSetting('model_config', JSON.stringify({ primary: {}, secondary: {} }));

    // 注入测试角色元数据
    mockCharacters.push({
      id: charId,
      name: '测试生命体',
      avatar: 'avatar.png',
      folder_name: folderName,
      created_at: Date.now()
    });

    // 创建角色的物理配置目录以通过生命引擎的 Schedule 等文件检测
    if (!fs.existsSync(charPath)) {
      fs.mkdirSync(charPath, { recursive: true });
    }
    fs.writeFileSync(path.join(charPath, 'Soul.md'), '# 测试生命体', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Memory.md'), '<!-- {"ltm": { "纪念日": "10-24创生日" }} -->', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-12**: 参加发布会', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Goals.md'), '# 长期目标', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Diary.md'), '# 日记', 'utf8');

    // Spy On / Mock 掉大模型呼叫和发帖等，避免执行具体的第三方服务
    vi.spyOn(AgentLifeEngine.prototype, 'generateActiveBehavior').mockImplementation(async (char) => {
      const activeCountStr = mockDbService.getSetting(`active_count_today_${char.id}`) || '0';
      const currentCount = parseInt(activeCountStr, 10);
      mockDbService.setSetting(`active_count_today_${char.id}`, String(currentCount + 1));
      mockDbService.setSetting(`active_last_timestamp_${char.id}`, Date.now().toString());
    });

    vi.spyOn(SocialMediaService.prototype, 'generateMoment').mockImplementation(async (char) => {
      mockDbService.saveMoment({
        id: 'm_gen_' + Math.random().toString(36).substr(2, 9),
        character_id: char.id,
        author_name: char.name,
        author_avatar: char.avatar,
        content: '自动生成的朋友圈',
        timestamp: Date.now(),
        likes: 0
      });
      return true;
    });

    vi.spyOn(SocialMediaService.prototype, 'generateForumPost').mockImplementation(async () => {
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (fs.existsSync(charPath)) {
      fs.rmSync(charPath, { recursive: true, force: true });
    }
  });

  describe('1. 唤醒门控优先级逻辑校验', () => {
    test('久未联系(missed_user)优先级最高，在同时有日程时依然触发 missed_user', () => {
      const now = new Date('2026-06-12T12:00:00');
      // 满足离线 80 小时 (久未联系触发条件)
      mockDbService.saveMessage({
        id: 'msg_1',
        character_id: charId,
        role: 'user',
        content: '你好',
        timestamp: now.getTime() - 80 * 60 * 60 * 1000
      });
      // 并且当天有日程 (2026-06-12)
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-12**: 参加发布会', 'utf8');

      // 运行检测
      const wakeResult = engine.checkWakeGate(charId, now);

      expect(wakeResult.wakeAgent).toBe(true);
      expect(wakeResult.triggerEvent?.type).toBe('missed_user');
      expect(wakeResult.triggerStrength).toBe('strong');
    });

    test('当离线未达 72 小时，但有今日日程时触发日程事件(schedule_event)', () => {
      const now = new Date('2026-06-12T12:00:00');
      // 离线只有 5 小时
      mockDbService.saveMessage({
        id: 'msg_1',
        character_id: charId,
        role: 'user',
        content: '你好',
        timestamp: now.getTime() - 5 * 60 * 60 * 1000
      });

      // 运行检测
      const wakeResult = engine.checkWakeGate(charId, now);

      expect(wakeResult.wakeAgent).toBe(true);
      expect(wakeResult.triggerEvent?.type).toBe('schedule_event');
      expect(wakeResult.triggerStrength).toBe('strong');
    });

    test('在没有日程时，检测特殊纪念日，且为 weak 触发强度', () => {
      // 修改 Schedule.md，使当天无日程
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-13**: 参加发布会', 'utf8');
      
      const now = new Date('2026-10-24T12:00:00');
      // 有交互历史，且为 now 之前 5 小时
      mockDbService.saveMessage({
        id: 'msg_1',
        character_id: charId,
        role: 'user',
        content: '你好',
        timestamp: now.getTime() - 5 * 60 * 60 * 1000
      });

      // 运行检测
      const wakeResult = engine.checkWakeGate(charId, now);

      expect(wakeResult.wakeAgent).toBe(true);
      expect(wakeResult.triggerEvent?.type).toBe('anniversary');
      expect(wakeResult.triggerStrength).toBe('weak');
    });

    test('当无日程与纪念日，但用户离线时间 >= 72h，触发 missed_user，且为 strong 强度', () => {
      // 当天无日程
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-13**: 无事', 'utf8');

      const now = new Date('2026-06-12T12:00:00');
      // 写入一条 80 小时前的聊天历史 (相对于 now)
      mockDbService.saveMessage({
        id: 'msg_old',
        character_id: charId,
        role: 'user',
        content: '再见',
        timestamp: now.getTime() - 80 * 60 * 60 * 1000
      });

      const wakeResult = engine.checkWakeGate(charId, now);
      expect(wakeResult.wakeAgent).toBe(true);
      expect(wakeResult.triggerEvent?.type).toBe('missed_user');
      expect(wakeResult.triggerStrength).toBe('strong');
    });

    test('当无其它强触发，在 07:00-08:00 期间触发清晨问候(good_morning)，触发强度为 weak', () => {
      // 当天无日程
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-15**: 无事', 'utf8');

      const morningTime = new Date('2026-06-13T07:30:00');
      // 写入一条 10 小时前的消息 (离线不超过 36 小时，且避开 72 小时强未联系)
      mockDbService.saveMessage({
        id: 'msg_recent',
        character_id: charId,
        role: 'user',
        content: '晚安',
        timestamp: morningTime.getTime() - 10 * 60 * 60 * 1000
      });

      const wakeResult = engine.checkWakeGate(charId, morningTime);
      expect(wakeResult.wakeAgent).toBe(true);
      expect(wakeResult.triggerEvent?.type).toBe('good_morning');
      expect(wakeResult.triggerStrength).toBe('weak');
    });

    test('已彻底移除 random_drift 漂移事件，不满足上述优先级时保持静默', () => {
      // 修改 Schedule，当天无日程
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-06-13**: 无事', 'utf8');

      const evalTime = new Date('2026-06-12T12:00:00');
      // 写入一条 10 小时前的消息，检测时间为中午 12:00
      mockDbService.saveMessage({
        id: 'msg_recent',
        character_id: charId,
        role: 'user',
        content: '哈喽',
        timestamp: evalTime.getTime() - 10 * 60 * 60 * 1000
      });

      const wakeResult = engine.checkWakeGate(charId, evalTime);
      expect(wakeResult.wakeAgent).toBe(false);
      expect(wakeResult.reason).toContain('未满足任何主动唤醒事件');
    });
  });

  describe('2. 延迟计划搭讪时间戳控制算法', () => {
    test('首次命中搭讪时，系统不直接呼叫 AI，仅设定未来计划搭讪时间戳，不扣减每日上限', async () => {
      const now = Date.now();
      mockDbService.saveMessage({
        id: 'msg_old',
        character_id: charId,
        role: 'user',
        content: '退了',
        timestamp: now - 80 * 60 * 60 * 1000
      });
      // 确保当天无日程
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n', 'utf8');

      // 运行生命引擎周期 tick，推进虚拟时间以推进里面的 setTimeout(..., 0)
      const p = engine.tick();
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
      await p;

      // 验证已被排程（写入了计划时间戳，且大于当前时间）
      const planTimestampStr = mockDbService.getSetting(`active_plan_timestamp_${charId}`);
      expect(planTimestampStr).not.toBeNull();
      const planTimestamp = parseInt(planTimestampStr!, 10);
      expect(planTimestamp).toBeGreaterThanOrEqual(now);
      
      // 验证未扣减每日上限（今日调用数应初始化为 0）
      const countToday = mockDbService.getSetting(`active_count_today_${charId}`);
      expect(parseInt(countToday || '0')).toBe(0);
    });

    test('在延迟等待期间，如果时间未到，再次轮询时保持跳过', async () => {
      const now = Date.now();
      // 设置一个在 1 小时后的计划搭讪时间戳
      const futureTime = now + 60 * 60 * 1000;
      mockDbService.setSetting(`active_plan_timestamp_${charId}`, futureTime.toString());
      mockDbService.setSetting(`active_plan_reason_${charId}`, '测试计划');

      // 构造离线 >= 72h 环境保证门控开启
      mockDbService.saveMessage({
        id: 'msg_old',
        character_id: charId,
        role: 'user',
        content: '再见',
        timestamp: now - 80 * 60 * 60 * 1000
      });
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n', 'utf8');

      // 运行 tick()
      const p = engine.tick();
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
      await p;

      // 验证计划时间戳没有被清除，依旧保留
      expect(mockDbService.getSetting(`active_plan_timestamp_${charId}`)).toBe(futureTime.toString());
      // 验证没有扣减次数
      expect(parseInt(mockDbService.getSetting(`active_count_today_${charId}`) || '0')).toBe(0);
    });

    test('在延迟等待期间，如果时间已到，且门控通过，触发实际发送并扣减次数，清除计划时间戳', async () => {
      const now = Date.now();
      // 设定一个在 10 分钟前的计划搭讪时间戳（已经过期）
      const pastTime = now - 10 * 60 * 1000;
      mockDbService.setSetting(`active_plan_timestamp_${charId}`, pastTime.toString());
      mockDbService.setSetting(`active_plan_reason_${charId}`, '已过期测试计划');

      // 构造离线 >= 72h 环境保证门控开启
      mockDbService.saveMessage({
        id: 'msg_old',
        character_id: charId,
        role: 'user',
        content: '再见',
        timestamp: now - 80 * 60 * 60 * 1000
      });
      fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n', 'utf8');

      // 运行 tick()
      const p = engine.tick();
      await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
      await p;

      // 验证计划时间戳已经被清除（设为 ''）
      expect(mockDbService.getSetting(`active_plan_timestamp_${charId}`)).toBe('');
      // 验证扣减了频次（次数自增为 1）
      expect(mockDbService.getSetting(`active_count_today_${charId}`)).toBe('1');
    });

    test('如果用户在此期间有互动，搭讪计划会被 MessageBus 即时物理取消', () => {
      // 模拟设定了未来的计划搭讪时间戳
      mockDbService.setSetting(`active_plan_timestamp_${charId}`, (Date.now() + 30 * 60 * 1000).toString());
      mockDbService.setSetting(`active_plan_reason_${charId}`, '等待搭讪中');

      // 用户主动向该角色发送一条消息，触发 MessageBusService
      MessageBusService.getInstance().publish({
        id: 'user_active_msg',
        round_id: 'round_1',
        seq: 0,
        character_id: charId,
        role: 'user',
        msg_type: 'text',
        content: '你在干嘛？',
        timestamp: Date.now()
      });

      // 物理取消验证：等待搭讪的相关 Settings 字段必须在瞬间全部被清空为 ''
      expect(mockDbService.getSetting(`active_plan_timestamp_${charId}`)).toBe('');
      expect(mockDbService.getSetting(`active_plan_reason_${charId}`)).toBe('');
    });
  });

  describe('3. 朋友圈 24 小时滑动窗口统计与间隔检验', () => {
    test('若 social_max_moment_per_day = 0，则完全过滤，不能生成朋友圈', async () => {
      mockDbService.setSetting('social_max_moment_per_day', '0');
      const mediaService = new SocialMediaService();

      // 满足聊天活跃条件
      mockDbService.saveMessage({
        id: 'msg_1',
        character_id: charId,
        role: 'user',
        content: '你好',
        timestamp: Date.now() - 5 * 60 * 60 * 1000
      });

      const modelAdapter: any = {};

      // 验证没有插入朋友圈 Moments 记录
      await mediaService.silentGenerateAll(modelAdapter);
      expect(mockMoments.length).toBe(0);
    });

    test('滑动窗口统计：24小时内条数超限或发圈最小间隔未满时，均拦截发圈', async () => {
      const mediaService = new SocialMediaService();
      const modelAdapter: any = {};

      // 满足聊天活跃条件
      mockDbService.saveMessage({
        id: 'msg_1',
        character_id: charId,
        role: 'user',
        content: '你好',
        timestamp: Date.now() - 5 * 60 * 60 * 1000
      });

      // 场景 A: 过去 24 小时内已经发了 1 条（上限为 1）
      mockDbService.saveMoment({
        id: 'm_1',
        character_id: charId,
        author_name: '测试生命体',
        author_avatar: 'avatar.png',
        content: '第一条朋友圈',
        timestamp: Date.now() - 10 * 60 * 60 * 1000,
        likes: 0
      });

      // 执行发朋友圈评估
      await mediaService.silentGenerateAll(modelAdapter);

      // mockMoments 条数依然是 1（没有生成新朋友圈）
      expect(mockMoments.length).toBe(1);

      // 场景 B: 24 小时上限设为 2，但未满足 social_moment_min_interval_hours = 24 小时的最小间隔
      mockDbService.setSetting('social_max_moment_per_day', '2');
      mockDbService.setSetting(`last_moment_timestamp_${charId}`, (Date.now() - 10 * 60 * 60 * 1000).toString()); // 10小时前刚发过

      await mediaService.silentGenerateAll(modelAdapter);

      // mockMoments 还是 1（由于最小间隔不到 24h 依然拦截）
      expect(mockMoments.length).toBe(1);

      // 场景 C: 最小间隔调整为 8 小时（满足冷却差值 > 8）且 24h 滑动窗口内仅发了 1 条（上限 2）
      mockDbService.setSetting('social_moment_min_interval_hours', '8');

      await mediaService.silentGenerateAll(modelAdapter);

      // 成功突破限制，物理条数变为 2
      expect(mockMoments.length).toBe(2);
    });
  });
});
