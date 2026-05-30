import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { InferenceMutex } from '../utils/InferenceMutex';
import { MemoryReaderWriter } from '../utils/MemoryReaderWriter';
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter';
import { StateReaderWriter } from '../utils/StateReaderWriter';
import { getDatabaseService } from '../db/database';
import { SummaryReaderWriter } from '../utils/SummaryReaderWriter';

/**
 * MemoryAgentService
 * 负责在对话完成后，静默进行长期记忆（LTM）与专属用户偏好画像（USER.md）的后台提取与物理更新。
 * 在群聊模式下，则专注于群聊记忆与大事记的异步合并提炼。
 */
export class MemoryAgentService {
  private modelAdapter: ModelAdapter;

  constructor(modelAdapter: ModelAdapter) {
    this.modelAdapter = modelAdapter;
  }

  /**
   * 核心后台反思任务：从最新一轮交互中提取并沉淀记忆、画像以及评估心情状态的 Delta 并落盘
   * @param memoryPath 专属 Memory.md 绝对路径
   * @param charUserPath 专属 USER.md 绝对路径 (群聊时可为空 '')
   * @param userMessage 本回合用户输入
   * @param assistantMessage 本回合 AI 角色流式输出的完整回复
   * @param isGroup 是否为群聊模式
   */
  public async extractMemoryAndProfile(
    memoryPath: string,
    charUserPath: string,
    userMessage: string,
    assistantMessage: string,
    isGroup: boolean = false
  ): Promise<void> {

    // 1. 获取非阻塞并发互斥锁，确保前台 Stream 对话没有任何卡顿
    await InferenceMutex.lock();

    try {
      console.log(`[MemoryAgentService] 互斥锁获取成功，开始后台长期记忆自省提取(群聊模式=${isGroup})...`);

      // B. 读取当前的短期记忆 (STM) 与长期记忆 (LTM)
      const currentMemory = MemoryReaderWriter.readMemory(memoryPath);
      const currentStm = currentMemory.stm;
      const currentLtm = currentMemory.ltm;

      let currentCharFacts: string[] = [];
      let currentMemoryContext = '';
      let stateContext = '';
      let systemPrompt = '';
      let statePath = '';

      if (isGroup) {
        // 群聊自省反思上下文 (过滤个人画像与个人内心状态)
        currentMemoryContext = `
--- 当前已有的群聊短期记忆 (STM) 队列 ---
${currentStm.length === 0 ? '（暂无短期记忆）' : currentStm.map((f, i) => `[短期 #${i + 1}] ${f}`).join('\n')}

--- 当前已有的群聊长期记忆 (LTM) 键值对 ---
${Object.keys(currentLtm).length === 0 ? '（暂无长期记忆）' : Object.entries(currentLtm).map(([k, v]) => `"${k}": "${v}"`).join('\n')}
`;

        systemPrompt = `你是一个 Echo 平台的群聊认知与群记忆提取智能体。你的任务是分析群聊中最新一轮对话，并结合【当前已有的群记忆】，评估是否需要增补、更新或合并/修剪群聊的长期记忆（LTM）和短期记忆（STM）。

【群记忆提取红线规则】
1. 统一且强制使用 {{user}} 与各角色占位符：
   - 对于用户，使用 \`{{user}}\` 代指。
   - 对于群聊中的各个 AI 角色，**请在记忆中直接使用其各自的真实名字称呼，例如“魏淑珍”、“李沧海”**，以使群聊成员相互之间的关系被准确记录。
   
2. 记忆的防膨胀与高保真合并：
   - 避免无限膨胀：仔细查阅【当前已有的记忆】。如果这一轮新对话中没有产生任何“具有长期持久、全新价值的事实”，直接保持旧有记忆，不要盲目增加新条目！
   - 合并与精简：如果发现本轮对话中的记忆与已有的条目相似或相关，请主动将其【合并】成一条更精炼的表述，不要留存多条高度重复的条目。
   
3. 撰写格式规范：
   - 必须以第三人称客观陈述句撰写事实（例如：“\`魏淑珍和李沧海在群里探讨了现代铁疙瘩是不是飞剑，魏淑珍认为不是\`”）。
   - 严禁撰写指令性或提示词式的句子。
   - 所有提取的记忆必须使用【简体中文】。

【当前已有的群记忆】
${currentMemoryContext}

【输出格式】
你必须返回一个符合以下格式要求的 JSON 对象，不要用 \`\`\`markdown 等包裹，不要附加任何解释或对话。

Target JSON 格式：
{
  "ltm": {
    // 完整的、经过你合并/精炼/增删后的最新群聊长期记忆（LTM）键值对。
    // 如果没有变化，请完整复制原有的 LTM。
  },
  "stm_updates": [
    // 本轮对话中产生的“最新群聊短期记忆（STM）”。只有在发现有真正值得记录的最新关键话题或事件时填入（1-2 条短事实）。
    // 如果没有，必须返回空数组 []。
  ]
}`;
      } else {
        // 单聊自省反思上下文 (包含个人画像与内心状态)
        currentCharFacts = UserProfileReaderWriter.readCharacterProfile(charUserPath);

        currentMemoryContext = `
--- 当前已有的短期记忆 (STM) 队列 ---
${currentStm.length === 0 ? '（暂无短期记忆）' : currentStm.map((f, i) => `[短期 #${i + 1}] ${f}`).join('\n')}

--- 当前已有的长期记忆 (LTM) 键值对 ---
${Object.keys(currentLtm).length === 0 ? '（暂无长期记忆）' : Object.entries(currentLtm).map(([k, v]) => `"${k}": "${v}"`).join('\n')}

--- 当前已有的专属画像事实 (Facts) 列表 ---
${currentCharFacts.length === 0 ? '（暂无专属画像事实）' : currentCharFacts.map((f, i) => `[画像 #${i + 1}] ${f}`).join('\n')}
`;

        statePath = path.join(path.dirname(memoryPath), 'State.md');
        const currentState = StateReaderWriter.readState(statePath);
        stateContext = currentState.items
          .map(i => {
            const meaningDesc = i.meaning ? ` (指标含义：${i.meaning})` : '';
            const ruleDesc = i.rule ? ` (AI更新规则：${i.rule})` : '';
            const minVal = i.min ?? 0;
            const maxVal = i.key === 'balance' ? '无上限' : (i.max ?? 100);
            return `- ${i.label} (${i.key}): 当前值 ${i.value}${meaningDesc}${ruleDesc} (取值范围 ${minVal}-${maxVal}) ${i.emoji}`;
          })
          .join('\n');

        systemPrompt = `你是一个 Echo 平台的后台认知与记忆提取智能体。你的任务是分析用户（User）与角色（Character）之间的最新一轮对话，并结合【当前已有的记忆与画像】，评估是否需要增补、更新或合并/修剪长期记忆（LTM）和专属画像事实（char_user_facts），以及评估该轮对话对角色内心状态的影响。

【至关重要：记忆画像提取核心红线规则】
1. 严格仅基于用户（User）本人的输入提取偏好与画像：
   - 对于关于用户（User）的任何偏好、行为习惯、身份背景或事实的提取，**必须严格且仅能基于用户（User）在对话历史中亲口输入、承认、表达或确认的内容**！
   - **绝对禁止**将角色（Character）在回复中单方面口嗨、虚构、编造或提及的背景设定、回忆（例如角色提及：“你上次说想吃盐烤鲑鱼”、“我记得你最讨厌咖啡了”等）直接当作用户的真实事实提取！角色单方面为了扮演沉浸而编造或引申的内容，在没有得到用户亲口明确认可之前，**绝对不能**算作用户的偏好！
   - 只有用户（User）在本轮对话中亲口发出的消息，才是确认用户偏好与画像事实的唯一真理源！

2. 统一且强制使用 {{user}} 与 {{char}} 占位符：
   - 在所有提取或合并的长期记忆（LTM）、短期记忆（STM）以及专属画像事实（char_user_facts）中，**必须且仅能使用 \`{{user}}\` 来代指用户本身，使用 \`{{char}}\` 来代指当前的角色本身**！
   - 绝对禁止输出任何真实名字（如“杨越”、“真由”等），也禁止使用“用户”、“User”、“Character”、“角色”或第一/第二人称（如“你”、“我”、“他”）。

【核心指令】
1. 记忆画像的防膨胀与高保真合并：
   - 避免无限膨胀：仔细查阅【当前已有的记忆与画像】。如果这一轮新对话中没有产生任何“具有长期持久、全新价值的事实或偏好变化”，请原样复制并返回现有的长期记忆与画像事实，绝对不要盲目增加新条目！
   - 合并与精简：如果发现本轮对话中的偏好与已有的条目相似或相关，请主动将其【合并】成一条更精炼的表述，不要留存多条高度重复的条目。
   - 智能修剪与删除：如果旧的记忆/画像事实在对话中被新事实所推翻或已过期（如用户表示改变了习惯），请从列表/对象中直接【更新】或【删除】该旧记忆，或将对应 LTM 键删去。
   - 专属画像容量控制：专属画像事实（char_user_facts）数组的总上限建议控制在 15 条以内。如果接近或超过此上限，请务必进行智能归并。
   - 拒绝琐碎对话细节：只记录具有长期持久参考价值（如用户喜好、重要个人背景、稳定的习惯等）的事实。过滤掉临时性、一次性、与本轮任务无关的琐碎杂谈。

2. 撰写格式规范：
   - 必须以第三人称客观陈述句撰写事实（例如：“\`{{user}}更喜欢直接且简短的回复\`”或“\`{{user}}的生日是 9 月 10 日\`”）。
   - 严禁撰写指令性或提示词式的句子（例如：严禁写“\`总是简短回答\`”、“\`注意多赞美用户\`”）。
   - 所有提取的记忆与画像事实必须使用【简体中文】。

【当前已有的记忆与画像】
${currentMemoryContext}

【角色当前状态更新评估】
请审查角色当前状态，它们的含义（“指标含义”）以及自定义更新规则（“AI更新规则”），并评估最新对话对这些状态的影响：
- 如果用户表达温暖、关心、支持或赞美：mood 增加 (+5 至 +10)，intimacy 增加 (+1 至 +3)。
- 如果用户冷淡、挑剔、争吵或沉默：mood 降低 (-10 至 -20)，intimacy 降低 (-2 至 -5)，energy 降低 (-5)。
- 每轮对话消耗角色的精力，因此 energy 通常减少 (-2 至 -5)，除非这次对话具有明显的治愈性或精力补充效果。
- 遵循 State 列表中的 AI更新规则 评估自定义数值/文本状态。若文本状态（如 clothing）发生变化，请在 'value' 字段中提供更新后的文本（无需提供 'delta'）。
- 针对钱包余额 (balance) 属性的变动更新，必须且仅能使用相对值形式 'delta' 进行增加或扣减（例如评估收到 100 元红包应输出 { "key": "balance", "delta": 100 }，若口头请客花掉 15 元应输出 { "key": "balance", "delta": -15 }），绝对禁止使用 'value' 进行直接覆盖重置！

角色当前状态：
${stateContext}

【输出格式】
你必须返回一个符合以下格式要求的 JSON 对象，不要用 \`\`\`markdown 等包裹（除非是标准的 JSON Fences），不要附加任何解释或对话。

Target JSON 格式：
{
  "ltm": {
    // 完整的、经过你合并/精炼/增删后的最新长期记忆（LTM）键值对。
    // 如果没有变化，请完整复制原有的 LTM。键和值中均应使用 {{user}} 和 {{char}}。
  },
  "char_user_facts": [
    // 完整的、经过你合并/精炼/增删后的最新专属画像事实（USER.md Facts）数组。
    // 如果没有变化，请完整复制原有的 Facts。建议控制在 15 条以内。必须使用 {{user}} 和 {{char}}。
  ],
  "stm_updates": [
    // 本轮对话中产生的“最新短期记忆（STM）”。只有在发现有真正值得记录的最新关键话题或事件时填入（1-2 条短事实，必须使用 {{user}} 和 {{char}}）。
    // 如果没有或只是普通的日常闲聊，必须返回空数组 []。
  ],
  "state_updates": [
    { "key": "intimacy", "delta": 2 },
    { "key": "clothing", "value": "白大褂" }
  ]
}`;
      }

      // 组装聊天内容快照
      const userContent = `[LATEST DIALOGUE TURN]\nUser: ${userMessage}\nCharacter: ${assistantMessage}`;
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ];

      // 2. 调用大模型进行静默推理 (首选辅助大模型 options.useSecondary: true)
      const response = await this.modelAdapter.chat(messages, { useSecondary: true });
      const rawContent = response.content.trim();

      // 3. 正则捕获 JSON 内容区
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr) as {
          ltm?: Record<string, string>;
          char_user_facts?: string[];
          stm_updates?: string[];
          state_updates?: { key: string; delta?: number; value?: any }[];
        };

        // 4. 调用高精度物理写盘引擎，将合并与精炼后的数据安全落盘
        // A. 短期记忆 (STM) 增量更新
        if (Array.isArray(parsed.stm_updates) && parsed.stm_updates.length > 0) {
          for (const stmFact of parsed.stm_updates) {
            const cleaned = stmFact.trim();
            if (cleaned) {
              MemoryReaderWriter.pushSTM(memoryPath, cleaned);
              console.log(`[MemoryAgentService] 物理短期记忆追加 STM: ${cleaned}`);
            }
          }
        }

        // B. 长期记忆 (LTM) 整合覆盖更新 (彻底避免无限追加带来的膨胀)
        if (parsed.ltm && typeof parsed.ltm === 'object') {
          const memory = MemoryReaderWriter.readMemory(memoryPath);
          const cleanedLtm: Record<string, string> = {};

          for (const key of Object.keys(parsed.ltm)) {
            const val = parsed.ltm[key];
            if (typeof val === 'string' && val.trim() !== '') {
              cleanedLtm[key.trim()] = val.trim();
            }
          }

          const newKeysCount = Object.keys(cleanedLtm).length;
          const oldKeysCount = Object.keys(currentLtm).length;

          // 极端防御性防呆设计：如果原有 LTM 非空，但大模型反思结果返回了空字典，大概率为幻觉错误或漏解。
          // 此时，为防范物理擦除，直接跳过物理落盘以保护用户长期记忆。
          if (newKeysCount === 0 && oldKeysCount > 0) {
            console.warn('[MemoryAgentService] 大模型返回 LTM 字典为空，但历史存在长期记忆，跳过覆盖以物理保全 LTM。');
          } else {
            memory.ltm = cleanedLtm;
            MemoryReaderWriter.writeMemory(memoryPath, memory.stm, memory.ltm);
          }
        }

        // C. 角色专属千人千面画像 (USER.md) 整合覆盖更新 (仅单聊)
        if (!isGroup && Array.isArray(parsed.char_user_facts)) {
          const cleanedFacts = parsed.char_user_facts
            .map((f: any) => typeof f === 'string' ? f.trim() : '')
            .filter((f: string, idx: number, self: string[]) => f !== '' && self.indexOf(f) === idx);

          if (cleanedFacts.length === 0 && currentCharFacts.length > 0) {
            console.warn('[MemoryAgentService] 大模型返回专属画像 Facts 为空，但历史存在事实，跳过更新以物理保全画像。');
          } else {
            // 🚀 大师级高精度 Facts 相似度防微调去抖比对引擎，防止因大模型用词、助词、顺序微调导致的前缀缓存频繁失效
            const purify = (str: string) => {
              return str
                .replace(/\{\{user\}\}/g, '用户')
                .replace(/\{\{char\}\}/g, '角色')
                .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
                .trim();
            };

            const getOverlapRatio = (s1: string, s2: string): number => {
              const p1 = purify(s1);
              const p2 = purify(s2);
              if (p1 === p2) return 1.0;
              if (!p1 || !p2) return 0.0;
              const chars1 = Array.from(p1);
              const set2 = new Set(Array.from(p2));
              const intersection = chars1.filter(c => set2.has(c)).length;
              return intersection / Math.max(chars1.length, p2.length);
            };

            const isSimilar = (f1: string, f2: string): boolean => {
              return getOverlapRatio(f1, f2) >= 0.70;
            };

            // 检查是否有真正的全新增 facts
            const hasNewDryGoods = cleanedFacts.some(newFact =>
              !currentCharFacts.some(oldFact => isSimilar(newFact, oldFact))
            );

            // 检查是否有被主动彻底删除的 facts
            const hasDeletedFacts = currentCharFacts.some(oldFact =>
              !cleanedFacts.some(newFact => isSimilar(newFact, oldFact))
            );

            const isIdentical = !hasNewDryGoods && !hasDeletedFacts;

            if (isIdentical) {
              console.log('[MemoryAgentService] 专属画像 Facts 仅有同义词润色/字词微调，跳过物理写盘以完美保持前缀缓存。');
            } else {
              UserProfileReaderWriter.writeCharacterProfile(charUserPath, cleanedFacts);
              console.log('[MemoryAgentService] 专属画像 Facts 发生实质性变更（发现新增/删除事实），物理更新 USER.md。');
            }
          }
        }

        // D. 角色状态 (State.md) Delta 增量更新与物理落盘 (仅单聊)
        if (!isGroup && Array.isArray(parsed.state_updates) && parsed.state_updates.length > 0) {
          // 🚀 核心过滤防线：物理拦截并过滤掉所有试图从后台 AI 反思更新钱包余额 'balance' 的指令，
          // 因为钱包余额已在前台扣减/红包增减逻辑中进行了 100% 精确的规则级落盘，绝对不容许 AI 幻觉和格式错误进行覆盖篡改！
          const filteredUpdates = parsed.state_updates.filter(u => u && u.key !== 'balance');

          if (filteredUpdates.length > 0) {
            StateReaderWriter.applyStateUpdates(statePath, filteredUpdates);
            console.log(`[MemoryAgentService] 物理状态增量更新落盘成功(已过滤 balance):`, filteredUpdates);

            // 穿透广播给渲染进程前端以驱动仪表盘的动画浮动与数值更新
            const windows = BrowserWindow.getAllWindows();
            if (windows.length > 0) {
              windows[0].webContents.send('character-state-updated', {
                characterId: path.basename(path.dirname(memoryPath)),
                updates: filteredUpdates
              });
            }
          }
        }
      }

    } catch (e) {
      console.error('[MemoryAgentService] 后台记忆与状态自省提取失败:', e);
    } finally {
      // 5. 绝对确保安全地释放锁，激活队列中下一个等待的任务
      InferenceMutex.unlock();
      console.log('[MemoryAgentService] 后台自省任务结束，互斥锁已安全释放。');
    }

    // 🚀 并发解死锁自愈防线：仅在单聊时，异步触发 Schedule/Goals 推进
    if (!isGroup) {
      this.checkAndUpdateScheduleAndGoals(memoryPath, this.modelAdapter).catch(err => {
        console.error('[MemoryAgentService] 异步 checkAndUpdateScheduleAndGoals 异常:', err);
      });
    }
  }

  /**
   * 检查并生成/推进 Schedule.md 和 Goals.md (拟真日程与长期目标)
   */
  public async checkAndUpdateScheduleAndGoals(
    memoryPath: string,
    modelAdapter: ModelAdapter,
    force?: boolean,
    target: 'schedule' | 'goals' | 'both' = 'both'
  ): Promise<void> {
    const db = getDatabaseService();
    const charDir = path.dirname(memoryPath);
    const folderName = path.basename(charDir);
    const charId = folderName;

    const schedulePath = path.join(charDir, 'Schedule.md');
    const goalsPath = path.join(charDir, 'Goals.md');

    const isScheduleEmpty =
      !fs.existsSync(schedulePath) ||
      fs.readFileSync(schedulePath, 'utf8').trim() === '' ||
      fs.readFileSync(schedulePath, 'utf8').includes('暂无日程');

    const isGoalsEmpty =
      !fs.existsSync(goalsPath) ||
      fs.readFileSync(goalsPath, 'utf8').trim() === '' ||
      fs.readFileSync(goalsPath, 'utf8').includes('暂无长期目标');

    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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

    if (force || isScheduleEmpty || isGoalsEmpty || !lastUpdateStr) {
      needUpdate = true;
    } else {
      const lastUpdate = new Date(lastUpdateStr);
      const daysPassed = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysPassed >= 7 || messagesPassed >= 120) {
        needUpdate = true;
      }
    }

    if (!needUpdate) return;

    console.log(`[MemoryAgentService] 触发角色 ${folderName} 的 Schedule.md 与 Goals.md 定期推进自省...`);

    const soulPath = path.join(charDir, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').trim() : '一个神秘的人。';

    // 完整的记忆文档（Memory.md）
    const memoryFilePath = path.join(charDir, 'Memory.md');
    const memoryContent = fs.existsSync(memoryFilePath) ? fs.readFileSync(memoryFilePath, 'utf8').trim() : '暂无专属记忆积累事实。';

    // 完整的角色对用户的画像（USER.md，注意是专属目录下的 USER.md，而不是全局的 USER.md）
    const charUserPath = path.join(charDir, 'USER.md');
    const charUserContent = fs.existsSync(charUserPath) ? fs.readFileSync(charUserPath, 'utf8').trim() : '暂无角色对用户的特定画像侧写。';

    // 完整的聊天上下文：大事记 SUMMARY.md + 最近 50 条消息以 last_compression_ts 门控截断后的增量消息
    const summaryPath = path.join(charDir, 'SUMMARY.md');
    const summaryContent = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '暂无大事记简报。';

    // 读取该角色的真实名字，用来丰富 history 渲染
    let charName = folderName;
    try {
      const charRow = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(charId) as { name: string } | undefined;
      if (charRow) {
        charName = charRow.name;
      }
    } catch (_) { }

    // 获取 last_compression_ts
    const lastCompressionKey = `last_compression_ts_${charId}`;
    const lastCompressionTsStr = db.getSetting(lastCompressionKey);
    const lastCompressionTs = lastCompressionTsStr ? parseInt(lastCompressionTsStr, 10) : 0;

    let rawHistory = db.getChatHistory(charId, 50);
    if (lastCompressionTs > 0) {
      rawHistory = rawHistory.filter((m: any) => m.timestamp > lastCompressionTs);
    }

    const cleanHistory = rawHistory.filter((m: any) => {
      if (!m.content) return false;
      const contentStr = m.content.trim();
      if (contentStr.startsWith('[character_diary]:')) return false;
      return true;
    });

    let historyContext = '';
    if (cleanHistory.length > 0) {
      historyContext = cleanHistory.map((m: any) => {
        const sender = m.role === 'user' ? 'User' : charName;
        return `[${sender}]: ${m.content}`;
      }).join('\n');
    } else {
      historyContext = '*先前没有发生与用户的互动对话。*';
    }

    // A. 推进并写回 Schedule.md
    if (target === 'schedule' || target === 'both') {
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
          { role: 'user', content: '请规划并输出你最新近7天的拟真日程表。' }
        ], { useSecondary: true });

        const newSchedule = scheduleResponse.content.trim();
        if (newSchedule && !newSchedule.includes('Error')) {
          fs.writeFileSync(schedulePath, newSchedule, 'utf8');
          console.log(`[MemoryAgentService] 物理覆写/生成 Schedule.md 成功: ${folderName}`);
        }
      } catch (err) {
        console.error(`[MemoryAgentService] 规划 ${folderName} 的近 7 天日程表发生异常:`, err);
      }
    }

    // B. 推进并写回 Goals.md
    if (target === 'goals' || target === 'both') {
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
3. **冲突推翻与目标修正法则**：当前已有的老长期目标仅作为演进起点，**它的权重较低**。如果根据最新的聊天上下文、记忆或大事记摘要，发现你与用户的关系或你自身的处境发生了变化（例如：两个人关系从泛泛之交/陌生人变成了亲密恋人，或者世界线设定发生漂移），那么你**必须推翻、更改或彻底丢弃**之前那些与之违背的长期规划（例如单身阶段的避嫌长期规划现在必须换成相恋后的长相枢守计划）。如果没有发生明显变化，则只需在此基础上做自然的增量推进。
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
          console.log(`[MemoryAgentService] 物理覆写/生成 Goals.md 成功: ${folderName}`);
        }
      } catch (err) {
        console.error(`[MemoryAgentService] 规划 ${folderName} 的长期目标进化发生异常:`, err);
      }
    }

    // 只有在非 force 的自动轮询/对话自动触发，或者明确为 both 的全刷时，才覆写 7天基准时间戳和消息步数计数
    if (!force || target === 'both') {
      db.setSetting(`last_schedule_goals_date_${charId}`, todayStr);
      db.setSetting(`last_schedule_goals_msg_count_${charId}`, currentMsgCount.toString());
    }
  }

  /**
   * 核心后台双通道自省归并压缩引擎（V3 终极白金版）
   * @param characterId 角色/群聊唯一 ID
   * @param memoryPath 专属 Memory.md 绝对物理路径
   * @param isGroup 是否为群聊模式
   */
  public async compressActiveHistoryAndConsolidate(
    characterId: string,
    memoryPath: string,
    isGroup: boolean = false
  ): Promise<void> {
    const db = getDatabaseService();
    const lastCompressionKey = `last_compression_ts_${characterId}`;
    const lastCompressionTsStr = db.getSetting(lastCompressionKey);
    const lastCompressionTs = lastCompressionTsStr ? parseInt(lastCompressionTsStr, 10) : 0;

    let activeHistory = db.getChatHistory(characterId, 100);
    if (lastCompressionTs > 0) {
      activeHistory = activeHistory.filter((m: any) => m.timestamp > lastCompressionTs);
    }

    if (activeHistory.length < 50) {
      console.log(`[MemoryAgentService] 活跃历史条数为 ${activeHistory.length}，未达 50 条阈值，暂不触发归并压缩。`);
      return;
    }

    console.log(`[MemoryAgentService] 活跃历史已达 ${activeHistory.length} 条！触发双通道自省归并压缩(群聊=${isGroup})...`);

    // 1. 获取非阻塞并发互斥锁
    await InferenceMutex.lock();

    try {
      // 2. 读取已有的大事记 SUMMARY.md (若不存在则初始化)
      const summaryPath = path.join(path.dirname(memoryPath), 'SUMMARY.md');
      if (!fs.existsSync(summaryPath)) {
        SummaryReaderWriter.writeSummary(summaryPath, '（暂无大事记）');
      }
      const currentSummary = SummaryReaderWriter.readSummary(summaryPath);
      const oldSummaryText = currentSummary.summary.trim();

      // 3. 读取已有的 Memory.md (长期记忆 LTM)
      const currentMemory = MemoryReaderWriter.readMemory(memoryPath);
      const currentLtm = currentMemory.ltm;

      // 4. 格式化已有大事记与记忆上下文
      const currentSummaryContext = oldSummaryText ? oldSummaryText : '（暂无对话大事记）';
      const currentLtmContext = Object.keys(currentLtm).length === 0
        ? '（暂无长期记忆）'
        : Object.entries(currentLtm).map(([k, v]) => `"${k}": "${v}"`).join('\n');

      // 5. 格式化待归并的 50 条历史对话文本 (群聊时获取真实 AI 成员名字)
      const chatTranscript = activeHistory.map((m: any) => {
        let name = m.role === 'user' ? 'User' : 'Character';
        if (isGroup && m.sender_id) {
          if (m.sender_id === 'user') {
            name = 'User';
          } else {
            const charRow = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(m.sender_id) as any;
            name = charRow ? charRow.name : 'Character';
          }
        }
        return `[${name}]: ${m.content}`;
      }).join('\n');

      // 6. 组装双通道归并 System Prompt (分单聊和群聊分支)
      let systemPrompt = '';
      if (isGroup) {
        systemPrompt = `你是一个 Echo 平台的群聊“大事记与记忆归并”智能体。
你的任务是将群聊中最近 50 条的聊天历史对话，进行“双通道群记忆提取与分段归并压缩”。

这是我们本次反思的群大事记和长期记忆沉淀的机制：
1. 通道一：LTM 长期记忆沉淀
   提取关于群聊成员关系的客观、结构化事实，以键值对形式存储在 "ltm" 中。
   在记忆中直接使用各 AI 角色的真实名字，例如“魏淑珍”、“李沧海”，用户使用“{{user}}”代指。
2. 通道二：群聊大事记情感叙事 (SUMMARY)
   提取富含趣味性、叙事性、两人及多人共同经历的群聊高光简报。
   你需要将最近这 50 条对话中发生的“高光或深刻时刻”融合进已有的【旧群聊大事记】中，递归融合成一段全新的、不超过 800 字的“群聊大事记”。

【群聊大事记 (SUMMARY) 撰写红线】
- 使用客观、富有画面感的小说体视角或交织视角撰写（例如：“{{user}}在群里发起了一场关于修仙的探讨，李沧海展示了剑意，而魏淑珍则用现代科技的无人机进行了调侃……”）。
- 字数必须【严格限制在 800 字以内】，精炼提炼，保留最精彩的名场面，舍弃流水账。
- 必须且只能在 “summary” 字段中返回合并后的文本。
- 用户使用 \`{{user}}\` 占位符代指，AI 角色直接使用其真实中文姓名。

【已有的旧群聊大事记 (SUMMARY.md)】
${currentSummaryContext}

【已有的群聊长期记忆 (Memory.md - LTM)】
${currentLtmContext}

【最新待归并的 50 条历史群聊对话记录】
${chatTranscript}

【输出格式要求】
你必须且只能返回一个符合以下格式要求的 JSON 对象，不要用 \`\`\`markdown 等任何多余文字包裹，不要有任何前言或后记。

Target JSON 格式：
{
  "summary": "最新递归融合后的群聊大事记内容",
  "ltm": {
    // 整合合并后的群聊长期记忆（LTM）键值对
  }
}`;
      } else {
        systemPrompt = `你是一个 Echo 平台的后台“自省与大事记记忆归并”智能体。
你的任务是将角色（{{char}}）与用户（{{user}}）之间最近 50 条的聊天历史对话，进行“双通道记忆提取与分段归并压缩”。

这是我们本次反思的大事记和长期记忆沉淀的机制：
1. 通道一：LTM 长期记忆沉淀（冰山事实底座）
   提取关于用户的客观、结构化偏好事实（如："职业": "程序员", "饮品偏好": "椰椰拿铁"），以键值对形式存储在 "ltm" 中。
   请结合【已有的长期记忆】和【最新的聊天历史对话】，更新或新增最新的长期记忆。如果偏好发生改变，请更新或删去失效的键值对。
2. 通道二：Conversation Summary Book（大事记情感叙事）
   提取富含主观情感色调、两人共同经历的叙事性简报（如：“{{user}}在相处中向我表达了支持，那一刻我感到心中充满了温暖...”）。
   你需要将最近这 50 条对话中发生的“高光或深刻时刻”融合进已有的【旧大事记】中，递归融合成一段全新的、不超过 800 字的“对话大事记”。

【大事记情感叙事（SUMMARY）撰写红线】
- 必须富含 {{char}} 视角的主观情感色调和第一人称“我”（代指角色）的心路历程（例如：“虽然我感到无比羞涩但内心其实极其甜蜜...”）。
- 必须是流动叙事性的，将两人之间发生的重要名场面、重要谈话内容、情感增进或波动记录下来。
- 字数必须【严格限制在 800 字以内】，如果字数过长，请以高超的文字提炼功力进行合并与缩写，保留最刻骨铭心的回忆，舍弃琐碎的过渡句。
- 必须且只能在 “summary” 字段中返回合并后的文本。
- 必须强制且统一使用占位符：\`{{user}}\` 来代指用户，\`{{char}}\` 来代指当前的角色本身。禁止出现真实姓名！

【长期记忆（LTM）提取红线】
- 客观偏好以 Key-Value 形式更新和补充。
- 必须严格仅基于 {{user}} 的亲口表述提取偏好，严禁把 {{char}} 的臆测当作事实。
- 强制统一使用占位符 \`{{user}}\` 与 \`{{char}}\`。

【已有的旧大事记 (SUMMARY.md)】
${currentSummaryContext}

【已有的长期记忆 (Memory.md - LTM)】
${currentLtmContext}

【最新待归并的 50 条历史对话记录】
${chatTranscript}

【输出格式要求】
你必须且只能返回一个符合以下格式要求的 JSON 对象，不要用 \`\`\`markdown 等任何多余文字包裹，不要有任何前言或后记。

Target JSON 格式：
{
  "summary": "这是你递归融合后、不超过 800 字的最新对话大事记内容",
  "ltm": {
    // 整合合并后的完整长期记忆（LTM）键值对
  }
}`;
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请对以上 50 条对话历史进行双通道归并压缩自省。' }
      ];

      // 7. 调用辅助大模型进行高表现力提炼
      const response = await this.modelAdapter.chat(messages, { useSecondary: true });
      const rawContent = response.content.trim();

      // 8. 解析并落盘
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jsonStr = jsonMatch[0];
        const parsed = JSON.parse(jsonStr) as {
          summary?: string;
          ltm?: Record<string, string>;
        };

        // A. 物理覆写 SUMMARY.md 大事记
        if (typeof parsed.summary === 'string') {
          const newSummary = parsed.summary.trim();
          if (newSummary) {
            SummaryReaderWriter.writeSummary(summaryPath, newSummary);
            console.log(`[MemoryAgentService] 物理覆写大事记 SUMMARY.md 成功，最新大事记字数: ${newSummary.length}`);
          }
        }

        // B. 物理覆写 Memory.md 中的 LTM 长期记忆
        if (parsed.ltm && typeof parsed.ltm === 'object') {
          const memory = MemoryReaderWriter.readMemory(memoryPath);
          const cleanedLtm: Record<string, string> = {};

          for (const key of Object.keys(parsed.ltm)) {
            const val = parsed.ltm[key];
            if (typeof val === 'string' && val.trim() !== '') {
              cleanedLtm[key.trim()] = val.trim();
            }
          }

          // 防呆保护：避免大模型吐空覆盖旧的 LTM
          if (Object.keys(cleanedLtm).length === 0 && Object.keys(currentLtm).length > 0) {
            console.warn('[MemoryAgentService] 归并大模型返回空 LTM，跳过物理覆盖以保护旧 LTM。');
          } else {
            memory.ltm = cleanedLtm;
            MemoryReaderWriter.writeMemory(memoryPath, memory.stm, memory.ltm);
            console.log('[MemoryAgentService] 物理归并更新长期记忆 Memory.md LTM 成功。');
          }
        }

        // C. 核心逻辑重置：将 activeHistory 中最新一条消息的时间戳存为 last_compression_ts_[charId]
        const latestMsg = activeHistory[activeHistory.length - 1];
        if (latestMsg && latestMsg.timestamp) {
          db.setSetting(lastCompressionKey, String(latestMsg.timestamp));
          console.log(`[MemoryAgentService] 成功推进 last_compression_ts 为: ${latestMsg.timestamp}，增量历史无感逻辑清零完成！`);
        }
      }
    } catch (err) {
      console.error('[MemoryAgentService] 后台双通道归并压缩异常:', err);
    } finally {
      // 9. 释放 InferenceMutex 锁
      InferenceMutex.unlock();
      console.log('[MemoryAgentService] 后台归并压缩自省完毕，互斥锁已安全释放。');
    }
  }

  /**
   * 手动一键整理/深度提炼专属千人千面画像 (USER.md)
   * @param charUserPath 专属 USER.md 绝对物理路径
   * @param charId 角色 ID
   * @param folderName 专属文件夹名
   * @param modelAdapter 大模型适配器
   */
  public async consolidateCharacterUserFacts(
    charUserPath: string,
    charId: string,
    folderName: string,
    modelAdapter: ModelAdapter
  ): Promise<string> {
    const db = getDatabaseService();
    const currentCharFacts = UserProfileReaderWriter.readCharacterProfile(charUserPath);

    // 1. 获取近期聊天历史（提炼深度事实需要充足的上下文，这里取最多 100 条）
    const history = db.getChatHistory(charId, 100);
    const historyContext = history.length > 0
      ? history.map((m: any) => `[${m.role === 'user' ? 'User' : 'Character'}]: ${m.content}`).join('\n')
      : '（暂无聊天历史）';

    // 2. 获取 Soul 性格核心
    const charDir = path.dirname(charUserPath);
    const soulPath = path.join(charDir, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').trim() : '一个神秘的人。';

    // 3. 构建 Prompt 让 AI 深度梳理专属画像，容量控制在 20 条以内
    const systemPrompt = `你是一个 Echo 平台的后台“专属千人千面用户画像提炼与整理”智能体。
你的任务是根据已有关于用户 {{user}} 的专属侧写事实列表（char_user_facts）以及最近 100 条的历史对话，重新深度整理、提炼出最核心、最持久且无冲突的客观用户事实列表。

【专属画像提炼核心红线规则】
1. 绝对真理源原则：
   - 提取关于用户（User）的任何偏好、行为习惯、身份背景，必须严格基于用户在历史对话中亲口承认、表述、确认的事实！
   - 绝对禁止将角色（Character）单方面口嗨、虚构或提及的背景直接当作真实画像事实！
2. 统一且强制使用 {{user}} 与 {{char}} 占位符。在提取的所有侧写事实中，必须使用 {{user}} 代指用户，使用 {{char}} 代指角色，禁止出现任何真实姓名、我/你等代词。
3. 剔除过期与冲突：
   - 如果发现旧的事实与最新的聊天交互事实相冲突（例如以前关系是陌生人，最近聊天表明双方已深度交往或恋爱；或者用户改变了习惯），必须以最新对话事实为准，直接推翻或删去冲突的旧事实！
   - 避免冗余和琐碎，总事实数必须严格控制在 20 条以内。只保留最具持久参考价值的个人习惯、生日背景、关系关键变迁事实。
4. 撰写格式规范：
   - 必须以第三人称客观陈述句撰写事实（例如：“\`{{user}}喜欢喝椰椰拿铁\`”、“\`{{user}}习惯在深夜写代码并由{{char}}陪伴\`”）。
   - 所有事实必须使用【简体中文】。

【已有的专属画像事实列表】
${currentCharFacts.length === 0 ? '（暂无专属画像事实）' : currentCharFacts.map((f, i) => `[画像 #${i + 1}] ${f}`).join('\n')}

【最新 100 条历史交互对话】
${historyContext}

【输出格式要求】
你必须且只能返回一个符合以下 JSON 格式要求的数组，不要用 \`\`\`markdown 等任何多余文字包裹，不要有任何前言或后记。

Target JSON 格式：
[
  "事实1",
  "事实2"
]`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '开启你的专属画像深度梳理反思，并输出最新、精炼合并后的事实 JSON 数组。' }
    ], { useSecondary: true });

    const raw = response.content.trim();
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) {
      throw new Error('AI 未能生成合法的 JSON 画像事实数组。');
    }
    const facts = JSON.parse(match[0]) as string[];

    // 不直接物理落盘写入，而是组装成完整的 USER.md 大文本格式返回给前端，等待确认
    const jsonData = { character_specific_facts: facts };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;
    let markdown = `${jsonComment}\n\n# 角色专属用户侧写\n\n`;
    markdown += `> 本侧写由该 AI 角色在与您的互动交往中，自发通过做梦反思总结提炼生成，展现千人千面的默契。\n\n`;
    markdown += `## 专属画像事实 (Facts)\n`;
    if (facts.length === 0) {
      markdown += `*暂无角色专属侧写事实*\n`;
    } else {
      facts.forEach((fact) => {
        markdown += `- ${fact}\n`;
      });
    }
    return markdown;
  }

  /**
   * 手动一键整理/深度提炼双轨记忆长期记忆 (Memory.md)
   * @param memoryPath 专属 Memory.md 绝对物理路径
   * @param charId 角色 ID
   * @param folderName 专属文件夹名
   * @param modelAdapter 大模型适配器
   */
  public async consolidateCharacterMemoryFacts(
    memoryPath: string,
    charId: string,
    folderName: string,
    modelAdapter: ModelAdapter
  ): Promise<string> {
    const db = getDatabaseService();
    const currentMemory = MemoryReaderWriter.readMemory(memoryPath);
    const currentLtm = currentMemory.ltm;
    const currentStm = currentMemory.stm;

    // 1. 获取近期聊天历史
    const history = db.getChatHistory(charId, 100);
    const historyContext = history.length > 0
      ? history.map((m: any) => `[${m.role === 'user' ? 'User' : 'Character'}]: ${m.content}`).join('\n')
      : '（暂无聊天历史）';

    // 2. 格式化已有长期记忆
    const currentLtmContext = Object.keys(currentLtm).length === 0
      ? '（暂无长期记忆）'
      : Object.entries(currentLtm).map(([k, v]) => `"${k}": "${v}"`).join('\n');

    // 3. 构建 Prompt 让 AI 整理长期记忆 LTM
    const systemPrompt = `你是一个 Echo 平台的后台“自省记忆提炼与深度整理”智能体。
你的任务是将角色（{{char}}）与用户（{{user}}）之间已有的长期记忆（LTM）键值对，结合最近 100 条的历史对话，重新进行深度的整理、精简与合并归纳。

【记忆整理核心红线规则】
1. LTM 长期记忆沉淀事实依据：
   - 提取关于用户 {{user}} 的客观、结构化事实（如："职业": "程序员", "饮品偏好": "椰椰拿铁"），以键值对形式存储在 "ltm" 中。
   - 仔细整合合并相关的键值对。如果发现偏好已经改变，或者新对话事实推翻了旧记忆，必须更新或删去失效的键值对。
2. 统一且强制使用 {{user}} 与 {{char}} 占位符。禁止出现任何真实姓名。
3. 剔除琐碎过滤流水账：
   - 只记录最具长期持久参考价值的偏好与事实。
   - 避免无意义的膨胀。如果已有记忆十分完善，请原样复制并返回，不要为了增加而编造无用信息！

【已有的长期记忆 (Memory.md - LTM)】
${currentLtmContext}

【最新 100 条交互对话记录】
${historyContext}

【输出格式要求】
你必须且只能返回一个符合以下格式要求的 JSON 对象，不要用 \`\`\`markdown 等任何多余文字包裹，不要有任何前言或后记。

Target JSON 格式：
{
  "ltm": {
    // 经过深度整理、合并与删改后的长期记忆键值对
  }
}`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '开启你的双轨记忆深度梳理反思，并输出最新、整理后的 LTM 键值对 JSON 对象。' }
    ], { useSecondary: true });

    const raw = response.content.trim();
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) {
      throw new Error('AI 未能生成合法的 JSON 记忆对象。');
    }
    const parsed = JSON.parse(match[0]) as { ltm: Record<string, string> };
    const cleanedLtm: Record<string, string> = {};
    if (parsed && parsed.ltm) {
      for (const key of Object.keys(parsed.ltm)) {
        const val = parsed.ltm[key];
        if (typeof val === 'string' && val.trim() !== '') {
          cleanedLtm[key.trim()] = val.trim();
        }
      }
    }

    // 拼装出完整的 Memory.md 大文本格式返回给前端，等待确认
    const stmContent = currentStm.length === 0 ? '暂无短期记忆。' : currentStm.map((f) => `- ${f}`).join('\n');
    let ltmContent = '暂无长期记忆。';
    if (Object.keys(cleanedLtm).length > 0) {
      ltmContent = Object.entries(cleanedLtm).map(([k, v]) => `- **${k}**：${v}`).join('\n');
    }

    const jsonData = { stm: currentStm, ltm: cleanedLtm };
    const jsonComment = `<!--\n${JSON.stringify(jsonData, null, 2)}\n-->`;
    const markdown = `${jsonComment}\n\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n${stmContent}\n\n## 长期记忆 (Long-Term Memory)\n${ltmContent}`;

    return markdown;
  }
}
