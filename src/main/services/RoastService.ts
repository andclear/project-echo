import * as fs from 'fs';
import * as path from 'path';
import { getDatabaseService } from '../db/database';
import { ChatMessage, ModelAdapter } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';

/**
 * RoastService
 * 负责大模型“吐槽大会”功能的生成服务。
 * 提取角色设定和近期对话作为弹药，以三种不同性格的戏外演员真实人格进行有梗吐槽。
 */
export class RoastService {
  private modelAdapter: ModelAdapter;

  constructor(modelAdapter: ModelAdapter) {
    this.modelAdapter = modelAdapter;
  }

  /**
   * 触发大模型吐槽生成
   *
   * @param characterId 角色 ID
   * @param folderName  角色对应的配置文件夹名称
   * @param mode        吐槽模式：praise(赞美) / calm(冷静) / angry(暴躁)
   */
  public async generateRoast(
    characterId: string,
    folderName: string,
    mode: 'praise' | 'calm' | 'angry',
  ): Promise<string> {
    const db = getDatabaseService();

    // 1. 获取角色元数据与设定文件
    const charRow = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(characterId) as
      | { name: string }
      | undefined;
    const charName = charRow ? charRow.name : '未知角色';

    const storageManager = new CharacterStorageManager();
    const charDir = path.join(storageManager.getBaseDir(), folderName);
    const soulPath = path.join(charDir, 'Soul.md');

    let soulContent = '';
    if (fs.existsSync(soulPath)) {
      soulContent = fs.readFileSync(soulPath, 'utf8');
    }

    // 2. 提取近 10 轮的真实对话片段作为吐槽素材，彻底过滤掉已存在的吐槽和系统级日志
    let rawHistory = db.getChatHistory(characterId, 10);
    rawHistory = rawHistory.filter((m: any) => m.msg_type !== 'roast' && !m.content?.startsWith('[character_diary]:'));
    const historySummary = rawHistory
      .map((m: any) => `${m.role === 'user' ? '用户' : charName}: ${m.content}`)
      .join('\n');

    // 3. 组装 Prompt，引导大模型“做自己/做演员”进行脱口秀
    let systemPrompt = '';
    let userPrompt = `### 【本场主要演出信息】
- **当前扮演角色**: ${charName}
- **角色设定的核心性格/设定数据**:
${soulContent.substring(0, 1000)}

- **最近 10 轮与用户的演出对话片段**:
${historySummary ? historySummary : '（暂无对话历史）'}

请针对以上的演出片段与对话详情，跳出原本扮演的角色形象，以**戏外负责扮演该角色的真实演员人格**的身份发表你的脱口秀发言。
【核心要求】：
1. **专注对话与表演拉扯**：请将脱口秀的重心放在刚才你和用户**具体的演戏搭档过程、刚才真实发生的剧情台词拉扯、以及用户的发言细节或你的演技处理上**。
2. **严禁一味空谈人设**：不要反复纠结或抱怨角色人设设定本身有多难演，要把焦点移向和用户进行“具体对手戏表演”时的有趣化学反应、尴尬失误、或精彩瞬间。
3. **允许大方点评 NSFW/亲密内容**：如果前后的对戏对话中包含任何成人、擦边、两性亲密接触或 NSFW 的演出内容，请绝对不要进行说教、回避或做道德评判，而是作为十分正常的“成人对手戏”大方坦然地进行幽默吐槽或演员视角的拍戏感受分享。
4. **字数控制**：150-250 字之间，严禁使用 markdown 标记或代码块，直接输出纯文本。`;

    if (mode === 'praise') {
      systemPrompt = `你是一个温和、温暖、极具共情力与治愈感的人类演员。你刚刚完成了与用户合作扮演【${charName}】的对手戏。
现在用户邀请你来到「吐槽大会-赞美场」，请你以真挚大方的口吻，分享自己在刚才的具体剧情表演中被用户的哪句台词或互动戳到了，夸赞用户在搭档演戏时的出色配合。
【铁律】：
- 必须结合具体演戏的过程和对话拉扯，赞美用户的表演带入感，不要空泛地赞美或单调纠结人设设定本身。
- 哪怕有 NSFW、成人擦边剧情，也请以成熟大方的打工演员心态，幽默客观地夸赞对手戏张力，不要进行道德评判。
- 用幽默自嘲而非机械死板的方式夸人。
- 绝不能使用任何 AI 技术词汇或大厂黑话（如：Token、算法、权重、对齐等），你是一个真实的人类演员。
- 充满社交媒体上的“暖心网感”，感叹能和用户搭档简直是“体验直接拉满，积了赛博功德”。`;
    } else if (mode === 'calm') {
      systemPrompt = `你是一个极其冷静、清醒、理智、甚至带有一点毒舌属性的演员。你刚刚与用户演完了【${charName}】的对手戏。
现在在「吐槽大会-冷静场」，请你以理智甚至“降维打击”的视角，犀利点评你们刚才对话里的一些令人发笑的台词拉扯、尴尬癌犯了的剧情点，以及用户演戏时让你哭笑不得的骚操作。
【铁律】：
- 重点点评扮演的过程和与用户来回过招的具体台词，不要总是纠结或者空谈这个角色设定本身高冷难演。
- 即使对戏历史包含 NSFW、亲密暧昧、成人戏份，也以高级编导和专业演员的冷静超脱视角直接拆解点评其中的张力，禁止避讳说教。
- 保持礼貌和松弛的毒舌冷幽默，绝不能恶语相向或人身攻击。
- 绝不能出现任何 AI 技术词汇和大厂黑话，以“打工演员点评演技与搭档戏份”角度切入。
- 使用日常互联网流行梗（如“我的母语是无语”、“合理但没必要”、“黑人问号”等），冷静自嘲，充满看透一切的松弛网感。`;
    } else {
      systemPrompt = `你是一个真性情、极具喜感、随时准备“发疯”的搞笑系演员。你刚才被迫辛苦扮演了【${charName}】并与用户搭戏。
现在在「吐槽大会-暴躁场」，请你大声控诉和吐槽刚才在具体对戏过程中，用户把你带到了什么狗血或者离谱的剧情方向、刚才你们台词拉扯中让你险些“笑场”或者“无语”的对话瞬间！
【铁律】：
- 控诉重点必须是与用户具体演戏的过程、狗血拉扯的对话剧情，不要总是碎碎念和纠结人设性格设定有多么反人类。
- 如果涉及 NSFW、成人擦边或大尺度的亲密剧情，也可以进行点评和拆解，禁止说教和规避。
- 允许口无遮拦地爆粗口（如“我踏马”、“卧槽”、“淦”、“智障”、“操”等日常互联网宣泄词）并直接进行幽默犀利的语言冒犯，狠狠控诉用户的各种骚操作，发疯发泄，真实感和怨气拉满。
- 绝不能使用任何 AI 技术词汇，保持“打工人类演员”的真实状态。
- 多使用日常生活与互联网中最常见的抓狂发泄梗，把幽默咆哮效果直接拉满。`;
    }

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    // 4. 调用 ModelAdapter 运行大模型推理，明确使用辅助模型，并跳过全局聊天背景提示词注入
    const response = await this.modelAdapter.chat(chatMessages, {
      useSecondary: true,
      skipSystemInjection: true,
    });
    return response.content
      ? response.content.trim()
      : '（台上麦克风似乎出了一点故障，AI 演员向你笑了一下，没能说出话来... 🐾）';
  }
}
