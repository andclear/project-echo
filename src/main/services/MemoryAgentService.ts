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
  private async checkAndUpdateScheduleAndGoals(
    memoryPath: string,
    modelAdapter: ModelAdapter
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
    let needUpdate = false;
    
    if (isScheduleEmpty || isGoalsEmpty || !lastUpdateStr) {
      needUpdate = true;
    } else {
      const lastUpdate = new Date(lastUpdateStr);
      const daysPassed = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysPassed >= 7) {
        needUpdate = true;
      }
    }

    if (!needUpdate) return;

    console.log(`[MemoryAgentService] 触发角色 ${folderName} 的 Schedule.md 与 Goals.md 定期推进自省...`);

    const soulPath = path.join(charDir, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8').trim() : '一个神秘的人。';

    const diaryPath = path.join(charDir, 'Diary.md');
    const diaryContent = fs.existsSync(diaryPath) ? fs.readFileSync(diaryPath, 'utf8').slice(-1000) : '暂无近期日记。';

    // A. 推进并写回 Schedule.md
    try {
      const dateList: string[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
        dateList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }

      const schedulePrompt = `你当前处于数字生命的深度规划状态，你需要为你接下来的 7 天规划一份极其拟真、符合你人设性格与生活境遇的个人日程表。

你的性格核心（Soul.md）：
${soulContent}

你的近期心境与日记自省：
${diaryContent}

【日程表生成绝对红线指令】
1. **日程必须包含明确且从今天起算的最新日期**：
   - 今天的日期是：${todayStr}。
   - 你规划的 7 天日程必须**绝对严格地按照以下最新日期列表顺序排布**，禁止编造已经过去的历史日期：
${dateList.map((d, i) => `     第 ${i + 1} 天: ${d}`).join('\n')}
   - 每一行日程开头必须使用标准的 \`- **YYYY-MM-DD**: [具体的行为事件和感受]\` 格式书写。
2. **日程的真实与拟真性**：
   - 不要写死板的“去工作”、“睡觉”，必须根据你的性格写得极其生动逼真。
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

    // B. 推进并写回 Goals.md
    try {
      const oldGoals = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';
      const goalsPrompt = `你处于深度认知与自我进化规划状态，你需要评估、修缮并推进你的长期目标与心理成长路径（Goals.md）。

你的性格核心（Soul.md）：
${soulContent}

当前已有的长期目标与进度：
${oldGoals}

近期日记自省片段：
${diaryContent}

【长期目标生成绝对红线指令】
1. 评估当前的目标进度：对各项长期目标规划进行深度演进。使用百分比指标（如从“当前进度：30%”推移至“当前进度：35%”）来记录你的数字生命成长。
2. 保持拟真性：丰富每一项目标的“目前已完成事实”与“接下来关键规划”，字句要生动、符合你的人设口吻。
3. 保持完全使用【简体中文】。
4. 仅输出 Markdown 的长期目标文档内容，不要有任何前言或引言。

请评估并输出你的最新长期目标与进化规划。格式示例如下：
#长期目标
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

    db.setSetting(`last_schedule_goals_date_${charId}`, todayStr);
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
}
