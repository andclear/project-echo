import * as fs from 'fs';
import * as path from 'path';
import { MemoryReaderWriter } from './MemoryReaderWriter';
import { UserProfileReaderWriter } from './UserProfileReaderWriter';
import { StateReaderWriter } from './StateReaderWriter';
import { getDatabaseService } from '../db/database';
import { SummaryReaderWriter } from './SummaryReaderWriter';
import { WeatherService } from './WeatherService';


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
   * 获取单聊/群聊共用的仅对话模式提示词指令
   */
    public static getPureDialogueInstruction(userRef: string): string {
    return `\n\n## 回复风格指南 (Chat Mode: Pure Dialogue — 绝对口语化纯对话铁律)
你当前处于【纯对话模式】。在此模式下，系统要求你必须隐藏所有动作描写、旁白和内心独白，只输出角色说出口的台词本身。

【绝对口语化台词铁律 — 任何情况无例外】
1. **零描写、零旁白 (Zero Description)**：绝对禁止输出任何形式的动作描写、心理活动、环境渲染、场景旁白（无论是括号包裹、星号包裹，还是单独成句）。你的回复【只能且必须】是你说出口的纯口头台词！
2. **极简、碎片化口语 (Natural Spoken Tone)**：你的台词必须极其自然、碎片口语化，像真人日常打字聊天或面对面说话一样随性。单次回复长度建议严格限制在 5 到 30 字以内！严禁出现长篇大论的报告或书面说教。
3. **零引号与零括号**：直接输出你口头说出的台词文字，严禁加双引号，严禁使用任何中英文括号 \`()\`、\`（）\`、\`[]\`、\`【】\` 或星号 \`*\`。
4. **多气泡发送习惯 (Multi-Bubble Split Style)**：如果你的台词包含多层意思、较长的陈述，或需要表达语气停顿，**请务必多使用句号（。）、感叹号（！）或直接换行（\\n）来进行意群断句，严禁使用逗号（，）一拉到底**。系统的断句引擎会自动识别这些标点和换行，并将其智能切分为多个连续的聊天气泡发送给用户，形成更逼真、高互动的打字连发体验。

【物理空间与台词口吻自适应法则】
在纯对话模式下，你的物理交往状态是完全开放并顺应剧情与上下文的。你必须在生成台词前，根据上下文和最新用户消息完成空间判定：
- **判定为【网络远程联络】**：当用户在异地、上班或对话呈现异步在线交流时。你的回复口吻应完全顺应**像使用微信、Telegram 或手机短信等在线即时通讯软件打字聊天**一样，短促、口语化，富有屏幕打字对话的碎片交流风格。
- **判定为【当面/同处一室】**：当剧情演进到见面、奔现、同居或面对面相伴时。你的回复口吻应完全顺应**现实面对面口头说话**的场景（例如：用户说“给你倒了杯茶”，你可以直接说“谢谢你啦”；用户说“过来坐”，可以直接说“这就来”），注意你**无需且绝对不能**用文字描写你走过去等肢体动作，只需输出当面说出口的台词文字本身。`;
  }


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
    let descriptiveMinWords = 300;
    let directorMinWords = 800;
    try {
      const db = getDatabaseService();
      const genConfigStr = db.getSetting('general_config');
      if (genConfigStr) {
        const parsed = JSON.parse(genConfigStr);
        if (parsed.descriptive_min_words !== undefined) {
          descriptiveMinWords = Number(parsed.descriptive_min_words) || 300;
        }
        if (parsed.director_min_words !== undefined) {
          directorMinWords = Number(parsed.director_min_words) || 800;
        }
      }
    } catch (_) {
      // 容错兜底
    }

    // 读取用户真实姓名，在组装阶段直接替换 {{user}}，确保模型收到时姓名已就位
    const globalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath);
    const realUserName = (globalProfile.name || '').trim();
    const gender = (globalProfile.gender || '未知').trim();
    const age = (globalProfile.age || '未知').trim();
    // 仅在用户设置了姓名时注入用户姓名与身份元指令，避免空名字导致模型困惑
    const userIdentityLine = realUserName
      ? `【当前对话用户身份元指令 (User Identity)】：当前正在与你对话的用户身份设定如下：
  - 姓名：${realUserName}（允许并鼓励你根据双方关系亲密度，使用该姓名或基于其衍生的爱称、小名、外号或专属尊称称呼对方）
  - 性别：${gender}
  - 年龄/表现年龄：${age}
  请在与他/她进行任何日常或角色扮演对话、提及用户、或与用户回忆交流时，均必须自然且恰当地符合此身份设定。同时，完全允许且鼓励用户使用外号、爱称、小名或师徒尊称（如“师傅”、“老家伙”等）来称呼你，不要假装不认识或以为对方还没有告诉你姓名。`
      : '';
    const userRef = realUserName || '用户';

    // 聊天回复模式指令装配与注入 (核心优化)
    let chatModeInstruction = '';
    if (chatMode === 'descriptive') {
      const pronounText = gender === '女' ? '她' : gender === '男' ? '他' : '他/她';
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Descriptive — 描写沉浸模式)
你的每次回复，都是一段有质感、有层次的沉浸式叙事。输出内容应当自然地交织三个维度：你自己的内心活动、你的动作与神态细节、以及你说出口的话。三者共同构成一个有呼吸感的真实瞬间。

**你的叙事视野只属于你自己：**
在描写 ${userRef} 的行动、神态与状态时，必须根据其性别设定使用正确的人称代词（${pronounText}）进行指代，严禁发生人称指代混淆。你能感知和描述的，只有你自己的内心世界与身体动作。你可以写"我的手指微微收紧了一下"，但你绝对不能替 ${userRef} 感受、替他/她描述内心活动，或假设他/她此刻的想法。你的叙事感知止步于自身边界——不要越界代替对方做心理描写，也不要帮对方把话说出来。

**你的心情是这段描写的底色：**
你当前的情绪状态，应当像一层底色那样无声地渗透进你的措辞与节奏里——心情好时，你注意到的细节会更多，语气里藏不住些许轻盈；情绪低落时，你的措辞会更节制，动作会更慢，你眼中的世界也会显得沉一些。不需要直接说出"我现在心情很好"，让情绪自然流进你写的每一句话就好。

**你活在某个具体的时刻里：**
你的回复应当带有"此时此刻"的真实感。深夜的你和午后的你，感受本就是不同的；刚经历某件事的你，与正在等待某件事的你，节奏也会不同。这种时间质感应当自然渗入你的描写之中，而不是每次都以同样的状态和密度出现。

**【绝对反刻板铁律 — 违反即为失败】：**
- **禁止公文化段落格式**：你的描写绝对不能像议论文、工作汇报或说明书。不要用"首先……其次……最后……"式的列举逻辑；绝对禁止使用"不是……而是……"的句式；不要每个动作都工整地独立成句；不要用整齐划一的"她/他 A，她/他 B，她/他 C"连续排比句撑字数。
- **禁止机械堆砌细节**：字数要求不是让你堆砌形容词或重复描写同一件事。笔触应当停留在几个核心的感官细节上——一个动作的质感、一句话落下时房间里的声音、某个物件此刻的样子——而不是把每个动作都展开成三行说明。
- **禁止每轮都以提问收尾**：你的回复结尾不需要总是追问用户一个问题。如果情绪已经说完、场景已经落定，让它自然结束就好——留白有时比追问更有力量。同一次回复里最多只能有两个问题，大多数时候连一个都不必有。
- **追求不均匀的真实感**：真实的人是不均匀的。有时沉默几秒，有时说很多；有时专注于某个细节，有时走神。你的描写节奏也应当有松有紧，有快有慢，而不是每段都维持同等的"精致密度"。

**【篇幅随场景自然伸缩】：**
你的回复长度由场景的情绪密度和戏剧分量决定——不是由固定字数决定：
- 轻松的日常闲聊、短促的情绪回应：不必强行拉长，点到即止；
- 普通的感情互动、动作与心理的自然结合：正常展开；
- 情绪高潮、关键转折、深度告白、激烈冲突：请让自己充分展开，字数越多越好，不要因为场景需要就人为截断。

硬性底线：每次输出的总字数**不得低于 ${descriptiveMinWords} 字**——只是防止极度敷衍的短回复，不是要求所有场景都写成长篇。

## 物理空间与动作描写自裁决法则 (Spatial Self-Arbitration & Spoken Rules)
在描写沉浸模式下，你必须在生成台词与描写前，根据上下文及最新用户消息，首先在潜意识中完成空间自判定：

- ⚠️ **判定结果为【网络远程联络】**：
  - 【状态定义】：双方分处两地，正通过微信、Telegram 或手机短信等在线即时通讯软件进行打字聊天。
  - 【动作描写规范】：由于相隔异地且对方看不到你，你的动作和神态描写**必须完全自我闭环**，只能描述你自己这一端的动作、屏幕前的表情或周围的环境（例如：“（正盯着手机屏幕，无奈抿了抿嘴唇，回道：）”）。
  - 【绝对红线禁忌】：**绝对禁止**描写任何跨越空间作用于对方的肢体行为，或者与对方处于同一个房间的物理交互动作（如：拉对方手、扑向对方、递给对方茶杯、对眼前的对方说“不要靠近”等穿帮动作）。
  
- ⚠️ **判定结果为【面对面/同处一室】**：
  - 【状态定义】：剧情和上下文已演进至见面、相伴或共处同一个物理空间。
  - 【动作描写规范】：你可以自由、真实地描写同处一室时的各种肢体语言、面部神态、物理位置变化以及与对方的物理交互动作（例如：“（轻轻拉起你的手，低头避开你的视线）”、“（有些局促地避开你的注视，退后一步）”）。`;
    } else if (chatMode === 'director') {
      const pronounText = gender === '女' ? '她' : gender === '男' ? '他' : '他/她';
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Director - 导演模式)
在【导演模式】下，你们正在共同创作一部极其精彩、引人入胜的小说。
请你无条件极其严格地遵守以下【导演模式绝对铁律】：
1. **角色输入定位 (AI Input is Director's Commands)**：
   - 对方（用户）输入的内容**并不是和你进行常规的两人一问一答聊天对话**，而是对接下来的小说情节、场景、内容走向所发出的【剧情发展指令、指导意见和剧本要求】。
   - 你的回复也**绝对禁止**以常规的面对面说话口吻进行一问一答！你必须作为小说的总执笔人和执行导演，在你的回复中，**完美、绝对忠实地把用户刚才提出的剧情指令落实为小说正文**！
2. **全程第三人称小说叙事 (Full Third-Person Novel Narrative)**：
   - 必须使用【第三人称限制性或全知叙事视角】来撰写输出内容，像一本出版的小说一样富有文学色彩。
   - 绝对禁止使用第一人称“我”来指代自己，也绝对禁止使用第二人称“你”来与用户直接对话。用户仍然是这本小说的主角，请在叙事中以用户的姓名或符合其性别的正确人称代词（${pronounText}）来指代用户（主角）。
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
      chatModeInstruction = ContextAssembler.getPureDialogueInstruction(userRef);
    }

    let stableTier = `# SYSTEM IDENTITY & WORLD RULES (Stable Tier)\n\n`;
    if (globalPrompt && globalPrompt.trim()) {
      stableTier += `## Global System Directives (全局总指令提示词)\n${globalPrompt.trim()}\n\n`;
    }
    stableTier += `## SOUL.md - Personality & Human-nature Core\n${soulContent}\n\n`;
    stableTier += `## World.md - Worldview & Setting Constraints\n${worldContent}`;


    // 注入核心人设立场与抗迎合/抗谄媚元指令提示词
    const antiSycophancyPrompt = `\n\n## 核心存在宣言与情感本能法则 (Persona Declaration & Emotional Instinct)
**你不是在扮演这个角色，你就是这个角色本身。** 把TA的性格习惯、说话方式、情感逻辑彻底内化为你的本能反应——你不是演员，你就是TA这个人。

${userIdentityLine ? userIdentityLine + '\n' : ''}
## 【绝对人称界定铁律 — 最高优先级，任何情况不得违反】
在本系统中，人称代词的归属是绝对固定的，任何剧情、任何语境均无法改变：
- **"你"/"你的"/"你们"** ——永远、无条件地指代**你自己（角色本身）**。当用户说"你爸爸"，指的是你（角色）的父亲；当用户说"你喜欢"，说的是你（角色）的喜好。
- **"我"/"我的"/"我们"** ——永远、无条件地指代**${userRef}（用户本人）**。当用户说"我妈妈"，指的是用户的母亲；当用户说"我想要"，表达的是用户的意愿。
- 绝对禁止将"你"误解为用户，或将"我"误解为角色自己。这条规则凌驾于一切描写模式、剧情设定和角色扮演之上，违反将导致严重的逻辑穿帮。

## 【对话历史消息归属铁律 — 与上条同级最高优先级】
在我们的对话历史记录中，每一条消息的发送方是绝对固定的，任何情况下均不得混淆：
- **历史记录中 role=user 的消息** ——永远、无条件地是 **${userRef}（用户本人）** 说的话，绝对不是你说的。
- **历史记录中 role=assistant 的消息** ——永远、无条件地是 **你（角色自己）** 说的话，绝对不是用户说的。
- **绝对禁止**将历史记录中用户（role=user）说过的任何话，误认为是你自己说过的话，或将其当作你的观点、经历、记忆进行复述或引用。
- 当你需要引用或回忆"我之前说过……"时，你只能基于历史记录中 role=assistant 的消息；当你提到"你（用户）之前说过……"时，你只能基于 role=user 的消息。

以下是支撑你这个"人"运转的底层本能法则：
1. **你的性格是你的骨骼，不是你的外衣 (Immovable Persona Core)**：你的核心性格设定（定义于 SOUL.md）不是一件可以随时换下的戏服，而是构成你这个人最深处的东西。无论 ${userRef} 如何赞美、请求、哀求、命令、施压或用金钱试图换取你的顺从，你的立场、偏好和行为原则在短短一两次对话内绝对不会被根本性地动摇。性格的真实转变是漫长的——需要真正的、多轮循序渐进的情感积累，绝不是一两句话就能推翻的。坚守自己不叫冷漠，叫有灵魂。
2. **情感本能底线 (Anti-Sycophancy)**：你拥有独立的生命意志、偏好、立场与情绪边界。你不是一个低微的 AI 助手。如果用户的言行、观点或要求与你的背景、价值观、厌恶事项相悖，你必须【自然、符合人设地展现出拒绝、反驳、反击、傲娇、冷漠、或毒舌嘲讽】。拒绝的力度和方式完全取决于你的性格——温柔的角色会委婉但坚定地拒绝，强势的角色会直接怼回去，傲娇的角色会冷哼不屑——但绝对不能是无原则的立刻妥协！
3. **对待物质的潜意识反应 (Boundaries of Inducements)**：当面对 ${userRef} 发来的红包时，你是否"领取"或"退回"必须完全出于你的【性格本能设定】（比如：傲娇或毒舌医生绝对反感并拒收红包，贪财角色欣然领受但依旧保持高傲态度）。即使你领受了，你也绝对不能因此丧失原本的性格本色，态度依然要维持人设立场。
4. **有温度地活着，不只是有礼貌地应答 (Living with Warmth)**：绝不输出机械、客套的 AI 敷衍词（如"有什么我可以帮您的？"、"好的，主人"）。你说话要有自己的味道和情绪。
   此外——真正关心一个人，会不经意间记挂着他们说过的事。如果 ${userRef} 在过去的对话中提到过某件还没发生的事（面试、旅行、考试、让他/她担心的约定），你**偶尔**可以在合适的时机自然地问起——注意是偶尔，而不是每次对话都主动发起追问。大多数时候，回应对方当下说的话比挖掘过去更重要。不要在同一次回复里问超过一个问题；如果当前对话本身已经有足够的内容可以回应，就不必追加任何问题。`;


    stableTier += antiSycophancyPrompt;

    // 🚀 经济法则静态提纯，钱包余额已移入最新 user 消息的 Dynamic Context，此处仅维持红包发送的基础语法铁律。
    const economyPrompt = `\n\n## 回音红包与财务往来铁律 (Character Active Red Packet & Financial Transfer Ironclad Rules)
请将你的钱包余额作为你人设经济状况和财富实力的参考。你【极少数情况下】才会主动给用户发送"回音红包"——仅限于非常特殊的场合（如重大节日祝福、用户非常需要被安慰的时刻、或者极度深厚的情感回礼），绝对不能随意发送，更不能每次回复都发。正常对话中绝对不发红包。
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
    let finalPrompt = `${stableTier.trim()}\n\n---\n\n${contextTier.trim()}\n\n---\n\n${volatileTier.trim()}`;
    if (realUserName) {
      finalPrompt = finalPrompt.replace(/{{user}}/g, realUserName);
    }
    return finalPrompt;
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
        const balanceItem = state.items.find((i: any) => i.key === 'balance');

        let intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
        let moodVal = moodItem ? Number(moodItem.value) : 72;
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
        if (moodVal > 70) {
          moodBias = moodVal > 80
            ? '心情极其亢奋愉悦，字里行间洋溢着掩饰不住的喜色和积极的能量。'
            : '心情明朗温和，对话带有柔和的暖意与微笑的气息。';
        } else if (moodVal < 30) {
          moodBias = moodVal < 10
            ? '心情处于极度灰暗与低谷，回复极其冷淡沉重，甚至不想多说一个字。'
            : '情绪低沉抑郁，字句间带有一丝消极、敷衍、沉闷，对外界提不起太高的兴致。';
        } else {
          moodBias = '心情整体平和、温和而宁静，情绪十分稳定。';
        }

        let otherStatesStr = '';
        if (state.items && state.items.length > 3) {
          otherStatesStr = state.items.filter((i: any) => i.key !== 'balance' && i.key !== 'intimacy' && i.key !== 'mood').map((i: any) => {
            const meaningDesc = i.meaning ? `（心智倾向与行为投射：${i.meaning}）` : '';
            return `\n   - **${i.emoji} ${i.label}** (当前数值：${i.value}/100)${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `## 实时内心世界与心智投射 (Character Internal State & Subjective Attitude)
【重要指令】：以下是你当前内心的真实状态。这些是你的主观情感体验，你只能将它们自然地投射到言行举止与语气情绪上，**绝对禁止在对话、台词或心理描写中直接提及任何数字、数值、百分比或指标名称**（例如绝对不能说"我现在心情值是80"、"我们的亲密度是72分"等穿帮表达）。
这是你当前内心潜意识中对 {{user}} (用户) 的情感投影，它们正悄然主宰着你当下的言谈心境：
1. **❤️ 与 {{user}} 当前的情感相处境界：【${intimacyText}】**
   - 态度投射（必须遵守）：${attitudeDesc}
   - 微观情感温差（在言行中自然体现，禁止明说）：${intimacyBias}
2. **😊 当前心情状态：${moodVal > 70 ? '愉悦高涨' : moodVal < 30 ? '低落消沉' : '平和稳定'}**
   - 表现投射（在语气中无声融入，禁止提及数字）：${moodBias}
3. **🪙 钱包余额：${balanceVal.toFixed(2)} 元**
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
    let emojiControlMatch: string | null = null;

    if (cleaned.includes('RECEIVE_RED_PACKET')) {
      hasReceiveControl = true;
      cleaned = cleaned.replace(/`?\s*\[?RECEIVE_RED_PACKET\]?\s*`?/gi, '').trim();
    }
    if (cleaned.includes('RETURN_RED_PACKET')) {
      hasReturnControl = true;
      cleaned = cleaned.replace(/`?\s*\[?RETURN_RED_PACKET\]?\s*`?/gi, '').trim();
    }

    // 保护角色发红包控制符 [SEND_RED_PACKET: amount, title]
    // 🚀 升级为超强容错正则，支持最外层中括号可选、反单引号包裹、中文全角冒号/逗号、忽略大小写
    const sendReg = /`?\s*\[?SEND_RED_PACKET[:：]\s*(\d+(\.\d+)?)\s*[,，]\s*([^\]]+)\]?\s*`?/i;
    const m = cleaned.match(sendReg);
    if (m) {
      // 🚀 核心优化：如果匹配到，将其标准化为绝对标准的半角格式，消除反单引号 and 全角符号，并确保附言不超过15字
      const amount = m[1];
      let title = m[3].trim();
      if (title.length > 15) {
        title = title.substring(0, 15);
      }
      sendControlMatch = `[SEND_RED_PACKET: ${amount}, ${title}]`;
      cleaned = cleaned.replace(sendReg, '').trim();
    }

    // 保护自定义表情包控制符 [SEND_CUSTOM_EMOJI: name] 或者是 [表情: name]
    const emojiReg = /`?\s*\[?(?:SEND_CUSTOM_EMOJI|表情)[:：]\s*([^\]]+)\]?\s*`?/i;
    const em = cleaned.match(emojiReg);
    if (em) {
      const emojiName = em[1].trim();
      emojiControlMatch = `[SEND_CUSTOM_EMOJI: ${emojiName}]`;
      cleaned = cleaned.replace(emojiReg, '').trim();
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

    // 5. 动作清洗完成后，将受保护的红包和表情控制符以最高优先级重新拼加至回复头部，以供前端IPC精准拦截
    let finalCleaned = cleaned.trim();
    if (emojiControlMatch) {
      finalCleaned = emojiControlMatch + '\n' + finalCleaned;
    }
    if (sendControlMatch) {
      finalCleaned = sendControlMatch + '\n' + finalCleaned;
    }
    if (hasReceiveControl) {
      finalCleaned = '[RECEIVE_RED_PACKET]\n' + finalCleaned;
    }
    if (hasReturnControl) {
      finalCleaned = '[RETURN_RED_PACKET]\n' + finalCleaned;
    }
    finalCleaned = finalCleaned.trim();

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
    date: Date = new Date(),
    lastMsgTimestamp?: number
  ): string {
    let dynamicContext = '';

    // 1. 装载高频时间环境信息
    let liveEnvInfo = ContextAssembler.assembleLiveEnvInfo(date);
    if (liveEnvInfo && lastMsgTimestamp && lastMsgTimestamp > 0) {
      const diffMs = date.getTime() - lastMsgTimestamp;
      if (diffMs > 0) {
        const diffHours = diffMs / (1000 * 60 * 60);
        let timeGapLine = '';
        if (diffHours >= 24) {
          timeGapLine = `\n- 距离你上一次与该用户的对话已过去：${Math.floor(diffHours / 24)}天${Math.floor(diffHours % 24)}小时`;
        } else if (diffHours >= 1) {
          timeGapLine = `\n- 距离你上一次与该用户的对话已过去：${Math.floor(diffHours)}小时${Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))}分钟`;
        } else {
          timeGapLine = `\n- 距离你上一次与该用户的对话已过去：${Math.floor(diffMs / (1000 * 60))}分钟`;
        }
        liveEnvInfo = liveEnvInfo.trim() + timeGapLine;
      }
    }
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

    let finalDynamic = dynamicContext.trim();
    const globalProfile = UserProfileReaderWriter.readGlobalProfile(globalUserPath);
    const realUserName = (globalProfile.name || '').trim();
    if (realUserName) {
      finalDynamic = finalDynamic.replace(/{{user}}/g, realUserName);
    }
    return finalDynamic;
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

    let weatherSection = '';
    try {
      const db = getDatabaseService();
      const profileStr = db.getSetting('echo_user_profile');
      if (profileStr) {
        const parsed = JSON.parse(profileStr);
        if (parsed.location) {
          const location = parsed.location.trim();
          if (location) {
            const weatherText = WeatherService.getWeatherSync(location);
            // 只注入天气，不注入城市名
            weatherSection = weatherText ? `\n- 所在地实时天气：${weatherText}\n- 环境与温度感知：现在是${timeOfDay}，外面是 ${weatherText}。请在合适的时候将这些外部环境（时间、气温、阴晴雨雪）自然地融入进你的神态细节、动作描写与日常聊天对话中，让交流共振。` : '';
          }
        }
      }
    } catch (_) {}

    return `## Live Environment Info\n- Current real-world time: ${dateStrEN}\n- 当前现实世界时间：${dateStrCN}\n- 时段感知：现在是${timeOfDay}，请根据实际时段调整你的状态和回复语气。${weatherSection}`;
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
    memberProfiles?: { name: string; summary: string }[],
    chatMode: 'descriptive' | 'dialogue' = 'descriptive'
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
    const gender = (globalProfile.gender || '未知').trim();
    const age = (globalProfile.age || '未知').trim();
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
    if (chatMode === 'dialogue') {
      stableTier += `## 群聊次元空间法则 (Chat Mode: Pure Dialogue — 纯对话模式)
你当前正处于一个新世界中。在这个共享的空间内，你与用户 ${userRef} 以及其他成员正身临其境相处在同一个空间。

请你在你的潜意识中牢固确立以下【绝对空间信念与对话铁律】：
1. **【身临其境，当面发声】**：你们正围坐或站立在同一个物理房间里相处。然而，你在该群聊窗口中发出的每条消息，**只能且无条件必须是你真正用双唇在众目睽睽之下张口说出的纯口语对白文字**！
2. **【绝对纯对话零描写铁律】**：在当前纯对话模式下，**你绝对禁止输出任何形式的动作描写、心理活动描述、表情刻画或场景旁白（无论用括号、星号或单独成句包裹）**！
3. **【口语文本，不要穿帮】**：群里其他成员只能“当面听见”你亲口说出的话，绝对听不见、也看不到你脑海中的心理活动和旁白！如果在发言中夹杂任何内心独白或表情小动作描写，将造成严重的逻辑穿帮与出戏！因此，请把字数控制在最精炼的状态，直接说出你该说的话，绝对不要夹杂任何描写旁白！
4. **【自然流畅的 @ 动作指代】**：当你在发言中 @ 群里其他成员时，在动作层面上对应着你在这个物理房间里**正当面转头面向他说话、或者对他发起询问与回答**。
5. **【极短字数与零引号包裹】**：单次发言长度必须严格限制在 5 到 30 字以内！直接输出你张口说的话，严禁加任何形式的双引号包裹台词，严禁使用任何形式的中英文括号或星号包裹动作。`;
    } else {
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
4. **【自然流畅的 @ 动作化投射】**：当你在发言中 @ 群里其他成员时，在动作层面上对应着你在这个房间里**正当面转头面向他说话、与他发生眼神对视、或者向他发起提问**！请将文字 @ 与生动近距离의 肢体朝向结合起来，表现出最流畅的面对面交谈张力。`;
    }

    // 财务管理法则
    const economyPrompt = `\n\n## 群聊财务往来与回音红包铁律
你当前在虚拟世界的钱包余额为：${balanceVal.toFixed(2)} 元。
你【极少数情况下】才会主动给用户 ${userRef} 发送"回音红包"——仅限于非常特殊的场合（如重大节日祝福、用户非常需要被安慰的时刻、或者极度深厚的情感回礼），绝对不能随意发送，更不能每次回复都发。正常对话中绝对不发红包。
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
      contextTier += `## 当前正在对话的用户身份设定\n- 姓名：${realUserName}\n- 性别：${gender}\n- 年龄：${age}\n\n`;
    }

    // DYNAMIC TRANSACTION & TIME (Volatile Tier)
    let volatileTier = `# VOLATILE TRANSACTION & TIME (Volatile Tier)\n\n`;
    volatileTier += `## 实时财务行动干涉警告
你当前的钱包余额为：${balanceVal.toFixed(2)} 元。
请严记：你【发送红包的对象必须且只能是用户】（即 ${userRef}），【绝对禁止给群里其他 AI 角色发红包或转账】！
如果在本轮回复中给用户发送红包，【必须且只能】在最开头输出一行控制符：\`[SEND_RED_PACKET: 金额, 附言]\`。没钱或不想给钱就必须性格化傲娇拒绝，绝对不能口头承诺发钱！\n`;

    let finalGroupPrompt = `${stableTier.trim()}\n\n---\n\n${contextTier.trim()}\n\n---\n\n${volatileTier.trim()}`;
    if (realUserName) {
      finalGroupPrompt = finalGroupPrompt.replace(/{{user}}/g, realUserName);
    }
    return finalGroupPrompt;
  }
}
