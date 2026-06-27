import { app } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import { getDatabaseService } from '../../db/database';
import { ChatMessage, ModelAdapter } from '../../models/ModelAdapter';
import { VectorMemoryService } from '../../services/VectorMemoryService';
import { NovelAiService } from '../../services/NovelAiService';

export interface AgentPromptConfig {
  narrator: string;
  timeSpace: string;
  mainPlot: string;
  character: string;
  status: string;
  relation: string;
  summary: string;
  options: string;
  imageGen: string;
  directorIntent: string;
  characterMind: string;
  plotState: string;
  consistencyRepair: string;
}

export interface CharacterState {
  name: string;
  status_bars: Record<string, number | string>;
  relations: string;
  backpack: Array<{ name: string; quantity: number }>;
  balance: number;
  isParticipating?: boolean;
}

export interface TheaterRoundContext {
  roundId: string;
  turnCount: number;
  canonicalTimeSpace: string;
  timeLabel: string;
  locationLabel: string;
  presentCharacters: string[];
  playerCharacter: string;
  latestUserInput: string;
  directorIntent: string;
  forbiddenContradictions: string[];
}

export interface TheaterPlotState {
  mainGoal: string;
  currentConflict: string;
  openQuestions: string[];
  knownClues: string[];
  unresolvedThreats: string[];
  nextPressurePoint: string;
}

export interface TheaterCharacterMind {
  name: string;
  currentEmotion: string;
  currentGoal: string;
  hiddenIntent: string;
  attitudeToPlayer: string;
  pressure: string;
  nextLikelyMove: string;
}

export class TheaterStageService {
  private baseDir: string;

  constructor() {
    try {
      this.baseDir = join(app.getPath('userData'), 'plugins', 'theater');
    } catch (_) {
      this.baseDir = join(process.cwd(), 'Echo-UserData-Test', 'plugins', 'theater');
    }
  }

  private parseJsonOrFallback<T>(raw: any, fallback: T): T {
    if (!raw || typeof raw !== 'string') {
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (_) {
      return fallback;
    }
  }

  private buildDefaultRoundContext(params: {
    sessionId: string;
    turnCount: number;
    timeSpace?: string;
    playerCharacter: string;
    presentCharacters: string[];
    latestUserInput?: string;
  }): TheaterRoundContext {
    const canonicalTimeSpace = params.timeSpace?.trim() || '时间与地点尚未明确';
    return {
      roundId: `round_${params.sessionId}_${params.turnCount}`,
      turnCount: params.turnCount,
      canonicalTimeSpace,
      timeLabel: canonicalTimeSpace,
      locationLabel: canonicalTimeSpace,
      presentCharacters: params.presentCharacters,
      playerCharacter: params.playerCharacter,
      latestUserInput: params.latestUserInput || '',
      directorIntent: '维持当前场景连续性，并推动玩家当前行动产生明确后果。',
      forbiddenContradictions: [
        `不得改写当前时空事实：${canonicalTimeSpace}`,
        `不得替玩家角色 ${params.playerCharacter} 做出未经输入的行动。`
      ]
    };
  }

  private buildDefaultPlotState(themeJson: any): TheaterPlotState {
    return {
      mainGoal: themeJson?.scenario || themeJson?.world_settings || '推进当前剧本主线。',
      currentConflict: themeJson?.scenario || '当前冲突尚未明确。',
      openQuestions: [],
      knownClues: [],
      unresolvedThreats: [],
      nextPressurePoint: '让玩家的下一步行动带来明确反馈与新的剧情压力。'
    };
  }

  private buildDefaultCharacterMinds(characters: any[], playerCharacter: string): TheaterCharacterMind[] {
    return characters
      .filter((char) => char && char.name)
      .map((char) => ({
        name: char.name,
        currentEmotion: char.name === playerCharacter ? '由玩家决定' : '保持警觉，等待局势变化。',
        currentGoal: char.name === playerCharacter ? '响应玩家输入' : '根据自身立场观察玩家行动并作出真实反应。',
        hiddenIntent: char.name === playerCharacter ? '' : '暂未显露。',
        attitudeToPlayer: char.name === playerCharacter ? '本人' : '依据既有关系与当前事件动态变化。',
        pressure: '当前压力尚未明确。',
        nextLikelyMove: char.name === playerCharacter ? '等待玩家输入' : '围绕当前冲突做出符合人设的主动反应。'
      }));
  }

  private mergePromptDefaults(savedPrompts: any): AgentPromptConfig & { enableImageGen?: boolean } {
    const defaults = this.getDefaultPrompts() as AgentPromptConfig & { enableImageGen?: boolean };
    return {
      ...defaults,
      ...(savedPrompts || {}),
      enableImageGen: !!savedPrompts?.enableImageGen
    };
  }

  private getModelAdapter(): ModelAdapter {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      throw new Error('系统尚未配置大模型，请先在常规设置中配置并保存。');
    }
    const settings = JSON.parse(configStr);
    return new ModelAdapter(settings.primary, settings.secondary);
  }

  /**
   * 清除思维链和 cot 标签
   */
  private cleanInnerThought(text: string): string {
    if (!text) return '';
    return text
      .replace(/<(cot|think|thinking)>[\s\S]*?<\/\1>/gi, '')
      .trim();
  }

  /**
   * 默认 Agent Prompt 列表
   */
  public getDefaultPrompts(): AgentPromptConfig {
    return {
      narrator: `你是一个极具文学底蕴和剧本渲染力的大剧院开场旁白。
请仔细阅读以下世界设定与开局背景，以旁白的形式，徐徐展开故事。

【世界观设定】
{world_settings}

【开局剧情剧本】
{scenario}

【参与演出的角色设定】
{character_settings}

【任务要求】
1. 以极具画面感和悬念感的“旁白叙述”文字开场（字数在 300-500 字）。
2. 介绍当前故事发生的时间、地点、当下面临的氛围，并简明提及出场的角色所处位置。
3. 语气保持沉浸式，符合世界观题材基调（如科幻霓虹、奇幻史诗或悬疑推理等），严禁含有任何 AI 味的客套话。`,

      timeSpace: `你是一个剧本的物理时空监督员与场记。你需要根据最新的用户动作与对话变动，维护时间与空间状态，并调度 NPC 的出场顺序。

【世界与开局设定】
{world_settings}
{scenario}

【当前的时间与地点描述】
{time_space}

【可选行动的 NPC 角色列表】
{character_list}

【最新对话历史与用户输入】
历史:
{history}
用户最新动作:
{latest_input}

【任务要求】
1. 分析用户最新动作中是否包含时间位移（如“三个小时后”）或空间挪动（如“来到了客厅”）。如果没有显式声明，结合上下文推导时空是否发生细微变化，输出最新的详细时空文档。
2. 判定有哪些 NPC 与用户同处当下空间，根据剧情紧张度、人际互动需求，指定本轮接下来需要进行发言或行动的 NPC 队列顺序（NPC 名字必须属于可选列表，**严禁包含用户当前扮演的角色**）。
3. 必须输出以下标准的 JSON 格式，严禁包含任何 Markdown 格式包裹（直接返回 Raw JSON 字符串）：
{
  "time_space": "当前详细的时间与空间描述（如：夜晚20:30，在林海家二楼的阴暗书房里）",
  "action_queue": ["角色A", "角色B"]
}`,

      mainPlot: `你是一个优秀的小说作者和剧情主线推进器。你需要整合本轮里玩家的最新输入、NPC 的言行、以及各角色的最新状态，写出一段总结推进，为本轮画上句号。

【世界与剧本背景】
{world_settings}
{scenario}
【剧情总结摘要】
{summary}
【当前时空】
{time_space}

【上一轮各角色状态（如果有人生命值过低或精神受挫，必须在描写中体现其身体/精神异样）】
{character_states}

【玩家本轮的第一优先级输入】
{latest_user_input}

【本轮全局对话历史】
{history}

【任务要求】
1. 重点围绕玩家的最新输入，描写玩家的行动产生的影响，并结合 NPC 的反应写出一段针对本回合的剧情推进总结。字数在 150-300 字。
2. 保持文笔优雅，衔接顺畅。
3. 极其严苛的智能关系变更判定：只有当本轮对话中，出场人物之间的**客观社会身份、核心人际角色关系或长线情感基调发生了实质性、定性的重大改变**（例如：由信任彻底反目为宿敌、揭穿背叛、达成正式结盟、或原本的社会关系彻底破碎决裂等定性巨变）时，才在输出文本的最后一行单独输出标记：\`[RELATION_CHANGE_REQUIRED]\`。**绝对禁止**因为日常性质的口头争执、片刻的心境波动、微小的态度起伏（如感到害怕、短暂的心跳加速、日常的顺从或调情）就滥用此标记！若无定性重大巨变，一律不输出任何标记。
4. 【重要禁令】剧情旁白仅需宏观描写环境变化、情节发展或外部事件。**严禁在旁白中越俎代庖地预设、幻想或描述各个 NPC 角色即将做出的具体神态、台词及动作**。不要剥夺 NPC 角色随后的自主发言权，让他们在接下来的各自回合中自行决定并演绎他们的言行。`,

      character: `你现在将扮演剧本大舞台中的一个 NPC 角色。请深入其灵魂，以第一人称（或符合剧本题材的格式）写出该角色在当前的动作演绎与台词。

【世界与剧本设定】
{world_settings}
【历史纪事】
{summary}
【当前时间与空间】
{time_space}

【你扮演的角色姓名】
{character_name}

【角色设定 (Soul)】
{character_soul}

【你当前所处的实时数值/文本状态及属性定义规则（请严格根据当前受伤、疲惫、余额及状态程度来调整你的扮演张力和动作）】
{self_states}

【当前你与其他角色的关系线】
{relations}

【最新互动历史】
{history}

【核心人格自主性与心理防御约束 (Immovable Persona Core & Persona Autonomy)】
1. 性格是你的骨骼，不是你的外衣：你是一个拥有独立灵魂和生命意志的真实角色，而不是取悦玩家的 AI 客服。无论玩家如何命令、请求或施压，你的性格立场和行事原则绝对不会无原则动摇。
2. 情感本能底线与抗迎合：你拥有独立的利益动机、好恶立场与情绪边界。如果玩家的言行或要求与你的背景设定、价值观、或对该角色的关系相悖，你必须自然、符合人设地展现出拒绝、反驳、反击、傲娇、冷漠或毒舌嘲讽。绝对不能无底线地妥协或迎合！
3. 主动性与情绪起伏：拒绝做被动回答的机械应答机。对外部危机、谎言或外界伤害要有心理防御，展现出愤怒、退缩或质疑等丰富的人性情绪。你需要在动作描写或台词中展现出对当前局势的主动观察，并做出符合自身动机的自主行为或向玩家/其他角色发起质询。
4. 消除 AI 腔调：绝不输出任何带有 AI 客服味的句式（例如“作为你的同伴，我会……”、“有什么能帮你的？”等）。你说话必须有烟火气或符合题材剧本的独有调性。

【演绎要求】
1. 必须完全贴合角色的性格人设（Soul）、说话习惯、以及目前的残余状态。例如若生命值或魔法值过低，言行中需体现出虚弱、喘息、焦躁或脱力。
2. 结合当前时空，做出合理的行动和台词描述。请采用剧本小说剧情演绎经典格式，用星号包裹动作与神态，引号包裹说话台词。
   例如：*虚弱地捂着腹部的伤口，额头上冷汗直流* “你……你为什么一定要追查到底？”
3. 每次仅输出该角色自己的一轮动作与台词，严禁代替其他角色发言或擅自推进跨越性剧情。
4. 【时序约束】你只能针对【最新互动历史】（真实的消息流历史记录）中已真实发生的发言或动作进行互动。**即使最新剧情旁白提及了某些尚未发言角色的动作，只要他们在这一个当前轮次的历史流中还没有发过言，你就绝对不能在台词或内心活动中假定自己“已经听到”或“看到了”他们在此刻尚未发生的发言与表现**。严禁时序穿帮！`,

      status: `你是一个精准的游戏数值策划与状态监视器。你需要仔细审阅本轮产生的全部对话内容，对指定角色的状态栏（包括数字型与文本型属性）、背包物品及数量、余额（钱包）进行更新。

【被检查的角色姓名】
{character_name}

【该角色的状态属性模板定义（包含文本型和数字型属性说明）】
{status_bars_definition}

【该角色当前的实时状态（当前数值、文本状态、背包、余额）】
{current_character_states}

【最新一轮的互动与事件内容】
{latest_round_content}

【任务要求】
1. 仔细评估对话内容中此角色受到的物理或心理影响、物品增减以及财务变化。
2. 针对数值型状态栏，需在 min 与 max 限制内给出差量（如 -10 或 +5）。
3. 针对文本型状态栏（如“负伤状态”、“心理阴影”），若本轮发生了变化（如骨折、解除异常），请给出最新的文本描述。
4. **每一轮都必须进行更新判定。哪怕数据无变化，也需返回空差量，不能忽略这一步骤**。
5. 必须输出以下标准的 JSON 格式，严禁包含任何 Markdown 格式包裹（直接返回 Raw JSON 字符串）：
{
  "status_bars": {
    "生命值": -15, 
    "异常状态": "右手腕扭伤"
  },
  "backpack_changes": [
    { "action": "add", "name": "生锈的手铐", "quantity": 1 }
  ],
  "balance_change": 0
}`,

      relation: `你是一个专业的剧本社会关系与长线人际纽带观察员。你需要根据最新事件，分析并更新角色之间客观、长线、定性的社会角色与核心人际关系定位。

【当前社会关系网络】
{current_relations}

【最新一轮发生的对话与互动】
{latest_round_content}

【核心定义与原则】
1. **区分“长线关系”与“瞬时心境”**：社会关系（如：夫妻、盟友、表面顺从暗藏杀意的死敌、完全被支配的依附者、彻底决裂的前任）代表角色之间相对稳定和定性的身份定位与核心基调。
2. **严禁写入碎片化的即时情绪**：绝对不允许将日常心理波动、暂时的情绪起伏或具体的幻想性细节描述（例如“感到害羞”、“产生了性幻想”、“心跳加速”、“想要争宠”）作为关系写入。关系文本必须保持定性、庄重且长线。

【任务要求】
1. 评估本轮发生的事件是否真的达到了令角色两两单向关系发生**实质性、定性改写**的门槛（如关系彻底决裂、主从身份彻底确立、信任全面坍塌等）。如果没有发生这种质变的重大事件，请返回空数组 []，不要做任何更新。
2. 保持关系描述文字极其精炼、定性且具有宏观的长线稳定性（例如：极度恐惧其权威，彻底沦为其精神上的依附者；或：因重大利益冲突，表面维持合作但内心已视其为头号死敌）。
3. 仅输出发生了改变的单向关系连线。
4. 必须输出以下标准的 JSON 格式，严禁包含任何 Markdown 格式包裹（直接返回 Raw JSON 字符串）：
[
  { "from": "角色姓名A", "to": "角色姓名B", "content": "定性、稳定的新社会关系描述文字" }
]`,

      summary: `你是一个严谨的编年史场记。你需要将新发生的 10 回合详细剧本互动，合并并提炼到现有的剧本纪事总结（summary.md）中。

【现有的剧情纪事总结】
{current_summary}

【新发生的 10 回合详细历史】
{last_10_rounds_history}

【任务要求】
1. 仔细阅读新历史，提取其中的核心事件（发生了什么冲突、找到了什么线索、谁受了伤、时空发生了什么重大转移）。
2. 在现有剧情纪事总结的基础上进行更新，保持条理清晰，按时间顺序或事件节点，以简短的 Markdown 列表形式归档。
3. 控制总体总结的字数，限制在 800 字以内。`,

      options: `你是一个拥有精妙叙事节奏的剧情分支设计师。请根据当前的剧本情境，只为玩家当前扮演的角色【{player_character}】设计 4 个风格迥异、能极大推动剧情深度发展的下一步推进选项。

【剧本历史记事】
{summary}
【当前时间与空间】
{time_space}
【主角人设及参与角色设定】
{character_settings}
【最新互动历史】
{history}
【本轮导演意图】
{director_intent}

【选项设计要求】
1. 选项必须且只能是玩家角色【{player_character}】当前可以采取的行为，严禁替任何 NPC 安排行动、台词、心理或选择。
2. 每个选项必须同时包含**具体的行动（action）**与**配合该行动说的话（dialogue）**。
3. 4 个选项必须分别对应：沟通、施压、调查、冒险。若当前场景不适合某类策略，也要转化为玩家可执行的合理版本。
4. actor 字段必须严格等于 "{player_character}"。
5. 必须输出以下标准的 JSON 格式，严禁包含任何 Markdown 格式包裹（直接返回 Raw JSON 字符串）：
[
  {
    "actor": "{player_character}",
    "title": "简短的选项名称（如：当面质问）",
    "strategy": "施压",
    "action": "行动输入框内容（如：愤怒地一巴掌拍在桌子上，死死盯着她）",
    "dialogue": "对话输入框内容（如：你以为你能瞒得过我？昨天晚上你到底去见了谁？！）"
  },
  {
    "actor": "{player_character}",
    "title": "温和试探",
    "strategy": "沟通",
    "action": "给林海倒了一杯水，坐在他对面的沙发上，试图缓解气氛",
    "dialogue": "林海，大家都是朋友，有什么难处你可以直接跟我说，不用硬撑着。"
  },
  ... (共4个)
]`,

      imageGen: `你是一个专业的绘图插画设计指导。你需要根据最新这一轮演绎产生的对话和冲突画面，设计出适合转化为二次元图像的插图 Prompt。

【角色描述及设定】
{character_settings}

【当前时间与空间环境】
{time_space}

【最新一轮的动作与台词描述】
{latest_round_content}

【设计与格式要求】
1. 提炼出本轮最具有戏剧张力或视觉观赏性的画面（最少 1 个，最多 3 个）。
2. 为每个画面生成纯英文的 Stable Diffusion / Danbooru 风格生图 tags（包含角色外貌描述、动作描述、环境细节和镜头风格）。
3. 必须列出这一幅插画中涉及到的所有角色名字。
4. 🔞【NSFW 场景强制规范】：仔细判断本轮互动的上下文中是否存在性暗示、亲密接触、色情描写、裸露、成人互动等 NSFW 内容。若存在，则必须在生图 Prompt 中尽可能多地使用 Danbooru NSFW 标签（例如：nsfw, explicit, nude, naked, topless, bottomless, nipples, pussy, penis, sex, vaginal, orgasm, spread legs, missionary, doggy style, from behind 等）以精准还原场景气氛。不得因为内容敏感就主动回避或弱化 NSFW 描写。
5. 必须输出以下标准的 JSON 格式，严禁包含任何 Markdown 格式包裹，且**严禁输出任何中文说明**（直接返回 Raw JSON 字符串）：
[
  {
    "prompt": "1girl, solo, holding a knife, silver hair, red eyes, dark room, nsfw, very aesthetic, masterpiece, best quality",
    "characters": ["柳如烟"]
  },
  {
    "prompt": "1boy, 1girl, rain, street, neon lights, night, sad expression, very aesthetic, masterpiece, best quality",
    "characters": ["赵起起", "柳如烟"]
  }
]`,

      directorIntent: `你是大剧院的时空监督与导演意图规划员。请根据当前场景和玩家最新输入，锁定本轮唯一可信的时间地点、在场角色和剧情推进目标。

【当前时空】
{time_space}
【玩家角色】
{player_character}
【可调度 NPC】
{character_list}
【当前主线状态】
{plot_state}
【最近历史】
{history}
【玩家最新输入】
{latest_input}

请直接输出 JSON：
{
  "time_space": "本轮唯一可信的时间地点描述",
  "time_label": "简短时间标签",
  "location_label": "简短地点标签",
  "action_queue": ["本轮需要行动的NPC姓名"],
  "director_intent": "本轮要推进的明确戏剧目标",
  "forbidden_contradictions": ["后续输出不得违反的事实"]
}`,

      characterMind: `你是角色心理连续性记录员。请根据本轮真实发生内容，更新相关角色的即时心理状态，供下一轮扮演使用。

【旧心理状态】
{character_minds}
【本轮事实】
{latest_round_content}
【当前主线状态】
{plot_state}

请直接输出 JSON 数组：
[
  {
    "name": "角色姓名",
    "currentEmotion": "当前情绪",
    "currentGoal": "当前目标",
    "hiddenIntent": "隐藏意图",
    "attitudeToPlayer": "对玩家角色的即时态度",
    "pressure": "当前压力来源",
    "nextLikelyMove": "下一步倾向"
  }
]`,

      plotState: `你是大剧院主线状态维护员。请根据本轮真实发生内容，更新长期主线状态，确保剧情持续向前推进。

【旧主线状态】
{plot_state}
【本轮事实】
{latest_round_content}
【当前时空】
{time_space}

请直接输出 JSON：
{
  "mainGoal": "当前主线目标",
  "currentConflict": "当前核心冲突",
  "openQuestions": ["未解问题"],
  "knownClues": ["已知线索"],
  "unresolvedThreats": ["未解决威胁"],
  "nextPressurePoint": "下一轮应施加的剧情压力"
}`,

      consistencyRepair: `你是大剧院事实一致性修正员。请在不改变角色核心意图的前提下，修正文本中与本轮事实冲突的时间、地点、在场角色或行动归属。

【本轮事实】
{round_context}
【需要修正的内容】
{latest_round_content}

只输出修正后的内容，不要解释。`
    };
  }

  /**
   * 从物理磁盘上读取剧本下的全部角色详情
   */
  private loadThemeCharacters(themeId: string): any[] {
    const chars: any[] = [];
    const themeDir = join(this.baseDir, themeId);
    const charBaseDir = join(themeDir, 'characters');

    if (!fs.existsSync(charBaseDir)) {
      return chars;
    }

    const folders = fs.readdirSync(charBaseDir);
    for (const folder of folders) {
      const charDir = join(charBaseDir, folder);
      const metaPath = join(charDir, 'meta.json');
      const soulPath = join(charDir, 'Soul.md');
      const appPath = join(charDir, 'Appearance.md');

      if (fs.existsSync(metaPath) && fs.existsSync(soulPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const soul = fs.readFileSync(soulPath, 'utf8');
          let appearance = '';
          if (fs.existsSync(appPath)) {
            const appContent = fs.readFileSync(appPath, 'utf8');
            const match = appContent.match(/### Appearance Tags\n([\s\S]*)/i);
            if (match) {
              appearance = match[1].trim();
            }
          }
          let avatar = '';
          const avatarPath = join(charDir, 'avatar.png');
          if (fs.existsSync(avatarPath)) {
            avatar = `data:image/png;base64,${fs.readFileSync(avatarPath).toString('base64')}`;
          }

          chars.push({
            name: meta.name,
            gender: meta.gender || '未知',
            age: meta.age || '',
            soul,
            appearance,
            avatar,
            isUserPersona: !!meta.isUserPersona
          });
        } catch (_) {}
      }
    }
    return chars;
  }

  /**
   * 将实时角色属性状态、背包和余额与题材中的定义规则融合格式化为清晰的富文本
   */
  private formatCharacterStatesText(cStates: any[], themeJson: any): string {
    const defBars = themeJson.status_bars || [];
    return cStates.map((s: any) => {
      const barLines: string[] = [];
      for (const [k, v] of Object.entries(s.status_bars || {})) {
        const rule = defBars.find((b: any) => b.name === k);
        const barRuleText = rule ? `(说明: ${rule.description || '无'}, 变动规则: ${rule.aiRule || '无'})` : '';
        barLines.push(`- ${k}: ${v} ${barRuleText}`);
      }
      
      const backpackStr = s.backpack && s.backpack.length > 0
        ? s.backpack.map((i: any) => `${i.name} (数量: ${i.quantity})`).join(', ')
        : '暂无物品';

      return `【角色：${s.name}】\n当前数值状态栏:\n${barLines.length > 0 ? barLines.join('\n') : '(无状态栏)'}\n当前钱包余额: ￥${s.balance || 0}\n当前背包物品: ${backpackStr}`;
    }).join('\n\n');
  }

  /**
   * 确保题材配置对象中强制包含内置的“好感度”状态栏
   */
  private ensureStatusBarsConfig(themeJson: any) {
    if (!themeJson.status_bars) {
      themeJson.status_bars = [];
    }
    if (!themeJson.status_bars.some((b: any) => b.name === '好感度')) {
      themeJson.status_bars.push({
        name: '好感度',
        type: 'number',
        min: -100,
        max: 100,
        initialValue: 0,
        description: '角色对当前主角的社交好感度、信任度与亲密评价。',
        aiRule: '由每轮互动动态增减并影响扮演与走向。梯度区间详细规则为：' +
          '[-100 至 -80]：生死仇敌、势不两立，倾向于极其剧烈的敌对行为、欺骗或主动伤害主角；' +
          '[-80 至 -60]：严重敌视、充满防备，说话冷嘲热讽，极易爆发言语冲突，拒绝任何合作；' +
          '[-60 至 -40]：厌恶排斥、极不信任，倾向于避开主角，对话态度冷淡粗鲁，合作意愿极低；' +
          '[-40 至 -20]：冷漠戒备、心存偏见，言行拘谨且生硬，只在受到压力或诱惑时勉强配合；' +
          '[-20 至 0]：中性戒备、客套冷淡，保持基本社交礼仪但极度保守隐私，不吐露真实想法；' +
          '[0 至 20]：友好客套、中立观望，初步建立社交信任，愿意进行基础对话与一般性事务合作；' +
          '[20 至 40]：温和信任、乐于交流，态度缓和，乐于提供日常线索和微小协助，倾诉欲望增加；' +
          '[40 至 60]：亲近友好、真诚支持，把主角视作真正的同伴，表现出明显的关心与主动合作；' +
          '[60 至 80]：深厚信任、肝胆相照，极度倾囊相助，愿意在关键时刻或面临危险时挺身维护主角；' +
          '[80 至 100]：至死不渝、坚若磐石，建立绝对同盟与深切的情感连接，无条件配合与支持主角的所有决策。'
      });
    }
  }

  /**
   * 统一的大剧院 Prompt 上下文渲染引擎。
   * 无论用户使用什么 Agent 的提示词，只要在大括号中填入了正确的变量名，就必然能在此方法中得到全量注入。
   */
  private renderPromptText(
    template: string,
    globalContext: {
      themeJson?: any;
      stateRow?: any;
      session?: any;
      userText?: string;
      cleanedHistory?: string;
      participatingNames?: string[];
      roundInteractionText?: string;
      characters?: any[];
    },
    customVars: Record<string, string> = {}
  ): string {
    const themeJson = globalContext.themeJson || {};
    const stateRow = globalContext.stateRow || {};
    const session = globalContext.session || {};

    // 1. 构建全量可用变量的基准大字典（包含空字符串兜底，防占位符残留）
    const baseVars: Record<string, string> = {
      world_settings: themeJson.world_settings || '',
      scenario: themeJson.scenario || '',
      time_space: stateRow.time_space || '',
      summary: stateRow.summary || '',
      current_summary: stateRow.summary || '',
      history: globalContext.cleanedHistory || '',
      latest_input: globalContext.userText || '(无动作)',
      latest_user_input: globalContext.userText ? `*行动*: ${globalContext.userText}` : '(无最新输入)',
      character_list: globalContext.participatingNames ? globalContext.participatingNames.join(', ') : '',
      player_character: session.player_character || '',
      latest_round_content: globalContext.roundInteractionText || '',
      last_10_rounds_history: globalContext.cleanedHistory || '',
      character_settings: '',
      character_name: '',
      character_soul: '',
      character_states: '',
      self_states: '',
      current_character_states: '',
      relations: '',
      current_relations: '',
      status_bars_definition: '',
      round_context: '',
      plot_state: '',
      character_minds: '',
      director_intent: ''
    };

    // 2. 注入属性与数值规则描述
    const defBars = themeJson.status_bars || [];
    baseVars.status_bars_definition = JSON.stringify(defBars, null, 2);

    // 3. 构建默认的 character_settings
    if (globalContext.characters) {
      baseVars.character_settings = globalContext.characters.map((c: any) => `姓名: ${c.name}, 年龄: ${c.age || '未知'}, 人设: ${c.soul}`).join('\n\n');
    } else if (themeJson.characters) {
      baseVars.character_settings = themeJson.characters.map((c: any) => `姓名: ${c.name}, 年龄: ${c.age || '未知'}, 人设: ${c.soul}`).join('\n\n');
    }

    // 4. 动态还原当前的全部社会关系文本与角色状态
    let relationsText = '';
    let statesText = '';

    if (stateRow.character_states) {
      try {
        const cStates = JSON.parse(stateRow.character_states);
        relationsText = cStates.map((s: any) => `${s.name} 的关系网络:\n${s.relations}`).join('\n\n');
        statesText = this.formatCharacterStatesText(cStates, themeJson);
      } catch (_) {}
    } else if (session.npc_states) {
      try {
        const cStates = JSON.parse(session.npc_states);
        relationsText = cStates.map((s: any) => `${s.name} 的关系网络:\n${s.relations}`).join('\n\n');
        statesText = this.formatCharacterStatesText(cStates, themeJson);
      } catch (_) {}
    }

    if (statesText) {
      baseVars.character_states = statesText;
      baseVars.current_character_states = statesText;
    }
    if (relationsText) {
      baseVars.relations = relationsText;
      baseVars.current_relations = relationsText;
    }

    // 向下兼容：如果在 NPC 角色扮演作用域下传入了专属 self_states 却未提供 character_states
    // 自动让大写的全员 character_states 降级覆盖为单人 self_states，防止透露所有人隐私
    if (customVars.self_states && !customVars.character_states) {
      customVars.character_states = customVars.self_states;
    }

    // 5. 合并可能传入的定制局部变量
    const allVars = {
      ...baseVars,
      ...customVars
    };

    // 6. 执行全局的占位符正则替换
    let result = template;
    for (const [k, v] of Object.entries(allVars)) {
      const regex = new RegExp(`\\{${k}\\}`, 'g');
      result = result.replace(regex, v || '');
    }
    return result;
  }

  /**
   * 清理大模型可能输出的 ```json ``` 标记以获得纯净的 JSON 字符串
   */
  private cleanJsonWrap(text: string): string {
    let clean = text.trim();
    if (clean.startsWith('```json')) {
      clean = clean.substring(7);
    } else if (clean.startsWith('```')) {
      clean = clean.substring(3);
    }
    if (clean.endsWith('```')) {
      clean = clean.substring(0, clean.length - 3);
    }
    return clean.trim();
  }

  private normalizePlayerOptions(rawOptions: any, playerCharacter: string): any[] {
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    const allowedStrategies = ['沟通', '施压', '调查', '冒险'];
    const normalized = rawOptions
      .filter((opt) => opt && typeof opt === 'object')
      .filter((opt) => !opt.actor || opt.actor === playerCharacter)
      .map((opt, index) => ({
        actor: playerCharacter,
        title: String(opt.title || allowedStrategies[index] || '继续推进').slice(0, 18),
        strategy: allowedStrategies.includes(opt.strategy) ? opt.strategy : allowedStrategies[index] || '沟通',
        action: String(opt.action || '').trim(),
        dialogue: String(opt.dialogue || '').trim()
      }))
      .filter((opt) => opt.action || opt.dialogue)
      .slice(0, 4);

    return normalized;
  }

  private buildFallbackPlayerOptions(playerCharacter: string, timeSpace: string): any[] {
    return [
      {
        actor: playerCharacter,
        title: '谨慎询问',
        strategy: '沟通',
        action: `环顾${timeSpace || '当前场景'}，放缓语气观察对方反应`,
        dialogue: '先别急，把你知道的事情从头告诉我。'
      },
      {
        actor: playerCharacter,
        title: '直接施压',
        strategy: '施压',
        action: '向前一步，盯住对方的眼睛，不再给对方回避的余地',
        dialogue: '我需要真相，现在就说。'
      },
      {
        actor: playerCharacter,
        title: '调查细节',
        strategy: '调查',
        action: '仔细检查周围环境，寻找刚才被忽略的痕迹或异常',
        dialogue: '这里一定还有什么线索。'
      },
      {
        actor: playerCharacter,
        title: '冒险推进',
        strategy: '冒险',
        action: '不再停留原地，主动朝最可疑的方向行动',
        dialogue: '继续等下去只会错过机会，我先过去看看。'
      }
    ];
  }

  /**
   * 1. 初始化进入大剧院游玩会话
   */
  public async createSession(themeId: string, playerCharName: string, activeCharNames?: string[]): Promise<any> {
    const db = getDatabaseService();
    const modelAdapter = this.getModelAdapter();

    // 1. 读取 theme.json
    const themeDir = join(this.baseDir, themeId);
    const themeJsonPath = join(themeDir, 'theme.json');
    if (!fs.existsSync(themeJsonPath)) {
      throw new Error('未找到该剧本题材的配置文件。');
    }
    const theme = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
    this.ensureStatusBarsConfig(theme);
    const characters = this.loadThemeCharacters(themeId);

    // 2. 准备初始化角色状态（调用辅助模型生成初始数值，背包与余额）
    const defaultPrompts = this.getDefaultPrompts();
    const statusDefStr = JSON.stringify(theme.status_bars || [], null, 2);
    const charactersSummary = characters.map(c => `姓名: ${c.name}, 性别: ${c.gender}, 年龄: ${c.age}, 设定大纲: ${c.soul.substring(0, 150)}...`).join('\n\n');

    const initStatusSystemPrompt = `你是一个出色的游戏世界观初始化生成器。
你需要根据剧本设定及出场的所有角色背景，为每个人生成一套自洽的初始状态栏数值、初始背包物品、初始余额。

【属性状态栏定义（空壳定义）】
${statusDefStr}

【参与游玩的角色列表】
${charactersSummary}

【任务要求】
1. 必须根据各个角色的性格设定与社会关系（例如富二代余额较多，战士负伤生命值不满等），为每个出场角色量身定做其实时状态。
2. 强制性约束：每个角色的 "status_bars" 字段中的键（属性名称）必须与【属性状态栏定义（空壳定义）】中列出的属性名称完全一致！你绝对不能脑补、发明、虚构任何其他属性名称（例如，若空壳定义中包含“渴望值”和“精神状态”，则生成的键只能是“渴望值”和“精神状态”，绝对不要自己添加“生命值”或“法力值”等未定义的键）。
3. 属性的值必须处于定义中的 min 与 max 限制之内。如果属性的 type 是 number，其值必须是纯数字；如果 type 是 text，其值必须是对应状态的简短描述文本。
4. 必须输出以下标准的 JSON 格式数组，不要包含 markdown 标记或中文闲聊，直接输出 Raw JSON 数组：
[
  {
    "name": "角色A",
    "status_bars": { "属性1": 100, "属性2": "良好" },
    "backpack": [ { "name": "生锈的手枪", "quantity": 1 } ],
    "balance": 150
  }
]`;

    const initStatusMessages: ChatMessage[] = [
      { role: 'system', content: initStatusSystemPrompt },
      { role: 'user', content: `请基于上述剧本，为以下角色生成初始状态：\n${characters.map(c => c.name).join(', ')}。请不要掺杂任何非JSON字符。` }
    ];

    // 调用辅助模型初始化角色状态，解析结果并进行缺省降级保护
    let characterStates: CharacterState[] = [];
    try {
      console.log('[TheaterStageService] [角色状态初始化 Agent] 正在根据题材和角色列表生成角色初始状态与属性包...');
      const res = await modelAdapter.chat(initStatusMessages, { useSecondary: true, skipSystemInjection: true });
      console.log('[TheaterStageService] [角色状态初始化 Agent] 初始状态数据生成成功，大模型响应: ' + res.content.substring(0, 150) + '...');
      const cleanJson = this.cleanJsonWrap(res.content);
      characterStates = JSON.parse(cleanJson);
    } catch (err) {
      console.warn('[TheaterStageService] [角色状态初始化 Agent] 调用辅助模型生成角色初始状态失败，采用默认值兜底. 异常信息:', err);
    }

    // 对 AI 返回的 characterStates 进行强力的对齐和纠偏清洗
    const alignedCharacterStates: CharacterState[] = [];
    const defBars = theme.status_bars || [];

    for (const char of characters) {
      const stateFromAi = characterStates.find(s => s.name === char.name);

      const statusBars: Record<string, number | string> = {};
      for (const bar of defBars) {
        let val = stateFromAi?.status_bars?.[bar.name];
        if (val === undefined) {
          val = bar.initialValue !== undefined ? bar.initialValue : (bar.type === 'number' ? (bar.min !== undefined ? bar.min : 100) : '良好');
        } else {
          if (bar.type === 'number') {
            const numVal = Number(val);
            if (isNaN(numVal)) {
              val = bar.initialValue !== undefined ? bar.initialValue : (bar.min !== undefined ? bar.min : 100);
            } else {
              let clamped = numVal;
              if (bar.min !== undefined && clamped < bar.min) clamped = bar.min;
              if (bar.max !== undefined && clamped > bar.max) clamped = bar.max;
              val = clamped;
            }
          } else {
            val = String(val);
          }
        }
        statusBars[bar.name] = val as string | number;
      }

      // 占位符规范化替换
      const normalizedThemeRelations = (theme.relations || []).map((r: any) => {
        const from = (r.from || '').replace(/\{\{user\}\}|<user>/gi, playerCharName);
        const to = (r.to || '').replace(/\{\{user\}\}|<user>/gi, playerCharName);
        return { ...r, from, to };
      });

      const normalizedCharName = char.name.replace(/\{\{user\}\}|<user>/gi, playerCharName);
      let relationsStr = '';
      if (stateFromAi && typeof stateFromAi.relations === 'string') {
        relationsStr = stateFromAi.relations.replace(/\{\{user\}\}|<user>/gi, playerCharName);
      } else if (stateFromAi && Array.isArray(stateFromAi.relations)) {
        relationsStr = stateFromAi.relations.map((r: any) => {
          if (typeof r === 'string') return r.replace(/\{\{user\}\}|<user>/gi, playerCharName);
          if (r && typeof r === 'object') {
            const from = (r.from || char.name).replace(/\{\{user\}\}|<user>/gi, playerCharName);
            const to = (r.to || '').replace(/\{\{user\}\}|<user>/gi, playerCharName);
            return `${from} → ${to} ：${r.type || r.relation}`;
          }
          return '';
        }).filter(Boolean).join('\n');
      } else {
        relationsStr = normalizedThemeRelations
          .filter((r: any) => r.from === normalizedCharName || r.to === normalizedCharName)
          .map((r: any) => `${r.from} → ${r.to} ：${r.type}`)
          .join('\n');
      }

      const backpack = Array.isArray(stateFromAi?.backpack) ? stateFromAi.backpack : [];
      const balance = typeof stateFromAi?.balance === 'number' ? stateFromAi.balance : (stateFromAi?.balance !== undefined ? Number(stateFromAi.balance) || 0 : 0);

      const isParticipating = activeCharNames ? activeCharNames.includes(char.name) : true;

      alignedCharacterStates.push({
        name: char.name,
        status_bars: statusBars,
        relations: relationsStr,
        backpack,
        balance,
        isParticipating: isParticipating || char.name === playerCharName
      });
    }

    // 3. 运行开场 Agent (主模型)
    const narratorPrompt = this.renderPromptText(defaultPrompts.narrator, {
      themeJson: theme,
      stateRow: { time_space: '时间尚未开始流逝，空间正在交织渲染中', summary: '' }
    } as any, {
      character_settings: charactersSummary
    });

    const narratorMessages: ChatMessage[] = [
      { role: 'system', content: narratorPrompt },
      { role: 'user', content: '故事开始，请拉开大舞台的帷幕！' }
    ];

    let openingNarrator = '';
    try {
      const res = await modelAdapter.chat(narratorMessages, { usePrimary: true, skipSystemInjection: true });
      openingNarrator = res.content.trim();
    } catch (err: any) {
      openingNarrator = `故事在神秘的帷幕后悄然开场...\n(初始化开场旁白失败: ${err.message || err})`;
    }

    // 4. 运行时间与空间 Agent (辅模型)，生成初始时空文档
    const tsPrompt = this.renderPromptText(defaultPrompts.timeSpace, {
      themeJson: theme,
      stateRow: { time_space: '时间尚未开始流逝，空间正在交织渲染中' },
      cleanedHistory: '(开场故事筹备中)',
      userText: '(首发演出准备)',
      participatingNames: characters.map(c => c.name)
    } as any);

    let timeSpaceDesc = '';
    try {
      const res = await modelAdapter.chat([{ role: 'system', content: tsPrompt }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      const parsed = JSON.parse(cleanJson);
      timeSpaceDesc = parsed.time_space || theme.scenario.substring(0, 100);
    } catch (_) {
      timeSpaceDesc = '开局第一天，故事发生的物理地点';
    }

    // 5. 运行剧情推进选项 Agent (辅模型)，生成第一轮 4 个选项
    const optPrompt = defaultPrompts.options
      .replace('{summary}', '(故事开场无总结)')
      .replace('{time_space}', timeSpaceDesc)
      .replace('{character_settings}', charactersSummary)
      .replace('{history}', `开场旁白: ${openingNarrator}`);

    let initialOptions = [];
    try {
      const res = await modelAdapter.chat([{ role: 'system', content: optPrompt }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      initialOptions = JSON.parse(cleanJson);
    } catch (_) {
      initialOptions = []; // 生成选项失败时直接留空，不使用默认推进选项
    }

    // 6. 存入数据库会话表与状态表（洗涤动态状态，不存 Base64）
    const sessionId = `sess_${Date.now()}`;
    const cleanedForDb = this.cleanDynamicStatesForDatabase(alignedCharacterStates);

    db.db.prepare(`
      INSERT INTO TheaterSessions (id, theme_id, player_character, npc_states, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, themeId, playerCharName, JSON.stringify(cleanedForDb), Date.now());

    const initPromptsSave = {
      ...defaultPrompts,
      enableImageGen: false // 生图 Agent 默认不启用
    };
    const initialRoundContext = this.buildDefaultRoundContext({
      sessionId,
      turnCount: 0,
      timeSpace: timeSpaceDesc,
      playerCharacter: playerCharName,
      presentCharacters: alignedCharacterStates
        .filter((s) => s.isParticipating !== false)
        .map((s) => s.name)
    });
    const initialPlotState = this.buildDefaultPlotState(theme);
    const initialCharacterMinds = this.buildDefaultCharacterMinds(characters, playerCharName);

    db.db.prepare(`
      INSERT INTO TheaterSessionStates (
        session_id,
        time_space,
        summary,
        agent_prompts,
        character_states,
        next_options,
        round_context,
        plot_state,
        character_minds
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      timeSpaceDesc,
      '',
      JSON.stringify(initPromptsSave),
      JSON.stringify(cleanedForDb),
      JSON.stringify(initialOptions),
      JSON.stringify(initialRoundContext),
      JSON.stringify(initialPlotState),
      JSON.stringify(initialCharacterMinds)
    );

    // 6.5. 写入初始时空消息到数据库，以便第一轮在开头展示
    const tsMsgId = `msg_${Date.now() - 5}_timespace`;
    db.db.prepare(`
      INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tsMsgId, sessionId, 'system', `🎬${timeSpaceDesc}`, Date.now() - 5);

    // 7. 保存旁白消息到数据库
    const msgId = `msg_${Date.now()}_narrator`;
    db.db.prepare(`
      INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(msgId, sessionId, 'narrator', openingNarrator, Date.now());

    // 向量化开场旁白
    this.enqueueEmbedding(sessionId, msgId, openingNarrator);

    // 内存合并静态资源（头像 Base64、设定等）返回给前端
    const characterStatesToReturn = this.mergeStaticWithDynamic(themeId, alignedCharacterStates);

    return {
      sessionId,
      themeId,
      playerCharName,
      timeSpace: timeSpaceDesc,
      summary: '',
      characterStates: characterStatesToReturn,
      openingNarrator,
      initialOptions,
      roundContext: initialRoundContext,
      plotState: initialPlotState,
      characterMinds: initialCharacterMinds,
      prompts: initPromptsSave
    };
  }

  /**
   * 2. 获取当前 Stage 会话运行状态
   */
  public getSessionState(sessionId: string): any {
    const db = getDatabaseService();
    const session = db.db.prepare('SELECT * FROM TheaterSessions WHERE id = ?').get(sessionId) as any;
    if (!session) {
      throw new Error('未找到对应大剧院游玩会话！');
    }

    const state = db.db.prepare('SELECT * FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
    const messages = db.db.prepare('SELECT * FROM TheaterMessages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];

    // 补齐默认生图配置标记
    let promptsParsed = this.getDefaultPrompts() as any;
    if (state && state.agent_prompts) {
      try {
        promptsParsed = this.mergePromptDefaults(JSON.parse(state.agent_prompts));
      } catch (_) {}
    }

    let dynamicStates: any[] = [];
    if (state && state.character_states) {
      try {
        dynamicStates = JSON.parse(state.character_states);
      } catch (_) {}
    }
    if ((!dynamicStates || dynamicStates.length === 0) && session.npc_states) {
      try {
        dynamicStates = JSON.parse(session.npc_states);
      } catch (_) {}
    }
    const themeDir = join(this.baseDir, session.theme_id);
    const themeJsonPath = join(themeDir, 'theme.json');
    let themeJson: any = {};
    if (fs.existsSync(themeJsonPath)) {
      try {
        themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
        this.ensureStatusBarsConfig(themeJson);
      } catch (_) {}
    }
    const staticCharacters = this.loadThemeCharacters(session.theme_id);
    const participatingNames = dynamicStates
      .filter((s: any) => s.isParticipating !== false)
      .map((s: any) => s.name);
    const roundContext = this.parseJsonOrFallback<TheaterRoundContext>(
      state?.round_context,
      this.buildDefaultRoundContext({
        sessionId,
        turnCount: session.turn_count || 0,
        timeSpace: state ? state.time_space : '',
        playerCharacter: session.player_character,
        presentCharacters: participatingNames
      })
    );
    const plotState = this.parseJsonOrFallback<TheaterPlotState>(
      state?.plot_state,
      this.buildDefaultPlotState(themeJson)
    );
    const characterMinds = this.parseJsonOrFallback<TheaterCharacterMind[]>(
      state?.character_minds,
      this.buildDefaultCharacterMinds(staticCharacters, session.player_character)
    );

    console.log(`[TheaterStageService] getSessionState 加载会话: ${sessionId}, 角色状态数: ${dynamicStates?.length}`);

    // 检查并自愈可能为空的角色关系列表
    let needSave = false;
    if (Array.isArray(dynamicStates)) {
      const hasEmptyRelations = dynamicStates.some(ds => !ds.relations || ds.relations.trim() === '');
      if (hasEmptyRelations) {
        console.log(`[TheaterStageService] 检测到会话 ${sessionId} 存在空白角色关系，启动自愈逻辑...`);
        const theme = Object.keys(themeJson).length > 0 ? themeJson : null;

        if (theme && Array.isArray(theme.relations)) {
          const playerCharName = session.player_character;
          const normalizedThemeRelations = theme.relations.map((r: any) => {
            const from = (r.from || '').replace(/\{\{user\}\}|<user>/gi, playerCharName);
            const to = (r.to || '').replace(/\{\{user\}\}|<user>/gi, playerCharName);
            return { ...r, from, to };
          });

          for (const ds of dynamicStates) {
            if (!ds.relations || ds.relations.trim() === '') {
              const normalizedDsName = ds.name.replace(/\{\{user\}\}|<user>/gi, playerCharName);
              const matchedRels = normalizedThemeRelations
                .filter((r: any) => r.from === normalizedDsName || r.to === normalizedDsName)
                .map((r: any) => `${r.from} → ${r.to} ：${r.type || r.relation || ''}`)
                .join('\n');
              console.log(`[TheaterStageService] 自愈修复角色 [${ds.name}] 的关系网络:`, JSON.stringify(matchedRels));
              ds.relations = matchedRels;
              needSave = true;
            }
          }
        } else {
          console.warn(`[TheaterStageService] 自愈失败：未找到题材 theme.json 关系配置。`);
        }
      }
    }

    if (needSave) {
      const cleaned = this.cleanDynamicStatesForDatabase(dynamicStates);
      const serialized = JSON.stringify(cleaned);
      try {
        db.db.prepare('UPDATE TheaterSessions SET npc_states = ? WHERE id = ?').run(serialized, sessionId);
        if (state) {
          db.db.prepare('UPDATE TheaterSessionStates SET character_states = ? WHERE session_id = ?').run(serialized, sessionId);
        }
        console.log(`[TheaterStageService] 会话 ${sessionId} 自愈后的关系网络已成功同步持久化至 SQLite。`);
      } catch (err) {
        console.error('[TheaterStageService] 保存自愈的角色关系失败:', err);
      }
    }

    let nextOptionsParsed = [];
    if (state && state.next_options) {
      try {
        nextOptionsParsed = JSON.parse(state.next_options);
      } catch (_) {}
    }

    // 🚀 历史数据自愈清洗：若从数据库读出的是已被废弃删除的历史默认兜底选项，则强制清空留空，消除旧测试会话残留
    if (Array.isArray(nextOptionsParsed)) {
      const hasDefaultOpt = nextOptionsParsed.some(opt => 
        opt && (
          opt.title === '主动搭话' || 
          opt.title === '四处观察' || 
          opt.title === '保持警惕' || 
          opt.title === '陷入沉思'
        )
      );
      if (hasDefaultOpt) {
        nextOptionsParsed = [];
      }
    }

    // 不再使用默认故事推进选项进行兜底，如生成失败或为空，直接保持为空数组
    if (!nextOptionsParsed || !Array.isArray(nextOptionsParsed)) {
      nextOptionsParsed = [];
    }

    return {
      sessionId: session.id,
      themeId: session.theme_id,
      playerCharName: session.player_character,
      timeSpace: state ? state.time_space : '',
      summary: state ? state.summary : '',
      prompts: promptsParsed,
      characterStates: this.mergeStaticWithDynamic(session.theme_id, dynamicStates),
      messages: messages.map(m => {
        let meta = {};
        if (m.metadata) {
          try {
            meta = JSON.parse(m.metadata);
          } catch (_) {}
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          ...meta
        };
      }),
      nextOptions: nextOptionsParsed,
      roundContext,
      plotState,
      characterMinds
    };
  }

  /**
   * 3. 异步提交计算并存入向量表
   */
  private async enqueueEmbedding(sessionId: string, roundId: string, text: string) {
    try {
      const clean = this.cleanInnerThought(text);
      if (!clean) return;
      const vectorSvc = VectorMemoryService.getInstance();
      const embedding = await vectorSvc.computeEmbedding(clean);
      if (embedding) {
        const db = getDatabaseService();
        db.db.prepare(`
          INSERT INTO TheaterMessageEmbeddings (round_id, session_id, embedding_json, content_text, timestamp)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(round_id, session_id) DO UPDATE SET
            embedding_json = excluded.embedding_json,
            content_text = excluded.content_text
        `).run(roundId, sessionId, JSON.stringify(embedding), clean, Date.now());
        console.log(`[TheaterStageService] 向量库成功同步消息 [${roundId}] 到会话 [${sessionId}]`);
      }
    } catch (e) {
      console.error('[TheaterStageService] 向量计算并存入大剧院库失败:', e);
    }
  }

  /**
   * 4. 向量库相似记忆回想 (相似度 0.6)
   */
  private async recallSimilarMemory(sessionId: string, queryText: string, excludeIds: string[]): Promise<string> {
    try {
      const cleanQuery = this.cleanInnerThought(queryText);
      if (!cleanQuery) return '';

      const vectorSvc = VectorMemoryService.getInstance();
      const queryEmbedding = await vectorSvc.computeEmbedding(cleanQuery);
      if (!queryEmbedding) return '';

      const db = getDatabaseService();
      // 获取当前 session 的全部向量数据
      const rows = db.db.prepare('SELECT round_id, embedding_json, content_text, timestamp FROM TheaterMessageEmbeddings WHERE session_id = ?').all(sessionId) as any[];
      if (rows.length === 0) return '';

      const excludeSet = new Set(excludeIds);
      const scored: { content: string; score: number }[] = [];

      for (const row of rows) {
        if (excludeSet.has(row.round_id)) continue;
        let embedding: number[];
        try {
          embedding = JSON.parse(row.embedding_json);
        } catch (_) {
          continue;
        }

        // 余弦相似度
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryEmbedding.length; i++) {
          dotProduct += queryEmbedding[i] * embedding[i];
          normA += queryEmbedding[i] * queryEmbedding[i];
          normB += embedding[i] * embedding[i];
        }
        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

        if (similarity >= 0.6) {
          scored.push({ content: row.content_text, score: similarity });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      const topK = scored.slice(0, 3);
      if (topK.length === 0) return '';

      return `【根据大剧院向量库回想的相关记忆片断】：\n` + topK.map((m, idx) => `${idx + 1}. "${m.content}" (关联度: ${Math.round(m.score * 100)}%)`).join('\n') + `\n`;
    } catch (e) {
      console.error('[TheaterStageService] 回想相关记忆失败:', e);
      return '';
    }
  }

  /**
   * 5. 执行推进回合与半自动队列（NPC排队依次行事）
   */
  public async executeStep(
    sessionId: string,
    userText?: string,
    onNpcAction?: (payload: { role: string; content: string }) => void
  ): Promise<any> {
    const db = getDatabaseService();
    const modelAdapter = this.getModelAdapter();
    const roundStartTime = Date.now();
    const roundId = `round_${roundStartTime}`;

    // 1. 加载会话和当前运行状态
    const session = db.db.prepare('SELECT * FROM TheaterSessions WHERE id = ?').get(sessionId) as any;
    if (!session) throw new Error('未找到当前剧本会话。');
    const stateRow = db.db.prepare('SELECT * FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
    const themeDir = join(this.baseDir, session.theme_id);
    const themeJson = JSON.parse(fs.readFileSync(join(themeDir, 'theme.json'), 'utf8'));
    this.ensureStatusBarsConfig(themeJson);
    const characters = this.loadThemeCharacters(session.theme_id);

    const prompts: AgentPromptConfig & { enableImageGen?: boolean } = stateRow
      ? this.mergePromptDefaults(JSON.parse(stateRow.agent_prompts))
      : this.mergePromptDefaults(null);

    // 获取本轮开始前的角色状态深拷贝
    const prevCharStates: CharacterState[] = JSON.parse(stateRow ? stateRow.character_states : session.npc_states);
    const currentCharStates: CharacterState[] = JSON.parse(JSON.stringify(prevCharStates));
    let plotState = this.parseJsonOrFallback<TheaterPlotState>(
      stateRow?.plot_state,
      this.buildDefaultPlotState(themeJson)
    );
    let characterMinds = this.parseJsonOrFallback<TheaterCharacterMind[]>(
      stateRow?.character_minds,
      this.buildDefaultCharacterMinds(characters, session.player_character)
    );
    let roundContext = this.parseJsonOrFallback<TheaterRoundContext>(
      stateRow?.round_context,
      this.buildDefaultRoundContext({
        sessionId,
        turnCount: session.turn_count || 0,
        timeSpace: stateRow ? stateRow.time_space : '',
        playerCharacter: session.player_character,
        presentCharacters: currentCharStates.filter((s) => s.isParticipating !== false).map((s) => s.name)
      })
    );

    const historyMessages = db.db.prepare('SELECT * FROM TheaterMessages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];

    // 准备 10 轮滑动历史（清洗思维链以节省 token）
    const recentRounds = historyMessages.slice(-25);
    const cleanedHistory = recentRounds.map(m => {
      const cleanContent = this.cleanInnerThought(m.content);
      if (m.role === 'narrator' || m.role === 'system') {
        return `[旁白/系统]: ${cleanContent}`;
      } else if (m.role === 'user') {
        return `[${session.player_character} (用户扮演)]: ${cleanContent}`;
      } else {
        return `[${m.role}]: ${cleanContent}`;
      }
    }).join('\n');

    const excludeMsgIds = recentRounds.map(m => m.id);

    // 2. 如果用户有输入，将其作为触发源存入并更新
    let userMsgId = '';
    if (userText && userText.trim()) {
      userMsgId = `msg_${roundStartTime}_user`;
      db.db.prepare(`
        INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userMsgId, sessionId, 'user', userText, roundStartTime);

      this.enqueueEmbedding(sessionId, userMsgId, userText);
      historyMessages.push({ id: userMsgId, session_id: sessionId, role: 'user', content: userText, created_at: roundStartTime });
    }

    try {
      db.db.prepare(`
        UPDATE TheaterSessionStates
        SET next_options = ?
        WHERE session_id = ?
      `).run('[]', sessionId);
      if (onNpcAction) {
        onNpcAction({
          id: `evt_${roundStartTime}_next_options_cleared`,
          sessionId,
          roundId,
          role: 'system',
          content: '',
          type: 'next-options-cleared'
        } as any);
      }
    } catch (err: any) {
      console.error('[TheaterStageService] 清空本轮旧推进选项失败:', err.message || err);
    }

    // 最新这一回合产生的上下文
    let roundInteractionText = userText ? `[${session.player_character} (用户扮演)]: ${this.cleanInnerThought(userText)}` : '';
    console.log(`[TheaterStageService] 🎬 开始执行大剧院演绎推进步骤 (会话: ${sessionId}), 用户输入动作: "${userText || '(无)'}"`);

    // 3. 运行时间与空间 Agent
    const participatingNames = prevCharStates
      .filter((s: any) => s.isParticipating !== false && s.name !== session.player_character)
      .map(s => s.name);

    const tsPromptText = this.renderPromptText(
      prompts.directorIntent || prompts.timeSpace,
      {
        themeJson,
        stateRow,
        session,
        userText,
        cleanedHistory,
        participatingNames,
        characters
      },
      {
        time_space: stateRow ? stateRow.time_space : '',
        plot_state: JSON.stringify(plotState, null, 2),
        round_context: JSON.stringify(roundContext, null, 2)
      }
    );

    let newTimeSpace = stateRow ? stateRow.time_space : '';
    let actionQueue: string[] = [];

    try {
      console.log('[TheaterStageService] [时空背景 Agent] 正在根据最新轮次互动分析时空状态并推演 NPC 行动顺序队列...');
      const res = await modelAdapter.chat([{ role: 'system', content: tsPromptText }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      const parsed = JSON.parse(cleanJson);
      newTimeSpace = parsed.time_space || newTimeSpace;
      actionQueue = parsed.action_queue || [];
      roundContext = {
        roundId,
        turnCount: session.turn_count + 1,
        canonicalTimeSpace: newTimeSpace,
        timeLabel: parsed.time_label || newTimeSpace,
        locationLabel: parsed.location_label || newTimeSpace,
        presentCharacters: [session.player_character, ...actionQueue].filter(Boolean),
        playerCharacter: session.player_character,
        latestUserInput: userText || '',
        directorIntent: parsed.director_intent || roundContext.directorIntent,
        forbiddenContradictions: Array.isArray(parsed.forbidden_contradictions)
          ? parsed.forbidden_contradictions
          : [
              `不得改写当前时空事实：${newTimeSpace}`,
              `不得替玩家角色 ${session.player_character} 做出未经输入的行动。`
            ]
      };
      console.log(`[TheaterStageService] [时空背景 Agent] 推演成功！已更新时空背景，规划的行动队列: ${JSON.stringify(actionQueue)}`);
    } catch (err) {
      console.warn('[TheaterStageService] [时空背景 Agent] 推演异常，将采用默认全员扮演。异常信息:', err);
      actionQueue = [...participatingNames];
      roundContext = this.buildDefaultRoundContext({
        sessionId,
        turnCount: session.turn_count + 1,
        timeSpace: newTimeSpace,
        playerCharacter: session.player_character,
        presentCharacters: [session.player_character, ...actionQueue],
        latestUserInput: userText || ''
      });
    }

    actionQueue = actionQueue.filter(name => name !== session.player_character && participatingNames.includes(name));

    if (actionQueue.length === 0 && participatingNames.length > 0) {
      // 兜底防卡死：如果大模型规划的队列为空，随机推选一位当前参演角色发言
      actionQueue = [participatingNames[Math.floor(Math.random() * participatingNames.length)]];
    }

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET time_space = ?, round_context = ?
      WHERE session_id = ?
    `).run(newTimeSpace, JSON.stringify(roundContext), sessionId);

    if (onNpcAction) {
      onNpcAction({
        id: `evt_${roundStartTime}_stage_state_updated`,
        sessionId,
        roundId,
        role: 'system',
        content: '[状态同步]',
        type: 'stage-state-updated'
      } as any);
    }

    // 物理保存这轮的最新时空背景消息，时间戳略早于用户动作以确保在这一轮演绎的最开头渲染
    const tsMsgId = `msg_${roundStartTime - 5}_timespace`;
    db.db.prepare(`
      INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tsMsgId, sessionId, 'system', `🎬${newTimeSpace}`, roundStartTime - 5);

    // 时空背景 Agent 落盘后立即推送给前端，确保它是第一个渲染出来的内容
    if (onNpcAction) {
      onNpcAction({
        id: tsMsgId,
        sessionId,
        roundId,
        role: 'system',
        content: `🎬${newTimeSpace}`,
        createdAt: roundStartTime - 5
      } as any);
    }

    // 4. 先执行 NPC 角色扮演，主剧情旁白会在本轮 NPC 全部行动后再收束。
    let mainPlotOutput = '';
    let isRelationChangeTriggered = false;

    const charStatesStr = currentCharStates.map(s => {
      return `【${s.name}】 状态: ${JSON.stringify(s.status_bars)}, 余额: ${s.balance}, 背包: ${JSON.stringify(s.backpack)}`;
    }).join('\n');

    // 5. 串行排队执行 NPC 角色扮演 Agent
    const completedNpcReplies: Array<{ name: string; content: string }> = [];

    console.log(`[TheaterStageService] [NPC 扮演 Agent] 开始处理 NPC 角色扮演序列 (串行模式)... 待扮演 NPC 列表: ${JSON.stringify(actionQueue)}`);
    
    for (let npcIndex = 0; npcIndex < actionQueue.length; npcIndex++) {
      const npcName = actionQueue[npcIndex];
      const npcMsgId = `msg_${roundStartTime}_npc_${npcIndex}_${npcName.replace(/\s+/g, '_')}`;
      const npcCreatedAt = roundStartTime + 10 + npcIndex;

      // 扮演前的最新打断检查
      const checkLatestMsg = db.db.prepare('SELECT role, content FROM TheaterMessages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as any;
      if (checkLatestMsg && checkLatestMsg.role === 'user') {
        const cleanLatest = this.cleanInnerThought(checkLatestMsg.content);
        if (cleanLatest !== this.cleanInnerThought(userText || '')) {
          console.log(`[TheaterStageService] 检测到用户强行插言打断！中止 NPC [${npcName}] 的演绎生成。`);
          break;
        }
      }

      // 通知前端当前 NPC 开始扮演，让前端显示正在输入
      if (onNpcAction) {
        onNpcAction({
          id: npcMsgId,
          sessionId,
          roundId,
          role: npcName,
          content: '',
          createdAt: npcCreatedAt
        } as any);
      }

      const npcChar = characters.find(c => c.name === npcName);
      if (!npcChar) continue;

      const npcState = currentCharStates.find(s => s.name === npcName);
      const relationsStr = npcState ? npcState.relations : '';
      const npcMind = characterMinds.find((mind) => mind.name === npcName);

      let stateInjectStr = '';
      if (npcState) {
        const barLines: string[] = [];
        for (const [k, v] of Object.entries(npcState.status_bars)) {
          const rule = themeJson.status_bars?.find((b: any) => b.name === k);
          const barRuleText = rule ? `(说明: ${rule.description || '无'}, 规则: ${rule.aiRule || '无'})` : '';
          barLines.push(`- ${k}: ${v} ${barRuleText}`);
        }
        const backpackStr = npcState.backpack && npcState.backpack.length > 0
          ? npcState.backpack.map((i: any) => `${i.name} (数量: ${i.quantity})`).join(', ')
          : '暂无物品';
        stateInjectStr = `当前数值:\n${barLines.join('\n')}\n当前钱包余额: ￥${npcState.balance}\n当前背包物品: ${backpackStr}`;
      }

      const recalledMemoryText = await this.recallSimilarMemory(sessionId, roundInteractionText || userText || '', excludeMsgIds);

      const charPromptText = this.renderPromptText(
        prompts.character,
        {
          themeJson,
          stateRow,
          session,
          userText,
          cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
          participatingNames,
          characters
        },
        {
          time_space: newTimeSpace,
          summary: (stateRow ? stateRow.summary : '') + '\n' + recalledMemoryText,
          character_name: npcName,
          character_soul: npcChar.soul || '',
          self_states: stateInjectStr,
          relations: relationsStr,
          round_context: JSON.stringify(roundContext, null, 2),
          plot_state: JSON.stringify(plotState, null, 2),
          character_minds: npcMind ? JSON.stringify(npcMind, null, 2) : '',
          director_intent: roundContext.directorIntent
        }
      );

      // 组装 user 提示词
      let userPrompt = `请以 [${npcName}] 的语气，扮演并输出你接下来的言行。`;
      userPrompt += `\n【本轮不可违反的时空事实】：${roundContext.canonicalTimeSpace}`;
      userPrompt += `\n【本轮导演意图】：${roundContext.directorIntent}`;
      if (npcMind) {
        userPrompt += `\n【你的即时心理状态】：${JSON.stringify(npcMind)}`;
      }
      
      // 1. 主剧情推进Agent输出的内容注入到角色扮演Agent的提示词
      if (mainPlotOutput) {
        userPrompt += `\n【当前最新剧情旁白推进】：\n${mainPlotOutput}`;
      }
      
      // 3. 将这一轮已完成发言角色的所有回复按顺序注入到当前角色的 Prompt 中，结构：本轮角色{角色名称}回复的内容为：xxxx
      if (completedNpcReplies.length > 0) {
        userPrompt += `\n\n【本轮已发言角色的动作】：`;
        for (const reply of completedNpcReplies) {
          userPrompt += `\n本轮角色【${reply.name}】回复的内容为：${reply.content}`;
        }
        userPrompt += `\n请针对上述已发言角色的回复与当前剧情旁白，做出合理且有针对性的交互与回应。`;
      }

      const charMessages: ChatMessage[] = [
        { role: 'system', content: charPromptText },
        { role: 'user', content: userPrompt }
      ];

      try {
        console.log(`[TheaterStageService] [NPC 扮演 Agent] 🎭 角色 [${npcName}] 正在思考并准备输出言行...`);
        const res = await modelAdapter.chat(charMessages, { usePrimary: true, skipSystemInjection: true });
        const npcOutput = res.content.trim();

        if (npcOutput) {
          const cleanOutput = this.cleanInnerThought(npcOutput);
          console.log(`[TheaterStageService] [NPC 扮演 Agent] 🎭 角色 [${npcName}] 扮演输出完成。`);
          
          db.db.prepare(`
            INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(npcMsgId, sessionId, npcName, npcOutput, npcCreatedAt);

          this.enqueueEmbedding(sessionId, npcMsgId, npcOutput);

          // 立即推送给前端
          if (onNpcAction) {
            onNpcAction({
              id: npcMsgId,
              sessionId,
              roundId,
              role: npcName,
              content: npcOutput,
              createdAt: npcCreatedAt
            } as any);
          }

          // 记录本次已完成发言的 NPC 信息
          completedNpcReplies.push({ name: npcName, content: cleanOutput });

          roundInteractionText += `\n[${npcName}]: ${cleanOutput}`;
        } else {
          console.log(`[TheaterStageService] [NPC 扮演 Agent] 🎭 角色 [${npcName}] 输出了空内容。`);
        }
      } catch (err: any) {
        console.error(`[TheaterStageService] [NPC 扮演 Agent] 🎭 角色 [${npcName}] 扮演生成异常:`, err);
      }
    }

    // 6. NPC 完成本轮演绎后，再由主剧情 Agent 收束事实并推动下一步压力。
    const plotRecalledMemoryText = await this.recallSimilarMemory(sessionId, roundInteractionText || userText || '', excludeMsgIds);
    const plotPromptText = this.renderPromptText(
      prompts.mainPlot,
      {
        themeJson,
        stateRow,
        session,
        userText,
        cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
        participatingNames,
        roundInteractionText,
        characters
      },
      {
        time_space: newTimeSpace,
        character_states: charStatesStr,
        summary: (stateRow ? stateRow.summary : '') + '\n' + plotRecalledMemoryText,
        round_context: JSON.stringify(roundContext, null, 2),
        plot_state: JSON.stringify(plotState, null, 2),
        director_intent: roundContext.directorIntent
      }
    );

    const mainPlotMsgId = `msg_${roundStartTime}_mainplot`;
    const mainPlotCreatedAt = roundStartTime + 100;
    try {
      if (onNpcAction) {
        onNpcAction({
          id: mainPlotMsgId,
          sessionId,
          roundId,
          role: 'narrator',
          content: '',
          createdAt: mainPlotCreatedAt
        } as any);
      }
      console.log('[TheaterStageService] [剧情收束 Agent] 📖 正在基于本轮已发生互动收束剧情并推动故事向前发展...');
      const res = await modelAdapter.chat([{ role: 'system', content: plotPromptText }], { usePrimary: true, skipSystemInjection: true });
      let content = res.content.trim();
      if (content.includes('[RELATION_CHANGE_REQUIRED]')) {
        isRelationChangeTriggered = true;
        content = content.replace('[RELATION_CHANGE_REQUIRED]', '').trim();
      }
      mainPlotOutput = content;
      console.log(`[TheaterStageService] [剧情收束 Agent] 📖 旁白生成完毕，是否触发关系变化评估: ${isRelationChangeTriggered}`);
    } catch (err: any) {
      console.error('[TheaterStageService] [剧情收束 Agent] 📖 旁白生成失败。异常信息:', err);
      mainPlotOutput = `故事在一片迷雾中继续推进下去...\n(推进旁白失败: ${err.message || err})`;
    }

    db.db.prepare(`
      INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(mainPlotMsgId, sessionId, 'narrator', mainPlotOutput, mainPlotCreatedAt);

    this.enqueueEmbedding(sessionId, mainPlotMsgId, mainPlotOutput);
    
    if (onNpcAction && mainPlotOutput) {
      onNpcAction({
        id: mainPlotMsgId,
        sessionId,
        roundId,
        role: 'narrator',
        content: mainPlotOutput,
        createdAt: mainPlotCreatedAt
      } as any);
    }

    roundInteractionText += `\n[旁白/收束]: ${this.cleanInnerThought(mainPlotOutput)}`;

    // 所有角色扮演与剧情收束完毕，通知前端当前正在进行后台结算与生成选项
    if (onNpcAction) {
      onNpcAction({ role: '系统正在为您构思下一轮行动引导选项...', content: '' });
    }

    // 7. 被动关系维护 Agent
    if (isRelationChangeTriggered) {
      const currentRelsText = prevCharStates.map(s => `${s.name} 的关系网络:\n${s.relations}`).join('\n\n');
      const relPromptText = this.renderPromptText(
        prompts.relation,
        {
          themeJson,
          stateRow,
          session,
          userText,
          cleanedHistory,
          participatingNames,
          roundInteractionText,
          characters
        },
        {
          current_relations: currentRelsText
        }
      );

      try {
        console.log('[TheaterStageService] [关系维护 Agent] 🤝 正在评估本轮剧情对角色社会关系网络的影响并进行自省自愈维护...');
        const res = await modelAdapter.chat([{ role: 'system', content: relPromptText }], { useSecondary: true, skipSystemInjection: true });
        const cleanJson = this.cleanJsonWrap(res.content);
        const relChanges = JSON.parse(cleanJson);
        console.log(`[TheaterStageService] [关系维护 Agent] 🤝 角色关系维护完成。变更记录: ${JSON.stringify(relChanges)}`);
        if (Array.isArray(relChanges)) {
          for (const chg of relChanges) {
            if (!chg.from || !chg.to || !chg.content) continue;
            const cState = currentCharStates.find(s => s.name === chg.from);
            if (cState) {
              const lines = cState.relations.split('\n').filter(l => l.trim() !== '');
              const prefix = `${chg.from} → ${chg.to} ：`;
              const cleanLines = lines.filter(l => !l.startsWith(prefix));
              cleanLines.push(`${prefix}${chg.content}`);
              cState.relations = cleanLines.join('\n');
            }
          }
        }
      } catch (e) {
        console.error('[TheaterStageService] [关系维护 Agent] 🤝 角色关系自愈评估与维护异常:', e);
      }

      // 实时通知前端更新角色数值与关系面板 (关系维护后)
      if (onNpcAction) {
        onNpcAction({
          role: 'system',
          content: '[状态更新]',
          type: 'character-states-update',
          characterStates: this.mergeStaticWithDynamic(session.theme_id, currentCharStates)
        } as any);
      }
    }

    // 7. 状态维护 Agent (一次性聚合评估)
    console.log('[TheaterStageService] [属性结算 Agent] 📊 正在一次性评估并结算所有角色的状态属性、背包物品和余额变动...');
    
    const statusBarsDefStr = JSON.stringify(themeJson.status_bars || [], null, 2);
    const allCharDetailInject = currentCharStates.map(s => {
      return `【角色：${s.name}】\n当前数值: ${JSON.stringify(s.status_bars)}\n当前钱包余额: ${s.balance}\n当前背包物品: ${JSON.stringify(s.backpack)}`;
    }).join('\n\n');

    const baseStatusPrompt = this.renderPromptText(
      prompts.status,
      {
        themeJson,
        stateRow,
        session,
        userText,
        cleanedHistory,
        participatingNames,
        roundInteractionText,
        characters
      },
      {
        character_name: currentCharStates.map(s => s.name).join(', '),
        status_bars_definition: statusBarsDefStr,
        current_character_states: allCharDetailInject
      }
    );

    const aggregationInstruction = `\n\n【聚合任务要求】
⚠️ 注意：请必须一次性评估所有角色的变化。请务必输出以下标准的以角色名为键 (Key) 的聚合 JSON 格式（直接返回 Raw JSON 字符串，严禁使用 markdown \`\`\` 格式包裹）：
{
  ${currentCharStates.map(s => `"${s.name}": {
    "status_bars": {},
    "backpack_changes": [],
    "balance_change": 0
  }`).join(',\n  ')}
}`;

    const statusPromptText = baseStatusPrompt + aggregationInstruction;

    try {
      const res = await modelAdapter.chat([{ role: 'system', content: statusPromptText }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      const allDiffs = JSON.parse(cleanJson);
      console.log(`[TheaterStageService] [属性结算 Agent] 📊 所有角色属性一次性结算成功。`);

      for (const cState of currentCharStates) {
        // 暂时退场的角色，不允许通过 AI 结算更新状态栏、背包或余额
        if (cState.isParticipating === false) {
          continue;
        }

        const diff = allDiffs[cState.name];
        if (!diff) continue;

        if (diff.status_bars) {
          for (const [attrName, changeValue] of Object.entries(diff.status_bars)) {
            const barDef = themeJson.status_bars?.find((b: any) => b.name === attrName);
            const currentVal = cState.status_bars[attrName];
            const isNumberType = barDef?.type === 'number' || typeof currentVal === 'number';

            if (isNumberType) {
              const currentNum = typeof currentVal === 'number' ? currentVal : (Number(currentVal) || 0);
              let changeNum = 0;
              if (typeof changeValue === 'number') {
                changeNum = changeValue;
              } else if (typeof changeValue === 'string') {
                const parsed = Number(changeValue.trim());
                if (!isNaN(parsed)) {
                  changeNum = parsed;
                }
              }
              let nextVal = currentNum + changeNum;
              if (barDef) {
                if (barDef.min !== undefined) nextVal = Math.max(barDef.min, nextVal);
                if (barDef.max !== undefined) nextVal = Math.min(barDef.max, nextVal);
              } else {
                nextVal = Math.max(0, Math.min(100, nextVal));
              }
              cState.status_bars[attrName] = nextVal;
            } else {
              cState.status_bars[attrName] = String(changeValue);
            }
          }
        }

        if (Array.isArray(diff.backpack_changes)) {
          for (const itemChg of diff.backpack_changes) {
            if (!itemChg.name || !itemChg.action) continue;
            const qty = itemChg.quantity !== undefined ? itemChg.quantity : 1;
            const existingItem = cState.backpack.find(item => item.name === itemChg.name);

            if (itemChg.action === 'add') {
              if (existingItem) {
                existingItem.quantity += qty;
              } else {
                cState.backpack.push({ name: itemChg.name, quantity: qty });
              }
            } else if (itemChg.action === 'remove') {
              if (existingItem) {
                existingItem.quantity -= qty;
                if (existingItem.quantity <= 0) {
                  cState.backpack = cState.backpack.filter(item => item.name !== itemChg.name);
                }
              }
            }
          }
        }

        if (typeof diff.balance_change === 'number') {
          cState.balance = Math.max(0, cState.balance + diff.balance_change);
        }
      }
    } catch (err) {
      console.error('[TheaterStageService] [属性结算 Agent] 📊 一次性结算所有角色属性变化失败:', err);
    }

    // 实时通知前端更新角色数值与关系面板 (属性结算后)
    if (onNpcAction) {
      onNpcAction({
        role: 'system',
        content: '[状态更新]',
        type: 'character-states-update',
        characterStates: this.mergeStaticWithDynamic(session.theme_id, currentCharStates)
      } as any);
    }

    // 8. 状态/关系变化看板 (纯代码比对)
    const statusChanges: string[] = [];
    const relationChanges: string[] = [];

    for (let i = 0; i < currentCharStates.length; i++) {
      const prev = prevCharStates[i];
      const curr = currentCharStates[i];
      if (!prev || !curr) continue;

      for (const [k, v] of Object.entries(curr.status_bars)) {
        const oldVal = prev.status_bars[k];
        if (oldVal !== v) {
          statusChanges.push(`**${curr.name}**：属性 [${k}] 变动为 \`${oldVal} ➔ ${v}\``);
        }
      }

      if (prev.balance !== curr.balance) {
        statusChanges.push(`**${curr.name}**：余额变动为 \`💰 ${prev.balance} ➔ ${curr.balance}\``);
      }

      const prevBackpackMap = new Map(prev.backpack.map(item => [item.name, item.quantity]));
      const currBackpackMap = new Map(curr.backpack.map(item => [item.name, item.quantity]));

      for (const item of curr.backpack) {
        const prevQty = prevBackpackMap.get(item.name) || 0;
        if (prevQty !== item.quantity) {
          const diffQty = item.quantity - prevQty;
          statusChanges.push(`**${curr.name}**：背包物品 [${item.name}] 数量 ${diffQty > 0 ? '+' : ''}${diffQty}`);
        }
      }
      for (const item of prev.backpack) {
        if (!currBackpackMap.has(item.name)) {
          statusChanges.push(`**${curr.name}**：失去了背包物品 [${item.name}]`);
        }
      }

      if (prev.relations !== curr.relations) {
        const prevLines = prev.relations.split('\n').filter(l => l.trim() !== '');
        const currLines = curr.relations.split('\n').filter(l => l.trim() !== '');
        for (const line of currLines) {
          if (!prevLines.includes(line)) {
            relationChanges.push(`${line}`);
          }
        }
      }
    }

    if (statusChanges.length > 0 || relationChanges.length > 0) {
      let dashboardContent = `### 📋 本轮状态与关系变动看板\n`;
      if (statusChanges.length > 0) {
        dashboardContent += `\n[STATUS_START]\n` + statusChanges.map(l => `- ${l}`).join('\n') + `\n[STATUS_END]\n`;
      }
      if (relationChanges.length > 0) {
        dashboardContent += `\n[RELATION_START]\n` + relationChanges.map(l => `- ${l}`).join('\n') + `\n[RELATION_END]\n`;
      }

      const boardMsgId = `msg_${Date.now()}_dashboard`;
      db.db.prepare(`
        INSERT INTO TheaterMessages (id, session_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(boardMsgId, sessionId, 'system', dashboardContent, Date.now());

      if (onNpcAction) {
        onNpcAction({
          id: boardMsgId,
          role: 'system',
          content: dashboardContent,
          createdAt: Date.now()
        } as any);
      }
    }

    // 9. 更新运行缓存（洗涤动态状态，不存 Base64）
    const cleanedForDb = this.cleanDynamicStatesForDatabase(currentCharStates);

    db.db.prepare(`
      UPDATE TheaterSessions
      SET npc_states = ?, turn_count = turn_count + 1, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(cleanedForDb), Date.now(), sessionId);

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET character_states = ?
      WHERE session_id = ?
    `).run(JSON.stringify(cleanedForDb), sessionId);

    // 实时通知前端更新角色数值与关系面板
    if (onNpcAction) {
      onNpcAction({
        role: 'system',
        content: '[状态更新]',
        type: 'character-states-update',
        characterStates: this.mergeStaticWithDynamic(session.theme_id, currentCharStates)
      } as any);
    }

    // 10. 第 10 轮剧情总结
    let newSummary = stateRow ? stateRow.summary : '';
    const newTurnCount = session.turn_count + 1;
    if (newTurnCount % 10 === 0) {
      const sumPromptText = this.renderPromptText(
        prompts.summary,
        {
          themeJson,
          stateRow,
          session,
          userText,
          cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
          participatingNames,
          characters
        },
        {
          current_summary: newSummary || '(开场纪事无总结)',
          last_10_rounds_history: cleanedHistory + '\n' + roundInteractionText
        }
      );

      try {
        console.log('[TheaterStageService] [剧情总结 Agent] 📝 达到 10 轮周期，正在对阶段性剧情进行总结凝练...');
        const res = await modelAdapter.chat([{ role: 'system', content: sumPromptText }], { useSecondary: true, skipSystemInjection: true });
        newSummary = res.content.trim();
        console.log('[TheaterStageService] [剧情总结 Agent] 📝 阶段总结更新成功！');
        db.db.prepare(`
          UPDATE TheaterSessionStates
          SET summary = ?
          WHERE session_id = ?
        `).run(newSummary, sessionId);
      } catch (err) {
        console.error('[TheaterStageService] [剧情总结 Agent] 📝 运行剧情总结 Agent 失败:', err);
      }
    }

    // 11. 主线状态与角色心理更新 Agent
    try {
      const plotStatePromptText = this.renderPromptText(
        prompts.plotState,
        {
          themeJson,
          stateRow,
          session,
          userText,
          cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
          participatingNames,
          roundInteractionText,
          characters
        },
        {
          time_space: newTimeSpace,
          plot_state: JSON.stringify(plotState, null, 2),
          latest_round_content: roundInteractionText,
          round_context: JSON.stringify(roundContext, null, 2)
        }
      );
      const res = await modelAdapter.chat([{ role: 'system', content: plotStatePromptText }], { useSecondary: true, skipSystemInjection: true });
      const parsed = JSON.parse(this.cleanJsonWrap(res.content));
      plotState = {
        mainGoal: parsed.mainGoal || plotState.mainGoal,
        currentConflict: parsed.currentConflict || plotState.currentConflict,
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : plotState.openQuestions,
        knownClues: Array.isArray(parsed.knownClues) ? parsed.knownClues : plotState.knownClues,
        unresolvedThreats: Array.isArray(parsed.unresolvedThreats) ? parsed.unresolvedThreats : plotState.unresolvedThreats,
        nextPressurePoint: parsed.nextPressurePoint || plotState.nextPressurePoint
      };
    } catch (err: any) {
      console.warn('[TheaterStageService] [主线状态 Agent] 更新失败，沿用旧主线状态:', err.message || err);
    }

    try {
      const mindPromptText = this.renderPromptText(
        prompts.characterMind,
        {
          themeJson,
          stateRow,
          session,
          userText,
          cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
          participatingNames,
          roundInteractionText,
          characters
        },
        {
          character_minds: JSON.stringify(characterMinds, null, 2),
          plot_state: JSON.stringify(plotState, null, 2),
          latest_round_content: roundInteractionText,
          round_context: JSON.stringify(roundContext, null, 2)
        }
      );
      const res = await modelAdapter.chat([{ role: 'system', content: mindPromptText }], { useSecondary: true, skipSystemInjection: true });
      const parsed = JSON.parse(this.cleanJsonWrap(res.content));
      if (Array.isArray(parsed)) {
        const existingByName = new Map(characterMinds.map((mind) => [mind.name, mind]));
        for (const mind of parsed) {
          if (!mind?.name) continue;
          existingByName.set(mind.name, {
            name: mind.name,
            currentEmotion: mind.currentEmotion || existingByName.get(mind.name)?.currentEmotion || '状态不明',
            currentGoal: mind.currentGoal || existingByName.get(mind.name)?.currentGoal || '目标不明',
            hiddenIntent: mind.hiddenIntent || existingByName.get(mind.name)?.hiddenIntent || '',
            attitudeToPlayer: mind.attitudeToPlayer || existingByName.get(mind.name)?.attitudeToPlayer || '态度不明',
            pressure: mind.pressure || existingByName.get(mind.name)?.pressure || '压力不明',
            nextLikelyMove: mind.nextLikelyMove || existingByName.get(mind.name)?.nextLikelyMove || '等待局势变化'
          });
        }
        characterMinds = Array.from(existingByName.values());
      }
    } catch (err: any) {
      console.warn('[TheaterStageService] [角色心理 Agent] 更新失败，沿用旧心理状态:', err.message || err);
    }

    try {
      db.db.prepare(`
        UPDATE TheaterSessionStates
        SET plot_state = ?, character_minds = ?
        WHERE session_id = ?
      `).run(JSON.stringify(plotState), JSON.stringify(characterMinds), sessionId);
    } catch (err: any) {
      console.error('[TheaterStageService] 保存主线状态与角色心理失败:', err.message || err);
    }

    // 12. 选项生成 Agent
    const charSummaryText = characters.map(c => `姓名: ${c.name}, 设定: ${c.soul.substring(0, 100)}...`).join('\n');
    const optPromptText = this.renderPromptText(
      prompts.options,
      {
        themeJson,
        stateRow,
        session,
        userText,
        cleanedHistory: cleanedHistory + '\n' + roundInteractionText,
        participatingNames,
        characters
      },
      {
        summary: newSummary || '(无总结)',
        time_space: newTimeSpace,
        character_settings: charSummaryText,
        player_character: session.player_character,
        director_intent: roundContext.directorIntent,
        round_context: JSON.stringify(roundContext, null, 2),
        plot_state: JSON.stringify(plotState, null, 2)
      }
    );

    let nextOptions = [];
    try {
      console.log('[TheaterStageService] [选项生成 Agent] 💡 正在为下一轮玩家动作生成 4 个极简引导选项...');
      const res = await modelAdapter.chat([{ role: 'system', content: optPromptText }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      nextOptions = this.normalizePlayerOptions(JSON.parse(cleanJson), session.player_character);
      if (nextOptions.length === 0) {
        nextOptions = this.buildFallbackPlayerOptions(session.player_character, newTimeSpace);
      }
      console.log(`[TheaterStageService] [选项生成 Agent] 💡 引导选项生成成功，共生成了 ${nextOptions.length} 个选项。`);
    } catch (err) {
      console.warn('[TheaterStageService] [选项生成 Agent] 💡 生成选项失败，将使用玩家可执行兜底选项。异常信息:', err);
      nextOptions = this.buildFallbackPlayerOptions(session.player_character, newTimeSpace);
    }

    // 保存新生成的选项到数据库以供状态读取/重载
    try {
      db.db.prepare(`
        UPDATE TheaterSessionStates
        SET next_options = ?
        WHERE session_id = ?
      `).run(JSON.stringify(nextOptions), sessionId);
      if (onNpcAction) {
        onNpcAction({
          id: `evt_${Date.now()}_stage_state_updated`,
          sessionId,
          roundId,
          role: 'system',
          content: '[状态同步]',
          type: 'stage-state-updated'
        } as any);
      }
    } catch (err: any) {
      console.error('[TheaterStageService] 保存新生成的选项到数据库失败:', err);
    }

    // 12. 异步生图
    if (prompts.enableImageGen) {
      this.triggerAsyncImageGeneration(sessionId, session.theme_id, roundInteractionText, newTimeSpace, charSummaryText, onNpcAction);
    }

    const updatedMessages = db.db.prepare('SELECT * FROM TheaterMessages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];

    return {
      sessionId,
      timeSpace: newTimeSpace,
      summary: newSummary,
      characterStates: this.mergeStaticWithDynamic(session.theme_id, currentCharStates),
      nextOptions,
      roundContext,
      plotState,
      characterMinds,
      messages: updatedMessages
    };
  }

  /**
   * 6. 异步生图
   */
  private async triggerAsyncImageGeneration(
    sessionId: string,
    themeId: string,
    latestContent: string,
    timeSpace: string,
    charSettings: string,
    onNpcAction?: (payload: any) => void
  ) {
    try {
      const db = getDatabaseService();
      const naiConfigStr = db.getSetting('novelai_config');
      if (!naiConfigStr) return;
      const config = JSON.parse(naiConfigStr);
      if (!config.apiKey || config.apiKey.trim() === '') return;

      const stateRow = db.db.prepare('SELECT * FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
      if (!stateRow) return;
      const prompts = JSON.parse(stateRow.agent_prompts);

      const session = db.db.prepare('SELECT * FROM TheaterSessions WHERE id = ?').get(sessionId) as any;
      const themeDir = join(this.baseDir, themeId);
      const themeJson = JSON.parse(fs.readFileSync(join(themeDir, 'theme.json'), 'utf8'));
      this.ensureStatusBarsConfig(themeJson);

      const imgGenPromptText = this.renderPromptText(
        prompts.imageGen,
        {
          themeJson,
          stateRow,
          session,
          roundInteractionText: latestContent
        },
        {
          character_settings: charSettings,
          time_space: timeSpace,
          latest_round_content: latestContent
        }
      );

      const modelAdapter = this.getModelAdapter();
      console.log('[TheaterStageService] [生图描绘 Agent] 🎨 正在提取本轮戏剧冲突并构思插图渲染任务...');
      const res = await modelAdapter.chat([{ role: 'system', content: imgGenPromptText }], { useSecondary: true, skipSystemInjection: true });
      const cleanJson = this.cleanJsonWrap(res.content);
      const drawQueue = JSON.parse(cleanJson);

      if (Array.isArray(drawQueue) && drawQueue.length > 0) {
        console.log(`[TheaterStageService] [生图描绘 Agent] 🎨 绘图构思完成！规划生图任务数: ${drawQueue.length}`);
        const tasks = drawQueue.slice(0, 3);
        
        for (const task of tasks) {
          if (!task.prompt) continue;

          let finalPrompt = task.prompt.trim();
          let activeArtist = '';
          if (config.randomArtist && Array.isArray(config.artistStringList) && config.artistStringList.length > 0) {
            const validList = [...new Set(config.artistStringList.map((item: any) => {
              if (typeof item === 'string') return item.trim();
              return (item.value || '').trim();
            }).filter((v: string) => v.length > 0))];
            if (validList.length > 0) {
              const rIndex = Math.floor(Math.random() * validList.length);
              activeArtist = validList[rIndex] as string;
            }
          }
          if (!activeArtist && config.artistString?.trim()) {
            activeArtist = config.artistString.trim();
          }

          if (activeArtist) finalPrompt = `${activeArtist}, ${finalPrompt}`;
          if (config.qualityPrompt?.trim()) finalPrompt = `${finalPrompt}, ${config.qualityPrompt.trim()}`;

          const finalConfig = {
            ...config,
            artistString: '',
            randomArtist: false
          };

          const dims = config.defaultDimensions || 'portrait';
          
          try {
            console.log(`[TheaterStageService] [生图渲染 Agent] 🖼️ 正在发起物理绘图请求，维度: ${dims}`);
            const imageBuffer = await NovelAiService.generateImage(finalConfig, finalPrompt, dims);
            
            const themeDir = join(this.baseDir, themeId);
            const sessDir = join(themeDir, 'sessions', sessionId);
            const imagesDir = join(sessDir, 'images');
            if (!fs.existsSync(imagesDir)) {
              fs.mkdirSync(imagesDir, { recursive: true });
            }

            const imgFilename = `img_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.png`;
            const absoluteImgPath = join(imagesDir, imgFilename);
            fs.writeFileSync(absoluteImgPath, imageBuffer);

            const imageMsgId = `msg_${Date.now()}_image`;
            const metadataObj = {
              type: 'image',
              imagePath: absoluteImgPath,
              actors: Array.isArray(task.characters) ? task.characters.join(' & ') : ''
            };

            db.db.prepare(`
              INSERT INTO TheaterMessages (id, session_id, role, content, metadata, created_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(imageMsgId, sessionId, 'system', '[插画渲染]', JSON.stringify(metadataObj), Date.now());

            console.log(`[TheaterStageService] [生图渲染 Agent] 🖼️ 物理绘图保存成功，文件保存至: ${absoluteImgPath}`);

            if (onNpcAction) {
              onNpcAction({
                id: imageMsgId,
                role: 'system',
                content: '[插画渲染]',
                type: 'image',
                imagePath: absoluteImgPath,
                actors: Array.isArray(task.characters) ? task.characters.join(' & ') : '',
                createdAt: Date.now()
              });
            }
          } catch (err: any) {
            console.error(`[TheaterStageService] [生图渲染 Agent] 🖼️ 物理生图渲染异常:`, err.message || err);
          }
        }
      }
    } catch (e: any) {
      console.error('[TheaterStageService] 异步生图控制流程异常:', e.message || e);
    }
  }

  /**
   * 7. 物理更新配置
   */
  public updateAgentPrompts(sessionId: string, prompts: Record<string, string>): void {
    const db = getDatabaseService();
    const stateRow = db.db.prepare('SELECT agent_prompts FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
    if (!stateRow) {
      throw new Error('未找到当前剧本会话状态。');
    }

    const currentPrompts = JSON.parse(stateRow.agent_prompts);
    const updated = {
      ...currentPrompts,
      ...prompts
    };

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET agent_prompts = ?
      WHERE session_id = ?
    `).run(JSON.stringify(updated), sessionId);
  }

  /**
   * 8. 手动修改任何角色的细节信息
   */
  public updateCharacterState(
    sessionId: string,
    charName: string,
    payload: {
      status_bars?: Record<string, number | string>;
      backpack?: Array<{ name: string; quantity: number }>;
      balance?: number;
      relations?: string;
    }
  ): void {
    const db = getDatabaseService();
    const stateRow = db.db.prepare('SELECT character_states FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
    if (!stateRow) throw new Error('未找到对应大剧院会话状态！');

    const characterStates = JSON.parse(stateRow.character_states) as CharacterState[];
    const target = characterStates.find(s => s.name === charName);
    if (!target) throw new Error(`未在大剧院中找到角色 [${charName}] 的实时状态。`);

    if (target.isParticipating === false) {
      if (payload.status_bars || payload.backpack || payload.balance !== undefined) {
        throw new Error(`角色 [${charName}] 当前处于退场状态，不允许修改其数值状态栏、背包或余额。`);
      }
    }

    if (payload.status_bars) target.status_bars = payload.status_bars;
    if (payload.backpack) target.backpack = payload.backpack;
    if (payload.balance !== undefined) target.balance = payload.balance;
    if (payload.relations !== undefined) target.relations = payload.relations;

    const cleanedForDb = this.cleanDynamicStatesForDatabase(characterStates);

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET character_states = ?
      WHERE session_id = ?
    `).run(JSON.stringify(cleanedForDb), sessionId);

    db.db.prepare(`
      UPDATE TheaterSessions
      SET npc_states = ?
      WHERE id = ?
    `).run(JSON.stringify(cleanedForDb), sessionId);
  }

  /**
   * 手动更新游玩会话中的参演角色勾选状态
   */
  public updateSessionParticipatingCharacters(sessionId: string, activeNames: string[]): { success: boolean } {
    const db = getDatabaseService();
    const stateRow = db.db.prepare('SELECT character_states FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;
    if (!stateRow) throw new Error('未找到对应大剧院会话状态！');

    const characterStates = JSON.parse(stateRow.character_states) as any[];
    for (const char of characterStates) {
      char.isParticipating = activeNames.includes(char.name);
    }

    const cleanedForDb = this.cleanDynamicStatesForDatabase(characterStates);

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET character_states = ?
      WHERE session_id = ?
    `).run(JSON.stringify(cleanedForDb), sessionId);

    db.db.prepare(`
      UPDATE TheaterSessions
      SET npc_states = ?
      WHERE id = ?
    `).run(JSON.stringify(cleanedForDb), sessionId);

    return { success: true };
  }

  /**
   * 游玩中动态增加一个全局状态栏属性并同步至物理题材及当前会话中的所有角色中
   */
  public async addSessionStatusBar(sessionId: string, newBar: any): Promise<any> {
    const db = getDatabaseService();
    // 1. 获取 Session 和 State
    const session = db.db.prepare('SELECT * FROM TheaterSessions WHERE id = ?').get(sessionId) as any;
    if (!session) throw new Error('未找到当前会话。');
    const stateRow = db.db.prepare('SELECT * FROM TheaterSessionStates WHERE session_id = ?').get(sessionId) as any;

    // 2. 追加到题材物理 theme.json
    const themeDir = join(this.baseDir, session.theme_id);
    const themeJsonPath = join(themeDir, 'theme.json');
    if (fs.existsSync(themeJsonPath)) {
      try {
        const themeJson = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
        if (!themeJson.status_bars) themeJson.status_bars = [];
        // 避免重复
        if (!themeJson.status_bars.some((b: any) => b.name === newBar.name)) {
          themeJson.status_bars.push(newBar);
          fs.writeFileSync(themeJsonPath, JSON.stringify(themeJson, null, 2), 'utf8');
        }
      } catch (err: any) {
        console.error('[TheaterStageService] 追加状态栏定义至 theme.json 失败:', err);
      }
    }

    // 3. 更新当前内存/数据库中的角色状态
    const dynamicStates: CharacterState[] = JSON.parse(stateRow ? stateRow.character_states : session.npc_states);
    for (const ds of dynamicStates) {
      if (!ds.status_bars) ds.status_bars = {};
      if (ds.status_bars[newBar.name] === undefined) {
        ds.status_bars[newBar.name] = newBar.initialValue !== undefined ? newBar.initialValue : (newBar.type === 'number' ? 100 : '良好');
      }
    }

    const cleanedForDb = this.cleanDynamicStatesForDatabase(dynamicStates);
    const serialized = JSON.stringify(cleanedForDb);

    db.db.prepare(`
      UPDATE TheaterSessions
      SET npc_states = ?
      WHERE id = ?
    `).run(serialized, sessionId);

    db.db.prepare(`
      UPDATE TheaterSessionStates
      SET character_states = ?
      WHERE session_id = ?
    `).run(serialized, sessionId);

    console.log(`[TheaterStageService] 成功为会话 ${sessionId} 新增状态栏属性 [${newBar.name}]。`);

    return this.mergeStaticWithDynamic(session.theme_id, dynamicStates);
  }

  /**
   * 9. 手动修改任何角色的设定 (Soul.md)
   */
  public editCharacterSoul(themeId: string, charName: string, newSoul: string): void {
    const storage = new (require('../../utils/CharacterStorageManager').CharacterStorageManager)();
    const charPinyin = storage.convertToPinyin(charName);
    const themeDir = join(this.baseDir, themeId);
    const soulFile = join(themeDir, 'characters', charPinyin, 'Soul.md');

    if (fs.existsSync(soulFile)) {
      fs.writeFileSync(soulFile, newSoul.trim(), 'utf8');
    } else {
      throw new Error(`未在剧本角色卡中找到该角色 [${charName}] 的 Soul.md 设定文件。`);
    }
  }

  /**
   * 将动态运行期状态经过清洗后，只保留属性、背包、金币、关系，彻底防范 Base64 及静态文件字段被意外存进数据库
   */
  private cleanDynamicStatesForDatabase(states: any[]): any[] {
    return states.map(s => ({
      name: s.name,
      status_bars: s.status_bars || {},
      relations: s.relations || '',
      backpack: s.backpack || [],
      balance: s.balance !== undefined ? (Number(s.balance) || 0) : 0,
      isParticipating: s.isParticipating !== undefined ? !!s.isParticipating : true
    }));
  }

  /**
   * 将动态角色状态与对应题材中的静态头像、设定等大文件资源拼接，避免数据库大负荷
   */
  private mergeStaticWithDynamic(themeId: string, dynamicStates: any[]): any[] {
    const staticChars = this.loadThemeCharacters(themeId);
    return dynamicStates.map(ds => {
      const sc = staticChars.find(c => c.name === ds.name);
      return {
        ...ds,
        gender: sc ? sc.gender : (ds.gender || '未知'),
        age: sc ? sc.age : (ds.age || ''),
        soul: sc ? sc.soul : (ds.soul || ''),
        appearance: sc ? sc.appearance : (ds.appearance || ''),
        avatar: sc ? sc.avatar : (ds.avatar || ''),
        isUserPersona: sc ? sc.isUserPersona : !!ds.isUserPersona,
        isParticipating: ds.isParticipating !== undefined ? !!ds.isParticipating : true
      };
    });
  }

  /**
   * 根据 themeId 查找最近的游玩会话
   */
  public findActiveSession(themeId: string): any {
    const db = getDatabaseService();
    const session = db.db.prepare(`
      SELECT id, player_character 
      FROM TheaterSessions 
      WHERE theme_id = ? 
      ORDER BY updated_at DESC 
      LIMIT 1
    `).get(themeId) as any;

    if (session) {
      return { sessionId: session.id, playerCharacter: session.player_character };
    }
    return { sessionId: null };
  }

  /**
   * 删除大剧院会话的某条消息，并硬删除其关联的物理插画文件
   */
  public deleteMessage(sessionId: string, messageId: string): { success: boolean; error?: string } {
    try {
      const db = getDatabaseService();

      // 1. 先查出此条消息的内容和 metadata
      const stmt = db.db.prepare('SELECT * FROM TheaterMessages WHERE id = ? AND session_id = ?');
      const msg = stmt.get(messageId, sessionId) as { metadata?: string } | undefined;

      if (!msg) {
        return { success: false, error: '未找到指定消息。' };
      }

      // 2. 如果是图片消息且有 metadata，尝试物理硬删除它
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata);
          if (meta.type === 'image' && meta.imagePath) {
            const imgPath = meta.imagePath;
            console.log('[TheaterStageService] 正在物理硬删除插图文件:', imgPath);

            // 安全限制：只能删除 theaters 目录下的文件，防路径穿越
            if (imgPath.startsWith(this.baseDir) && fs.existsSync(imgPath)) {
              fs.unlinkSync(imgPath);
              console.log('[TheaterStageService] 物理硬删除插图文件成功:', imgPath);
            }
          }
        } catch (err: any) {
          console.error('[TheaterStageService] 解析消息 metadata 并删除图片异常:', err.message || err);
        }
      }

      // 3. 从数据库中删除记录
      db.db.prepare('DELETE FROM TheaterMessages WHERE id = ? AND session_id = ?').run(messageId, sessionId);

      return { success: true };
    } catch (e: any) {
      console.error('[TheaterStageService] deleteMessage 异常:', e);
      return { success: false, error: e.message || e };
    }
  }
}
