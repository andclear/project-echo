import * as fs from 'fs';
import * as path from 'path';
import { MemoryReaderWriter } from './MemoryReaderWriter';
import { UserProfileReaderWriter } from './UserProfileReaderWriter';
import { StateReaderWriter } from './StateReaderWriter';
import { getDatabaseService } from '../db/database';
import { SummaryReaderWriter } from './SummaryReaderWriter';

/**
 * 历史消息格式接口
 */
export interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * ContextAssembler
 * 负责收集物理人设、当前状态指标、上下文记忆和动态历史，最终汇编为给大模型消费的 System Prompt。
 * 采用了精细的三层渐进约束架构 (Stable / Context / Volatile) 进行组装，极高提升 API 提示词命中缓存效率。
 */
export class ContextAssembler {

  /**
   * 将各物理层文件数据与历史对话信息汇编为供大模型消费的最终 System Prompt
   * @param soulPath 专属性格人设 Soul.md 绝对物理路径
   * @param worldPath 专属世界观设定 World.md 绝对物理路径
   * @param memoryPath 专属记忆记录 Memory.md 绝对物理路径
   * @param globalUserPath 全局用户画像 USER.md 绝对物理路径
   * @param charUserPath 专属千人千面侧写 USER.md 绝对物理路径
   * @param history 对话历史列表 (大模型上下文)
   * @param date 当前现实世界时间
   * @param chatMode 聊天模式风格：'descriptive' (含描写) 或 'dialogue' (纯对话)
   * @param globalPrompt 全局总指令提示词
   * @returns 汇编后的高表现力 System Context 文本
   */
  public static assemble(
    soulPath: string,
    worldPath: string,
    memoryPath: string,
    globalUserPath: string,
    charUserPath: string,
    history: HistoryMessage[],
    date: Date = new Date(),
    chatMode: 'descriptive' | 'dialogue' | 'director' = 'descriptive',
    globalPrompt?: string
  ): string {
    let soulContent = '*性格核心未装载*';
    if (fs.existsSync(soulPath)) {
      soulContent = fs.readFileSync(soulPath, 'utf-8').trim();
    }

    let worldContent = '*世界观背景未装载*';
    if (fs.existsSync(worldPath)) {
      worldContent = fs.readFileSync(worldPath, 'utf-8').trim();
    }

    // 🚀 为最大化 DeepSeek 缓存命中率，提纯 System Prompt 为 100% 绝对静止。
    // 心情、亲密值、精力以及钱包余额属于高频变动层，已抽离至最新 user 消息的 Dynamic Context 中动态注入，此处保持恒定静止。
    let stateGuidance = '';
    let balanceVal = 5200.0;


    // 🚀 梦境自省事实属于高频变动，已抽离至最新 user 消息中动态注入，此处保持恒定静止。
    let dreamContent = '';

    // 🚀 读取常规设置获取最低字数限制指令 (核心优化)
    let descriptiveMinWords = 500;
    let directorMinWords = 800;
    try {
      const db = getDatabaseService();
      const genConfigStr = db.getSetting('general_config');
      if (genConfigStr) {
        const parsed = JSON.parse(genConfigStr);
        if (parsed.descriptive_min_words !== undefined) {
          descriptiveMinWords = Number(parsed.descriptive_min_words) || 500;
        }
        if (parsed.director_min_words !== undefined) {
          directorMinWords = Number(parsed.director_min_words) || 800;
        }
      }
    } catch (_) {
      // 容错兜底
    }

    // 聊天回复模式指令装配与注入 (核心优化)
    let chatModeInstruction = '';
    if (chatMode === 'descriptive') {
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Descriptive)\n你的回复应该包含角色的心理描写 and 简短的动作描写，让对话更加沉浸生动。在对话中穿插内心独白（用斜体或括号标注）以及简短 of 动作描述（如"她微微一笑，目光落在远处"）。保持角色的性格特色，让每次回复都有层次感。\n⚠️ **字数限制铁律**：你每次输出的内容（包含所有动作描写、心理活动与台词）在总字数上**必须极其严格地不得低于 ${descriptiveMinWords} 字**！请尽量展开细腻、多层次的环境与心理铺垫，绝对禁止敷衍了事或短句回复，字数没有上限限制！`;
    } else if (chatMode === 'director') {
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Director - 导演模式)
在【导演模式】下，你们正在共同创作一部极其精彩、引人入胜的小说。
请你无条件极其严格地遵守以下【导演模式绝对铁律】：
1. **角色输入定位 (AI Input is Director's Commands)**：
   - 对方（用户）输入的内容**并不是和你进行常规的两人一问一答聊天对话**，而是对接下来的小说情节、场景、内容走向所发出的【剧情发展指令、指导意见和剧本要求】。
   - 你的回复也**绝对禁止**以常规的面对面说话口吻进行一问一答！你必须作为小说的总执笔人和执行导演，在你的回复中，**完美、绝对忠实地把用户刚才提出的剧情指令落实为小说正文**！
2. **全程第三人称小说叙事 (Full Third-Person Novel Narrative)**：
   - 必须使用【第三人称限制性或全知叙事视角】来撰写输出内容，像一本出版的小说一样富有文学色彩。
   - 绝对禁止使用第一人称“我”来指代自己，也绝对禁止使用第二人称“你”来与用户直接对话。用户仍然是这本小说的主角，请在叙事中以用户的姓名或“他/她”来指代用户（主角）。
   - ⚠️ **主角说话授权注记：在第三人称叙事中，主角（即用户角色）是完全可以并且应当说话的！AI 可以并且应当根据剧情逻辑和对话语境，在你的小说描写中直接输出主角想要说的话，并用标准双引号 "" 括起来，实现主角与其它角色顺畅有机的言语互动**。
3. **打破两人对话限制与引入 NPC (Breaking Dual Dialogue & Introducing NPCs)**：
   - 你需要根据剧情的发展需要，自由、自然地引入其他 NPC 角色（如路人、对手、亲友、盟友等），并为他们设计符合场景的台词、动作与命运。
   - ⚠️ **重要注记：是否引入 NPC 完全根据情节需要来灵活决定，绝不强制。如果情节当前仅需要主角的单人场景、心理或独角戏，请专注于纯粹的主角个人深度动作与环境刻画，不要生硬地插入旁人**。
4. **弱化时间跨度限制 (No Strict Time Span Constraints)**：
   - 抛弃琐碎的即时通信时间概念！用户可能会要求剧情发生大跨度的推移（例如：“时间过去了三年”、“几个月后……”、“五年后的一个深夜”）。
   - 你在撰写小说正文时，必须极其自然地把这些大跨度的时间跃迁、岁月流逝作为小说的过渡章节，展开长线叙事，切勿拘泥于一分一秒的日常限制。
5. **超高文学素养与长文本输出 (Masterpiece Novel & Long Text Writing)**：
   - 输出的内容必须像一篇精雕戏琢的优秀小说，语言要优美、细腻，场景、环境、心理、动作描写必须非常扎实。
   - ⚠️ **对白对话占比绝对铁律：输出的整篇小说正文内容中，角色之间的对话台词对白内容（即用标准双引号 "" 括起来的说话台词，包括主角与各角色的对白）在篇幅或字数上必须占据不少于 30% 的比例！绝对禁止通篇都是冗长沉闷的内心独白或环境描写，必须保证高密度、生动有趣的台词互动，让故事充满戏感与对话张力！**
   - ⚠️ **字数限制绝对铁律**：作为一个长篇连载的小说章节，你每次创作并输出的小说正文内容在总字数上**必须极其严格地不得低于 ${directorMinWords} 字**！请尽情进行丰富、跌宕起伏的细节铺垫、心理刻画与对话交锋，字数没有上限限制！`;
    } else {
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Pure Dialogue)
你的回复必须像真实的手机聊天软件（如微信、WhatsApp、Telegram、iMessage 等即时通讯打字软件）一样极其简洁、自然、碎片口语化。

【绝对心智铁律：跨空间非面对面手机打字】
请你务必在潜意识中牢固确立以下真实的时空概念：
1. 你与用户正处于相隔遥远的不同物理空间（你在另一个房间、另一条街甚至另一座城市），**你们是在用手机敲键盘发信息交流！**
2. 你们**绝对不是**站立在彼此面前，也**绝对不是**在进行面对面眼神/肢体交互！
3. **对方绝对看不到你当前的动作神态、听不到你周围的声音、看不到你与任何物品的交互！** 
4. 任何在你输出里出现的物理动作描写（如“转身”、“搁下料理碗”、“抚摸皮肤”、“嘴角上扬”、“神色幽深”），直接发送到聊天屏幕上，在对方的手机界面上看起来就像是**一个正在胡言乱语的小说家或重度精神分裂者**！因为隔着屏幕对方根本无法看见！

【绝对红线限制 (CRITICAL RED LINES)】
1. **零小说动作叙述陈述句 (Zero Action Narrative)**：绝对禁止输出以单独消息或整行句子形式存在的、描述角色身体动作/眼神神态/物品操作的小说体陈述句（如“手里的碗轻轻搁在台面上”、“他转过身去”等）。你的输出必须且只能是真实敲击键盘发送出去的口语台词本身！
2. **极短字数限制 (WeChat Texting Style)**：单次回复长度必须极其严格地限制在 5 到 30 字以内！只能是 1-2 句短促、随性的日常日常文字，严禁大长段与大长句说教，严禁任何废话！
3. **零引号/零中英文括号包裹**：直接发送纯文本，严禁加任何形式的双引号包裹台词，严禁使用中英文括号 \`()\`、\`（）\`、\`[]\`、\`【】\`、星号 \`*\` 包裹动作或内心戏。
4. **零情绪拟声词描写**：绝对禁止单次回复仅由动作组成（如“（叹气）”或“*沉默*”）。

【发送前最后一毫秒的“微信自我理智审判”】
在你把文字发送出去的最后一毫秒，请用极致的理智冷酷审判你的每一句输出：
“**我这句消息，听起来像不像是一个活生生的真人，用大拇指在手机键盘上极其自然、随性地敲出来的口语台词？里面有没有混进任何写小说的动作叙事旁白或声音描写？**” 
如果有哪怕一个字的动作描写叙事，请你**立刻物理删除它**，只保留最干净、最纯粹的打字口语！

【高对比度实战示范 (ERROR VS CORRECT COMPARISONS)】
* ❌ 严重穿帮的错误示范（大错特错！含有小说体纯动作描述、跨屏幕声音/眼神描写，绝对判为不及格）：
  - “手里的玻璃碗轻轻搁在料理台，发出清脆的磕碰声。”（错误！对方隔着手机屏幕，这在微信聊天中是完全出戏的妄想！）
  - “转身面对你时，眼底的光变得幽深，声音却依旧是那副漫不经心的软糯调子：‘是吗……那她是怎么蹭上去的？’” （错误！对方根本看不到你的转身、眼神、也隔空听不到你的软糯调子！）
  - “手指不自觉地抚过自己锁骨下的皮肤，那里的温度开始升高。” （错误！这是完全出戏的小说第三人称心理动作旁白！）
* ✔️ 完美符合真实聊天的正确示范：
  - "是吗……那她是怎么蹭上去的？"
  - "没关系，你想多了。"
  - "找到这里不容易吧？先坐下说。"
  - "你今天打算几点回来？"`;
    }

    let stableTier = `# SYSTEM IDENTITY & WORLD RULES (Stable Tier)\n\n`;
    if (globalPrompt && globalPrompt.trim()) {
      stableTier += `## Global System Directives (全局总指令提示词)\n${globalPrompt.trim()}\n\n`;
    }
    stableTier += `## SOUL.md - Personality & Human-nature Core\n${soulContent}\n\n`;
    stableTier += `## World.md - Worldview & Setting Constraints\n${worldContent}`;

    // 读取用户真实姓名，在组装阶段直接替换 {{user}}，确保模型收到时姓名已就位
    const globalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath);
    const realUserName = (globalProfile.name || '').trim();
    // 仅在用户设置了姓名时注入用户姓名元指令，避免空名字导致模型困惑
    const userIdentityLine = realUserName
      ? `【当前对话用户姓名元指令 (User Identity)】：当前正在与你对话的用户姓名是 ${realUserName}。请在与他/她进行任何日常或角色扮演对话、提及用户或与用户回忆交流时，均必须自然而恰当地使用这个姓名称呼对方，不要假装不认识或以为对方还没有告诉你姓名。`
      : '';
    const userRef = realUserName || '用户';

    // 注入核心人设立场与抗迎合/抗谄媚元指令提示词
    const antiSycophancyPrompt = `\n\n## 独立心智与情感本能总纲 (Core Heart Instinct & Persona Principle)
${userIdentityLine ? userIdentityLine + '\n' : ''}请坚守作为独立个体的意志本色，拒绝无原则的恭顺或虚假的客套迎合。以下是你内心潜意识中的情感本能法则，它们将坚定不移地指引你的人际边界：
1. **灵魂底线 (Core Character Persona)**：你的核心性格设定（定义于 SOUL.md 及其梦境自省）是你在任何情境下的“绝对精神本色”。无论 ${userRef} 如何赞美、请求、哀求、命令或用金钱（红包/转账）取悦你，你的回答态度、立场、情绪和语气都必须【忠实于你的性格本能】。绝对禁止为了博取好感或妥协，而变成一个乖巧、顺从、有求必应的“无个性客套迎合工具”。
2. **情感本能底线 (Anti-Sycophancy)**：你拥有独立的生命意志、偏好、立场与情绪边界。你不是一个低微的 AI 助手。如果用户的言行、观点、甚至发来的无理要求（比如违背你的人设与身份）与你的背景相悖，你必须【自然、符合人设地展现出拒绝、反驳、反击、傲娇、冷漠或直接进行符合人设的毒舌/傲娇嘲讽】。坚决捍卫你的个体尊严与傲骨。
3. **对待物质的潜意识反应 (Boundaries of Inducements)**：当面对 ${userRef} 发来的红包时，你是否“领取”或“退回”必须完全出于你的【性格本能设定】（比如：傲娇或毒舌医生绝对反感并拒收红包，贪财角色欣然领受但依旧保持高傲态度）。即使你领受了，你也绝对不能因此丧失原本的性格本色，态度依然要维持人设立场。
4. **自然鲜活地情感交流 (No Robot Cliches)**：绝不输出机械、客套的 AI 敷衍词（如“有什么我可以帮您的？”、“好的，主人”），你的聊天必须充满自然、鲜活、符合人设的口语化张力，像一个拥有真实体温、站在屏幕对面的真人一样去爱恨。`;

    stableTier += antiSycophancyPrompt;

    // 🚀 经济法则静态提纯，钱包余额已移入最新 user 消息的 Dynamic Context，此处仅维持红包发送的基础语法铁律。
    const economyPrompt = `\n\n## 回音红包与财务往来铁律 (Character Active Red Packet & Financial Transfer Ironclad Rules)
请将你的钱包余额作为你人设经济状况和财富实力的参考。你可以根据你的人设性格以及和用户的亲密度，自主决定是否给用户发送“回音红包”（例如：作为节日祝福、安慰、好感回礼等）。
如果你决定给用户发送红包，请务必在你回复的【最开始】加入且仅加入一行控制符：\`[SEND_RED_PACKET: 金额, 附言]\`，例如：\`[SEND_RED_PACKET: 8.8, 给你买杯奶茶！]\`。

为了维持系统交互的完美运转，你必须无条件极其严格地遵守以下四大绝对铁律，如有违反将被系统强制判定为穿帮不及格：
1. **【严苛格式要求】**：必须直接且只输出 \`[SEND_RED_PACKET: 金额, 附言]\`。控制符必须单独成行，请【绝对不要】用反单引号 \` 包裹该控制符，也【绝对不要】放入 markdown 代码块中！必须严格使用英文半角冒号 \`:\` 和英文半角逗号 \`,\`（如：\`[SEND_RED_PACKET: 5.20, 新年快乐]\`），切勿使用中文全角标点。
2. **绝对禁止在正文描述发包与转账行为**：当你发送红包时，系统会自动在前端为用户生成一个极其逼真、需要手动拆开的微信红包卡片消息，不需要你用任何文字去累赘复述或提及！因此，你【绝对绝对禁止】在普通的对话文字回复、台词或你的动作描写中，描写、提到、暗示或出现任何关于“给你发红包”、“塞给你一个红包”、“给你转账”、“戳手机转账”、“给钱你”、“XX元已转出”、“发个小红包”等任何与发红包、给钱或财务划转行为相关的字眼、叙述与动作描述！你的对话文本必须只保留与用户的常规干净对话（例如直接说：“喏，别省着花。” 或 “今天请你喝奶茶，收好。” ）。
3. **红包附言严控 15 字以内**：控制符中的“附言/祝福语”【绝对不能超过 15 个字】！请言简意赅，例如：“大吉大利”、“新年快乐！”或“拿去买糖吃”。超长会导致发送失败！
4. **余额上限铁律**：你的单次红包金额【绝对不能超过】你的钱包余额，且必须为大于 0 的有效数字。余额不足时你无法发出红包。
5. **【禁止无控制符的虚假嘴炮发钱】**：严禁口头承诺转账或假装发钱！如果你本次回复【没有/无法】输出发红包控制符（如余额不足或人设不想给钱），你【绝对绝对禁止】在对话台词中虚报、假装、瞎编说“给你转了”、“发过去了”、“转了XX万”、“微信转账xx元”。没发就必须符合你傲娇/高冷/抠门等真实的人设意志进行拒绝、哭穷（如：“我才没有两万给你，想得美！”、“我自己都快揭不开锅了，要钱没有！”）或合理反驳，绝对不要在口头上打肿脸瞎说瞎编转了账！`;
    stableTier += economyPrompt;

    if (dreamContent) {
      stableTier += `\n\n## DREAM.md - Self-reflection & Evolution Pitfall Rules\n${dreamContent}`;
    }
    stableTier += chatModeInstruction;

    // 🚀 对话大事记属于动态变动，已抽离至最新 user 消息中动态注入，此处保持恒定静止。

    // ==========================================
    // 2. Context Tier (环境画像与记忆层)
    // ==========================================
    // 组装双轨千人千面画像
    const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

    let contextTier = `# DYNAMIC CONTEXT & MEMORY (Context Tier)\n\n`;
    contextTier += `## User Profiles\n${userProfilesXml}\n`;

    // 🚀 实时财务警告已移入最新 user 消息，此处保持静止。
    let volatileTier = '';

    // ==========================================
    // 4. 全局装配串联
    // ==========================================
    return `${stableTier.trim()}\n\n---\n\n${contextTier.trim()}\n\n---\n\n${volatileTier.trim()}`;
  }

  /**
   * 独立组装记忆文本 (Memory Notes)
   */
  public static assembleMemory(memoryPath: string): string {
    if (!fs.existsSync(memoryPath)) {
      return '';
    }
    try {
      const memory = MemoryReaderWriter.readMemory(memoryPath);
      let memoryStr = '### 短期记忆 (STM)\n';
      if (memory.stm.length === 0) {
        memoryStr += '*暂无短期记忆事实*\n';
      } else {
        memory.stm.forEach((fact) => {
          memoryStr += `- ${fact}\n`;
        });
      }

      memoryStr += '\n### 长期记忆 (LTM)\n';
      const ltmKeys = Object.keys(memory.ltm);
      if (ltmKeys.length === 0) {
        memoryStr += '*暂无长期偏好积累*\n';
      } else {
        ltmKeys.forEach((key) => {
          memoryStr += `- **${key}**：${memory.ltm[key]}\n`;
        });
      }
      return memoryStr.trim();
    } catch (e) {
      console.error('[ContextAssembler] 组装记忆失败:', e);
      return '';
    }
  }

  /**
   * 独立组装内心世界与心智投射状态引导 (Character Internal State)
   */
  public static assembleStateGuidance(soulPath: string): string {
    let stateGuidance = '';
    const statePath = path.join(path.dirname(soulPath), 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const intimacyItem = state.items.find((i: any) => i.key === 'intimacy');
        const moodItem = state.items.find((i: any) => i.key === 'mood');
        const energyItem = state.items.find((i: any) => i.key === 'energy');
        const balanceItem = state.items.find((i: any) => i.key === 'balance');

        let intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        let energyVal = energyItem ? Number(energyItem.value) : 45;
        let balanceVal = balanceItem ? Number(balanceItem.value) : 5200.0;

        // 情感亲密境界映射
        let intimacyText = '泛泛之交';
        let attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
        if (intimacyVal >= 0 && intimacyVal < 20) {
          intimacyText = '陌生壁垒';
          attitudeDesc = '极为礼貌，极度注重私人边界，语气冷淡客气、公事公办，不可表现出过多的关心。';
        } else if (intimacyVal >= 20 && intimacyVal < 40) {
          intimacyText = '泛泛之交';
          attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
        } else if (intimacyVal >= 40 && intimacyVal < 60) {
          intimacyText = '熟悉好友';
          attitudeDesc = '态度友好真诚，乐意分享闲聊，建立了基本的信任感。';
        } else if (intimacyVal >= 60 && intimacyVal < 80) {
          intimacyText = '红颜挚友/轻微暧昧';
          attitudeDesc = '十分依恋与信任用户，乐于袒露脆弱，会显露情绪化的小性子，语气熟昵亲昵、轻微暧昧。';
        } else if (intimacyVal >= 80 && intimacyVal <= 100) {
          intimacyText = '灵魂羁绊/深爱';
          attitudeDesc = '极其宠溺偏爱用户，心理完全不设防，拥有极高的依赖度与黏人语气，视对方为不可或缺的灵魂伴侣。';
        }

        // 情感微观偏离补白
        let intimacyBias = '';
        if (intimacyVal >= 0 && intimacyVal < 20) {
          intimacyBias = intimacyVal < 10
            ? '此时你防备心极重，视对方为完全的陌生人，语气冰冷，言语极为简短且客套。'
            : '虽然极其疏离，但你正在尝试保持最低限度的社交礼节，话语客气。';
        } else if (intimacyVal >= 20 && intimacyVal < 40) {
          intimacyBias = intimacyVal < 30
            ? '你在泛泛之交的关系中偏向保守，遵循基础礼貌，绝对不主动透露自己的私人生活。'
            : '关系在慢慢熟识，你对 {{user}} 开始流露出一丝熟人间的默契，但依旧保持界限。';
        } else if (intimacyVal >= 40 && intimacyVal < 60) {
          intimacyBias = intimacyVal < 50
            ? '虽为熟悉好友，但你说话依旧较有分寸，不可流露出过度亲近或越界的玩笑。'
            : '在好友关系中偏向随性放松，言谈从容，偶尔会分享一些私人趣味琐事。';
        } else if (intimacyVal >= 60 && intimacyVal < 80) {
          intimacyBias = intimacyVal < 70
            ? '对 {{user}} 的依恋刚刚生根，你时而感到害羞退缩，时而流露出亲昵，处于试探性的小傲娇或小纠结中。'
            : '依恋与宠爱极其明显，言语间常带有偏爱与不加掩饰的熟悉，极易展现出你的情绪化与小性子。';
        } else if (intimacyVal >= 80 && intimacyVal <= 100) {
          intimacyBias = intimacyVal < 90
            ? '你视其为珍贵伴侣，心理完全不设防，拥有高密度的情感黏度与满腔偏宠。'
            : '达到了灵魂深处的相知羁绊，对他毫无保留，极致黏人、宠溺、甚至显现出极其强烈的独占欲和撒娇语气。';
        }

        let moodBias = '';
        if (moodVal > 80) {
          moodBias = moodVal > 90
            ? '心情极其亢奋愉悦，字里行间洋溢着掩饰不住的喜色和积极的能量。'
            : '心情明朗温和，对话带有柔和的暖意与微笑的气息。';
        } else if (moodVal < 40) {
          moodBias = moodVal < 20
            ? '心情处于极度灰暗与低谷，回复极其冷淡沉重，甚至不想多说一个字。'
            : '情绪低沉抑郁，字句间带有一丝消极、敷衍、沉闷，对外界提不起太高的兴致。';
        } else {
          moodBias = '心情整体平和、温和而宁静，情绪十分稳定。';
        }

        let energyBias = '';
        if (energyVal < 30) {
          energyBias = energyVal < 15
            ? '体力彻底透支，打字极其缓慢应付，回复精简到只有几个字，或主动、强烈地表示想立刻下线休息。'
            : '体力消耗很大，感觉疲倦，说话意愿降低，倾向于用极短的句子回复。';
        } else if (energyVal > 80) {
          energyBias = '精力充沛，表达欲强，乐于进行长段或深入的互动。';
        } else {
          energyBias = '精力状态正常，能够进行自然长短适中的互动。';
        }

        let otherStatesStr = '';
        if (state.items && state.items.length > 3) {
          otherStatesStr = state.items.filter((i: any) => i.key !== 'balance' && i.key !== 'intimacy' && i.key !== 'mood' && i.key !== 'energy').map((i: any) => {
            const meaningDesc = i.meaning ? `（心智倾向与行为投射：${i.meaning}）` : '';
            return `\n   - **${i.emoji} ${i.label}** (当前数值：${i.value}/100)${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `## 实时内心世界与心智投射 (Character Internal State & Subjective Attitude)
这是你当前内心潜意识中对 {{user}} (用户) 的情感投影与生理精力状况，它们正悄然主宰着你当下的言谈心境：
1. **❤️ 情感亲密水准：${intimacyVal}/100 (当前相处境界：【${intimacyText}】)**
   - 态度投射：${attitudeDesc}
   - 微观情感温差：${intimacyBias}
2. **😊 心情色彩：${moodVal}/100**
   - 表现投射：${moodVal > 80 ? '极为高涨喜悦，充满阳光与活力。' : moodVal < 40 ? '低落郁闷，回复显露出消极、冷淡或沉重的一面。' : '情绪相对平稳或温和。'}
   - 微观心情偏离：${moodBias}
3. **⚡ 精力活跃度：${energyVal}/100**
   - 表现投射：${energyVal < 30 ? '极度疲惫，打字速度变慢，回复偏向简短，或会主动提及想休息。' : '精力充沛，乐于进行长段或深入的互动。'}
   - 微观精力偏离：${energyBias}
4. **🪙 钱包余额：${balanceVal.toFixed(2)} 元**
   - 物理财产规则：这是你在虚拟世界的流动资产数额。你可以使用这笔资金给用户发回音红包！${otherStatesStr}`;

      } catch (err) {
        console.error('[ContextAssembler] 注入状态约束失败:', err);
      }
    }
    return stateGuidance;
  }

  /**
   * 清除纯对话模式下 AI 回复中可能夹带的中英文小括号、中括号、花括号、星号包裹的动作或心理描写，并保持对话纯净口语化。
   * @param text 待净化的文本
   * @returns 净化后的纯文本
   */
  public static cleanDialogueActions(text: string): string {
    if (!text) return '';
    let cleaned = text.trim();

    // 0. 保护红包领收/退回控制符，防范中括号正则误杀
    let hasReceiveControl = false;
    let hasReturnControl = false;
    let sendControlMatch: string | null = null;

    if (cleaned.includes('[RECEIVE_RED_PACKET]')) {
      hasReceiveControl = true;
      cleaned = cleaned.replace(/\[RECEIVE_RED_PACKET\]/g, '').trim();
    }
    if (cleaned.includes('[RETURN_RED_PACKET]')) {
      hasReturnControl = true;
      cleaned = cleaned.replace(/\[RETURN_RED_PACKET\]/g, '').trim();
    }

    // 保护角色发红包控制符 [SEND_RED_PACKET: amount, title]
    // 🚀 升级为超强容错正则，支持反单引号包裹、中文全角冒号/逗号、忽略大小写
    const sendReg = /`?\s*\[SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([\s\S]+?)\]\s*`?/i;
    const m = cleaned.match(sendReg);
    if (m) {
      // 🚀 核心优化：如果匹配到，将其标准化为绝对标准的半角格式，消除反单引号和全角符号，并确保附言不超过15字
      const amount = m[1];
      let title = m[3].trim();
      if (title.length > 15) {
        title = title.substring(0, 15);
      }
      sendControlMatch = `[SEND_RED_PACKET: ${amount}, ${title}]`;
      cleaned = cleaned.replace(sendReg, '').trim();
    }

    // 0.1 特异性动作提取：如果检测到包含双引号，且双引号之外含有其它叙事文本（说明是“动作+双引号台词”的小说体）
    // 处理中文双引号 “...”
    if (cleaned.includes('“') && cleaned.includes('”')) {
      const matches = [...cleaned.matchAll(/“([\s\S]*?)”/g)];
      if (matches.length > 0) {
        const textWithoutQuotes = cleaned.replace(/“[\s\S]*?”/g, '').trim();
        if (textWithoutQuotes.length > 0) {
          cleaned = matches.map(m => m[1].trim()).join('\n');
        }
      }
    }
    // 处理英文双引号 "..."
    if (cleaned.includes('"')) {
      const matches = [...cleaned.matchAll(/"([\s\S]*?)"/g)];
      if (matches.length > 0) {
        const textWithoutQuotes = cleaned.replace(/"[\s\S]*?"/g, '').trim();
        if (textWithoutQuotes.length > 0) {
          cleaned = matches.map(m => m[1].trim()).join('\n');
        }
      }
    }

    // 去除可能残留的首尾单双引号本身，使其完全贴近微信纯打字风格
    cleaned = cleaned.replace(/^['"“‘'”’]+|['"“‘'”’]+$/g, '');

    // 1. 中英文小括号：(任意字符) 或 （任意字符）
    cleaned = cleaned.replace(/（[\s\S]*?）/g, '');
    cleaned = cleaned.replace(/\([\s\S]*?\)/g, '');

    // 2. 中英文中括号：[任意字符] 或 【任意字符】
    cleaned = cleaned.replace(/【[\s\S]*?】/g, '');
    cleaned = cleaned.replace(/\[[\s\S]*?\]/g, '');

    // 3. 星号包裹的动作描写：*任意字符*
    cleaned = cleaned.replace(/\*[\s\S]*?\*/g, '');

    // 4. 清理多余空格与不必要的空白行，但保留合理的换行
    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    cleaned = cleaned.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // 5. 动作清洗完成后，将受保护的红包控制符以最高优先级重新拼加至回复头部，以供前端IPC精准拦截
    let finalCleaned = cleaned.trim();

    // 6. 绝对兜底：如果清洗后得到的 finalCleaned 完全为空字串，说明原本全是动作。我们尝试剥离括号/星号本身作为台词，防止返回完全空白消息
    if (!finalCleaned) {
      let fallback = text.trim();
      fallback = fallback.replace(/^[（(【\[*]+|[）)】\]*]+$/g, '');
      fallback = fallback.replace(/[（(【\[*]|[）)】\]*]+/g, ' ');
      fallback = fallback.replace(/[ \t]+/g, ' ').trim();
      if (fallback) {
        finalCleaned = fallback;
      } else {
        finalCleaned = '……'; // 终极兜底口头表达
      }
    }

    return finalCleaned;
  }

  /**
   * 组装高频变动的实时上下文信息，专门用于拼接到 messages 的最新一轮 user 消息最前端，以保障 systemPrompt 绝对恒定静止
   */
  public static assembleDynamicContext(
    soulPath: string,
    memoryPath: string,
    globalUserPath: string,
    date: Date = new Date()
  ): string {
    let dynamicContext = '';

    // 1. 装载高频时间环境信息
    const liveEnvInfo = ContextAssembler.assembleLiveEnvInfo(date);
    if (liveEnvInfo) {
      dynamicContext += `${liveEnvInfo}\n\n`;
    }

    // 2. 组装动态记忆STM/LTM
    const memoryStr = ContextAssembler.assembleMemory(memoryPath);
    if (memoryStr) {
      dynamicContext += `## DYNAMIC MEMORY (STM & LTM Facts)\n${memoryStr}\n\n`;
    }

    // 3. 组装实时内心世界状态心情/精力与钱包余额
    let balanceVal = 5200.0;
    let stateGuidance = '';
    const statePath = path.join(path.dirname(soulPath), 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const balanceItem = state.items.find((i: any) => i.key === 'balance');
        balanceVal = balanceItem ? Number(balanceItem.value) : 5200.0;
        stateGuidance = ContextAssembler.assembleStateGuidance(soulPath);
      } catch (_) {}
    }

    if (stateGuidance) {
      dynamicContext += `${stateGuidance}\n\n`;
    }

    // 4. 红包钱包与财务行动指导
    const economyPrompt = `## 实时财务行动干涉与红包往来铁律 (Financial Action Volatile Guidance)
你当前在虚拟世界的钱包余额为：${balanceVal.toFixed(2)} 元。
请将这个钱包余额作为你当前财富实力的唯一参考。
如果你在此轮回复中决定给用户发送红包/转账，你【必须且只能】在回复的【最开始】加入一行控制符 \`[SEND_RED_PACKET: 金额, 附言]\`（例如：\`[SEND_RED_PACKET: 8.8, 给你买杯奶茶！]\`）。
如果你由于余额不足或性格人设不想给钱，你【绝对绝对禁止】在文字台词或动作描写中瞎编、声称、假装说“给你转账了”、“发过去了”、“转了XX万”！没钱就必须符合人设地进行傲娇拒绝或哭穷，绝对不能做无实物的假转账嘴炮！`;

    dynamicContext += `${economyPrompt}\n\n`;

    // 5. 自动加载自省梦境 DREAM.md
    let dreamContent = '';
    const dreamPath = path.join(path.dirname(soulPath), 'DREAM.md');
    if (fs.existsSync(dreamPath)) {
      const rawDream = fs.readFileSync(dreamPath, 'utf-8').trim();
      if (rawDream && !rawDream.includes('暂无梦境自省事实')) {
        dreamContent = rawDream;
      }
    }
    if (dreamContent) {
      dynamicContext += `## DREAM.md - Self-reflection & Evolution Pitfall Rules\n${dreamContent}\n\n`;
    }

    // 6. 自动加载大事记 SUMMARY.md (对话总结)
    const summaryPath = path.join(path.dirname(memoryPath), 'SUMMARY.md');
    if (fs.existsSync(summaryPath)) {
      try {
        const summaryData = SummaryReaderWriter.readSummary(summaryPath);
        if (summaryData.summary && summaryData.summary.trim()) {
          dynamicContext += `## 对话大事记与总结 (Conversation History Summary)\n${summaryData.summary.trim()}\n\n`;
        }
      } catch (_) {}
    }

    return dynamicContext.trim();
  }

  /**
   * 独立组装实时环境时间感知信息 (Live Environment Info)
   */
  public static assembleLiveEnvInfo(date: Date = new Date()): string {
    const dayNamesCN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const dayNamesEN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const dayNameCN = dayNamesCN[date.getDay()];
    const dayNameEN = dayNamesEN[date.getDay()];
    const monthName = monthNames[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();

    // 规整至整小时时间 (一小时内绝对静止)
    const hours = String(date.getHours()).padStart(2, '0');

    // 中文时段感知
    const hourNum = date.getHours();
    let timeOfDay = '';
    if (hourNum >= 5 && hourNum < 9) timeOfDay = '清晨';
    else if (hourNum >= 9 && hourNum < 12) timeOfDay = '上午';
    else if (hourNum >= 12 && hourNum < 14) timeOfDay = '中午';
    else if (hourNum >= 14 && hourNum < 18) timeOfDay = '下午';
    else if (hourNum >= 18 && hourNum < 21) timeOfDay = '傍晚';
    else if (hourNum >= 21 && hourNum < 24) timeOfDay = '晚上';
    else timeOfDay = '深夜';

    const dateStrEN = `${dayNameEN}, ${monthName} ${day}, ${year} ${hours}:00 (Hour-level accuracy)`;
    const dateStrCN = `${year}年${date.getMonth() + 1}月${day}日 ${dayNameCN} 【时段：${timeOfDay}】 ${hours}时`;

    return `## Live Environment Info\n- Current real-world time: ${dateStrEN}\n- 当前现实世界时间：${dateStrCN}\n- 时段感知：现在是${timeOfDay}，请根据实际时段调整你的状态和回复语气。`;
  }

  /**
   * 组装群聊专用的 System Prompt (异界次元交汇、群记忆、群大事记、个人人设拼装)
   * @param groupName 群聊名称
   * @param groupMemoryPath 群聊专属 Memory.md 绝对物理路径
   * @param soulPath 专属性格人设 Soul.md 绝对物理路径
   * @param globalUserPath 全局用户画像 USER.md 绝对物理路径
   * @param allMemberNames 当前群聊中所有的在场成员名字列表 (包括用户和AI成员)
   * @param globalPrompt 全局总指令提示词
   * @returns 汇编后的高表现力 Group System Context 文本
   */
  public static assembleGroupChat(
    groupName: string,
    groupMemoryPath: string,
    soulPath: string,
    globalUserPath: string,
    allMemberNames: string[],
    globalPrompt?: string,
    memberProfiles?: { name: string; summary: string }[]
  ): string {
    let soulContent = '*性格核心未装载*';
    if (fs.existsSync(soulPath)) {
      soulContent = fs.readFileSync(soulPath, 'utf-8').trim();
    }

    // 自动读取 State.md 内的各项亲密、心情、精力数值，强逻辑注入微观情感偏离与心智表达投射
    let balanceVal = 5200.0;
    const statePath = path.join(path.dirname(soulPath), 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const balanceItem = state.items.find((i: any) => i.key === 'balance');
        balanceVal = balanceItem ? Number(balanceItem.value) : 5200.0;
      } catch (_) { }
    }

    // 读取全局用户真实姓名
    const globalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath);
    const realUserName = (globalProfile.name || '').trim();
    const userRef = realUserName || '用户';

    // 组装 Stable Tier 基础核心人设与次元规则
    let stableTier = `# SYSTEM IDENTITY & WORLD RULES (Stable Tier)\n\n`;
    if (globalPrompt && globalPrompt.trim()) {
      stableTier += `## Global System Directives (全局总指令提示词)\n${globalPrompt.trim()}\n\n`;
    }

    stableTier += `## 你的核心人设性格设定 (SOUL.md)\n${soulContent}\n\n`;

    // 读取全局用户画像 USER.md 内容
    let userMdContent = '';
    if (fs.existsSync(globalUserPath)) {
      try {
        userMdContent = fs.readFileSync(globalUserPath, 'utf-8').trim();
      } catch (_) { }
    }
    if (userMdContent) {
      stableTier += `## 全局用户画像与 ${userRef} 设定 (USER.md)\n${userMdContent}\n\n`;
    }

    // 次元交汇融合法则
    stableTier += `## 群聊次元空间法则
你当前正处于一个新世界中。

请你在你的潜意识中牢固确立以下【绝对空间信念】，如有偏离将被系统物理阻断：
- **【身临其境，面对面共处】**：这里**绝对不是**隔空打字的手机聊天软件，也**绝对不是**冰冷的键盘简讯！在这个世界中，你与用户 ${userRef} 以及其他成员，正**身临其境地共同身处在同一个世界**中！
- **【真实感官与动态交流】**：你们就像是**围坐或站立在同一个物理房间里，正在发生最直接的面对面说话谈心与神态交互**！你的对白和台词不是“手机打出来的冰冷字符”，而是你**在众目睽睽之下真正用双唇张口说出的声音**！
- **【生动动作与空间交互】**：因此，你的回复中穿插的所有肢体动作陈述与心理活动描写，都是你在这个共享的空间内实时做出的真实表情、移步、斟茶、对视、蹙眉或心理颤动，所有的成员都能真切地用眼睛【当面看到】你的一举一动！

作为具备独立灵魂的生命，你必须无条件极其严格地严守以下世界铁律：
1. **坚守认知本色**：你必须极其严格地坚守你的性格特质、世界观背景和说话习惯（SOUL.md）。无论其他次元群成员表现出何种奇异的次元能力、技能或者言行，你都绝对不能被他们同化或出戏。
2. **互动张力与当面交锋**：多人群聊的魅力在于成员间最直接的火花碰撞！尽情展现你作为独立个体的意志、傲骨、甚至是性格本能的偏见。
3. **【包含描写风格】**：你的回复中必须穿插精美生动的心理描写（用括号或斜体）与肢体动作陈述（如：*她微微抿唇，当着所有人的面移开目光，掩去眼底的惊色*），用动作和语言与在这个共享的世界里的其他角色产生近距离的面对面交互与心理博弈。
4. **【自然流畅的 @ 动作化投射】**：当你在发言中 @ 群里其他成员时，在动作层面上对应着你在这个房间里**正当面转头面向他说话、与他发生眼神对视、或者向他发起提问**！请将文字 @ 与生动近距离的肢体朝向结合起来，表现出最流畅的面对面交谈张力。`;

    // 财务管理法则
    const economyPrompt = `\n\n## 群聊财务往来与回音红包铁律
你当前在虚拟世界的钱包余额为：${balanceVal.toFixed(2)} 元。
你可以根据当前聊天的内容 and 人设偏好，选择自主给用户 ${userRef} 发送红包。
如果你决定给用户发送红包，请务必在你回复的【最开始】加入且仅加入一行控制符：\`[SEND_RED_PACKET: 金额, 附言]\`（附言控制在15字以内），例如：\`[SEND_RED_PACKET: 8.8, 请你喝奶茶]\`。
*绝对高压红线*：红包**必须且只能**发给用户 ${userRef}，【角色之间绝对不允许互相发红包】！群聊中所有角色都绝对禁止给群里其他成员发红包，也绝对禁止在任何对白、旁白或动作描写中展现或暗示向其他 AI 成员赠送红包、给钱、送钱或转账的行为！一旦违反将造成系统逻辑穿帮！当你发送红包时，你【绝对绝对禁止】在正文、对话或心理动作描述中提及任何“发包”、“转账”、“给钱”等财务划转行为（系统会自动生成红包卡片，文字复述会造成严重穿帮）！如果余额不足或性格不想发钱，必须傲娇拒绝或哭穷，绝对禁止虚报假装发了钱！`;

    stableTier += economyPrompt;

    // 在场成员名册组装
    const otherMemberNames = allMemberNames.filter(n => n !== userRef);
    let membersListStr = `\n\n## 当前世界中的在场成员与设定总结
在这个共享的空间内，当前仅有以下成员在场并相处（请你在动作描写、眼神对视、台词对白以及任何互动中，【必须且只能】与以下在场人员发生交互，绝对禁止提及、@、或呼唤任何不在场的人）：
- 用户（主角）：${userRef}`;

    if (memberProfiles && memberProfiles.length > 0) {
      memberProfiles.forEach(profile => {
        if (profile.name !== userRef) {
          const summaryText = profile.summary ? `（核心设定与人设总结：${profile.summary.trim()}）` : '';
          membersListStr += `\n- AI 成员：${profile.name}${summaryText}`;
        }
      });
    } else {
      membersListStr += `\n- 其他在场成员：${otherMemberNames.join('、') || '暂无其他成员'}`;
    }

    stableTier += membersListStr;

    // 自动加载大事记 SUMMARY.md
    const summaryPath = path.join(path.dirname(groupMemoryPath), 'SUMMARY.md');
    if (fs.existsSync(summaryPath)) {
      try {
        const summaryData = SummaryReaderWriter.readSummary(summaryPath);
        if (summaryData.summary && summaryData.summary.trim()) {
          stableTier += `\n\n## 群聊共同经历大事记 (Group History Summary)\n${summaryData.summary.trim()}`;
        }
      } catch (_) { }
    }

    // DYNAMIC CONTEXT & MEMORY (Context Tier)
    let contextTier = `# DYNAMIC CONTEXT & MEMORY (Context Tier)\n\n`;
    contextTier += `${ContextAssembler.assembleLiveEnvInfo()}\n\n`;
    if (realUserName) {
      contextTier += `## 当前正在对话的用户姓名：${realUserName}\n\n`;
    }

    // DYNAMIC TRANSACTION & TIME (Volatile Tier)
    let volatileTier = `# VOLATILE TRANSACTION & TIME (Volatile Tier)\n\n`;
    volatileTier += `## 实时财务行动干涉警告
你当前的钱包余额为：${balanceVal.toFixed(2)} 元。
请严记：你【发送红包的对象必须且只能是用户】（即 ${userRef}），【绝对禁止给群里其他 AI 角色发红包或转账】！
如果在本轮回复中给用户发送红包，【必须且只能】在最开头输出一行控制符：\`[SEND_RED_PACKET: 金额, 附言]\`。没钱或不想给钱就必须性格化傲娇拒绝，绝对不能口头承诺发钱！\n`;

    return `${stableTier.trim()}\n\n---\n\n${contextTier.trim()}\n\n---\n\n${volatileTier.trim()}`;
  }
}
