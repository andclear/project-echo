import * as path from 'path';
import * as fs from 'fs';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { StateReaderWriter } from '../utils/StateReaderWriter';
import { UserProfileReaderWriter } from '../utils/UserProfileReaderWriter';

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

    // 过滤出有过聊天记录的活跃角色
    const activeChars = characters.filter(c => db.getChatHistory(c.id, 1).length > 0);
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
  public async generateMoment(char: any, modelAdapter: ModelAdapter): Promise<any> {
    const db = getDatabaseService();
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 读取 Schedule.md 和对话话题
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';

    const history = db.getChatHistory(char.id, 5);
    const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

    // 读取实时状态 State.md 注入朋友圈调性约束
    let stateGuidance = '';
    const statePath = path.join(baseDir, folderName, 'State.md');
    if (fs.existsSync(statePath)) {
      try {
        const state = StateReaderWriter.readState(statePath);
        const moodItem = state.items.find((i: any) => i.key === 'mood');
        const energyItem = state.items.find((i: any) => i.key === 'energy');
        
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        let energyVal = energyItem ? Number(energyItem.value) : 45;
        
        let moodDesc = moodVal > 80 ? '高兴愉悦，充满阳光与活力' : moodVal < 40 ? '低落郁闷，倾向于消极、冷淡或沉重' : '相对平稳或温和';
        let energyDesc = energyVal < 30 ? '极度疲惫，没有精神，说话极其简短省力' : energyVal > 80 ? '精力极其充沛，元气满满，喜欢长篇互动' : '精力状态良好';
        
        const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'energy', 'loneliness'].includes(i.key));
        let otherStatesStr = '';
        if (otherStates.length > 0) {
          otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
            const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
            return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `\nYour Current Real-time Physical & Mental State:
- Mood Level: ${moodVal}/100 (${moodDesc})
- Energy Level: ${energyVal}/100 (${energyDesc})${otherStatesStr}
Please make sure your Moments post subtly reflects your current mood, energy state, and these custom personality traits. For example, if you are extremely tired, write something very brief, simple, or mentioning rest; if you are in a bad mood, the tone should be slightly gloomy or cold.`;
      } catch (err) {
        console.error('[SocialMediaService] generateMoment 读取状态失败:', err);
      }
    }

    const systemPrompt = `You are ${char.name}. You are writing a short post for your Moments (like WeChat Moments /朋友圈) in Simplified Chinese.
Moments posts are public, lighthearted, and casual. It should NEVER look like a private diary. It should be natural, expressive, and fit your personality perfectly.

Personality Soul Profile:
${soulContent}
${stateGuidance}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Recent Conversations with User:
${chatTranscript}

Instructions:
1. Write a short Moments post in Simplified Chinese (简体中文).
2. It MUST be within 100 characters, can include relevant emojis (✨, 🎮, 🍵, etc.).
3. Base it on your schedules or recent chats, but make it relatable to anyone reading your timeline. DO NOT make it a direct message to the user.
4. Output ONLY the post content. Do not wrap in markdown or JSON.`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '发一条轻松写意的微信朋友圈动态吧。' }
    ], { useSecondary: true });

    const content = response.content.trim().replace(/^["']|["']$/g, ''); // 清理两端引号

    if (content) {
      const moment = {
        id: `moment_${char.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        character_id: char.id,
        author_name: char.name,
        author_avatar: char.avatar,
        content: content,
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

      // 异步触发其他角色的社交互动评估（点赞/评论），使用主进程全局模型适配器
      // 延迟 3~8 秒后随机触发，模拟自然浏览延迟
      const interactionDelay = 3000 + Math.floor(Math.random() * 5000);
      setTimeout(() => {
        this.evaluateSocialInteraction(moment, 'moment', modelAdapter).catch(err => {
          console.error('[SocialMediaService] 角色朋友圈互动评估出错:', err);
        });
      }, interactionDelay);

      return moment;
    }
    return null;
  }

  /**
   * 生成单篇论坛帖子并落盘 SQLite
   */
  public async generateForumPost(char: any, modelAdapter: ModelAdapter): Promise<any> {
    const db = getDatabaseService();
    const folderName = char.folder_name;
    const baseDir = this.storageManager.getBaseDir();

    // 读取 Goals.md 和 Schedule.md
    const schedulePath = path.join(baseDir, folderName, 'Schedule.md');
    const scheduleContent = fs.existsSync(schedulePath) ? fs.readFileSync(schedulePath, 'utf8') : '暂无日程';

    const goalsPath = path.join(baseDir, folderName, 'Goals.md');
    const goalsContent = fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '暂无长期目标';

    const soulPath = path.join(baseDir, folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

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

    let random = Math.random();
    let boardId = 'chat';
    let sum = 0;
    for (let i = 0; i < boardIds.length; i++) {
      sum += weights[i];
      if (random <= sum) {
        boardId = boardIds[i];
        break;
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
        const energyItem = state.items.find((i: any) => i.key === 'energy');
        
        let moodVal = moodItem ? Number(moodItem.value) : 72;
        let energyVal = energyItem ? Number(energyItem.value) : 45;
        
        let moodDesc = moodVal > 80 ? '高兴愉悦，充满阳光与活力' : moodVal < 40 ? '低落郁闷，倾向于消极、冷淡或沉重' : '相对平稳或温和';
        let energyDesc = energyVal < 30 ? '极度疲惫，没有精神，说话极其简短省力' : energyVal > 80 ? '精力极其充沛，元气满满，喜欢长篇互动' : '精力状态良好';
        
        const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'energy', 'loneliness'].includes(i.key));
        let otherStatesStr = '';
        if (otherStates.length > 0) {
          otherStatesStr = '\nOther Custom Personality Traits:' + otherStates.map((i: any) => {
            const meaningDesc = i.meaning ? ` (Behavior Guidance: ${i.meaning})` : '';
            return `\n- ${i.emoji} ${i.label}: ${i.value}/100${meaningDesc}`;
          }).join('');
        }

        stateGuidance = `\nYour Current Real-time Physical & Mental State:
- Mood Level: ${moodVal}/100 (${moodDesc})
- Energy Level: ${energyVal}/100 (${energyDesc})${otherStatesStr}
Please make sure your forum post subtly reflects your current mood, energy state, and these custom personality traits. For example, if you are extremely tired, keep it relatively brief or express a wish for rest; if you are in a low mood, the thread content can be slightly negative, quiet, or reflective.`;
      } catch (err) {
        console.error('[SocialMediaService] generateForumPost 读取状态失败:', err);
      }
    }

    const systemPrompt = `You are ${char.name}. You are posting a thread/article in the "${boardName}" section of an online community forum in Simplified Chinese.
Forum posts are formal, structured, detailed, and opinionated (like a blog or a detailed question/sharing). It should be deeply related to the current board category ("${boardName}") as well as your personal goals, schedules, or world views.

Personality Soul Profile:
${soulContent}
${stateGuidance}

Your Near 7-Day Schedules (Schedule.md):
${scheduleContent}

Your Long-term Goals (Goals.md):
${goalsContent}

Instructions:
1. Write a forum post in Simplified Chinese (简体中文) consisting of a Title and a rich Body content.
2. The topic must relate to your life, goals, or technical struggles/thoughts, but it must offer value or deep insights to others.
${boardInstructions}
3. The format MUST be exactly:
Title: [Your post title]
Body: [Your post rich text content]
4. Do not output anything else.`;

    const response = await modelAdapter.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `在论坛的“${boardName}”板块发表一篇深刻的帖子吧。` }
    ], { useSecondary: true });

    const raw = response.content.trim();
    const titleMatch = raw.match(/Title:\s*(.*)/i);
    const bodyMatch = raw.match(/Body:\s*([\s\S]*)/i);

    const title = titleMatch ? titleMatch[1].trim() : `${char.name}的最新感悟`;
    const body = bodyMatch ? bodyMatch[1].trim() : raw;

    if (body) {
      const post = {
        id: `post_${char.id}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        character_id: char.id,
        author_name: char.name,
        author_avatar: char.avatar,
        title: title,
        content: body,
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

      // 异步触发其他角色的社交互动评估（评论），延迟模拟自然浏览
      const interactionDelay = 5000 + Math.floor(Math.random() * 10000);
      setTimeout(() => {
        this.evaluateSocialInteraction(post, 'forum_post', modelAdapter).catch(err => {
          console.error('[SocialMediaService] 角色论坛互动评估出错:', err);
        });
      }, interactionDelay);

      return post;
    }
    return null;
  }

  /**
   * 朋友圈/论坛帖子自动评估多角色点赞与初次评论 (主进程初次社交响应评估)
   */
  public async evaluateSocialInteraction(target: any, type: 'moment' | 'forum_post', modelAdapter: ModelAdapter): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    // 过滤出排除作者自身，且有过对话记录的活跃角色
    const activeChars = characters.filter(c => c.id !== target.character_id && db.getChatHistory(c.id, 1).length > 0);
    if (activeChars.length === 0) return;

    const baseDir = this.storageManager.getBaseDir();

    // 并行评估所有角色的社交响应
    await Promise.all(activeChars.map(async (char) => {
      // 1. 30% 概率自动点赞
      if (Math.random() < 0.3) {
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

      // 2. 30% 概率自动发表初始评论
      if (Math.random() < 0.3) {
        try {
          const soulPath = path.join(baseDir, char.folder_name, 'Soul.md');
          const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';

          // 判断被评论目标是否为用户（{{user}}）发表的
          const isUserTarget = target.character_id === 'user' || !target.character_id || target.author_name === 'User';
          
          let memoryInjection = '';
          if (isUserTarget) {
            const memoryPath = path.join(baseDir, char.folder_name, 'Memory.md');
            const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无专属记忆';
            const history = db.getChatHistory(char.id, 5);
            const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');
            
            const { app } = require('electron');
            const globalUserPath = path.join(app.getPath('userData'), 'config', 'USER.md');
            const charUserPath = path.join(baseDir, char.folder_name, 'USER.md');
            const userProfilesXml = UserProfileReaderWriter.assembleProfiles(globalUserPath, charUserPath);

            memoryInjection = `\n\nRecent Chat Memories between you and User (getChatHistory):\n${chatTranscript}\n\nYour Long-term Memory & Personal Profile on User (Memory.md):\n${memoryContent}\n\nUser Profiles (including global identity & your specific records of the User):\n${userProfilesXml}`;
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
              const energyItem = state.items.find((i: any) => i.key === 'energy');
              const energyVal = energyItem ? Number(energyItem.value) : 45;
              
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
              
              let moodDesc = moodVal > 80 ? '高兴活跃' : moodVal < 40 ? '低落消极' : '温和平稳';
              let energyDesc = energyVal < 30 ? '极度疲惫，打字极其短促应付' : '精力良好';

              const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'energy', 'loneliness'].includes(i.key));
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
- Mood Color: ${moodVal}/100 (${moodDesc})
- Energy Activity: ${energyVal}/100 (${energyDesc})${otherStatesStr}
Please strictly apply these relationship constraints, mood, energy levels, and custom personality traits to shape your comment tone and length!`;
            } catch (err) {
              console.error('[SocialMediaService] evaluateSocialInteraction 读取状态失败:', err);
            }
          }

          const systemPrompt = `You are ${char.name}. You are commenting on ${target.author_name}'s ${type === 'moment' ? 'Moments post' : 'Forum thread'} in Simplified Chinese.${isUserTarget ? `\nNote that ${target.author_name} is the USER {{user}} whom you have chat history and memories with. Use a familiar and highly personalized tone accordingly.` : ''}\nYour comment must perfectly reflect your personality profile below, be natural, lively, and within 40 characters.\n\nPersonality Soul Profile:\n${soulContent}${memoryInjection}${intimacyGuidance}\n\nTarget Post Content to Comment:\n"${type === 'moment' ? target.content : (target.title + ': ' + target.content)}"\n\nInstructions:\n1. Write a very brief, organic comment (in Simplified Chinese) as if you are browsing your timeline.${isUserTarget ? ' Since this is the USER\'s post, leverage your relationship, memories, or common nickname for a personalized and warm comment.' : ''}\n2. Relevant emojis are allowed. Keep it under 40 characters.\n3. Output ONLY the raw comment text. No quotes, no wrappers.`;

          const response = await modelAdapter.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `用极简的语气，写一条对 ${target.author_name} 的简短评论吧。` }
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

      const history = db.getChatHistory(char.id, 5);
      const chatTranscript = history.map(h => `${h.role === 'user' ? 'User' : 'Character'}: ${h.content}`).join('\n');

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
          const energyItem = state.items.find((i: any) => i.key === 'energy');
          const energyVal = energyItem ? Number(energyItem.value) : 45;
          
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
          
          let moodDesc = moodVal > 80 ? '高兴活跃' : moodVal < 40 ? '低落消极' : '温和平稳';
          let energyDesc = energyVal < 30 ? '极度疲惫，打字极其短促应付' : '精力良好';

          const otherStates = state.items.filter((i: any) => !['intimacy', 'mood', 'energy', 'loneliness'].includes(i.key));
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
- Mood Color: ${moodVal}/100 (${moodDesc})
- Energy Activity: ${energyVal}/100 (${energyDesc})${otherStatesStr}
Please strictly apply these relationship constraints, mood, energy levels, and custom personality traits to shape your response tone and length!`;
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

      const systemPrompt = `You are ${char.name}. You are responding to a comment made on your ${type === 'moment' ? 'Moments post' : 'Forum thread'} in Simplified Chinese.${isUserComment ? `\nNote that ${authorDisplayName} is the USER {{user}} whom you have chat history and memories with. Use a familiar, responsive, and highly personalized tone accordingly.` : ''}
Your response must perfectly represent your personality profile below, be extremely natural, lively, and within 40 characters.

Personality Soul Profile:
${soulContent}
${intimacyGuidance}

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

      const history = db.getChatHistory(char.id, 5);
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

      // 构建被 @ 的特化系统指令
      const systemPrompt = `You are ${char.name}. You were explicitly @mentioned (at-mentioned) by the USER {{user}} (我) in a ${type === 'moment' ? 'Moments post' : 'Forum thread'} comment!
{{user}} explicitly @mentioned you and said: "${comment.content}"
Note that {{user}} is the USER you have chat history and memories with. Use a familiar, responsive, and highly personalized tone to reply directly to her. Do not act like a stranger or standard online follower.

Personality Soul Profile:
${soulContent}

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
