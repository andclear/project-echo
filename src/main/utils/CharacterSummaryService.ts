import * as fs from 'fs';
import * as path from 'path';
import { ModelAdapter, ModelConfig, ChatMessage } from '../models/ModelAdapter';
import { getDatabaseService } from '../db/database';
import { CharacterStorageManager } from './CharacterStorageManager';
import { UserProfileReaderWriter } from './UserProfileReaderWriter';

/**
 * CharacterSummaryService
 * 负责角色核心设定总结 (Summary.md) 的动态生成、物理固化与自愈缓存读取。
 * 核心目标是提炼 100 字内的高清设定总结，用于在群聊拼接时注入，从常识层面根治跨次元行为穿帮。
 */
export class CharacterSummaryService {
  /**
   * 获取或异步生成 100 字内的设定总结
   * @param characterId 角色 ID
   * @param force 是否强制重刷 (例如初始导入或用户保存时)
   */
  public static async getOrGenerateSummary(characterId: string, force: boolean = false): Promise<string> {
    try {
      const storageManager = new CharacterStorageManager();
      const speakerDir = path.join(storageManager.getBaseDir(), characterId);
      const summaryPath = path.join(speakerDir, 'Summary.md');
      const soulPath = path.join(speakerDir, 'Soul.md');
      const worldPath = path.join(speakerDir, 'World.md');

      // 1. 若不需要强制重刷，且文件存在且内容不为空，则极速秒读静态缓存
      if (!force && fs.existsSync(summaryPath)) {
        const content = fs.readFileSync(summaryPath, 'utf-8').trim();
        if (content) {
          return content;
        }
      }

      // 2. 若文件缺失、为空或需要强制重刷，则触发大模型自动总结提炼
      console.log(`[SummaryService] 开始为角色 ${characterId} 提炼核心人设总结 (Force: ${force})...`);

      let soulContent = '';
      let worldContent = '';
      if (fs.existsSync(soulPath)) {
        soulContent = fs.readFileSync(soulPath, 'utf-8').trim();
      }
      if (fs.existsSync(worldPath)) {
        worldContent = fs.readFileSync(worldPath, 'utf-8').trim();
      }

      // 如果人设和世界设定都为空，直接返回空总结并写入
      if (!soulContent && !worldContent) {
        if (!fs.existsSync(speakerDir)) {
          fs.mkdirSync(speakerDir, { recursive: true });
        }
        fs.writeFileSync(summaryPath, '', 'utf-8');
        return '';
      }

      // 3. 读取全局模型配置构造适配器
      const db = getDatabaseService();
      const configStr = db.getSetting('model_config');
      if (!configStr) {
        throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！');
      }

      const settings = JSON.parse(configStr);
      const modelAdapter = new ModelAdapter(
        settings.primary,
        settings.enableSecondary && settings.secondary ? settings.secondary : undefined
      );

      // 4. 组装高精度 100 字核心设定总结 Prompt
      const summarizePrompt = `你是一个专业的人设总结大师。请你仔细阅读以下角色的核心人设设定 (Soul.md) 以及其所处的背景世界观设定 (World.md)。
请用最精炼、准确且富有该角色性格特质的第三人称陈述，为该角色归纳总结出一份极简的设定总结。

【严格限制】：
1. 字数必须严格控制在 100 字以内！请写得极其简练。不要使用多余的长篇大论，直接用最凝练的语言收尾。
2. 总结应包含：角色的核心身份定位、为人处事基调、以及其世界观常识背景。
3. 请不要在文中刻意强调空间限制，仅客观生动地描述其是一个什么样的人。
4. 你必须完全使用简体中文进行回答，并且不要说任何诸如“这是总结”等引言或废话，直接输出总结正文！

--- 角色的核心性格设定 (Soul.md) ---
${soulContent || '（无性格人设设定）'}

--- 角色的世界观设定 (World.md) ---
${worldContent || '（无世界观背景设定）'}`;

      const chatMessages: ChatMessage[] = [
        { role: 'user', content: summarizePrompt }
      ];

      // 5. 调用主大模型进行提炼
      const response = await modelAdapter.chat(chatMessages, { usePrimary: true });
      let finalSummary = (response.content || '').trim();

      // 清洗大模型可能包裹的 markdown 代码外套
      finalSummary = this.cleanMarkdownBlock(finalSummary);

      // 6. 将最终提炼的极简设定总结持久化存盘入 Summary.md
      if (!fs.existsSync(speakerDir)) {
        fs.mkdirSync(speakerDir, { recursive: true });
      }
      const userName = UserProfileReaderWriter.getUserNameByFolder(characterId);
      const processedSummary = UserProfileReaderWriter.replaceUserNameToPlaceholder(finalSummary, userName);
      fs.writeFileSync(summaryPath, processedSummary, 'utf-8');
      console.log(`[SummaryService] 角色 ${characterId} 核心总结提炼存盘成功！内容: "${processedSummary}"`);

      return finalSummary;
    } catch (error: any) {
      console.error(`[SummaryService] 提炼角色 ${characterId} 总结异常:`, error);
      // 容错兜底：若生成失败且文件有旧内容，则保留读取旧内容；否则返回空
      return '';
    }
  }

  /**
   * 去除 ```markdown ... ``` 等标记
   */
  private static cleanMarkdownBlock(text: string): string {
    let cleaned = text.trim();
    if (cleaned.startsWith('```markdown')) {
      cleaned = cleaned.substring(11);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.substring(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
    return cleaned.trim();
  }
}
