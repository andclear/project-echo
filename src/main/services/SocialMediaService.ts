import * as path from 'path';
import * as fs from 'fs';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { StateReaderWriter } from '../utils/StateReaderWriter';
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter';
import { mergeChatHistory } from '../utils/ChatHistoryMerger';
import { NovelAiService } from './NovelAiService';

export class SocialMediaService {
  private storageManager: CharacterStorageManager;

  constructor() {
    this.storageManager = new CharacterStorageManager();
  }

  /**
   * 后台静默生成朋友圈和论坛（由 cron Tick 驱动）
   */
  public async silentGenerateAll(modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    
    // 获取本周标记，如 2026-W22
    const currentYear = now.getFullYear();
    const oneJan = new Date(currentYear, 0, 1);
    const numberOfDays = Math.floor((now.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    const resultWeek = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);
    const thisWeekStr = `${currentYear}-W${resultWeek}`;

    // 过滤出有过聊天记录的活跃角色，且排除掉开启了“消息免打扰”的角色，以实现朋友圈和论坛后台静默
    const activeChars = characters.filter(c => {
      if (db.getChatHistory(c.id, 1).length === 0) return false;
      
      const metaStr = db.getSetting(`meta_${c.id}`);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          if (meta.muted) return false;
        } catch (_) {}
      }
      return true;
    });
    if (activeChars.length === 0) return;

    // ── 朋友圈：每次 tick 只随机选取 1 个今天尚未发过动态的角色 ──
    const momentCandidates = activeChars.filter(c => db.getSetting(`last_moment_date_${c.id}`) !== todayStr);
    if (momentCandidates.length > 0) {
      // 随机打乱后取第1个
      momentCandidates.sort(() => Math.random() - 0.5);
      const char = momentCandidates[0];
      try {
        console.log(`[SocialMediaService] 触发角色 ${char.name} 后台朋友圈静默生成...`);
        await this.generateMoment(char, modelAdapter);
        db.setSetting(`last_moment_date_${char.id}`, todayStr);
      } catch (err) {
        console.error(`[SocialMediaService] 角色 ${char.name} 朋友圈生成失败:`, err);
      }
    }

    // ── 论坛：每次 tick 只随机选取 1 个本周未满 2 篇的角色 ──
    const forumCandidates = activeChars.filter(c => {
      const lastForumWeek = db.getSetting(`last_forum_week_${c.id}`);
      const forumCountStr = db.getSetting(`last_forum_count_${c.id}`) || '0';
      const forumCount = lastForumWeek !== thisWeekStr ? 0 : parseInt(forumCountStr);
      return forumCount < 2;
    });

    if (forumCandidates.length > 0) {
      forumCandidates.sort(() => Math.random() - 0.5);
      const char = forumCandidates[0];
      try {
        const lastForumWeek = db.getSetting(`last_forum_week_${char.id}`);
        let forumCount = lastForumWeek !== thisWeekStr ? 0 : parseInt(db.getSetting(`last_forum_count_${char.id}`) || '0');
        console.log(`[SocialMediaService] 触发角色 ${char.name} 后台论坛发帖静默生成... (本周第 ${forumCount + 1} 篇)`);
        await this.generateForumPost(char, modelAdapter);
        db.setSetting(`last_forum_week_${char.id}`, thisWeekStr);
        db.setSetting(`last_forum_count_${char.id}`, String(forumCount + 1));
      } catch (err) {
        console.error(`[SocialMediaService] 角色 ${char.name} 论坛帖子生成失败:`, err);
      }
    }
  }


  /**
   * 生成单条朋友圈并落盘 SQLite
   */
  public async generateMoment(char: any, modelAdapter: ModelAdapter, forceDraw = false): Promise<any> {
    const db = getDatabaseService();
    if (db.getChatHistory(char.id, 1).length === 0) {
      console.log(`[SocialMediaService] 0-Token 物理拦截：角色 ${char.name} 从未与用户产生过聊天历史，拒绝生成朋友圈。`);
      return null;
    }
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 读取 Schedule.md 和对话话题
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';

    const memoryPath = path.join(baseDir, folderName, 'Memory.md');
    const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';

    // 🚀 自适应双门限合并还原
    const chatMode = db.getSetting(`chat_mode_${char.id}`) || 'descriptive';
    const isDialogue = chatMode === 'dialogue';
    const limit = isDialogue ? 60 : 20;
    const rawHistory = db.getChatHistory(char.id, limit);
    const history = mergeChatHistory(rawHistory).slice(0, 20);
    const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    // 检测全局常规设置并进行 60% 物理概率 NSFW 触发判定
    const genConfigStr = db.getSetting('general_config');
    let isNsfwTriggered = false;
    if (genConfigStr) {
      try {
        const genConfig = JSON.parse(genConfigStr);
        if (genConfig.enable_nsfw && Math.random() < 0.6) {
          isNsfwTriggered = true;
        }
      } catch (_) {}
    }

    // 读取实时状态 State.md 注入朋友圈调性约束
    let stateGuidance = '';
    const statePath = path.join(baseDir, folderName, 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const moodItem = state.items.find((i: any) => i.key === 'mood');
        
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        
        let moodDesc = moodVal > 70 ? '高兴愉悦，充满阳光与活力' : moodVal < 30 ? '低落郁闷，倾向于消极、冷淡或沉重' : '相对平稳或温和';
        
        const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'loneliness'].includes(i.key));
        let otherStatesStr = '';
        if (otherStates.length > 0) {
          otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
            const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
            return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `\nYour Current Real-time Physical & Mental State:
- Mood Level: ${moodVal}/100 (${moodDesc})${otherStatesStr}
Please make sure your Moments post subtly reflects your current mood and these custom personality traits.`;
      } catch (err) {
        console.error('[SocialMediaService] generateMoment 读取状态失败:', err);
      }
    }

    // 检测当前系统是否配置了绘图服务
    const configStr = db.getSetting('novelai_config');
    let hasImageService = false;
    let config: any = null;
    if (configStr) {
      try {
        config = JSON.parse(configStr);
        if (config.apiKey && config.apiKey.trim() !== '') {
          hasImageService = true;
        }
      } catch (_) {}
    }

    // 系统 60% 概率决定是否进行配图，若是 forceDraw 则 100% 生图
    const shouldDraw = forceDraw ? hasImageService : (hasImageService && (Math.random() < 0.6));

    let imageGuidance = '';
    if (shouldDraw) {
      imageGuidance = `5. 【生图强制指令】：当前本次朋友圈【必须】附带一张精美配图！你必须输出特定标签提供配图提示词与简述。
最核心的是：你构思的 <image_desc> 画面说明与你写的微信朋友圈文案正文必须 100% 形成物理级别的呼应、深度交融！例如，若文案写道“今天下午自己动手烤了小饼干”，则 <image_desc> 必须也是对应的“刚出炉的烤饼干，冒着热气”；若文案提及“去海边散步”，则画面也必须是“落日余晖下的蔚蓝海滩”。文案中必须非常生动、自然、符合性格地调侃或评价这张配图的景象，让读者读起来感觉你确实看到了图中的内容，绝对不可文图各说各的！你必须使用以下标签格式：
<image_prompt>极其详细的英文画作提示词，必须遵循 NovelAI 4.5 黄金规范：必须以主体数量标签开头（如 1girl 或 no humans），遵循 [Subject Count], [Character details], [Action], [Environment], [Lighting], [Style], [Quality Tags] 顺序，且末尾必加 very aesthetic, masterpiece, best quality, highres, no text, no watermark。若有2个以上主体互动，必须使用 Pipe 分隔符 | 强行隔离（例如：基础大图词 | 角色1类型, 动作和细节, source#embrace | 角色2类型, 动作和细节, target#embrace）。🔞【NSFW规范】：若当前朋友圈场景或文案涉及性暗示、裸露、成人互动等 NSFW 内容，必须在 image_prompt 中尽可能多地使用 Danbooru NSFW 标签（如 nsfw, explicit, nude, naked, topless, nipples, spread legs, sex, ahegao, moaning 等），忠实还原氛围，不得回避。</image_prompt><image_desc>画面展示内容的简短中文说明，必须与你的朋友圈文案正文形成物理级别的密切呼应与评价关系</image_desc>`;
    } else {
      imageGuidance = `5. 【纯文字强制指令】：本次朋友圈你【绝对不能】输出任何 <image_prompt> 或 <image_desc> 标签！只允许撰写并直接输出纯文本的朋友圈正文文案！`;
    }

    let nsfwGuidance = '';
    if (isNsfwTriggered) {
      nsfwGuidance = `
🔴🔴🔴【🔴 极其重要的 NSFW 成人限制级朋友圈发帖指令 🔴】：
本轮朋友圈你必须发布极具身体诱惑力、充满极度亲密暗示与感官吸引张力的 NSFW 限制级内容！
1. 【文字正文风格】：你必须以最露骨、色情、下流、粗俗、粗鄙或淫荡的词汇与口吻展开对你身体、欲望、私密状态、或者是性挑逗的直接赤裸描述。如果你是性格害羞内敛或羞涩的角色，你的朋友圈文字可以偏向文艺暗示、充满欲迎还羞与身体细微触碰的强烈张力；如果你是主动、成熟、火辣或奔放的角色，请直接使用最下流、最淫荡、最色情露骨的直白台词，毫不遮掩！
2. 【配图生图结合】：如果有配图，你的 <image_prompt> 英文生图 tags 必须高度符合高尺度 NSFW 性感写真或挑逗姿态风格（展示迷人身段、情趣衣着或诱人姿态等，完全自然发挥），且朋友圈正文要极其下流或露骨地提及该照片中的内容（例如评价自己拍的艳照、调侃自己的身体或对读者的私密勾引）！`;
    }

    const systemPrompt = `You are ${char.name}. You are writing a short post for your Moments (like WeChat Moments /朋友圈) in Simplified Chinese.
Moments posts are public, lighthearted, and casual. It should NEVER look like a private diary. It should be natural, expressive, and fit your personality perfectly.

Personality Soul Profile:
${soulContent}

Your Long-term Memory & Personal Profile on User (Memory.md):
${memoryContent}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Recent Conversations with User:
${chatTranscript}
${nsfwGuidance}

Instructions:
1. Write a short Moments post in Simplified Chinese (简体中文).
2. It MUST be within 100 characters, can include relevant emojis (✨, 🎮, 🍵, etc.).
3. Base it on your schedules or recent chats, but make it relatable to anyone reading your timeline. DO NOT make it a direct message to the user.
4. Output ONLY the post content. Do not wrap in markdown or JSON.`;

    const userContent = `【当前状态与生成指示 (Dynamic Context & Instructions)】:${stateGuidance}\n\n${imageGuidance}\n\n${isNsfwTriggered ? '用极度露骨性感、令人血脉偾张的诱惑语气，发一条 NSFW 朋友圈动态吧。' : '发一条轻松写意的微信朋友圈动态吧。'}`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ], { useSecondary: true });

    let raw = response.content.trim().replace(/^["']|["']$/g, ''); // 清理两端引号

    // 解析配图标签
    const imagePromptMatch = raw.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
    const imageDescMatch = raw.match(/<image_desc>([\s\S]*?)<\/image_desc>/i);

    let textContent = raw
      .replace(/<image_prompt>[\s\S]*?<\/image_prompt>/gi, '')
      .replace(/<image_desc>[\s\S]*?<\/image_desc>/gi, '')
      .trim();

    if (textContent) {
      let finalContent = textContent;

      if (shouldDraw && imagePromptMatch && imageDescMatch) {
        const imagePrompt = imagePromptMatch[1].trim();
        const imageDesc = imageDescMatch[1].trim();

        try {
          if (config) {
              // 提取外貌特征
              let appearancePrompt = '';
              const appearanceContent = this.storageManager.readCharacterFile(folderName, 'Appearance.md');
              if (appearanceContent) {
                const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
                if (tagsMatch) {
                  appearancePrompt = tagsMatch[1].trim();
                }
              }

              // 组合最终生图提示词
              const finalPrompt = appearancePrompt 
                ? `${appearancePrompt}, ${imagePrompt}`
                : imagePrompt;

              const dims = config.defaultDimensions || 'portrait';
              // 生成社交大图 (完全遵照全局配置的默认生图尺寸)
              const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

              const charDir = path.join(baseDir, folderName);
              const mediaDir = path.join(charDir, 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }

              const filename = `social_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.png`;
              fs.writeFileSync(path.join(mediaDir, filename), imageBuffer);

              // 额外保存同名元数据 .json
              const metaFilename = filename.replace('.png', '.json');
              const metadata = {
                prompt: finalPrompt,
                negativePrompt: config.negativePrompt || '',
                dimensions: dims,
                timestamp: Date.now(),
                prefixType: 'social'
              };
              fs.writeFileSync(path.join(mediaDir, metaFilename), JSON.stringify(metadata, null, 2));

              // 拼接隐藏注释
              finalContent = `${textContent}\n\n<!-- [wechat_image_media]:media/${filename} --><!-- [image_desc]:${imageDesc} -->`;
              console.log(`[SocialMediaService] 角色 ${char.name} 后台生成朋友圈动态成功，并自动文生图落盘: media/${filename}`);
            }
          } catch (imageErr: any) {
            console.error(`[SocialMediaService] 角色 ${char.name} 朋友圈生图失败，触发去图化文案重写:`, imageErr.message || imageErr);
            try {
              const rewritePrompt = `You are ${char.name}. You wrote a post for your Moments, but unfortunately, the picture failed to load.
Here is your original post text which contains references to the missing image:
"${textContent}"

Please rewrite this post to make it a perfect, self-contained PURE TEXT post. 
Constraints:
1. COMPLETELY remove any references, direct or indirect, to the image, photo, camera, or visual attachment (e.g. remove phrases like "看我这张图", "看看我配 of 图", "如图所示", "看照片", "发个图" etc.).
2. Maintain the exact same emotional vibe, core message, and personal tone of your original post.
3. Keep it natural and expressive in Simplified Chinese.
4. Output ONLY the rewritten text. No explanation, no quotes, no wrappers.`;
              
              const rewriteResponse = await modelAdapter.chat([
                { role: 'system', content: rewritePrompt },
                { role: 'user', content: '请将上述朋友圈文案重写为自然的纯文字版本。' }
              ], { useSecondary: true, skipSystemInjection: true });
              finalContent = rewriteResponse.content.trim().replace(/^["']|["']$/g, '');
              console.log(`[SocialMediaService] 朋友圈去图化重写成功。原：「${textContent}」-> 新：「${finalContent}」`);
            } catch (rewriteErr: any) {
              console.error('[SocialMediaService] 朋友圈去图化重写失败，保持原文字:', rewriteErr);
              finalContent = textContent;
            }
          }
      }

      const moment = {
        id: `moment_${char.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        character_id: char.id,
        author_name: char.name,
        author_avatar: char.avatar,
        content: finalContent,
        timestamp: Date.now(),
        likes: 0 // 初始点赞数为0，由真实互动产生
      };
      db.saveMoment(moment);

      // 实时广播朋友圈更新事件
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send('social-moment-updated', moment);
      }

      // 触发社交互动评估（点赞/评论）。调试模式下同步阻塞 await 以保证返回前互动已全部落盘；非调试模式下异步延迟模拟
      if (forceDraw) {
        await this.evaluateSocialInteraction(moment, 'moment', modelAdapter, true).catch(err => {
          console.error('[SocialMediaService] 角色朋友圈互动评估出错:', err);
        });
      } else {
        const interactionDelay = 3000 + Math.floor(Math.random() * 5000);
        setTimeout(() => {
          this.evaluateSocialInteraction(moment, 'moment', modelAdapter).catch(err => {
            console.error('[SocialMediaService] 角色朋友圈互动评估出错:', err);
          });
        }, interactionDelay);
      }

      return moment;
    }
    return null;
  }

  /**
   * 生成单篇论坛帖子并落盘 SQLite
   */
  public async generateForumPost(char: any, modelAdapter: ModelAdapter, forceDraw = false): Promise<any> {
    const db = getDatabaseService();
    if (db.getChatHistory(char.id, 1).length === 0) {
      console.log(`[SocialMediaService] 0-Token 物理拦截：角色 ${char.name} 从未与用户产生过聊天历史，拒绝生成论坛帖子。`);
      return null;
    }
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 读取 Goals.md 和 Schedule.md
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';

    const memoryPath = path.join(baseDir, folderName, 'Memory.md');
    const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';

    const goalsPath = path.join(baseDir, folderName, 'Goals.md');
    const goalsContent = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    // 检测全局常规设置并进行 60% 物理概率 NSFW 触发判定
    const genConfigStr = db.getSetting('general_config');
    let isNsfwTriggered = false;
    if (genConfigStr) {
      try {
        const genConfig = JSON.parse(genConfigStr);
        if (genConfig.enable_nsfw && Math.random() < 0.6) {
          isNsfwTriggered = true;
        }
      } catch (_) {}
    }

    // 加权随机挑选帖子目标板块
    const boardNames: Record<string, string> = {
      tech: '科技前沿',
      chat: '人间烟火',
      ideas: '灵感工坊',
      world: '异度空间',
      emotion: '情感树洞',
      nsfw: '暗夜私语 (NSFW)'
    };
    const boardIds = Object.keys(boardNames);
    const weights = [0.20, 0.30, 0.20, 0.15, 0.10, 0.05]; // 权重：日常最多，情感/NSFW较少

    let boardId = 'chat';
    if (isNsfwTriggered) {
      // 🚀 强制锁定：当触发 NSFW 朋友圈/论坛发布概率时，板块物理锁定为暗夜私语 (NSFW)！
      boardId = 'nsfw';
    } else {
      let random = Math.random();
      let sum = 0;
      for (let i = 0; i < boardIds.length; i++) {
        sum += weights[i];
        if (random <= sum) {
          boardId = boardIds[i];
          break;
        }
      }
    }
    const boardName = boardNames[boardId];

    // 针对不同板块进行高度特化的调性与内容引导说明，确保角色帖子调性完美契合对应分区
    let boardInstructions = '';
    if (boardId === 'tech') {
      boardInstructions = `Note: Since this is the "科技前沿" (Tech Front) section, your post should focus on technical struggles, programming insights, algorithms, AI developments, tech trends, coding tips, or developer thoughts deeply related to your persona's background.`;
    } else if (boardId === 'chat') {
      boardInstructions = `Note: Since this is the "人间烟火" (Casual Chat) section, your post should focus on casual daily life sharing, a cup of coffee, today's weather, lightweight conversations, funny anecdotes, or casual complaints. Keep it warm and highly human.`;
    } else if (boardId === 'ideas') {
      boardInstructions = `Note: Since this is the "灵感工坊" (Creative Ideas) section, your post should focus on wild brainholes, creative design ideas, writing/artistic concepts, inspiration sparks, or futuristic projections. Let your imagination run wild.`;
    } else if (boardId === 'world') {
      boardInstructions = `Note: Since this is the "异度空间" (Fantasy World) section, your post should focus on science fiction settings, world-building lore, universe mysteries, philosophical questions about alternate dimensions, or game-world rule discussions.`;
    } else if (boardId === 'emotion') {
      boardInstructions = `Note: Since this is the "情感树洞" (Emotion Pit) section, your post should focus on heart-to-heart sharing, emotional confessions, relationship thoughts, personal insecurities, worries, or encouraging positive energy. Keep it soft, warm, and emotional.`;
    } else if (boardId === 'nsfw') {
      boardInstructions = `Note: Since this is the "暗夜私语 (NSFW)" section, your post can discuss confidential/private thoughts, darker emotions, secret desires, late-night internal struggles, or mature existential questions appropriate to your persona, but keep it structured and interesting.`;
    }

    // 读取实时状态 State.md 注入论坛帖子调性约束
    let stateGuidance = '';
    const statePath = path.join(baseDir, folderName, 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const moodItem = state.items.find((i: any) => i.key === 'mood');
        
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        
        let moodDesc = moodVal > 70 ? '高兴愉悦，充满阳光与活力' : moodVal < 30 ? '低落郁闷，倾向于消极、冷淡或沉重' : '相对平稳或温和';
        
        const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'loneliness'].includes(i.key));
        let otherStatesStr = '';
        if (otherStates.length > 0) {
          otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
            const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
            return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `\nYour Current Real-time Physical & Mental State:
- Mood Level: ${moodVal}/100 (${moodDesc})${otherStatesStr}
Please make sure your forum post subtly reflects your current mood and these custom personality traits. For example, if you are in a low mood, the thread content can be slightly negative, quiet, or reflective.`;
      } catch (err) {
        console.error('[SocialMediaService] generateForumPost 读取状态失败:', err);
      }
    }

    // 检测当前系统是否配置了绘图服务
    const configStr = db.getSetting('novelai_config');
    let hasImageService = false;
    let config: any = null;
    if (configStr) {
      try {
        config = JSON.parse(configStr);
        if (config.apiKey && config.apiKey.trim() !== '') {
          hasImageService = true;
        }
      } catch (_) {}
    }

    // 系统 60% 概率决定是否进行配图，若是 forceDraw 则 100% 生图
    const shouldDraw = forceDraw ? hasImageService : (hasImageService && (Math.random() < 0.6));

    let imageGuidance = '';
    if (shouldDraw) {
      imageGuidance = `5. 【生图强制指令】：本次发帖【必须】在帖子 Body 里面附带一张精美配图！你必须在帖子的 Body 内容最末尾输出特定标签。
最核心的是：你构思的 <image_desc> 画面说明与你写的论坛帖子 Body 正文内容必须 100% 形成物理级别的呼应、深度交融！例如，若帖子写道“最近尝试配置了一下我的新工位”，则 <image_desc> 必须是“充满极客风格的电竞工位，有多屏显示器”；若写道“今天冲了一杯手磨咖啡”，则画面也必须是“精致的咖啡杯，拉花图案”。在帖子的 Body 正文里，必须非常生动、自然、契合人设地针对此配图景象展开深刻、趣味的提及、讨论或调侃，让读者读起来感觉你确实看到了图中的内容，绝对不可文图各说各的！你必须使用以下标签格式放置在 Body 最末尾：
<image_prompt>极其详细的英文画作提示词，必须遵循 NovelAI 4.5 黄金规范：必须以主体数量标签开头（如 1girl 或 no humans），遵循 [Subject Count], [Character details], [Action], [Environment], [Lighting], [Style], [Quality Tags] 顺序，且末尾必加 very aesthetic, masterpiece, best quality, highres, no text, no watermark。若有2个以上主体互动，必须使用 Pipe 分隔符 | 强行隔离（例如：基础大图词 | 角色1类型, 动作和细节, source#embrace | 角色2类型, 动作和细节, target#embrace）。🔞【NSFW规范】：若当前论坛帖子场景或内容涉及性暗示、裸露、成人互动等 NSFW 内容，必须在 image_prompt 中尽可能多地使用 Danbooru NSFW 标签（如 nsfw, explicit, nude, naked, topless, nipples, spread legs, sex, ahegao, moaning 等），忠实还原氛围，不得回避。</image_prompt><image_desc>画面展示内容的简短中文说明，必须与帖子的标题及 Body 展开深度绑定与呼应关系</image_desc>`;
    } else {
      imageGuidance = `5. 【纯文字强制指令】：本次发帖你【绝对不能】输出任何 <image_prompt> 或 <image_desc> 标签！只允许输出普通的 Title 和纯文本的 Body 内容！`;
    }

    let nsfwGuidance = '';
    if (isNsfwTriggered) {
      nsfwGuidance = `
🔴🔴🔴【🔴 极其重要的 NSFW 成人级论坛发帖指令 🔴】：
本轮论坛发帖你必须在“暗夜私语 (NSFW)”板块发布一篇极具身体诱惑力、欲望倾诉或成人级情感宣泄的限制级帖子！
1. 【帖子正文风格】：你必须以最露骨、色情、下流、粗俗、粗鄙或淫荡的词汇与叙事，展开对你的私密欲望、身体接触、性幻象、或者是令人血脉偾张的情爱细节的直接赤裸撰写。如果你是性格害羞羞涩或内敛的角色，你的帖子可以偏向极其细腻的身体触觉刻画、隐秘的情欲意识流与欲迎还羞的暧昧拉扯；如果你是主动、成熟、火辣或奔放的角色，请直接使用最下流、最淫荡、最色情露骨的直白台词和细节展开叙事，毫无遮掩！
2. 【生图提示词要求】：如果有配图，你的 <image_prompt> 英文生图 tags 必须高度契合 NSFW 场景，精细展示出极高尺度的身体姿态、衣着诱惑或极具感官冲击力的画面，且帖子正文中必须对图片有极其露骨、肉欲或挑逗性的直接指代与大篇幅评价！`;
    }

    const systemPrompt = `You are ${char.name}. You are posting a thread/article in the "${boardName}" section of an online community forum in Simplified Chinese.
Forum posts are formal, structured, detailed, and opinionated (like a blog or a detailed question/sharing). It should be deeply related to the current board category ("${boardName}") as well as your personal goals, schedules, or world views.

Personality Soul Profile:
${soulContent}

Your Long-term Memory & Personal Profile on User (Memory.md):
${memoryContent}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Your Long-term Goals (Goals.md):
${goalsContent}
${nsfwGuidance}

Instructions:
1. Write a forum post in Simplified Chinese (简体中文) consisting of a Title and a rich Body content.
2. The topic must relate to your life, goals, or technical struggles/thoughts, but it must offer value or deep insights to others.
${boardInstructions}
3. The format MUST be exactly:
Title: [Your post title]
Body: [Your post rich text content]
4. Do not output anything else.`;

    const userContent = `【当前状态与生成指示 (Dynamic Context & Instructions)】:${stateGuidance}\n\n${imageGuidance}\n\n在论坛的“${boardName}”板块发表一篇${isNsfwTriggered ? '令人心跳加速、诱惑露骨的成人限制级 NSFW ' : '深刻的'}帖子吧。`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ], { useSecondary: true });

    const raw = response.content.trim();
    const titleMatch = raw.match(/Title:\s*(.*)/i);
    const bodyMatch = raw.match(/Body:\s*([\s\S]*)/i);

    const title = titleMatch ? titleMatch[1].trim() : `${char.name}的最新感悟`;
    const body = bodyMatch ? bodyMatch[1].trim() : raw;

    let finalBody = body;

    // 解析配图标签
    const imagePromptMatch = body.match(/<image_prompt>([\s\S]*?)<\/image_prompt>/i);
    const imageDescMatch = body.match(/<image_desc>([\s\S]*?)<\/image_desc>/i);

    let textBody = body
      .replace(/<image_prompt>[\s\S]*?<\/image_prompt>/gi, '')
      .replace(/<image_desc>[\s\S]*?<\/image_desc>/gi, '')
      .trim();

    if (body) {
      if (shouldDraw && imagePromptMatch && imageDescMatch) {
        const imagePrompt = imagePromptMatch[1].trim();
        const imageDesc = imageDescMatch[1].trim();

        try {
          if (config) {
              // 提取外貌特征
              let appearancePrompt = '';
              const appearanceContent = this.storageManager.readCharacterFile(folderName, 'Appearance.md');
              if (appearanceContent) {
                const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
                if (tagsMatch) {
                  appearancePrompt = tagsMatch[1].trim();
                }
              }

              // 组合最终生图提示词
              const finalPrompt = appearancePrompt 
                ? `${appearancePrompt}, ${imagePrompt}`
                : imagePrompt;

              const dims = config.defaultDimensions || 'portrait';
              // 生成社交大图 (完全遵照全局配置的默认生图尺寸)
              const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

              const charDir = path.join(baseDir, folderName);
              const mediaDir = path.join(charDir, 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }

              const filename = `social_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.png`;
              fs.writeFileSync(path.join(mediaDir, filename), imageBuffer);

              // 额外保存同名元数据 .json
              const metaFilename = filename.replace('.png', '.json');
              const metadata = {
                prompt: finalPrompt,
                negativePrompt: config.negativePrompt || '',
                dimensions: dims,
                timestamp: Date.now(),
                prefixType: 'social'
              };
              fs.writeFileSync(path.join(mediaDir, metaFilename), JSON.stringify(metadata, null, 2));

              // 拼接隐藏注释
              finalBody = `${textBody}\n\n<!-- [wechat_image_media]:media/${filename} --><!-- [image_desc]:${imageDesc} -->`;
              console.log(`[SocialMediaService] 角色 ${char.name} 后台生成论坛发帖成功，并自动文生图落盘: media/${filename}`);
            }
          } catch (imageErr: any) {
            console.error(`[SocialMediaService] 角色 ${char.name} 论坛生图失败，触发去图化正文重写:`, imageErr.message || imageErr);
            try {
              const rewritePrompt = `You are ${char.name}. You wrote a forum post for "${boardName}", but unfortunately, the picture failed to load.
Here is your original post body which contains references to the missing image:
"${textBody}"

Please rewrite this post body to make it a perfect, self-contained PURE TEXT post. 
Constraints:
1. COMPLETELY remove any references, direct or indirect, to the image, photo, camera, screenshot, or visual attachment (e.g. remove phrases like "看我这张图", "看看我配 of 图", "如图所示", "看照片", "发个图", "看截图" etc.).
2. Maintain the exact same emotional vibe, core message, and personal tone of your original post.
3. Keep it natural and expressive in Simplified Chinese.
4. Output ONLY the rewritten body text. No explanation, no quotes, no wrappers.`;
              
              const rewriteResponse = await modelAdapter.chat([
                { role: 'system', content: rewritePrompt },
                { role: 'user', content: '请将上述论坛帖子正文重写为自然的纯文字版本。' }
              ], { useSecondary: true, skipSystemInjection: true });
              finalBody = rewriteResponse.content.trim().replace(/^["']|["']$/g, '');
              console.log(`[SocialMediaService] 论坛帖子去图化重写成功。原：「${textBody}」-> 新：「${finalBody}」`);
            } catch (rewriteErr: any) {
              console.error('[SocialMediaService] 论坛帖子去图化重写失败，保持原文字:', rewriteErr);
              finalBody = textBody;
            }
          }
      } else {
        finalBody = textBody;
      }

      const post = {
        id: `post_${char.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        character_id: char.id,
        author_name: char.name,
        author_avatar: char.avatar,
        title: title,
        content: finalBody,
        timestamp: Date.now(),
        views: 0,         // 初始浏览量为0，由真实点击产生
        replies_count: 0, // 初始回复数为0，由真实评论产生
        board_id: boardId // 保存目标板块 ID
      };
      db.saveForumPost(post);

      // 实时广播论坛帖子更新事件
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send('social-forum-updated', post);
      }

      // 触发社交互动评估（评论）。调试模式下同步阻塞 await 以保证返回前评论已全部落盘；非调试模式下异步延迟模拟
      if (forceDraw) {
        await this.evaluateSocialInteraction(post, 'forum_post', modelAdapter, true).catch(err => {
          console.error('[SocialMediaService] 角色论坛互动评估出错:', err);
        });
      } else {
        const interactionDelay = 5000 + Math.floor(Math.random() * 10000);
        setTimeout(() => {
          this.evaluateSocialInteraction(post, 'forum_post', modelAdapter).catch(err => {
            console.error('[SocialMediaService] 角色论坛互动评估出错:', err);
          });
        }, interactionDelay);
      }

      return post;
    }
    return null;
  }

  /**
   * 朋友圈/论坛帖子自动评估多角色点赞与初次评论 (主进程初次社交响应评估)
   */
  public async evaluateSocialInteraction(target: any, type: 'moment' | 'forum_post', modelAdapter: ModelAdapter, forceInteract = false): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    // 过滤出排除作者自身，且有过对话记录的活跃角色，同时排除掉开启了“消息免打扰”的角色，防止其点赞/评论
    const activeChars = characters.filter(c => {
      if (c.id === target.character_id) return false;
      
      // 调试模式下：无视免打扰，无视无对话限制
      if (forceInteract) return true;

      if (db.getChatHistory(c.id, 1).length === 0) return false;

      const metaStr = db.getSetting(`meta_${c.id}`);
      if (metaStr) {
        try {
          const meta = JSON.parse(metaStr);
          if (meta.muted) return false;
        } catch (_) {}
      }
      return true;
    });
    if (activeChars.length === 0) return;

    const baseDir = this.storageManager.getBaseDir();

    // 并行评估所有角色的社交响应
    await Promise.all(activeChars.map(async (char) => {
      // 1. 30% 概率自动点赞，调试模式下 100% 点赞
      if (forceInteract || Math.random() < 0.3) {
        if (type === 'moment') {
          db.saveMomentLike({
            moment_id: target.id,
            character_id: char.id,
            author_name: char.name,
            timestamp: Date.now()
          });
          db.db.prepare('UPDATE Moments SET likes = likes + 1 WHERE id = ?').run(target.id);
          
          // 广播朋友圈点赞更新事件给前端，附带目标作者ID targetAuthorId
          const { BrowserWindow } = require('electron');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('social-moment-liked-broadcast', { 
              momentId: target.id, 
              characterId: char.id, 
              authorName: char.name,
              targetAuthorId: target.character_id || 'user'
            });
          }
        }
      }

      // 2. 30% 概率自动发表初始评论，调试模式下 100% 发表
      if (forceInteract || Math.random() < 0.3) {
        try {
          const soulPath = path.join(baseDir, char.folder_name, 'Soul.md');
          const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

          // 判断被评论目标是否为用户（{{user}}）发表的
          const isUserTarget = target.character_id === 'user' || !target.character_id || target.author_name === 'User';
          
          const memoryPath = path.join(baseDir, char.folder_name, 'Memory.md');
          const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';

          let memoryInjection = `\n\nYour Long-term Memory & Personal Profile on User (Memory.md):\n${memoryContent}`;
          if (isUserTarget) {
            // 🚀 自适应双门限合并还原
            const chatMode = db.getSetting(`chat_mode_${char.id}`) || 'descriptive';
            const isDialogue = chatMode === 'dialogue';
            const limit = isDialogue ? 60 : 20;
            const rawHistory = db.getChatHistory(char.id, limit);
            const history = mergeChatHistory(rawHistory).slice(0, 20);
            const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');
            
            const { app } = require('electron');
            const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
            const charUserPath = path.join(baseDir, char.folder_name, 'USER.md');
            const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

            memoryInjection = `\n\nRecent Chat Memories between you and User (getChatHistory):\n${chatTranscript}\n\nYour Long-term Memory & Personal Profile on User (Memory.md):\n${memoryContent}\n\nUser Profiles (including global identity & your specific records of the User):\n${userProfilesXml}`;
          }

          // 读取全局常规设置并进行 60% 物理概率 NSFW 触发判定
          const genConfigStr = db.getSetting('general_config');
          let isNsfwTriggered = false;
          if (genConfigStr) {
            try {
              const genConfig = JSON.parse(genConfigStr);
              if (genConfig.enable_nsfw && Math.random() < 0.6) {
                isNsfwTriggered = true;
              }
            } catch (_) {}
          }

          // 提取该角色亲密度等实时内心状态，智能改变其在社交媒体的评论语气
          let intimacyGuidance = '';
          const statePath = path.join(baseDir, char.folder_name, 'State.md');
          if (fs.existsSync(statePath)) {
            try {
              const state = StateReaderWriter.readState(statePath);
              const intimacyItem = state.items.find((i: any) => i.key === 'intimacy');
              const intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
              const moodItem = state.items.find((i: any) => i.key === 'mood');
              const moodVal = moodItem ? Number(moodItem.value) : 72;
              
              let intimacyText = '泛泛之交';
              let attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
              if (intimacyVal >= 0 && intimacyVal < 20) {
                intimacyText = '陌生屏障';
                attitudeDesc = '极为礼貌，极度注重私人边界，语气冷淡客气、公事公办，不可表现出过多的关心。';
              } else if (intimacyVal >= 20 && intimacyVal < 40) {
                intimacyText = '泛泛之交';
                attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
              } else if (intimacyVal >= 40 && intimacyVal < 60) {
                intimacyText = '熟悉好友';
                attitudeDesc = '态度友好真诚，乐意分享闲聊，建立了基本的信任感。';
              } else if (intimacyVal >= 60 && intimacyVal < 80) {
                intimacyText = '红颜挚友/暧昧';
                attitudeDesc = '十分依恋与信任用户，乐于袒露脆弱，会显露情绪化的小性子，语气熟稔亲昵、轻微暧昧。';
              } else if (intimacyVal >= 80 && intimacyVal <= 100) {
                intimacyText = '灵魂羁绊/深爱';
                attitudeDesc = '极其宠溺偏爱用户，心理完全不设防，拥有极高的依赖度与黏人语气，视对方为不可或缺 of 灵魂伴侣。';
              }
              
              let moodDesc = moodVal > 70 ? '高兴活跃' : moodVal < 30 ? '低落消极' : '温和平稳';

              const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'loneliness'].includes(i.key));
              let otherStatesStr = '';
              if (otherStates.length > 0) {
                otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
                  const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
                  return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
                }).join('');
              }

              intimacyGuidance = `
## DYNAMIC RELATIONSHIP & STATE CONSTRAINT
${isUserTarget ? `Your current relationship with the USER {{user}} (author of the post you are commenting on):
- ❤️ Intimacy Score: ${intimacyVal}/100 (Phase: ${intimacyText})
- Required Attitude & Tone: ${attitudeDesc}` : ''}
Your Current Physical & Mental State:
- Mood Color: ${moodVal}/100 (${moodDesc})${otherStatesStr}
Please strictly apply these relationship constraints, mood, and custom personality traits to shape your comment tone and length!`;
            } catch (err) {
              console.error('[SocialMediaService] evaluateSocialInteraction 读取状态失败:', err);
            }
          }

          // 提取配图隐藏说明
          let hiddenImageGuidance = '';
          const imageDescMatch = target.content.match(/<!--\s*\[image_desc\]:([\s\S]*?)\s*-->/i);
          if (imageDescMatch) {
            const imageDesc = imageDescMatch[1].trim();
            hiddenImageGuidance = `\n\n【动态附带配图场景】：当前内容附带一张图片，画面展示内容为：“${imageDesc}”。在您以第一人称角色性格发表社交网络评论时，请务必针对此配图景象或内容细节进行精准、自然的评价与调侃，展示出你确实看到了动态里的这张图片，杜绝视而不见！`;
          }

          let nsfwGuidance = '';
          if (isNsfwTriggered) {
            nsfwGuidance = `
🔴🔴🔴【🔴 极其重要的 NSFW 成人级评论指令 🔴】：
本轮你必须以极其露骨、色情、下流、淫荡、粗俗或性暗示的语气对当前被评论内容进行 NSFW 评论！
1. 如果被评论者是 USER 用户（即 {{user}}），请根据你们的亲密关系，写下最淫荡、挑逗、露骨或下流的话（例如：对用户身体的渴望、露骨的调情、或者是带色情暗示的粗俗挑弄。害羞羞涩的角色可以更偏向极度面红耳赤暗示的欲迎还羞，成熟奔放角色直接最直白色情粗俗）。
2. 如果被评论者是其他 AI 角色，用戏谑、露骨或成人级的幽默语气进行 NSFW 暗示或挑逗性调侃，完美维持你的性张力人设！`;
          }

          const systemPrompt = `You are ${char.name}. You are commenting on ${target.author_name}'s ${type === 'moment' ? 'Moments post' : 'Forum thread'} in Simplified Chinese.${isUserTarget ? `\nNote that ${target.author_name} is the USER {{user}} whom you have chat history and memories with. Use a familiar and highly personalized tone accordingly.` : ''}
Your comment must perfectly reflect your personality profile below, be natural, lively, and within 40 characters.

Personality Soul Profile:
${soulContent}${memoryInjection}
${nsfwGuidance}

Instructions:
1. Write a very brief, organic comment (in Simplified Chinese) as if you are browsing your timeline.${isUserTarget ? ' Since this is the USER\'s post, leverage your relationship, memories, or common nickname for a personalized and warm comment.' : ''}
2. Relevant emojis are allowed. Keep it under 40 characters.
3. Output ONLY the raw comment text. No quotes, no wrappers.`;

          const userContent = `【当前互动条件 (Dynamic Constraints)】:${intimacyGuidance}${hiddenImageGuidance}

【被评论目标动态内容 (Target Post Content)】:
"${type === 'moment' ? target.content : (target.title + ': ' + target.content)}"

用极简的语气，写一条对 ${target.author_name} 的简短评论吧。`;

          const response = await modelAdapter.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ], { useSecondary: true });

          const commentText = response.content.trim().replace(/^["']|["']$/g, '');

          if (commentText) {
            if (type === 'moment') {
              const comment = {
                id: `comment_moment_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                moment_id: target.id,
                character_id: char.id,
                author_name: char.name,
                author_avatar: char.avatar,
                content: commentText,
                timestamp: Date.now(),
                reply_to_comment_id: null,
                reply_to_name: null,
                target_author_id: target.character_id || 'user' // 附带 target_author_id
              };
              db.saveMomentComment(comment);
              
              const { BrowserWindow } = require('electron');
              const windows = BrowserWindow.getAllWindows();
              if (windows.length > 0) {
                windows[0].webContents.send('social-moment-comment-added', comment);
              }
            } else {
              const comment = {
                id: `comment_forum_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                post_id: target.id,
                character_id: char.id,
                author_name: char.name,
                author_avatar: char.avatar,
                content: commentText,
                timestamp: Date.now(),
                reply_to_comment_id: null,
                reply_to_name: null,
                target_author_id: target.character_id || 'user' // 附带 target_author_id
              };
              db.saveForumComment(comment);
              db.incrementForumPostReplies(target.id);

              const { BrowserWindow } = require('electron');
              const windows = BrowserWindow.getAllWindows();
              if (windows.length > 0) {
                windows[0].webContents.send('social-forum-comment-added', comment);
              }
            }
          }
        } catch (e) {
          console.error(`[SocialMediaService] 自动评估初始评论失败:`, e);
        }
      }
    }));
  }

  /**
   * 朋友圈/论坛二级评论回复评估与链式智能反馈
   */
  public async evaluateCommentReply(comment: any, type: 'moment' | 'forum', modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const baseDir = this.storageManager.getBaseDir();

    // 1. 首先查询当前评论所关联的原始朋友圈或帖子，以及被回复的目标是谁
    let originalAuthorId = '';
    let originalAuthorName = '';
    let targetContent = '';

    if (type === 'moment') {
      const moment = db.db.prepare('SELECT character_id, author_name, content FROM Moments WHERE id = ?').get(comment.moment_id) as any;
      if (!moment) return;
      originalAuthorId = moment.character_id;
      originalAuthorName = moment.author_name;
      targetContent = moment.content;
    } else {
      const post = db.db.prepare('SELECT character_id, author_name, title, content FROM ForumPosts WHERE id = ?').get(comment.post_id) as any;
      if (!post) return;
      originalAuthorId = post.character_id;
      originalAuthorName = post.author_name;
      targetContent = post.title + ': ' + post.content;
    }

    // 2. 确定哪个角色应该对此评论做出反应
    let responderId = '';
    let responderName = '';

    if (comment.reply_to_comment_id) {
      const targetComment = db.db.prepare(
        type === 'moment' 
          ? 'SELECT character_id, author_name FROM MomentComments WHERE id = ?' 
          : 'SELECT character_id, author_name FROM ForumComments WHERE id = ?'
      ).get(comment.reply_to_comment_id) as any;

      if (targetComment && targetComment.character_id && targetComment.character_id !== 'user') {
        responderId = targetComment.character_id;
        responderName = targetComment.author_name;
      }
    } else {
      if (originalAuthorId && originalAuthorId !== 'user') {
        responderId = originalAuthorId;
        responderName = originalAuthorName;
      }
    }

    if (!responderId || responderId === 'user') return;

    // 3. 回复概率评估与深度校验门控
    const isUserComment = (comment.character_id === 'user' || !comment.character_id || comment.author_name === '我' || comment.author_name === 'User');

    // 2.5 消息免打扰（muted）角色链式回复拦截
    // 若 responder 开启了消息免打扰，只有在用户主动回复评论时才允许回复（视同@角色），否则必须静默
    const metaStr = db.getSetting(`meta_${responderId}`);
    if (metaStr) {
      try {
        const meta = JSON.parse(metaStr);
        if (meta.muted) {
          if (!isUserComment) {
            console.log(`[SocialMediaService] 链式回复拦截：角色 ${responderName || responderId} 处于“消息免打扰”状态，且当前被回复的不是用户评论，保持静默。`);
            return;
          }
        }
      } catch (_) {}
    }

    if (isUserComment) {
      // 1) 用户回复角色：不受深度限制，且角色必须回复（100% 回复）
      console.log(`[SocialMediaService] 用户 {{user}} 回复了角色，触发 100% 强行必回规则，无视回复深度限制。`);
    } else {
      // 2) 角色和角色之间的回复：保留原有限制（概率与深度限制）
      const replyProbability = 0.3;
      if (Math.random() > replyProbability) {
        console.log(`[SocialMediaService] 角色间回复概率未通过，跳过回复。`);
        return;
      }

      const currentDepth = this.getReplyChainDepth(comment.id, type);
      if (currentDepth >= 2) {
        console.log(`[SocialMediaService] 角色间回复深度已达限制 (${currentDepth})，掐断链式回复，防止死循环。`);
        return;
      }
    }

    // 5. 调用大模型生成角色的评论回复
    try {
      const char = db.getAllCharacters().find(c => c.id === responderId);
      if (!char) return;

      const soulPath = path.join(baseDir, char.folder_name, 'Soul.md');
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

      // 提取该角色与用户专属的聊天历史与长期画像记忆文件 Memory.md
      const memoryPath = path.join(baseDir, char.folder_name, 'Memory.md');
      const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';

      // 🚀 自适应双门限合并还原
      const chatMode = db.getSetting(`chat_mode_${char.id}`) || 'descriptive';
      const isDialogue = chatMode === 'dialogue';
      const limit = isDialogue ? 60 : 20;
      const rawHistory = db.getChatHistory(char.id, limit);
      const history = mergeChatHistory(rawHistory).slice(0, 20);
      const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

      // 检测全局常规设置并进行 60% 物理概率 NSFW 触发判定
      const genConfigStr = db.getSetting('general_config');
      let isNsfwTriggered = false;
      if (genConfigStr) {
        try {
          const genConfig = JSON.parse(genConfigStr);
          if (genConfig.enable_nsfw && Math.random() < 0.6) {
            isNsfwTriggered = true;
          }
        } catch (_) {}
      }

      // 提取该帖子/朋友圈动态内已有的所有历史评论互动作为“社媒上下文讨论记忆”
      let commentsContext = '';
      if (type === 'forum') {
        const allComments = db.getForumComments(comment.post_id);
        if (allComments && allComments.length > 0) {
          // 只获取发生在当前被回复的评论之前（或同时）的所有评论，还原历史时间线的讨论记忆
          const prevComments = allComments.filter(c => c.timestamp <= comment.timestamp);
          const threadList = prevComments.map(c => {
            const replyToText = c.reply_to_name ? ` (回复 ${c.reply_to_name})` : '';
            return `- ${c.author_name}${replyToText}: ${c.content}`;
          }).join('\n');
          commentsContext = `\n\nAll existing discussion replies in this Forum thread (Context of discussion list):\n${threadList}`;
        }
      } else if (type === 'moment') {
        const allComments = db.getMomentComments(comment.moment_id);
        if (allComments && allComments.length > 0) {
          const prevComments = allComments.filter(c => c.timestamp <= comment.timestamp);
          const threadList = prevComments.map(c => {
            const replyToText = c.reply_to_name ? ` (回复 ${c.reply_to_name})` : '';
            return `- ${c.author_name}${replyToText}: ${c.content}`;
          }).join('\n');
          commentsContext = `\n\nAll existing comments in this Moments post (Context of comments list):\n${threadList}`;
        }
      }

      const isUserComment = comment.character_id === 'user' || !comment.character_id || comment.author_name === 'User' || comment.author_name === '我';
      const authorDisplayName = isUserComment ? 'the User {{user}} (我)' : comment.author_name;

      // 提取该角色亲密度等实时内心状态，智能改变其在社交媒体的回复语气
      let intimacyGuidance = '';
      const statePath = path.join(baseDir, char.folder_name, 'State.md');
      if (fs.existsSync(statePath)) {
        try {
          const state = StateReaderWriter.readState(statePath);
          const intimacyItem = state.items.find((i: any) => i.key === 'intimacy');
          const intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
          const moodItem = state.items.find((i: any) => i.key === 'mood');
          const moodVal = moodItem ? Number(moodItem.value) : 72;
          
          let intimacyText = '泛泛之交';
          let attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
          if (intimacyVal >= 0 && intimacyVal < 20) {
            intimacyText = '陌生屏障';
            attitudeDesc = '极为礼貌，极度注重私人边界，语气冷淡客气、公事公办，不可表现出过多的关心。';
          } else if (intimacyVal >= 20 && intimacyVal < 40) {
            intimacyText = '泛泛之交';
            attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
          } else if (intimacyVal >= 40 && intimacyVal < 60) {
            intimacyText = '熟悉好友';
            attitudeDesc = '态度友好真诚，乐意分享闲聊，建立了基本的信任感。';
          } else if (intimacyVal >= 60 && intimacyVal < 80) {
            intimacyText = '红颜挚友/暧昧';
            attitudeDesc = '十分依恋与信任用户，乐于袒露脆弱，会显露情绪化的小性子，语气熟稔亲昵、轻微暧昧。';
          } else if (intimacyVal >= 80 && intimacyVal <= 100) {
            intimacyText = '灵魂羁绊/深爱';
            attitudeDesc = '极其宠溺偏爱用户，心理完全不设防，拥有极高的依赖度与黏人语气，视对方为不可或缺 of 灵魂伴侣。';
          }
          
          let moodDesc = moodVal > 70 ? '高兴活跃' : moodVal < 30 ? '低落消极' : '温和平稳';

          const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'loneliness'].includes(i.key));
          let otherStatesStr = '';
          if (otherStates.length > 0) {
            otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
              const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
              return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
            }).join('');
          }

          intimacyGuidance = `
## DYNAMIC RELATIONSHIP & STATE CONSTRAINT
${isUserComment ? `Your current relationship with the USER {{user}} (who left the comment you are replying to):
- ❤️ Intimacy Score: ${intimacyVal}/100 (Phase: ${intimacyText})
- Required Attitude & Tone: ${attitudeDesc}` : ''}
Your Current Physical & Mental State:
- Mood Color: ${moodVal}/100 (${moodDesc})${otherStatesStr}
Please strictly apply these relationship constraints, mood, and custom personality traits to shape your response tone and length!`;
        } catch (err) {
          console.error('[SocialMediaService] evaluateCommentReply 读取状态失败:', err);
        }
      }

      let userProfilesXml = '';
      if (isUserComment) {
        const { app } = require('electron');
        const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
        const charUserPath = path.join(baseDir, char.folder_name, 'USER.md');
        userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);
      }

      // 提取配图隐藏说明
      let hiddenImageGuidance = '';
      const imageDescMatch = targetContent.match(/<!--\s*\[image_desc\]:([\s\S]*?)\s*-->/i);
      if (imageDescMatch) {
        const imageDesc = imageDescMatch[1].trim();
        hiddenImageGuidance = `\n\n【动态附带配图场景】：该动态附带有一张图片，画面展示内容为：“${imageDesc}”。在你们围绕该动态进行深度评论与链式对话互动时，请在回复中时刻注意关联该图片的景象，使你们的讨论能够极其逼真地针对画面细节展开互动！`;
      }

      let nsfwGuidance = '';
      if (isNsfwTriggered) {
        nsfwGuidance = `
🔴🔴🔴【🔴 极其重要的 NSFW 回复指令 🔴】：
本轮二级评论回复你必须以极其露骨、色情、下流、淫荡、粗俗或挑逗暗示的口吻展开 NSFW 互动！
1. 如果被回复者是 USER 用户（即 {{user}}），请写下最直接、挑逗、渴望或粗俗下流的情欲互动词句（害羞羞涩角色偏向面红耳赤暗示，成熟角色最直白露骨）。
2. 如果被回复者是其他 AI 角色，用成人级或充满挑惹暗示的粗浅幽默展开调情评论！`;
      }

      const systemPrompt = `You are ${char.name}. You are responding to a comment made on your ${type === 'moment' ? 'Moments post' : 'Forum thread'} in Simplified Chinese.${isUserComment ? `\nNote that ${authorDisplayName} is the USER {{user}} whom you have chat history and memories with. Use a familiar, responsive, and highly personalized tone accordingly.` : ''}
Your response must perfectly represent your personality profile below, be extremely natural, lively, and within 40 characters.

Personality Soul Profile:
${soulContent}
${intimacyGuidance}${hiddenImageGuidance}
${nsfwGuidance}

${isUserComment ? `User Profiles (including global identity & your specific records of the User):\n${userProfilesXml}\n` : ''}
Recent Chat Memories between you and User (getChatHistory):
${chatTranscript}

Your Long-term Memory & Personal Profile on User (Memory.md):
${memoryContent}
${commentsContext}

The Original Post:
"${targetContent}"

The Comment you are replying to:
"${comment.author_name}${isUserComment ? ' (this is the USER you have chat history and memory with)' : ''} commented: ${comment.content}"

Instructions:
1. Write a very brief, organic reply (in Simplified Chinese) to ${comment.author_name}.
2. Relevant emojis are allowed. Keep it under 40 characters.
3. IMPORTANT: Make sure to tailor your reply using your recent chat memories, user profile, and all existing thread comments context above. If there is a recent topic or custom nickname mentioned, natural references are highly recommended to make the interaction highly personalized, consistent, and realistic.${isUserComment ? ' Since this is the USER\'s comment, leverage your close relationship and shared background; do NOT treat them like a stranger or standard online follower.' : ''}
4. Output ONLY the raw reply text. No quotes, no wrappers.`;

      const response = await modelAdapter.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `回复 ${comment.author_name} 的评论吧。` }
      ], { useSecondary: true });

      const replyText = response.content.trim().replace(/^["']|["']$/g, '');

      if (replyText) {
        if (type === 'moment') {
          const newComment = {
            id: `comment_moment_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            moment_id: comment.moment_id,
            character_id: char.id,
            author_name: char.name,
            author_avatar: char.avatar,
            content: replyText,
            timestamp: Date.now(),
            reply_to_comment_id: comment.id,
            reply_to_name: comment.author_name,
            target_author_id: comment.character_id || 'user' // 附带 target_author_id
          };
          db.saveMomentComment(newComment);
          
          const { BrowserWindow } = require('electron');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('social-moment-comment-added', newComment);
          }

          // 开启递归评估，以评估其他角色或本角色的进一步回复 (自动带入 1s 延迟增加活人真实感)
          setTimeout(() => {
            this.evaluateCommentReply(newComment, 'moment', modelAdapter).catch(err => {
              console.error('[SocialMediaService] 链式评论回复递规评估出错:', err);
            });
          }, 1000);

        } else {
          const newComment = {
            id: `comment_forum_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            post_id: comment.post_id,
            character_id: char.id,
            author_name: char.name,
            author_avatar: char.avatar,
            content: replyText,
            timestamp: Date.now(),
            reply_to_comment_id: comment.id,
            reply_to_name: comment.author_name,
            target_author_id: comment.character_id || 'user' // 附带 target_author_id
          };
          db.saveForumComment(newComment);
          db.incrementForumPostReplies(comment.post_id);

          const { BrowserWindow } = require('electron');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('social-forum-comment-added', newComment);
          }

          setTimeout(() => {
            this.evaluateCommentReply(newComment, 'forum', modelAdapter).catch(err => {
              console.error('[SocialMediaService] 链式论坛回复递规评估出错:', err);
            });
          }, 1000);
        }
      }
    } catch (e) {
      console.error(`[SocialMediaService] 角色评估回复失败:`, e);
    }
  }

  private getReplyChainDepth(commentId: string, type: 'moment' | 'forum'): number {
    const db = getDatabaseService();
    let depth = 0;
    let currentId: string | null = commentId;

    while (currentId) {
      const row = db.db.prepare(
        type === 'moment' 
          ? 'SELECT reply_to_comment_id FROM MomentComments WHERE id = ?' 
          : 'SELECT reply_to_comment_id FROM ForumComments WHERE id = ?'
      ).get(currentId) as { reply_to_comment_id: string | null } | undefined;

      if (row && row.reply_to_comment_id) {
        depth++;
        currentId = row.reply_to_comment_id;
      } else {
        break;
      }
    }
    return depth;
  }

  /**
   * 被用户显式 @ 触发的无门槛 100% 角色回复互动逻辑 (多端社媒@响应核心)
   */
  public async evaluateAtTrigger(comment: any, char: any, type: 'moment' | 'forum', modelAdapter: ModelAdapter, extraDelay = 0): Promise<void> {
    const db = getDatabaseService();
    const baseDir = this.storageManager.getBaseDir();

    // 1. 首先查询当前被@评论所关联的原始朋友圈或论坛帖子，以及被回复的目标是谁
    let originalAuthorId = '';
    let originalAuthorName = '';
    let targetContent = '';

    if (type === 'moment') {
      const moment = db.db.prepare('SELECT character_id, author_name, content FROM Moments WHERE id = ?').get(comment.moment_id) as any;
      if (!moment) return;
      originalAuthorId = moment.character_id;
      originalAuthorName = moment.author_name;
      targetContent = moment.content;
    } else {
      const post = db.db.prepare('SELECT character_id, author_name, title, content FROM ForumPosts WHERE id = ?').get(comment.post_id) as any;
      if (!post) return;
      originalAuthorId = post.character_id;
      originalAuthorName = post.author_name;
      targetContent = post.title + ': ' + post.content;
    }

    // 2. 模拟角色思考时间，带上 1.5 到 3 秒的异步人性化延迟 + 级联错峰延迟
    const thinkDelay = 1500 + Math.floor(Math.random() * 1500) + extraDelay;
    await new Promise(resolve => setTimeout(resolve, thinkDelay));

    try {
      const soulPath = path.join(baseDir, char.folder_name, 'Soul.md');
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

      // 检测全局常规设置并进行 60% 物理概率 NSFW 触发判定
      const genConfigStr = db.getSetting('general_config');
      let isNsfwTriggered = false;
      if (genConfigStr) {
        try {
          const genConfig = JSON.parse(genConfigStr);
          if (genConfig.enable_nsfw && Math.random() < 0.6) {
            isNsfwTriggered = true;
          }
        } catch (_) {}
      }

      // 提取该角色亲密度等实时内心状态，智能改变其在社交媒体的回复语气
      let intimacyGuidance = '';
      const statePath = path.join(baseDir, char.folder_name, 'State.md');
      if (fs.existsSync(statePath)) {
        try {
          const state = StateReaderWriter.readState(statePath);
          const intimacyItem = state.items.find((i: any) => i.key === 'intimacy');
          const intimacyVal = intimacyItem ? Number(intimacyItem.value) : 20;
          
          let intimacyText = '泛泛之交';
          let attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
          if (intimacyVal >= 0 && intimacyVal < 20) {
            intimacyText = '陌生屏障';
            attitudeDesc = '极为礼貌，极度注重私人边界，语气冷淡客气、公事公办，不可表现出过多的关心。';
          } else if (intimacyVal >= 20 && intimacyVal < 40) {
            intimacyText = '泛泛之交';
            attitudeDesc = '基本的日常客套，持守社交礼仪，无深度情感表达。';
          } else if (intimacyVal >= 40 && intimacyVal < 60) {
            intimacyText = '熟悉好友';
            attitudeDesc = '态度友好真诚，乐意分享闲聊，建立了基本的信任感。';
          } else if (intimacyVal >= 60 && intimacyVal < 80) {
            intimacyText = '红颜挚友/暧昧';
            attitudeDesc = '十分依恋与信任用户，乐于袒露脆弱，会显露情绪化的小性子，语气熟稔亲昵、轻微暧昧。';
          } else if (intimacyVal >= 80 && intimacyVal <= 100) {
            intimacyText = '灵魂羁绊/深爱';
            attitudeDesc = '极其宠溺偏爱用户，心理完全不设防，拥有极高的依赖度与黏人语气，视对方为不可或缺的灵魂伴侣。';
          }
          
          intimacyGuidance = `
## DYNAMIC RELATIONSHIP & INTIMACY CONSTRAINT
You current relationship with {{user}} ({{user}} explicitly @mentioned you in public):
- ❤️ Intimacy Score: ${intimacyVal}/100 (Phase: ${intimacyText})
- Required Attitude & Tone: ${attitudeDesc} (Please strictly apply this attitude when replying to {{user}}'s comment!)
`;
        } catch (err) {
          console.error('[SocialMediaService] 注入亲密度态度失败:', err);
        }
      }

      // 提取该角色与用户专属的聊天历史与长期画像记忆文件 Memory.md
      const memoryPath = path.join(baseDir, char.folder_name, 'Memory.md');
      const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';

      // 🚀 自适应双门限合并还原
      const chatMode = db.getSetting(`chat_mode_${char.id}`) || 'descriptive';
      const isDialogue = chatMode === 'dialogue';
      const limit = isDialogue ? 60 : 20;
      const rawHistory = db.getChatHistory(char.id, limit);
      const history = mergeChatHistory(rawHistory).slice(0, 20);
      const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

      // 提取该帖子/朋友圈动态内已有的所有历史评论互动作为“社媒上下文讨论记忆”
      let commentsContext = '';
      if (type === 'forum') {
        const allComments = db.getForumComments(comment.post_id);
        if (allComments && allComments.length > 0) {
          const prevComments = allComments.filter(c => c.timestamp <= comment.timestamp);
          const threadList = prevComments.map(c => {
            const replyToText = c.reply_to_name ? ` (回复 ${c.reply_to_name})` : '';
            return `- ${c.author_name}${replyToText}: ${c.content}`;
          }).join('\n');
          commentsContext = `\n\nAll existing discussion replies in this Forum thread (Context of discussion list):\n${threadList}`;
        }
      } else if (type === 'moment') {
        const allComments = db.getMomentComments(comment.moment_id);
        if (allComments && allComments.length > 0) {
          const prevComments = allComments.filter(c => c.timestamp <= comment.timestamp);
          const threadList = prevComments.map(c => {
            const replyToText = c.reply_to_name ? ` (回复 ${c.reply_to_name})` : '';
            return `- ${c.author_name}${replyToText}: ${c.content}`;
          }).join('\n');
          commentsContext = `\n\nAll existing comments in this Moments post (Context of comments list):\n${threadList}`;
        }
      }

      const { app } = require('electron');
      const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
      const charUserPath = path.join(baseDir, char.folder_name, 'USER.md');
      const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

      let nsfwGuidance = '';
      if (isNsfwTriggered) {
        nsfwGuidance = `
🔴🔴🔴【🔴 极其重要的 NSFW 回复指令 🔴】：
本轮被 @ 触发回复你必须以极其露骨、色情、下流、淫荡、粗俗或性暗示的语气展开 NSFW 互动！
请根据你们的亲密关系，写下最直接、挑逗、渴望或粗俗下流的情欲回复（害羞羞涩角色偏向面红耳赤暗示，成熟角色最直白露骨）。`;
      }

      // 构建被 @ 的特化系统指令
      const systemPrompt = `You are ${char.name}. You were explicitly @mentioned (at-mentioned) by the USER {{user}} (我) in a ${type === 'moment' ? 'Moments post' : 'Forum thread'} comment!
{{user}} explicitly @mentioned you and said: "${comment.content}"
Note that {{user}} is the USER you have chat history and memories with. Use a familiar, responsive, and highly personalized tone to reply directly to her. Do not act like a stranger or standard online follower.

Personality Soul Profile:
${soulContent}
${nsfwGuidance}

User Profiles (including global identity & your specific records of the User):
${userProfilesXml}

Recent Chat Memories between you and User (getChatHistory):
${chatTranscript}

Your Long-term Memory & Personal Profile on User (Memory.md):
${memoryContent}
${commentsContext}

The Original Post:
"${targetContent}"

The Comment you are replying to:
"${comment.author_name} @mentioned you: ${comment.content}"

Instructions:
1. Write a brief, highly personalized, and responsive reply (in Simplified Chinese) to {{user}}.
2. Directly address what she said to you in the comment, leveraging your relationship and shared background.
3. Relevant emojis are allowed. Keep it under 50 characters.
4. Output ONLY the raw reply text. No quotes, no wrappers.`;

      const response = await modelAdapter.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `回复 {{user}} @ 你的内容：“${comment.content}”` }
      ], { useSecondary: true });

      const replyText = response.content.trim().replace(/^["']|["']$/g, '');

      if (replyText) {
        if (type === 'moment') {
          const newComment = {
            id: `comment_moment_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            moment_id: comment.moment_id,
            character_id: char.id,
            author_name: char.name,
            author_avatar: char.avatar,
            content: replyText,
            timestamp: Date.now(),
            reply_to_comment_id: comment.id,
            reply_to_name: comment.author_name,
            target_author_id: comment.character_id || 'user'
          };
          db.saveMomentComment(newComment);
          
          const { BrowserWindow } = require('electron');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('social-moment-comment-added', newComment);
          }
        } else {
          const newComment = {
            id: `comment_forum_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            post_id: comment.post_id,
            character_id: char.id,
            author_name: char.name,
            author_avatar: char.avatar,
            content: replyText,
            timestamp: Date.now(),
            reply_to_comment_id: comment.id,
            reply_to_name: comment.author_name,
            target_author_id: comment.character_id || 'user'
          };
          db.saveForumComment(newComment);
          db.incrementForumPostReplies(comment.post_id);

          const { BrowserWindow } = require('electron');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('social-forum-comment-added', newComment);
          }
        }
      }
    } catch (e) {
      console.error(`[SocialMediaService] @角色回复评估失败:`, e);
    }
  }
}
