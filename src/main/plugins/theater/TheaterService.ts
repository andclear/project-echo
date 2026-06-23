import { app } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import * as zlib from 'zlib';
import { getDatabaseService } from '../../db/database';
import { ChatMessage, ModelAdapter } from '../../models/ModelAdapter';
import { CharacterCardParser } from '../../utils/CharacterCardParser';
import { CharacterStorageManager } from '../../utils/CharacterStorageManager';

export interface TheaterThemeConfig {
  id: string;
  name: string;
  description?: string;
  world_settings: string;
  scenario: string;
  status_bars: any[];
  relations: any[];
}

export class TheaterService {
  private baseDir: string;

  constructor() {
    let legacyDir = '';
    try {
      this.baseDir = join(app.getPath('userData'), 'plugins', 'theater');
      legacyDir = join(app.getPath('userData'), 'theaters');
    } catch (_) {
      this.baseDir = join(process.cwd(), 'Echo-UserData-Test', 'plugins', 'theater');
      legacyDir = join(process.cwd(), 'Echo-UserData-Test', 'theaters');
    }

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    // 🚀 大剧院历史题材数据平滑自愈迁移逻辑：防止路径升级造成用户的老题材老存档显示为空
    if (fs.existsSync(legacyDir)) {
      try {
        const files = fs.readdirSync(legacyDir);
        for (const file of files) {
          if (file === '.' || file === '..' || file === '.DS_Store') continue;
          const oldPath = join(legacyDir, file);
          const newPath = join(this.baseDir, file);
          
          if (!fs.existsSync(newPath)) {
            // 使用稳健的递归复制，规避重命名 rename 跨不同挂载分区时的 EXDEV 物理限制
            fs.cpSync(oldPath, newPath, { recursive: true });
            console.log(`[TheaterMigration] 成功将旧剧本数据 ${file} 自愈迁移至新 plugins/theater/ 目录下`);
          }
        }
      } catch (err: any) {
        console.warn(`[TheaterMigration] 尝试迁移老剧本数据失败（不影响主程序运行）:`, err.message || err);
      }
    }
  }

  /**
   * 安全获取唯一拼音目录
   */
  private getUniqueThemeId(name: string): string {
    const storage = new CharacterStorageManager();
    const pinyinName = storage.convertToPinyin(name);

    let currentId = pinyinName;
    let counter = 1;

    while (fs.existsSync(join(this.baseDir, currentId))) {
      currentId = `${pinyinName}_${counter}`;
      counter++;
    }
    return currentId;
  }

  /**
   * 读取常规设置中的全局提示词 (globalPrompt)
   */
  private getGlobalPrompt(): string {
    try {
      const db = getDatabaseService();
      const configStr = db.getSetting('model_config');
      if (configStr) {
        const settings = JSON.parse(configStr);
        return settings.globalPrompt?.trim() || '';
      }
    } catch (_) {}
    return '';
  }

  /**
   * 初始化 ModelAdapter 实例
   */
  private getModelAdapter(): ModelAdapter {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      throw new Error('系统尚未配置大模型，请先在常规设置中配置并保存。');
    }
    const settings = JSON.parse(configStr);
    const adapter = new ModelAdapter(settings.primary, settings.secondary);
    
    // 拦截 chat 方法，实现大剧院 AI 错误自动重试一次机制
    const originalChat = adapter.chat.bind(adapter);
    adapter.chat = async (messages: ChatMessage[], options?: any) => {
      try {
        return await originalChat(messages, options);
      } catch (err: any) {
        console.warn(`[TheaterService AI Retry] 大剧院 AI 调用发生错误（${err.message || err}），正在自动重试...`);
        return await originalChat(messages, options);
      }
    };
    
    return adapter;
  }

  /**
   * 1. 一句话生成世界观或剧本背景
   */
  public async generateBackground(prompt: string, type: 'world' | 'scenario'): Promise<string> {
    const modelAdapter = this.getModelAdapter();
    const globalPrompt = this.getGlobalPrompt();

    let systemPrompt = '';
    if (type === 'world') {
      systemPrompt = `你是一个非常专业的世界观设定架构师。
请你根据用户提供的一句话灵感，构思并生成一个细节详尽、逻辑自洽的宏观世界设定背景（约 600-800 字）。
必须涵盖：世界的运行基本法则、物理或魔法体系、社会制度与核心冲突环境。`;
    } else {
      systemPrompt = `你是一个极具悬念和戏剧冲突感的跑团剧本设计师。
请你根据用户提供的一句话灵感，构思并生成一个引人入胜的游玩开局故事剧本描述（约 600-800 字）。
必须涵盖：故事当前的紧急矛盾点、玩家扮演的主角所处的物理地点、以及开局直接面临的突发危机或首个任务。`;
    }

    // 自动在最前面注入全局提示词
    if (globalPrompt) {
      systemPrompt = `${globalPrompt}\n\n${systemPrompt}`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `我的剧本创意是："${prompt}"。请帮我生成对应的${type === 'world' ? '世界观设定' : '剧本开局背景'}。`,
      },
    ];

    const res = await modelAdapter.chat(messages, { useSecondary: true, skipSystemInjection: true });
    return res.content.trim();
  }

  /**
   * 2. 一句话生成多个角色
   */
  public async generateCharacters(backgroundText: string, maxCount?: number): Promise<any[]> {
    const modelAdapter = this.getModelAdapter();
    const globalPrompt = this.getGlobalPrompt();

    const countStr = maxCount !== undefined ? `${maxCount}` : '3-4';

    let systemPrompt = `你是一个优秀的 TTRPG 跑团群演人设塑造师。
请你仔细阅读提供的世界观/剧本背景，为该故事题材设计出 ${countStr} 名有血有肉、特征鲜明的核心群演角色。

【🔴 角色设计规范】：
1. 角色人设内容（soul）全部使用简体中文，字数不低于 400 字，包含定位、内在反差矛盾、语言风格与可爱盲区等细节，{{user}}表示玩家/主角，{{char}}表示角色自身。人设中不要重复世界观大环境。
2. 角色外貌（appearance）输出英文逗号分隔的 Danbooru tags 外形特征描述.
3. 必须以标准的 JSON 数组格式返回，不要包含 markdown \`\`\` 标记，直接输出 raw JSON 以便程序反序列化。`;

    // 自动在最前面注入全局提示词
    if (globalPrompt) {
      systemPrompt = `${globalPrompt}\n\n${systemPrompt}`;
    }

    const userPrompt = `【当前剧本背景设定】：\n${backgroundText}\n\n请帮我生成 ${countStr} 个匹配该题材的角色。返回格式严格限制为以下 JSON 数组：
[
  {
    "name": "角色真实姓名",
    "gender": "男/女/自定义性别",
    "age": "年龄数字或区间",
    "soul": "角色独立的六维性格设定文本...",
    "appearance": "1girl, long hair, blue eyes"
  }
]`;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const res = await modelAdapter.chat(messages, { useSecondary: true, skipSystemInjection: true });
    let cleanJson = res.content.trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.substring(7);
    } else if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.substring(3);
    }
    if (cleanJson.endsWith('```')) {
      cleanJson = cleanJson.substring(0, cleanJson.length - 3);
    }
    cleanJson = cleanJson.trim();

    try {
      const list = JSON.parse(cleanJson);
      if (Array.isArray(list)) {
        return list;
      }
    } catch (e) {
      console.error('[TheaterService] 解析 AI 生成角色 JSON 失败，返回原始字符串，内容为：', cleanJson, e);
    }
    return [];
  }

  /**
   * 3. 导入酒馆角色卡解密提炼
   */
  public async parseCharacterCard(filePath: string, onProgress?: (data: any) => void): Promise<any> {
    const fileBuffer = fs.readFileSync(filePath);
    return this.parseCharacterCardFromBuffer(fileBuffer, onProgress);
  }

  /**
   * 从二进制 Buffer 导入酒馆角色卡解密提炼
   */
  public async parseCharacterCardFromBuffer(buffer: Buffer | Uint8Array, onProgress?: (data: any) => void): Promise<any> {
    const modelAdapter = this.getModelAdapter();
    const globalPrompt = this.getGlobalPrompt();

    // 1. 解析基础卡片文本
    const cardData = CharacterCardParser.parseFromBuffer(buffer);

    // 合并卡片中的设定文本，以便 LLM 分析
    const combinedTexts: string[] = [];
    if (cardData.name) combinedTexts.push(`【卡片原始名称】：${cardData.name}`);
    if (cardData.personality) combinedTexts.push(`【性格设定】：${cardData.personality}`);
    if (cardData.description) combinedTexts.push(`【描述设定】：${cardData.description}`);
    if (cardData.scenario) combinedTexts.push(`【故事背景】：${cardData.scenario}`);
    if (cardData.character_book) {
      combinedTexts.push(`【世界书设定集】：${JSON.stringify(cardData.character_book)}`);
    }

    const cleanJsonWrap = (text: string): string => {
      if (!text) return '';
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
    };

    // 第一步：提炼大纲与核心角色名单（最多筛选出最核心的 7 个主要角色，忽略不重要的背景路人角色）
    onProgress?.({ stage: 'outline', message: '正在提炼世界框架（第一步提炼大纲）...' });

    let systemPrompt = `你是一个非常专业且具有丰富经验的剧本大纲与角色名单提炼专家。
现在，我们会给你一张非标准角色卡的全部原始文本内容。该卡片可能包含多个嵌套人物、世界书 Lorebook 条目等。
请你仔细梳理文本，提炼出故事大纲、背景以及最核心的主要角色名单。

【你的任务】：
1. 提炼出故事的【世界观（world）】和【剧本开局背景（scenario）】。
2. 提炼出卡片中【核心的、对故事剧本起关键推动作用的独立角色列表】。
   【🔴 角色提炼过滤限制】：请在提炼前根据设定文本智能判定角色的主次。对于只在世界书里作为背景设定出现、或在故事中无关紧要的极次要背景路人角色，请坚决忽略，不予提炼，只保留最核心的主要角色（数量严格限制在最多 7 人以内，如果多于 7 个，请只筛选出最核心的 7 个）。
3. 🔴【变量原样保留规则】：如果原始卡片文本中包含 "{{user}}" 或 "<user>" 占位标记，你必须绝对原样保留这些占位字段，严禁将其翻译或替换为具体姓名。所有输出中提到该占位时，均必须原封不动保留为 "{{user}}" 或 "<user>"！

【格式规范】：
必须以标准的 JSON 格式返回，不要包含 markdown \`\`\` 标记，直接输出 raw JSON：
{
  "world": "提炼出的整个故事世界观设定",
  "scenario": "提炼出的开局剧本故事背景",
  "characters": [
    {
      "name": "角色真实姓名",
      "gender": "性别",
      "age": "年龄/区间"
    }
  ]
}`;

    if (globalPrompt) {
      systemPrompt = `${globalPrompt}\n\n${systemPrompt}`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `以下是提取出的酒馆卡片全部设定文本：\n\n${combinedTexts.join('\n\n')}\n\n请帮我提炼解耦，并筛选出最多 7 个最核心角色名列表。`,
      },
    ];

    console.log(`[TheaterService] 正在向大模型发起“大剧院大纲与核心角色提炼”非流式 AI 请求...`);
    let outlineRes: any;
    try {
      outlineRes = await modelAdapter.chat(messages, { usePrimary: true, skipSystemInjection: true });
      console.log(`[TheaterService] 大剧院大纲与核心角色提炼成功！返回内容长度: ${outlineRes?.content?.length || 0}`);
    } catch (chatErr: any) {
      console.error(`[TheaterService] 大剧院大纲与核心角色提炼 AI 请求失败:`, chatErr.message || chatErr);
      throw chatErr;
    }
    let cleanOutlineJson = cleanJsonWrap(outlineRes.content);
    let outlineData: any;
    try {
      outlineData = JSON.parse(cleanOutlineJson);
    } catch (e) {
      console.error('[TheaterService] 解析大纲提炼 JSON 失败:', cleanOutlineJson, e);
      throw new Error('解析世界框架与核心角色名单失败，大模型未能返回标准的 JSON 结构。');
    }

    const world = outlineData.world || '';
    const scenario = outlineData.scenario || '';
    const rawChars = outlineData.characters || [];

    // 限制最多 7 个角色
    const coreChars = rawChars.slice(0, 7);

    // 通知前端拿到了角色清单，准备进入并发提炼
    onProgress?.({
      stage: 'characters_list',
      message: '已提取核心角色名单，准备依次提炼个性设定...',
      characters: coreChars.map((c: any) => c.name)
    });

    const resultCharacters: any[] = [];

    // 并发限流函数，限制并发为 2
    const limitConcurrent = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
      const results: R[] = [];
      const executing: Promise<any>[] = [];
      for (const item of items) {
        const p = Promise.resolve().then(() => fn(item));
        results.push(p as any);
        if (limit <= items.length) {
          const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
          executing.push(e);
          if (executing.length >= limit) {
            await Promise.race(executing);
          }
        }
      }
      return Promise.all(results);
    };

    // 每一个角色的提炼子任务
    const extractSingleCharacter = async (char: any) => {
      try {
        console.log(`[TheaterService] 正在提炼角色 [${char.name}] 的设定信息...`);
        onProgress?.({
          stage: 'character_start',
          charName: char.name,
          message: `正在提炼角色 [${char.name}] 设定信息...`
        });

        const isUserPersona = char.name === '{{user}}' || char.name === '<user>';
        let charPrompt = '';
        if (isUserPersona) {
          charPrompt = `你是一个非常专业且具有丰富经验的酒馆角色人设提炼专家。
现在你正在提炼的是【用户/玩家自己】所扮演的角色的性格人设与外表特征。
请仔细分析全部卡片原始文本，仅提炼出原卡片中对于【用户/玩家/主人】这一视角的身份定位、角色性格特征、或与其它主要角色互动时的特定设定（例如：你是她的主人 / 你是一个误入城堡的旅人）。

在分析与总结时，你必须【严格遵守】以下五点提炼规范：
1. 【🔴 核心防混淆防假冒规则】：你当前的提炼目标仅针对【用户自己扮演的角色】！绝对禁止将卡片中的主要 NPC 的性格设定、物理外貌或名字张冠李戴地强写给用户。NPC 是独立的角色，他们的设定与用户完全无关！
2. 【人设提炼要求】：提取卡片对用户角色的背景或互动身份设定。如果卡片里根本没有对用户（{{user}}）的任何性格特征描述（用户纯粹是个旁白或普通旁观者），请直接返回 “请补全您的角色性格设定”，严禁复制编造其他 NPC 的人设。字数不限，符合真实设定即可。
3. 【外貌特征 Danbooru Tags 化】：必须翻译/转换/提取为纯英文、以英文逗号分隔的 Danbooru tags 格式外形描述。如果原卡片未提及用户外貌，请返回空字符串。
4. 【变量一致性】：在表述中必须保持使用 {{user}} 或 <user> 占位符指代用户。
5. 【纯简体中文人设输出】：你必须完全使用简体中文来撰写和提炼性格人设的细节。

【格式规范】：
必须以标准的 JSON 格式返回，不要包含 markdown \`\`\` 标记，直接输出 raw JSON：
{
  "soul": "用户扮演角色的身份设定与性格特征...",
  "appearance": "1girl, solo, short hair, glasses"
}`;
        } else {
          charPrompt = `你是一个非常专业且具有丰富经验的酒馆角色人设提炼专家。
请从我们给出的全部卡片原始文本内容中，针对核心角色【${char.name}】进行专属的精细化性格人设与外表特征提炼。

在分析与总结时，你必须【严格遵守】以下五点提炼规范：
1. 【核心防混淆规则】：你当前的提炼目标仅针对角色【${char.name}】！世界书中很多条目介绍的是其他 NPC。请注意别弄混，绝对不要把其他 NPC 的外貌、人设或身份误当成角色【${char.name}】的设定。
2. 【人设精细化提炼】：详细且高质量地总结出她的性格与核心人设。必须包含该角色的行事动机、内在矛盾、口头禅风格、言行细节、可爱盲区等，字数不少于 400 字，力求极其饱满并符合戏剧张力。人设只关注其个人特征，剔除世界观背景。
3. 【外貌特征 Danbooru Tags 化】：必须翻译/转换/提取为纯英文、以英文逗号分隔的 Danbooru tags 格式外形描述（例如: 1girl, solo, black hair, blue eyes, white dress），绝对禁止使用中文或英文整句。
4. 【用户姓名脱敏规则】：凡是需要指代、提及、或描述对话对象（即用户、玩家、主角、或角色的主人）的地方，必须统一且只使用 {{user}} 或 <user> 占位符进行指代！绝对禁止在总结中写死任何具体的人名、昵称、You 或 User。
5. 【纯简体中文人设输出】：你必须完全使用简体中文来撰写和提炼性格人设（soul）的细节。

【格式规范】：
必须以标准的 JSON 格式返回，不要包含 markdown \`\`\` 标记，直接输出 raw JSON：
{
  "soul": "个人六维性格设定文本...",
  "appearance": "1girl, solo, short hair, glasses"
}`;
        }

        const charMessages: ChatMessage[] = [
          { role: 'system', content: globalPrompt ? `${globalPrompt}\n\n${charPrompt}` : charPrompt },
          {
            role: 'user',
            content: `以下是提取出的酒馆卡片全部设定文本：\n\n${combinedTexts.join('\n\n')}\n\n请针对核心角色【${char.name}】进行专属的人设与外貌特征提取。`,
          }
        ];

        const charRes = await modelAdapter.chat(charMessages, { usePrimary: true, skipSystemInjection: true });
        let cleanCharJson = cleanJsonWrap(charRes.content);
        const charDetail = JSON.parse(cleanCharJson);

        resultCharacters.push({
          name: char.name,
          gender: char.gender || '自定义',
          age: String(char.age || ''),
          soul: charDetail.soul || '无详细人设',
          appearance: charDetail.appearance || ''
        });

        console.log(`[TheaterService] 角色 [${char.name}] 提炼完成！`);
      } catch (err: any) {
        console.error(`[TheaterService] 提炼角色 [${char.name}] 发生异常，降级容错:`, err.message || err);
        resultCharacters.push({
          name: char.name,
          gender: char.gender || '自定义',
          age: String(char.age || ''),
          soul: `${char.name}，关于该角色的详细设定未能成功生成。`,
          appearance: ''
        });
      }
    };

    // 执行并发提炼，限制并发度为 2
    await limitConcurrent(coreChars, 2, extractSingleCharacter);

    // 第三步：理清社会关系网络
    console.log('[TheaterService] 正在提炼理清角色间的社会关系网络...');
    onProgress?.({ stage: 'relations', message: '正在理清关系网络...' });

    let relations: any[] = [];
    try {
      const relationPrompt = `你是一个非常专业且具有丰富经验的角色社会关系网提炼专家。
请根据整个故事的背景设定，以及这一组出场角色的简短身份名单，理清他们之间错综复杂的初始人际关系连线。

【角色清单】：
${resultCharacters.map(c => `姓名: ${c.name}, 性别: ${c.gender}, 大纲: ${c.soul.substring(0, 100)}...`).join('\n')}

【剧情/世界背景】：
${world}\n\n${scenario}

【🔴 关系提炼简化限制】：
请保持人际关系网极简和主次分明。只保留核心的、能直接触发戏剧冲突和人设张力的主线关系，坚决杜绝让所有人两两配对的复杂交叉关系。每个角色身上最多只保留 2-3 条与其人际关系最深或最冲突的连线。对于无实质情节推动作用的普通人际关系一律忽略。

【格式规范】：
必须以标准的 JSON 格式返回，不要包含 markdown \`\`\` 标记，直接输出 raw JSON：
[
  { "from": "源角色姓名", "to": "目标角色姓名", "type": "关系描述" }
]`;

      const relMessages: ChatMessage[] = [
        { role: 'system', content: globalPrompt ? `${globalPrompt}\n\n${relationPrompt}` : relationPrompt },
        { role: 'user', content: '请帮我提炼理清这些核心角色之间的社会关系网络。' }
      ];

      const relRes = await modelAdapter.chat(relMessages, { usePrimary: true, skipSystemInjection: true });
      let cleanRelJson = cleanJsonWrap(relRes.content);
      relations = JSON.parse(cleanRelJson);
    } catch (err: any) {
      console.warn('[TheaterService] 提炼角色关系失败，采用空关系数组兜底:', err.message || err);
    }

    // 第四阶段：通知写入数据库
    onProgress?.({ stage: 'db', message: '正在写入数据库...' });

    // 如果 buffer 是合法的 PNG，可以直接将其转换成 base64 作为封面返回给前端
    let coverBase64 = '';
    try {
      if (buffer && buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        const bufObj = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        coverBase64 = `data:image/png;base64,${bufObj.toString('base64')}`;
      }
    } catch (e) {
      console.warn('[TheaterService] 转换角色卡 buffer 到 base64 封面失败:', e);
    }

    return {
      world,
      scenario,
      characters: resultCharacters,
      relations,
      cover: coverBase64
    };
  }

  /**
   * 4. 保存剧本 (物理混合存盘 + 数据库缓存)
   */
  public saveTheme(payload: {
    id?: string;
    name: string;
    world_settings: string;
    scenario: string;
    status_bars: any[];
    relations: any[];
    characters: any[];
    coverBase64?: string;
  }): { success: boolean; id: string } {
    let themeId = payload.id?.trim();
    const isEdit = !!themeId;

    // 如果是新建，生成唯一的拼音 ID
    if (!themeId) {
      themeId = this.getUniqueThemeId(payload.name);
    }

    const themeDir = join(this.baseDir, themeId);
    if (!fs.existsSync(themeDir)) {
      fs.mkdirSync(themeDir, { recursive: true });
    }

    // 1. 保存封面图片
    if (payload.coverBase64) {
      try {
        const cleanBase64 = payload.coverBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(cleanBase64, 'base64');
        fs.writeFileSync(join(themeDir, 'cover.png'), buffer);
      } catch (err) {
        console.error('[TheaterService] 保存封面图片失败:', err);
      }
    }

    // 2. 保存角色独立物理文件
    const charBaseDir = join(themeDir, 'characters');
    if (!fs.existsSync(charBaseDir)) {
      fs.mkdirSync(charBaseDir, { recursive: true });
    }

    const storage = new CharacterStorageManager();
    const savedCharIds: string[] = [];

    for (const char of payload.characters) {
      const charPinyin = storage.convertToPinyin(char.name);
      const charDir = join(charBaseDir, charPinyin);
      if (!fs.existsSync(charDir)) {
        fs.mkdirSync(charDir, { recursive: true });
      }

      // 保存头像
      if (char.avatarBase64) {
        try {
          const cleanAvatar = char.avatarBase64.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(cleanAvatar, 'base64');
          fs.writeFileSync(join(charDir, 'avatar.png'), buffer);
        } catch (err) {
          console.error(`[TheaterService] 保存角色 [${char.name}] 头像失败:`, err);
        }
      }

      // 写入性格设定 Soul.md
      fs.writeFileSync(join(charDir, 'Soul.md'), (char.soul || '').trim(), 'utf8');

      // 写入外貌设定 Appearance.md
      const appearanceContent = `### Appearance Tags\n${(char.appearance || '').trim()}\n`;
      fs.writeFileSync(join(charDir, 'Appearance.md'), appearanceContent, 'utf8');

      // 写入辅助元数据 meta.json
      const meta = {
        name: char.name,
        gender: char.gender || '未知',
        age: char.age || '',
        isUserPersona: !!char.isUserPersona,
      };
      fs.writeFileSync(join(charDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

      savedCharIds.push(charPinyin);
    }

    // 清理已被删除的角色的物理子目录
    try {
      const existingDirs = fs.readdirSync(charBaseDir);
      for (const dir of existingDirs) {
        if (!savedCharIds.includes(dir)) {
          const fullPath = join(charBaseDir, dir);
          fs.rmSync(fullPath, { recursive: true, force: true });
          console.log(`[TheaterService] 清理已删除角色的目录: ${fullPath}`);
        }
      }
    } catch (_) {}

    // 3. 写入核心配置文件 theme.json
    const themeConfig: TheaterThemeConfig = {
      id: themeId,
      name: payload.name,
      description: payload.scenario ? payload.scenario.substring(0, 100) + '...' : '',
      world_settings: payload.world_settings,
      scenario: payload.scenario,
      status_bars: payload.status_bars,
      relations: payload.relations,
    };
    fs.writeFileSync(join(themeDir, 'theme.json'), JSON.stringify(themeConfig, null, 2), 'utf8');

    // 4. 更新数据库快速缓存索引
    const db = getDatabaseService();
    db.db
      .prepare(
        `
      INSERT INTO TheaterThemes (id, name, description, folder_name, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        folder_name = excluded.folder_name
    `,
      )
      .run(themeId, payload.name, themeConfig.description || '', themeId, Date.now());

    console.log(`[TheaterService] 剧本 [${payload.name}] 已物理保存，物理路径为: ${themeDir}`);
    return { success: true, id: themeId };
  }

  /**
   * 5. 物理删除剧本 (删除物理目录 + 数据库清理)
   */
  public deleteTheme(themeId: string): void {
    const themeDir = join(this.baseDir, themeId);

    // 1. 删除磁盘物理目录
    if (fs.existsSync(themeDir)) {
      try {
        fs.rmSync(themeDir, { recursive: true, force: true });
        console.log(`[TheaterService] 物理删除剧本目录成功: ${themeDir}`);
      } catch (err) {
        console.error(`[TheaterService] 物理删除剧本目录失败: ${themeDir}`, err);
      }
    }

    // 2. 删除数据库的题材索引
    const db = getDatabaseService();

    // 使用 sqlite3 事务一键清理运行时残留会话、消息及连线
    const deleteTx = db.db.transaction(() => {
      // 查出该题材下的所有会话
      const sessions = db.db.prepare('SELECT id FROM TheaterSessions WHERE theme_id = ?').all(themeId) as {
        id: string;
      }[];
      for (const sess of sessions) {
        db.db.prepare('DELETE FROM TheaterMessages WHERE session_id = ?').run(sess.id);
        db.db.prepare('DELETE FROM TheaterRelationNodes WHERE session_id = ?').run(sess.id);
        db.db.prepare('DELETE FROM TheaterRelationEdges WHERE session_id = ?').run(sess.id);
      }
      db.db.prepare('DELETE FROM TheaterSessions WHERE theme_id = ?').run(themeId);
      db.db.prepare('DELETE FROM TheaterThemes WHERE id = ?').run(themeId);
    });

    deleteTx();
    console.log(`[TheaterService] 数据库清理剧本 [${themeId}] 索引及相关运行时会话成功！`);
  }

  /**
   * 6. 加载并同步返回所有剧本列表
   */
  public listThemes(): any[] {
    const list: any[] = [];
    if (!fs.existsSync(this.baseDir)) {
      return list;
    }

    const db = getDatabaseService();
    const folders = fs.readdirSync(this.baseDir);

    // 用于标记本次物理扫描到的 ID，扫描结束后物理删除数据库中失效的记录
    const scannedIds: string[] = [];

    for (const folder of folders) {
      const themeDir = join(this.baseDir, folder);
      const configPath = join(themeDir, 'theme.json');

      if (fs.existsSync(configPath)) {
        try {
          const configStr = fs.readFileSync(configPath, 'utf8');
          const config = JSON.parse(configStr);

          // 加载封面
          let cover = '';
          const coverPath = join(themeDir, 'cover.png');
          if (fs.existsSync(coverPath)) {
            const imgBuffer = fs.readFileSync(coverPath);
            cover = `data:image/png;base64,${imgBuffer.toString('base64')}`;
          }

          // 扫描该剧本下的所有角色
          const chars: any[] = [];
          const charBaseDir = join(themeDir, 'characters');
          if (fs.existsSync(charBaseDir)) {
            const charDirs = fs.readdirSync(charBaseDir);
            for (const cDir of charDirs) {
              const cPath = join(charBaseDir, cDir);
              const metaPath = join(cPath, 'meta.json');
              const soulPath = join(cPath, 'Soul.md');
              const appPath = join(cPath, 'Appearance.md');

              if (fs.existsSync(metaPath) && fs.existsSync(soulPath)) {
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
                const avatarPath = join(cPath, 'avatar.png');
                if (fs.existsSync(avatarPath)) {
                  const imgBuffer = fs.readFileSync(avatarPath);
                  avatar = `data:image/png;base64,${imgBuffer.toString('base64')}`;
                }

                chars.push({
                  name: meta.name,
                  gender: meta.gender,
                  age: meta.age,
                  soul,
                  appearance,
                  avatar,
                  isUserPersona: !!meta.isUserPersona,
                });
              }
            }
          }

          const themeItem = {
            ...config,
            cover,
            characters: chars,
          };
          list.push(themeItem);
          scannedIds.push(config.id);

          // 自动同步/自愈插入至 SQLite 缓存中
          db.db
            .prepare(
              `
            INSERT INTO TheaterThemes (id, name, description, folder_name, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              folder_name = excluded.folder_name
          `,
            )
            .run(config.id, config.name, config.description || '', folder, Date.now());
        } catch (err) {
          console.error(`[TheaterService] 读取剧本目录 [${folder}] 失败:`, err);
        }
      }
    }

    // 清理数据库中多余的已在磁盘物理删除的剧本索引
    try {
      const allDbThemes = db.db.prepare('SELECT id FROM TheaterThemes').all() as { id: string }[];
      for (const dbTheme of allDbThemes) {
        if (!scannedIds.includes(dbTheme.id)) {
          db.db.prepare('DELETE FROM TheaterThemes WHERE id = ?').run(dbTheme.id);
          console.log(`[TheaterService] 自动清除了已在物理磁盘上废弃的数据库索引: ${dbTheme.id}`);
        }
      }
    } catch (_) {}

    list.sort((a, b) => a.id.localeCompare(b.id));
    return list;
  }

  /**
   * 7. 导出题材包为 Gzip 二进制 Buffer
   */
  public exportThemeToBuffer(themeId: string): Buffer {
    const themeDir = join(this.baseDir, themeId);
    if (!fs.existsSync(themeDir)) {
      throw new Error('题材物理目录不存在！');
    }

    // 1. 读取 theme.json
    const themeJsonPath = join(themeDir, 'theme.json');
    if (!fs.existsSync(themeJsonPath)) {
      throw new Error('未找到 theme.json，这可能不是一个有效的大剧院题材目录！');
    }
    const themeJsonStr = fs.readFileSync(themeJsonPath, 'utf8');
    const theme = JSON.parse(themeJsonStr);

    // 2. 读取封面 cover.png 并转为 base64
    let coverBase64 = '';
    const coverPath = join(themeDir, 'cover.png');
    if (fs.existsSync(coverPath)) {
      coverBase64 = 'data:image/png;base64,' + fs.readFileSync(coverPath).toString('base64');
    }

    // 3. 扫描并打包 characters 目录
    const characters: any[] = [];
    const charBaseDir = join(themeDir, 'characters');
    if (fs.existsSync(charBaseDir)) {
      const folders = fs.readdirSync(charBaseDir);
      for (const folder of folders) {
        const charDir = join(charBaseDir, folder);
        const metaPath = join(charDir, 'meta.json');
        const soulPath = join(charDir, 'Soul.md');
        const appPath = join(charDir, 'Appearance.md');

        if (fs.existsSync(metaPath) && fs.existsSync(soulPath)) {
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

          let avatarBase64 = '';
          const avatarPath = join(charDir, 'avatar.png');
          if (fs.existsSync(avatarPath)) {
            avatarBase64 = 'data:image/png;base64,' + fs.readFileSync(avatarPath).toString('base64');
          }

          characters.push({
            name: meta.name,
            gender: meta.gender || '未知',
            age: meta.age || '',
            isUserPersona: !!meta.isUserPersona,
            soul,
            appearance,
            avatarBase64
          });
        }
      }
    }

    // 4. 构建打包大 JSON
    const packData = {
      version: '1.0.0',
      exportTime: Date.now(),
      theme,
      coverBase64,
      characters
    };

    // 5. 进行 Gzip 压缩并返回 Buffer
    return zlib.gzipSync(Buffer.from(JSON.stringify(packData), 'utf8'));
  }

  /**
   * 8. 从 Gzip 二进制 Buffer 导入题材包
   */
  public importThemeFromBuffer(packBuffer: Buffer): { success: boolean; id?: string; error?: string } {
    try {
      // 1. Gzip 解压并反序列化 JSON
      const decompressed = zlib.gunzipSync(packBuffer).toString('utf8');
      const packData = JSON.parse(decompressed);

      if (!packData.theme || !packData.theme.name) {
        return { success: false, error: '无效的剧本数据包：未检测到剧本题材配置或剧本名称！' };
      }

      const originalTheme = packData.theme;
      const themeName = originalTheme.name;

      // 2. 重新生成唯一的拼音 ID，防范物理磁盘目录冲突
      const newThemeId = this.getUniqueThemeId(themeName);
      const themeDir = join(this.baseDir, newThemeId);
      if (!fs.existsSync(themeDir)) {
        fs.mkdirSync(themeDir, { recursive: true });
      }

      // 3. 还原封面图片 cover.png
      if (packData.coverBase64 && packData.coverBase64.startsWith('data:image/')) {
        try {
          const cleanBase64 = packData.coverBase64.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(join(themeDir, 'cover.png'), Buffer.from(cleanBase64, 'base64'));
        } catch (coverErr) {
          console.error(`[TheaterService] 还原封面失败:`, coverErr);
        }
      }

      // 4. 还原角色物理结构
      if (Array.isArray(packData.characters)) {
        const charBaseDir = join(themeDir, 'characters');
        if (!fs.existsSync(charBaseDir)) {
          fs.mkdirSync(charBaseDir, { recursive: true });
        }

        const storage = new CharacterStorageManager();

        for (const char of packData.characters) {
          if (!char.name) continue;
          const charPinyin = storage.convertToPinyin(char.name);
          const charDir = join(charBaseDir, charPinyin);
          if (!fs.existsSync(charDir)) {
            fs.mkdirSync(charDir, { recursive: true });
          }

          // 还原头像
          if (char.avatarBase64 && char.avatarBase64.startsWith('data:image/')) {
            try {
              const cleanAvatar = char.avatarBase64.replace(/^data:image\/\w+;base64,/, '');
              fs.writeFileSync(join(charDir, 'avatar.png'), Buffer.from(cleanAvatar, 'base64'));
            } catch (avatarErr) {
              console.error(`[TheaterService] 还原角色 [${char.name}] 头像失败:`, avatarErr);
            }
          }

          // 还原 Soul.md性格设定
          fs.writeFileSync(join(charDir, 'Soul.md'), (char.soul || '').trim(), 'utf8');

          // 还原 Appearance.md外貌设定
          const appearanceContent = `### Appearance Tags\n${(char.appearance || '').trim()}\n`;
          fs.writeFileSync(join(charDir, 'Appearance.md'), appearanceContent, 'utf8');

          // 还原 meta.json
          const meta = {
            name: char.name,
            gender: char.gender || '未知',
            age: char.age || '',
            isUserPersona: !!char.isUserPersona,
          };
          fs.writeFileSync(join(charDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
        }
      }

      // 5. 组装并保存新的 theme.json (重写新 ID)
      const themeConfig: TheaterThemeConfig = {
        id: newThemeId,
        name: originalTheme.name,
        description: originalTheme.description || originalTheme.scenario?.substring(0, 100) + '...' || '',
        world_settings: originalTheme.world_settings || '',
        scenario: originalTheme.scenario || '',
        status_bars: originalTheme.status_bars || [],
        relations: originalTheme.relations || [],
      };
      fs.writeFileSync(join(themeDir, 'theme.json'), JSON.stringify(themeConfig, null, 2), 'utf8');

      // 6. 将新题材快速索引同步到 SQLite 缓存
      const db = getDatabaseService();
      db.db
        .prepare(
          `
        INSERT INTO TheaterThemes (id, name, description, folder_name, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          folder_name = excluded.folder_name
      `,
        )
        .run(newThemeId, themeConfig.name, themeConfig.description || '', newThemeId, Date.now());

      console.log(`[TheaterService] 剧本题材 [${themeConfig.name}] 成功导入并自愈分配 ID: ${newThemeId}`);
      return { success: true, id: newThemeId };
    } catch (err: any) {
      console.error(`[TheaterService] 导入剧本包失败:`, err);
      return { success: false, error: err.message || err };
    }
  }
}
