import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabaseService } from '../src/main/db/database';

// 1. 高精度纯 JS 数据存取层 Mock，规避 native-bindings (NODE_MODULE_VERSION 冲突)
const mockSessions = new Map<string, any>();
const mockSessionStates = new Map<string, any>();
const mockMessages: any[] = [];
const mockEmbeddings: any[] = [];
const mockNextOptionsUpdates: string[] = [];

const mockDbService = {
  db: {
    prepare: (sql: string) => {
      const cleanSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      
      return {
        run: (...args: any[]) => {
          // INSERT INTO TheaterSessions
          if (cleanSql.includes('insert into theatersessions (')) {
            mockSessions.set(args[0], {
              id: args[0],
              theme_id: args[1],
              player_character: args[2],
              npc_states: args[3],
              turn_count: 0,
              updated_at: args[4]
            });
          }
          // INSERT INTO TheaterSessionStates
          else if (cleanSql.includes('insert into theatersessionstates (')) {
            mockSessionStates.set(args[0], {
              session_id: args[0],
              time_space: args[1],
              summary: args[2],
              agent_prompts: args[3],
              character_states: args[4],
              next_options: args[5],
              round_context: args[6],
              plot_state: args[7],
              character_minds: args[8]
            });
          }
          // INSERT INTO TheaterMessages
          else if (cleanSql.includes('insert into theatermessages (')) {
            mockMessages.push({
              id: args[0],
              session_id: args[1],
              role: args[2],
              content: args[3],
              metadata: args[4] || null,
              created_at: args[5] || Date.now()
            });
          }
          // UPDATE TheaterSessions
          else if (cleanSql.includes('update theatersessions set')) {
            if (cleanSql.includes('turn_count')) {
              const sess = mockSessions.get(args[2]);
              if (sess) {
                sess.npc_states = args[0];
                sess.turn_count += 1;
                sess.updated_at = args[1];
              }
            } else {
              const sess = mockSessions.get(args[1]);
              if (sess) {
                sess.npc_states = args[0];
              }
            }
          }
          // UPDATE TheaterSessionStates
          else if (cleanSql.includes('update theatersessionstates set')) {
            if (cleanSql.includes('time_space')) {
              const state = mockSessionStates.get(cleanSql.includes('round_context') ? args[2] : args[1]);
              if (state) {
                state.time_space = args[0];
                if (cleanSql.includes('round_context')) {
                  state.round_context = args[1];
                }
              }
            } else if (cleanSql.includes('summary')) {
              const state = mockSessionStates.get(args[1]);
              if (state) state.summary = args[0];
            } else if (cleanSql.includes('character_states')) {
              const state = mockSessionStates.get(args[1]);
              if (state) state.character_states = args[0];
            } else if (cleanSql.includes('agent_prompts')) {
              const state = mockSessionStates.get(args[1]);
              if (state) state.agent_prompts = args[0];
            } else if (cleanSql.includes('next_options')) {
              const state = mockSessionStates.get(args[1]);
              if (state) {
                state.next_options = args[0];
                mockNextOptionsUpdates.push(args[0]);
              }
            } else if (cleanSql.includes('plot_state')) {
              const state = mockSessionStates.get(args[2]);
              if (state) {
                state.plot_state = args[0];
                state.character_minds = args[1];
              }
            }
          }
          // INSERT INTO TheaterMessageEmbeddings
          else if (cleanSql.includes('insert into theatermessageembeddings (')) {
            mockEmbeddings.push({
              round_id: args[0],
              session_id: args[1],
              embedding_json: args[2],
              content_text: args[3]
            });
          }
          // DELETE FROM TheaterMessages
          else if (cleanSql.includes('delete from theatermessages where')) {
            const messageId = args[0];
            const sessionId = args[1];
            const idx = mockMessages.findIndex(m => m.id === messageId && m.session_id === sessionId);
            if (idx !== -1) {
              mockMessages.splice(idx, 1);
            }
          }
          return { changes: 1 };
        },
        get: (...args: any[]) => {
          if (cleanSql.includes('select * from theatersessions where')) {
            return mockSessions.get(args[0]);
          }
          else if (cleanSql.includes('select * from theatersessionstates where')) {
            return mockSessionStates.get(args[0]);
          }
          else if (cleanSql.includes('select agent_prompts from theatersessionstates where')) {
            return mockSessionStates.get(args[0]);
          }
          else if (cleanSql.includes('select character_states from theatersessionstates where')) {
            return mockSessionStates.get(args[0]);
          }
          else if (cleanSql.includes('select role, content from theatermessages where')) {
            const filtered = mockMessages.filter(m => m.session_id === args[0]);
            return filtered[filtered.length - 1];
          }
          else if (cleanSql.includes('select * from theatermessages where id = ?')) {
            return mockMessages.find(m => m.id === args[0] && (args[1] === undefined || m.session_id === args[1]));
          }
          return undefined;
        },
        all: (...args: any[]) => {
          if (cleanSql.includes('select * from theatermessages where')) {
            return mockMessages.filter(m => m.session_id === args[0]);
          }
          else if (cleanSql.includes('select round_id, embedding_json, content_text from theatermessageembeddings')) {
            return mockEmbeddings.filter(e => e.session_id === args[0]);
          }
          return [];
        }
      };
    }
  },
  getSetting: (key: string) => {
    if (key === 'model_config') {
      return JSON.stringify({
        primary: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'test' },
        enableSecondary: false
      });
    }
    return null;
  }
};

vi.mock('../src/main/db/database', () => {
  return {
    getDatabaseService: () => mockDbService
  };
});

// 2. Mock electron app 和物理测试目录
const testBaseDir = path.join(__dirname, 'temp_stage_service_test');
vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn().mockImplementation((name) => {
        if (name === 'userData') {
          return testBaseDir;
        }
        return '/tmp';
      })
    }
  };
});

// 3. Mock ModelAdapter 行为
vi.mock('../src/main/models/ModelAdapter', () => {
  return {
    ModelAdapter: vi.fn().mockImplementation(() => {
      return {
        chat: vi.fn().mockImplementation(async (messages) => {
          const systemMsg = messages.find((m: any) => m.role === 'system')?.content || '';
          
          if (systemMsg.includes('世界观初始化')) {
            return {
              content: JSON.stringify([
                {
                  name: '小红',
                  status_bars: { '生命值': 90, '疲劳度': 10 },
                  backpack: [{ name: '匕首', quantity: 1 }],
                  balance: 60
                }
              ])
            };
          }
          if (systemMsg.includes('时空监督与导演意图规划员')) {
            return {
              content: JSON.stringify({
                time_space: '傍晚，大剧院化妆间里',
                time_label: '傍晚',
                location_label: '大剧院化妆间',
                action_queue: ['小红'],
                director_intent: '让小红回应玩家质问，并把门后的异常声响推进到台前。',
                forbidden_contradictions: ['不得把当前时间改成夜晚', '不得替玩家角色行动']
              })
            };
          }
          if (systemMsg.includes('物理时空监督员')) {
            return {
              content: JSON.stringify({
                time_space: '傍晚，大剧院化妆间里',
                action_queue: ['小红']
              })
            };
          }
          if (systemMsg.includes('数值策划与状态监视器')) {
            return {
              content: JSON.stringify({
                '小红': {
                  status_bars: { '生命值': -10, '疲劳度': 20 },
                  backpack_changes: [{ action: 'add', name: '大门钥匙', quantity: 1 }],
                  balance_change: 15
                }
              })
            };
          }
          if (systemMsg.includes('角色社会关系维护观察员') || systemMsg.includes('社会关系与长线人际纽带观察员')) {
            return {
              content: JSON.stringify([])
            };
          }
          if (systemMsg.includes('大剧院主线状态维护员')) {
            return {
              content: JSON.stringify({
                mainGoal: '查清大剧院后台异常的来源',
                currentConflict: '小红隐瞒了门后声响的真实原因',
                openQuestions: ['门后是谁', '小红为什么守在化妆间'],
                knownClues: ['傍晚时化妆间传出异常声响'],
                unresolvedThreats: ['后台可能有人正在接近'],
                nextPressurePoint: '门后声响再次打断对话'
              })
            };
          }
          if (systemMsg.includes('角色心理连续性记录员')) {
            return {
              content: JSON.stringify([
                {
                  name: '小红',
                  currentEmotion: '紧张',
                  currentGoal: '拖延玩家靠近门后',
                  hiddenIntent: '隐藏门后的异常来源',
                  attitudeToPlayer: '戒备但不想撕破脸',
                  pressure: '玩家已经发现她在化妆间',
                  nextLikelyMove: '用含糊解释争取时间'
                }
              ])
            };
          }
          if (systemMsg.includes('分支设计师')) {
            return {
              content: JSON.stringify([
                { actor: '小明', title: '大步走去', strategy: '调查', action: '快速走近她', dialogue: '发生了什么？' }
              ])
            };
          }
          
          // 兜底旁白与NPC演绎
          return { content: '这是一段测试性的文本输出 [RELATION_CHANGE_REQUIRED]' };
        })
      };
    })
  };
});

// 4. Mock 向量服务
vi.mock('../src/main/services/VectorMemoryService', () => {
  return {
    VectorMemoryService: {
      getInstance: () => ({
        computeEmbedding: vi.fn().mockResolvedValue([0.15, 0.25, 0.35])
      })
    }
  };
});

// 5. Mock 生图服务
vi.mock('../src/main/services/NovelAiService', () => {
  return {
    NovelAiService: {
      generateImage: vi.fn().mockResolvedValue(Buffer.from('fake_image_binary_data'))
    }
  };
});

// 6. 引入服务
import { TheaterStageService } from '../src/main/plugins/theater/TheaterStageService';

describe('TheaterStageService 大剧院游玩阶段核心服务测试', () => {
  beforeAll(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testBaseDir, { recursive: true });
    mockSessions.clear();
    mockSessionStates.clear();
    mockMessages.length = 0;
    mockEmbeddings.length = 0;
    mockNextOptionsUpdates.length = 0;
  });

  afterAll(() => {
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  it('应当能够完整运行初始化和单步演绎回合', async () => {
    const service = new TheaterStageService();

    // 1. 物理模拟题材文件
    const themeId = 'test_theme_stage';
    const themeDir = path.join(testBaseDir, 'plugins', 'theater', themeId);
    fs.mkdirSync(themeDir, { recursive: true });

    const mockThemeJson = {
      id: themeId,
      name: '舞台测试剧本',
      world_settings: '这是一个世界观。',
      scenario: '开场剧情。',
      status_bars: [
        { name: '生命值', type: 'number', min: 0, max: 100, initialValue: 100, description: '血量' },
        { name: '疲劳度', type: 'number', min: 0, max: 100, initialValue: 0, description: '疲惫' }
      ],
      relations: [
        { from: '小明', to: '小红', type: '同伴' }
      ]
    };
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(mockThemeJson, null, 2), 'utf8');

    // 模拟角色物理文件
    const charBaseDir = path.join(themeDir, 'characters');
    fs.mkdirSync(charBaseDir, { recursive: true });

    // 角色1: 小红 (NPC)
    const xiaohongDir = path.join(charBaseDir, 'xiaohong');
    fs.mkdirSync(xiaohongDir, { recursive: true });
    fs.writeFileSync(path.join(xiaohongDir, 'meta.json'), JSON.stringify({ name: '小红', gender: '女', age: '17' }), 'utf8');
    fs.writeFileSync(path.join(xiaohongDir, 'Soul.md'), '性格外向', 'utf8');

    // 角色2: 小明 (主角玩家)
    const xiaomingDir = path.join(charBaseDir, 'xiaoming');
    fs.mkdirSync(xiaomingDir, { recursive: true });
    fs.writeFileSync(path.join(xiaomingDir, 'meta.json'), JSON.stringify({ name: '小明', gender: '男', age: '18', isUserPersona: true }), 'utf8');
    fs.writeFileSync(path.join(xiaomingDir, 'Soul.md'), '性格沉稳', 'utf8');

    // 2. 初始化游玩会话测试
    const sessionRes = await service.createSession(themeId, '小明');
    expect(sessionRes.sessionId).toBeDefined();
    expect(sessionRes.timeSpace).toBe('傍晚，大剧院化妆间里');
    expect(sessionRes.characterStates.length).toBe(2);
    expect(sessionRes.roundContext.canonicalTimeSpace).toBe('傍晚，大剧院化妆间里');
    expect(sessionRes.plotState.currentConflict).toBe('开场剧情。');
    expect(sessionRes.characterMinds.some((mind: any) => mind.name === '小红')).toBe(true);

    const xiaohongState = sessionRes.characterStates.find((s: any) => s.name === '小红');
    expect(xiaohongState).toBeDefined();
    expect(xiaohongState.status_bars['生命值']).toBe(90);
    expect(xiaohongState.backpack[0].name).toBe('匕首');
    expect(xiaohongState.balance).toBe(60);

    const xiaomingState = sessionRes.characterStates.find((s: any) => s.name === '小明');
    expect(xiaomingState).toBeDefined();
    expect(xiaomingState.status_bars['生命值']).toBe(100);

    const sessionId = sessionRes.sessionId;

    // 3. 执行单步演绎回合测试
    const dbStateBeforeStep = mockSessionStates.get(sessionId);
    dbStateBeforeStep.next_options = JSON.stringify([
      { actor: '小明', title: '旧选项', action: '观察', dialogue: '这里怎么了？' }
    ]);
    const pushedEvents: any[] = [];
    const stepRes = await service.executeStep(sessionId, '*推开门走了进来* “你果然在这里。”', (payload: any) => {
      pushedEvents.push(payload);
    });
    expect(stepRes.sessionId).toBe(sessionId);
    expect(stepRes.timeSpace).toBe('傍晚，大剧院化妆间里');
    expect(stepRes.characterStates.length).toBe(2);
    expect(pushedEvents.some((evt) => evt.type === 'next-options-cleared' && evt.sessionId === sessionId)).toBe(true);
    expect(mockNextOptionsUpdates).toContain('[]');
    expect(JSON.parse(mockSessionStates.get(sessionId).next_options)).toEqual(stepRes.nextOptions);

    // 状态结算检查
    const updatedXiaohong = stepRes.characterStates.find((s: any) => s.name === '小红');
    expect(updatedXiaohong.status_bars['生命值']).toBe(80); // 90 - 10
    expect(updatedXiaohong.status_bars['疲劳度']).toBe(30); // 10 + 20
    expect(updatedXiaohong.balance).toBe(75); // 60 + 15
    expect(updatedXiaohong.backpack.some((i: any) => i.name === '大门钥匙')).toBe(true);

    // 4. 重载会话状态测试
    const loadedState = service.getSessionState(sessionId);
    expect(loadedState.sessionId).toBe(sessionId);
    expect(loadedState.timeSpace).toBe('傍晚，大剧院化妆间里');
    expect(loadedState.roundContext.canonicalTimeSpace).toBe('傍晚，大剧院化妆间里');
    expect(loadedState.plotState.nextPressurePoint).toContain('门后声响');
    expect(loadedState.characterMinds.some((mind: any) => mind.name === '小红')).toBe(true);
    
    expect(loadedState.messages.length).toBeGreaterThanOrEqual(4);

    // 5. 修改 Agent prompts 测试
    service.updateAgentPrompts(sessionId, { narrator: '你是一个全新的旁白。' });
    const reloadedState = service.getSessionState(sessionId);
    expect(reloadedState.prompts.narrator).toBe('你是一个全新的旁白。');

    // 6. 手动修改角色状态属性值测试
    service.updateCharacterState(sessionId, '小红', {
      status_bars: { '生命值': 50 },
      balance: 100
    });
    const modifiedState = service.getSessionState(sessionId);
    const modXiaohong = modifiedState.characterStates.find((s: any) => s.name === '小红');
    expect(modXiaohong.status_bars['生命值']).toBe(50);
    expect(modXiaohong.balance).toBe(100);

    // 7. 关系自愈测试：手动模拟老旧数据库字段缺失/为空
    // 将 mock 数据库中该 SessionState 里的关系网络字段强行改空
    const dbSessState = mockSessionStates.get(sessionId);
    if (dbSessState) {
      const parsedStates = JSON.parse(dbSessState.character_states);
      for (const charState of parsedStates) {
        charState.relations = ''; // 置空关系
      }
      dbSessState.character_states = JSON.stringify(parsedStates);
    }
    
    // 调用 getSessionState，应当触发自愈并读回静态 theme.json 的配置
    const healedState = service.getSessionState(sessionId);
    const healedXiaohong = healedState.characterStates.find((s: any) => s.name === '小红');
    expect(healedXiaohong.relations).toContain('小明 → 小红 ：同伴');

    // 并且数据库里已被更新，不再是空值
    const updatedDbState = JSON.parse(mockSessionStates.get(sessionId).character_states);
    const dbXiaohong = updatedDbState.find((s: any) => s.name === '小红');
    expect(dbXiaohong.relations).toContain('小明 → 小红 ：同伴');

    // 8. 物理删除消息测试 (包含物理文件删除测试)
    // 8.1 模拟一条大剧院图片消息插入数据库
    const testMsgId = 'msg_test_image_to_delete';
    const testImgPath = path.join(themeDir, 'sessions', sessionId, 'images', 'test_delete_img.png');
    // 创建对应的虚拟图片目录和空文件
    fs.mkdirSync(path.dirname(testImgPath), { recursive: true });
    fs.writeFileSync(testImgPath, 'dummy image data');

    const metadataObj = {
      type: 'image',
      imagePath: testImgPath,
      actors: '小明'
    };

    const db = getDatabaseService();
    db.db.prepare(`
      INSERT INTO TheaterMessages (id, session_id, role, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(testMsgId, sessionId, 'system', '[插画渲染]', JSON.stringify(metadataObj), Date.now());

    // 验证文件存在
    expect(fs.existsSync(testImgPath)).toBe(true);

    // 8.2 执行删除
    const deleteRes = service.deleteMessage(sessionId, testMsgId);
    expect(deleteRes.success).toBe(true);

    // 8.3 验证数据库消息已被删除
    const checkStmt = db.db.prepare('SELECT * FROM TheaterMessages WHERE id = ?');
    const checkedMsg = checkStmt.get(testMsgId);
    expect(checkedMsg).toBeUndefined();

    // 8.4 验证物理文件已被硬删除
    expect(fs.existsSync(testImgPath)).toBe(false);
  });

  it('应当在 createSession 与 getSessionState 自愈时成功处理 {{user}} 占位符关系转换且不消失', async () => {
    const service = new TheaterStageService();

    // 1. 物理模拟题材文件
    const themeId = 'test_theme_user_relations';
    const themeDir = path.join(testBaseDir, 'plugins', 'theater', themeId);
    if (fs.existsSync(themeDir)) {
      fs.rmSync(themeDir, { recursive: true, force: true });
    }
    fs.mkdirSync(themeDir, { recursive: true });

    const mockThemeJson = {
      id: themeId,
      name: '占位符关系测试剧本',
      world_settings: '测试占位符关系。',
      scenario: '开场占位符关系测试。',
      status_bars: [
        { name: '生命值', type: 'number', min: 0, max: 100, initialValue: 100, description: '血量' }
      ],
      relations: [
        { from: '{{user}}', to: '小绿', type: '师徒' }
      ]
    };
    fs.writeFileSync(path.join(themeDir, 'theme.json'), JSON.stringify(mockThemeJson, null, 2), 'utf8');

    // 模拟角色物理文件
    const charBaseDir = path.join(themeDir, 'characters');
    fs.mkdirSync(charBaseDir, { recursive: true });

    // 角色1: 小绿 (NPC)
    const xiaolvDir = path.join(charBaseDir, 'xiaolv');
    fs.mkdirSync(xiaolvDir, { recursive: true });
    fs.writeFileSync(path.join(xiaolvDir, 'meta.json'), JSON.stringify({ name: '小绿', gender: '女', age: '15' }), 'utf8');
    fs.writeFileSync(path.join(xiaolvDir, 'Soul.md'), '性格单纯', 'utf8');

    // 角色2: {{user}} (玩家占位角色)
    const userDir = path.join(charBaseDir, 'user');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'meta.json'), JSON.stringify({ name: '{{user}}', gender: '男', age: '18', isUserPersona: true }), 'utf8');
    fs.writeFileSync(path.join(userDir, 'Soul.md'), '主角', 'utf8');

    // 2. 初始化游玩会话测试，玩家真实名字为 '赵起起'
    const playerCharName = '赵起起';
    const sessionRes = await service.createSession(themeId, playerCharName);
    expect(sessionRes.sessionId).toBeDefined();
    
    // 检查初始化的角色关系列表
    const userState = sessionRes.characterStates.find((s: any) => s.name === '{{user}}');
    expect(userState).toBeDefined();
    // 应该生成了 "赵起起 → 小绿 ：师徒" 的关系，且没有消失！
    expect(userState.relations).toContain('赵起起 → 小绿 ：师徒');

    const xiaolvState = sessionRes.characterStates.find((s: any) => s.name === '小绿');
    expect(xiaolvState).toBeDefined();
    expect(xiaolvState.relations).toContain('赵起起 → 小绿 ：师徒');

    const sessionId = sessionRes.sessionId;

    // 3. 关系自愈测试：手动置空关系，调用 getSessionState 时应当自愈生成规范化后的真实关系
    const dbSessState = mockSessionStates.get(sessionId);
    if (dbSessState) {
      const parsedStates = JSON.parse(dbSessState.character_states);
      for (const charState of parsedStates) {
        charState.relations = ''; // 置空关系
      }
      dbSessState.character_states = JSON.stringify(parsedStates);
    }

    const healedState = service.getSessionState(sessionId);
    const healedUser = healedState.characterStates.find((s: any) => s.name === '{{user}}');
    expect(healedUser.relations).toContain('赵起起 → 小绿 ：师徒');

    const healedXiaolv = healedState.characterStates.find((s: any) => s.name === '小绿');
    expect(healedXiaolv.relations).toContain('赵起起 → 小绿 ：师徒');
  });
});
