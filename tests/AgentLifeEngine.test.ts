import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// 1. 手动内存级高精度 mock 数据库服务与 electron 属性，隔绝 C++ native addons 二进制加载与 userData 运行依赖
let mockSettings: Record<string, string> = {};
let mockHistory: any[] = [];
let mockCharacters: any[] = [];

const mockDbService = {
  getSetting: (key: string) => mockSettings[key] || null,
  setSetting: (key: string, val: string) => { mockSettings[key] = val; },
  getChatHistory: (characterId: string, limit: number) => {
    // 模拟 SQLite 倒序 limit 截取
    return mockHistory.slice(0, limit);
  },
  getAllCharacters: () => mockCharacters,
  clearCharacterSettings: (characterId: string) => {
    for (const key of Object.keys(mockSettings)) {
      if (key.includes(characterId)) {
        delete mockSettings[key];
      }
    }
  }
};

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  };
});

vi.mock('electron', () => {
  return {
    app: {
      getPath: () => '/tmp/echo-tests-mock'
    },
    Notification: {
      isSupported: () => false
    },
    BrowserWindow: {
      getAllWindows: () => []
    }
  };
});

import { AgentLifeEngine } from '../src/main/services/AgentLifeEngine';
import { CharacterStorageManager } from '../src/main/utils/CharacterStorageManager';

describe('AgentLifeEngine 0-Token 唤醒门控 (Wake Gate) 内存自闭环测试', () => {
  const testCharId = 'furina_test_id';
  const testFolderName = 'FurinaTest';
  let engine: AgentLifeEngine;
  let storageManager: CharacterStorageManager;
  let charPath: string;

  beforeEach(() => {
    engine = new AgentLifeEngine();
    storageManager = new CharacterStorageManager();
    charPath = path.join(storageManager.getBaseDir(), testFolderName);

    // 重置内存数据库数据
    mockSettings = {};
    mockHistory = [];
    mockCharacters = [
      {
        id: testCharId,
        name: '芙宁娜',
        avatar: 'avatar.png',
        folder_name: testFolderName,
        created_at: Date.now()
      }
    ];

    // 创建测试角色的物理目录和必要空文件以满足 Schedule/Memory 文件解析
    if (!fs.existsSync(charPath)) {
      fs.mkdirSync(charPath, { recursive: true });
    }
    
    // 初始化角色卡基础 MD
    fs.writeFileSync(path.join(charPath, 'Soul.md'), '# 芙宁娜\n核心人设：水之歌剧院的明星。', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Memory.md'), '<!--\n{\n  "stm": [],\n  "ltm": {\n    "纪念日": "10-13芙宁娜入驻纪念日"\n  }\n}\n-->\n# 记忆', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-05-26**: 特别活动演出', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Goals.md'), '# 长期目标\n- 演出完美谢幕', 'utf8');
    fs.writeFileSync(path.join(charPath, 'Diary.md'), '# 日记', 'utf8');
  });

  // 测试清理
  afterEach(() => {
    if (fs.existsSync(charPath)) {
      fs.rmSync(charPath, { recursive: true, force: true });
    }
  });

  test('1. 无交互历史完全静默规则拦截', () => {
    // 交互消息空
    mockHistory = [];

    const wakeResult = engine.checkWakeGate(testCharId);
    expect(wakeResult.wakeAgent).toBe(false);
    expect(wakeResult.reason).toContain('从未与用户发生过聊天互动');
  });

  test('2. 消息免打扰强行关闭门控', () => {
    // 注入一条聊天消息作为交互历史
    mockHistory = [
      {
        id: 'msg_1',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，你好！',
        timestamp: Date.now(),
        token_usage: 10
      }
    ];

    // 设为免打扰 muted: true
    mockSettings[`meta_${testCharId}`] = JSON.stringify({ muted: true });

    const wakeResult = engine.checkWakeGate(testCharId);
    expect(wakeResult.wakeAgent).toBe(false);
    expect(wakeResult.reason).toContain('消息免打扰');
  });

  test('3. 久未联系 (>= 72h) 强事件门控唤醒', () => {
    // 注入最后一条消息在 4 天前 (96 小时前)
    const fourDaysAgo = Date.now() - 96 * 60 * 60 * 1000;
    mockHistory = [
      {
        id: 'msg_old',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，下次聊。',
        timestamp: fourDaysAgo,
        token_usage: 10
      }
    ];

    const wakeResult = engine.checkWakeGate(testCharId);
    expect(wakeResult.wakeAgent).toBe(true);
    expect(wakeResult.triggerStrength).toBe('strong');
    expect(wakeResult.triggerEvent?.type).toBe('missed_user');
    expect(wakeResult.reason).toContain('用户已离线');
  });

  test('4. 清晨问候 (07:00-09:00) 弱事件触发', () => {
    // 注入消息在 10 小时前 (小于 36 小时)
    const tenHoursAgo = Date.now() - 10 * 60 * 60 * 1000;
    mockHistory = [
      {
        id: 'msg_recent',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，明天见。',
        timestamp: tenHoursAgo,
        token_usage: 10
      }
    ];

    // 构造清晨时间环境: 2026-05-25 08:30:00
    const morningTime = new Date('2026-05-25T08:30:00');
    
    const wakeResult = engine.checkWakeGate(testCharId, morningTime);
    expect(wakeResult.wakeAgent).toBe(true);
    expect(wakeResult.triggerStrength).toBe('weak');
    expect(wakeResult.triggerEvent?.type).toBe('good_morning');
  });

  test('5. 今日重要日程 (Schedule.md) 强事件门控唤醒', () => {
    // 写入一个当天（2026-05-25）有具体日程的安排
    fs.writeFileSync(path.join(charPath, 'Schedule.md'), '# 近7天日程\n- **2026-05-25**: 参加水神大剧院的庆功宴', 'utf8');

    // 注入聊天历史以满足非全新静默条件
    mockHistory = [
      {
        id: 'msg_recent',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，等你的演出。',
        timestamp: Date.now() - 5 * 60 * 60 * 1000,
        token_usage: 10
      }
    ];

    // 检测时间设为当天：2026-05-25 12:00:00
    const evalTime = new Date('2026-05-25T12:00:00');

    const wakeResult = engine.checkWakeGate(testCharId, evalTime);
    expect(wakeResult.wakeAgent).toBe(true);
    expect(wakeResult.triggerStrength).toBe('strong');
    expect(wakeResult.triggerEvent?.type).toBe('schedule_event');
    expect(wakeResult.triggerEvent?.detail).toContain('参加水神大剧院的庆功宴');
  });

  test('6. 主动搭讪 2 小时冷却强拦截 (Cooldown)', () => {
    const evalTime = new Date('2026-05-25T12:00:00');
    // 注入聊天历史以满足非全新静默条件
    mockHistory = [
      {
        id: 'msg_recent',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，下次聊。',
        timestamp: evalTime.getTime() - 96 * 60 * 60 * 1000,
        token_usage: 10
      }
    ];

    // 模拟上一次搭讪时间戳在 30 分钟前 (小于 2 小时)
    const thirtyMinsAgo = evalTime.getTime() - 30 * 60 * 1000;
    mockSettings[`active_last_timestamp_${testCharId}`] = thirtyMinsAgo.toString();
    mockSettings[`active_count_today_${testCharId}`] = '1';
    mockSettings[`active_today_date_${testCharId}`] = '2026-5-25';
    mockSettings[`last_diary_date_${testCharId}`] = '2026-5-25'; // 今日已自省写过日记

    // 试图在 2026-05-25 12:00:00 (触发久未联系强事件) 进行唤醒检测
    const wakeResult = engine.checkWakeGate(testCharId, evalTime);

    // 期望：因为未满 2 小时冷却，门控强行关闭
    expect(wakeResult.wakeAgent).toBe(false);
    expect(wakeResult.reason).toContain('目前处于 2 小时搭讪冷却期内');
  });

  test('7. 主动搭讪今日 3 次上限强拦截 (Daily Limit)', () => {
    const evalTime = new Date('2026-05-25T12:00:00');
    // 注入聊天历史以满足非全新静默条件
    mockHistory = [
      {
        id: 'msg_recent',
        character_id: testCharId,
        role: 'user',
        content: '芙宁娜，下次聊。',
        timestamp: evalTime.getTime() - 96 * 60 * 60 * 1000,
        token_usage: 10
      }
    ];

    // 模拟今日已搭讪 3 次，且最后一次是在 3 小时前 (已过 2 小时冷却)
    const threeHoursAgo = evalTime.getTime() - 3 * 60 * 60 * 1000;
    mockSettings[`active_last_timestamp_${testCharId}`] = threeHoursAgo.toString();
    mockSettings[`active_count_today_${testCharId}`] = '3';
    mockSettings[`active_today_date_${testCharId}`] = '2026-5-25';
    mockSettings[`last_diary_date_${testCharId}`] = '2026-5-25'; // 今日已自省写过日记

    // 试图进行唤醒检测
    const wakeResult = engine.checkWakeGate(testCharId, evalTime);

    // 期望：因为今日已达 3 次上限，门控强行关闭
    expect(wakeResult.wakeAgent).toBe(false);
    expect(wakeResult.reason).toContain('今日主动搭讪已达 3 次上限');
  });
});
