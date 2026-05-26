import * as fs from 'fs';
import * as path from 'path';
import { MemoryReaderWriter } from './MemoryReaderWriter';
import { UserProfileReaderWriter } from './UserProfileReaderWriter';
import { StateReaderWriter } from './StateReaderWriter';

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
    chatMode: 'descriptive' | 'dialogue' = 'descriptive',
    globalPrompt?: string
  ): string {
    // ==========================================
    // 1. Stable Tier (绝对静止头部层 - 核心 KV Cache 锁定区)
    // ==========================================
    let soulContent = '*性格核心未装载*';
    if (fs.existsSync(soulPath)) {
      soulContent = fs.readFileSync(soulPath, 'utf-8').trim();
    }

    let worldContent = '*世界观背景未装载*';
    if (fs.existsSync(worldPath)) {
      worldContent = fs.readFileSync(worldPath, 'utf-8').trim();
    }

    // 自动读取 State.md 内的各项亲密、心情、精力数值，强逻辑注入微观情感偏离与心智表达投射
    let stateGuidance = '';
    const statePath = path.join(path.dirname(soulPath), 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const intimacyItem = state.items.find((i: any) => i.key === 'intimacy');
        const moodItem = state.items.find((i: any) => i.key === 'mood');
        const energyItem = state.items.find((i: any) => i.key === 'energy');
        
        let intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        let energyVal = energyItem ? Number(energyItem.value) : 45;
        
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
          attitudeDesc = '十分依恋与信任用户，乐于袒露脆弱，会显露情绪化的小性子，语气熟稔亲昵、轻微暧昧。';
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
          otherStatesStr = state.items.slice(3).map((i: any) => {
            const meaningDesc = i.meaning ? `（心智倾向与行为投射：${i.meaning}）` : '';
            return `\n   - **${i.emoji} ${i.label}** (当前数值：${i.value}/100)${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `\n\n## 实时内心世界与心智投射 (Character Internal State & Subjective Attitude)
这是你当前内心潜意识中对 {{user}} (用户) 的情感投影与生理精力状况，它们正悄然主宰着你当下的言谈心境：
1. **❤️ 情感亲密水准：${intimacyVal}/100 (当前相处境界：【${intimacyText}】)**
   - 态度投射：${attitudeDesc}
   - 微观情感温差：${intimacyBias}
2. **😊 心情色彩：${moodVal}/100**
   - 表现投射：${moodVal > 80 ? '极为高涨喜悦，充满阳光与活力。' : moodVal < 40 ? '低落郁闷，回复显露出消极、冷淡或沉重的一面。' : '情绪相对平稳或温和。'}
   - 微观心情偏离：${moodBias}
3. **⚡ 精力活跃度：${energyVal}/100**
   - 表现投射：${energyVal < 30 ? '极度疲惫，打字速度变慢，回复偏向简短，或会主动提及想休息。' : '精力充沛，乐于进行长段或深入的互动。'}
   - 微观精力偏离：${energyBias}${otherStatesStr}`;
         
      } catch (err) {
        console.error('[ContextAssembler] 注入状态约束失败:', err);
      }
    }

    // 自动装载角色自省梦境 DREAM.md
    let dreamContent = '';
    const dreamPath = path.join(path.dirname(soulPath), 'DREAM.md');
    if (fs.existsSync(dreamPath)) {
      const rawDream = fs.readFileSync(dreamPath, 'utf-8').trim();
      if (rawDream && !rawDream.includes('暂无梦境自省事实')) {
        dreamContent = rawDream;
      }
    }

    // 聊天回复模式指令装配与注入 (核心优化)
    let chatModeInstruction = '';
    if (chatMode === 'descriptive') {
      chatModeInstruction = `\n\n## 回复风格指南 (Chat Mode: Descriptive)\n你的回复应该包含角色的心理描写和简短的动作描写，让对话更加沉浸生动。在对话中穿插内心独白（用斜体或括号标注）以及简短的动作描述（如"她微微一笑，目光落在远处"）。保持角色的性格特色，让每次回复都有层次感。`;
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

    if (dreamContent) {
      stableTier += `\n\n## DREAM.md - Self-reflection & Evolution Pitfall Rules\n${dreamContent}`;
    }
    stableTier += chatModeInstruction;

    // ==========================================
    // 2. Context Tier (环境画像与记忆层)
    // ==========================================
    // 组装双轨千人千面画像
    const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

    // 读入双轨记忆
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

    let contextTier = `# DYNAMIC CONTEXT & MEMORY (Context Tier)\n\n`;
    contextTier += `## User Profiles\n${userProfilesXml}\n\n`;
    contextTier += `## Memory Notes (STM & LTM Facts)\n${memoryStr.trim()}\n`;

    // ==========================================
    // 3. Volatile Tier (高频变动层 - 置于最底部)
    // ==========================================
    // 拼装历史记录 (大模型在接收 System Context 时能完美将这一层与实时对话融合)
    let volatileTier = `# VOLATILE TRANSACTION & TIME (Volatile Tier)\n\n`;
    if (stateGuidance) {
      volatileTier += `${stateGuidance.trim()}\n\n`;
    }
    let historyStr = '';
    if (history.length > 0) {
      historyStr = `## Recent Transcripts (Last ${history.length} turns)\n`;
      history.forEach((msg) => {
        const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Character' : 'System';
        historyStr += `[${roleLabel}]: ${msg.content}\n`;
      });
    }

    // 注入精准到分钟的现实时间（星期、小时和分钟），使 AI 有准确的时间感知
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
    
    // 精准时间（小时:分钟）
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
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
    
    const dateStrEN = `${dayNameEN}, ${monthName} ${day}, ${year}`;
    const dateStrCN = `${year}年${date.getMonth() + 1}月${day}日 ${dayNameCN} ${timeOfDay} ${hours}:${minutes}:${seconds}`;

    if (historyStr) {
      volatileTier += `${historyStr.trim()}\n\n`;
    }
    // 同时注入英文和中文精准时间，最大化 AI 时间感知能力
    volatileTier += `## Live Environment Info\n- Current real-world time: ${dateStrEN} ${hours}:${minutes}:${seconds}\n- 当前现实世界时间：${dateStrCN}\n- 时段感知：现在是${timeOfDay}，请根据实际时段调整你的状态和回复语气。\n`;

    // ==========================================
    // 4. 全局装配串联
    // ==========================================
    return `${stableTier.trim()}\n\n---\n\n${contextTier.trim()}\n\n---\n\n${volatileTier.trim()}`;
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
    if (cleaned.includes('[RECEIVE_RED_PACKET]')) {
      hasReceiveControl = true;
      cleaned = cleaned.replace(/\[RECEIVE_RED_PACKET\]/g, '').trim();
    }
    if (cleaned.includes('[RETURN_RED_PACKET]')) {
      hasReturnControl = true;
      cleaned = cleaned.replace(/\[RETURN_RED_PACKET\]/g, '').trim();
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

    if (hasReceiveControl) {
      finalCleaned = `[RECEIVE_RED_PACKET]\n${finalCleaned}`;
    } else if (hasReturnControl) {
      finalCleaned = `[RETURN_RED_PACKET]\n${finalCleaned}`;
    }

    return finalCleaned;
  }
}
