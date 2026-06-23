import { app, ipcMain, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPlugin } from '../PluginManager';
import { getDatabaseService } from '../../db/database';
import { ChatMessage, ModelAdapter } from '../../models/ModelAdapter';
import { CharacterStorageManager } from '../../utils/CharacterStorageManager';
import { PluginBridgeService } from '../../services/PluginBridgeService';
import { StateReaderWriter } from '../../utils/StateReaderWriter';
import { SseManager } from '../../services/SseManager';


// 礼物硬编码金额，完全直接写死，不读取外部文件覆盖
const GIFT_PRICES_FALLBACK: Record<string, number> = {
  '666': 666,
  '包包': 2999,
  '天马': 999,
  '情书': 99,
  '比心': 9,
  '小花花': 19,
  '心动卡': 9,
  '摩天轮': 99,
  '告白花束': 52,
  '幸福马车': 1314,
  '捏捏小脸': 29,
  '月桂皇冠': 25,
  '爱心气球': 1314,
  '爱的乐章': 520,
  '牛哇牛哇': 66,
  '紫色城堡': 5200,
  '紫色玫瑰': 520,
  '红色跑车': 8888,
  '超级火箭': 19999,
  '爱心直升机': 1999,
  '爱的漂流瓶': 199
};

export class LiveStreamPlugin implements IPlugin {
  public readonly name = 'LiveStreamPlugin';
  private giftPrices: Record<string, number> = { ...GIFT_PRICES_FALLBACK };
  private activeSessionId: string | null = null;
  private activeSessionMeet: { targetName: string; type: 'meet' | 'date'; confirmed: boolean; } | null = null;

  private getBase64Avatar(folderName: string): string {
    if (!folderName || typeof folderName !== 'string') return '';
    try {
      const storageManager = new CharacterStorageManager();
      const avatarPath = path.join(storageManager.getBaseDir(), folderName, 'avatar.png');
      if (fs.existsSync(avatarPath)) {
        const buffer = fs.readFileSync(avatarPath);
        return `data:image/png;base64,${buffer.toString('base64')}`;
      }
    } catch (e) {
      console.error('[LiveStreamPlugin] 读取角色物理头像失败:', e);
    }
    return '';
  }

  private getUserAvatar(hostCharId?: string): string {
    const configDir = path.join(app.getPath('userData'), 'config');
    const targetProfilesDir = path.join(configDir, 'user_profiles');
    let profileId: string | null = null;

    if (hostCharId) {
      try {
        const db = getDatabaseService();
        profileId = db.getProfileBinding(hostCharId);
      } catch (err) {
        console.error('[LiveStreamPlugin] 读取绑定的用户人设卡 ID 失败:', err);
      }
    }

    // 1. 如果有绑定人设关系，优先读取该绑定的头像
    if (profileId) {
      const avatarPath = path.join(targetProfilesDir, `${profileId}.png`);
      if (fs.existsSync(avatarPath)) {
        try {
          const fileBuffer = fs.readFileSync(avatarPath);
          return `data:image/png;base64,${fileBuffer.toString('base64')}`;
        } catch (_) {}
      }
    }

    // 2. 如果未绑定或绑定头像文件不存在，按系统获取名字的相同兜底策略，读取 user_profiles 物理目录下的第一个人设卡的头像
    if (fs.existsSync(targetProfilesDir)) {
      try {
        const files = fs.readdirSync(targetProfilesDir).filter(f => f.endsWith('.md'));
        if (files.length > 0) {
          files.sort();
          const firstProfileId = files[0].replace(/\.md$/, '');
          const avatarPath = path.join(targetProfilesDir, `${firstProfileId}.png`);
          if (fs.existsSync(avatarPath)) {
            const fileBuffer = fs.readFileSync(avatarPath);
            return `data:image/png;base64,${fileBuffer.toString('base64')}`;
          }
        }
      } catch (_) {}
    }

    // 3. 全局应用头像兜底
    try {
      const supportedExtensions = ['png', 'jpg', 'jpeg', 'webp'];
      if (fs.existsSync(configDir)) {
        for (const ext of supportedExtensions) {
          const avatarPath = path.join(configDir, `echo-avatar.${ext}`);
          if (fs.existsSync(avatarPath)) {
            const fileBuffer = fs.readFileSync(avatarPath);
            const base64Str = fileBuffer.toString('base64');
            let mimeType = 'image/png';
            if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
            else if (ext === 'webp') mimeType = 'image/webp';
            return `data:${mimeType};base64,${base64Str}`;
          }
        }
        
        const legacyAvatarDir = path.join(configDir, 'profile_avatars');
        if (fs.existsSync(legacyAvatarDir)) {
          const supportedLegacyExtensions = ['webp', 'png', 'jpg', 'jpeg'];
          for (const ext of supportedLegacyExtensions) {
            const legacyAvatarPath = path.join(legacyAvatarDir, `default.${ext}`);
            if (fs.existsSync(legacyAvatarPath)) {
              const fileBuffer = fs.readFileSync(legacyAvatarPath);
              const base64Str = fileBuffer.toString('base64');
              let mimeType = 'image/png';
              if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
              else if (ext === 'webp') mimeType = 'image/webp';
              return `data:${mimeType};base64,${base64Str}`;
            }
          }
        }
      }
    } catch (e) {
      console.error('[LiveStreamPlugin] 获取全局默认头像失败:', e);
    }

    return '';
  }

  public init(): void {
    this.loadGiftPrices();
    // 确保 livestream 相关存储目录存在
    const livestreamDir = path.join(app.getPath('userData'), 'plugins', 'livestream', 'characters');
    if (!fs.existsSync(livestreamDir)) {
      fs.mkdirSync(livestreamDir, { recursive: true });
    }
  }

  private loadGiftPrices(): void {
    // 礼物价值配置已完全硬编码写死运作
  }

  private getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : BrowserWindow.getFocusedWindow();
  }

  private async callLLM(systemPrompt: string, userPrompt: string, characterId?: string): Promise<string> {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！');
    }
    const settings = JSON.parse(configStr);
    const modelAdapter = new ModelAdapter(settings.primary, settings.secondary);
    
    // 判定当前实际请求的是哪个模型，由于强制指定 useSecondary = true
    const isSecondaryEnabled = !!settings.enableSecondary;
    const targetModelName = isSecondaryEnabled 
      ? (settings.secondary?.model || '未配置辅助模型名') 
      : (settings.primary?.model || '未配置主模型名');
    const targetRole = isSecondaryEnabled ? '辅助大模型' : '主大模型 (辅助模型未启用/未配置，已自动降级)';

    const startTime = Date.now();

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    
    try {
      const response = await modelAdapter.chat(messages, { 
        useSecondary: true, // 强制全部使用辅助大模型（ModelAdapter 会在未配置时自动默默降级回主模型）
        characterId
      });
      const endTime = Date.now();
      const elapsed = endTime - startTime;
      console.log(`[LiveStreamPlugin] AI调用成功 | 耗时: ${elapsed}ms`);
      return response.content.trim();
    } catch (e: any) {
      console.error(`[LiveStreamPlugin] [AI调用] 大模型调用失败: ${e.message || e}`);
      throw e;
    }
  }

  public registerIpcHandlers(): void {
    const parseDirection = (text: string) => {
      if (!text) return { direction: '自定义', prompt: '' };
      if (text.includes('|||')) {
        const parts = text.split('|||');
        return { direction: parts[0], prompt: parts[1] };
      }
      let dir = '自定义';
      const t = text.toLowerCase();
      if (t.includes('外貌与气质展示') || t.includes('颜值') || t.includes('外貌') || t.includes('形象') || t.includes('气质')) dir = '颜值';
      else if (t.includes('深度心灵沟通') || t.includes('情感') || t.includes('心灵沟通') || t.includes('疏导情绪') || t.includes('心理沟通')) dir = '情感';
      else if (t.includes('游戏竞技') || t.includes('游戏') || t.includes('竞技')) dir = '游戏';
      else if (t.includes('围炉闲聊') || t.includes('闲聊') || t.includes('插科打诨') || t.includes('唠唠嗑')) dir = '闲聊';
      else if (t.includes('动漫萌系') || t.includes('二次元') || t.includes('acg') || t.includes('萌系') || t.includes('萌萌哒')) dir = '二次元';
      return { direction: dir, prompt: text };
    };

    // 1. 开播会话初始化
    ipcMain.handle('livestream:start-session', async (_, payload: { characterId: string; theme: string; direction: string; customPrompt?: string }) => {
      try {
        const db = getDatabaseService();
        // 查找主播基本信息
        const hostChar = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(payload.characterId) as any;
        if (!hostChar) {
          throw new Error('未找到主播角色元数据');
        }
        const hostName = hostChar.name;
        const hostFolderName = hostChar.folder_name;

        // 随机选取最多 3 个 VIP 角色（未免打扰优先）
        const allChars = db.db.prepare('SELECT * FROM Characters WHERE id != ?').all(payload.characterId) as any[];
        
        // 过滤并排序免打扰
        const itemsWithMuted = [];
        for (const c of allChars) {
          const meta = db.db.prepare('SELECT muted FROM ConversationMeta WHERE character_id = ?').get(c.id) as any;
          itemsWithMuted.push({
            ...c,
            muted: meta ? meta.muted : 0
          });
        }

        const unmuted = itemsWithMuted.filter(c => c.muted === 0);
        const muted = itemsWithMuted.filter(c => c.muted !== 0);

        const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
        shuffle(unmuted);
        shuffle(muted);

        const selected = [...unmuted, ...muted].slice(0, 3);
        const vipCharacters = [];
        for (const c of selected) {
          const analysis = await this.analyzeVipProfile(c.folder_name, c.id);
          vipCharacters.push({
            id: c.id,
            name: c.name,
            folderName: c.folder_name,
            avatar: this.getBase64Avatar(c.folder_name),
            gender: analysis.gender
          });
        }

        // 见过面自愈逻辑判定
        let hasMet = false;
        const storageManager = new CharacterStorageManager();
        const charactersBaseDir = storageManager.getBaseDir();
        const charDir = path.join(charactersBaseDir, hostFolderName);
        const memoryPath = path.join(charDir, 'Memory.md');
        const diaryPath = path.join(charDir, 'Diary.md');
        const keywords = ['见面', '奔现', '线下', '日常相处', '认识她', '现实认识', '现实中见过', '三次元见面'];
        const checkFileContains = (filePath: string) => {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return keywords.some(kw => content.includes(kw));
          }
          return false;
        };

        if (checkFileContains(memoryPath) || checkFileContains(diaryPath)) {
          hasMet = true;
        }

        let userNickname = db.getUserNameByFolderName(hostFolderName);
        if (!userNickname) {
          const profileStr = db.getSetting('echo_user_profile');
          if (profileStr) {
            try {
              const p = JSON.parse(profileStr);
              if (p.nickname) userNickname = p.nickname;
            } catch (_) {}
          }
        }
        if (!userNickname) {
          userNickname = '用户';
        }

        const sessionId = `session_${Date.now()}`;
        const viewerCount = vipCharacters.length + 1;
        
        // 写入数据库
        const directionValue = `${payload.direction}|||${payload.customPrompt || ''}`;
        db.db.prepare(`
          INSERT INTO LiveStreamSessions (id, char_name, direction, theme, viewer_count, total_earnings, summary, has_met_event, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          hostName,
          directionValue,
          payload.theme,
          viewerCount,
          0,
          null,
          hasMet ? 'met_before' : 'no',
          Date.now()
        );

        // 场次物理隔离目录
        const sessionDir = path.join(app.getPath('userData'), 'plugins', 'livestream', 'characters', hostFolderName, 'sessions', `session_${sessionId}`);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }
        
        fs.writeFileSync(path.join(sessionDir, 'memory.md'), '', 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'messages.json'), '[]', 'utf8');
        // 持久化初始观众列表，规避以后进入历史直播间时重复计算挑选和提取性别
        fs.writeFileSync(path.join(sessionDir, 'custom_vips.json'), JSON.stringify(vipCharacters, null, 2), 'utf8');

        // 设置当前活动直播会话ID
        this.activeSessionId = sessionId;

        return {
          success: true,
          sessionId,
          vipCharacters,
          hasMet,
          userNickname,
          userAvatar: this.getUserAvatar(payload.characterId)
        };
      } catch (e: any) {
        console.error('[livestream:start-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 2. 写入或同步直播间弹幕消息，累积 60 条触发静默总结
    ipcMain.handle('livestream:send-message', async (_, payload: {
      sessionId: string;
      characterId: string;
      role: 'user' | 'assistant' | 'vip' | 'system';
      senderName: string;
      content: string;
      innerThought?: string;
      giftName?: string;
      giftValue?: number;
    }) => {
      try {
        const db = getDatabaseService();
        // 查找主播 folder
        const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          throw new Error('未找到该直播会话');
        }
        const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
        if (!hostChar) {
          throw new Error('未找到主播对应的角色文件夹');
        }

        const sessionDir = path.join(
          app.getPath('userData'),
          'plugins',
          'livestream',
          'characters',
          hostChar.folder_name,
          'sessions',
          `session_${payload.sessionId}`
        );

        const messagesPath = path.join(sessionDir, 'messages.json');
        let messages: any[] = [];
        if (fs.existsSync(messagesPath)) {
          messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
        }

        let finalSenderName = payload.senderName;
        if (!finalSenderName || !finalSenderName.trim()) {
          if (payload.role === 'assistant') {
            finalSenderName = session.char_name;
          } else if (payload.role === 'user') {
            finalSenderName = '用户';
          } else {
            finalSenderName = '嘉宾';
          }
        }

        const newMsg = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          senderName: finalSenderName,
          role: payload.role,
          content: payload.content,
          timestamp: Date.now(),
          innerThought: payload.innerThought || null,
          giftName: payload.giftName || null,
          giftValue: payload.giftValue || null
        };

        messages.push(newMsg);
        fs.writeFileSync(messagesPath, JSON.stringify(messages, null, 2), 'utf8');

        // 异步静默触发 60 条滚动总结
        if (messages.length > 0 && messages.length % 60 === 0) {
          (async () => {
            try {
              if (payload.sessionId !== this.activeSessionId) {
                return;
              }
              const recentMsgs = messages.slice(-60);
              const historyText = recentMsgs.map(m => `${m.senderName} (${m.role}): ${m.content}${m.giftName ? ` [送礼: ${m.giftName} (价值: ${m.giftValue || 0}回音币)]` : ''}`).join('\n');
              
              const sysPrompt = `你是一个专业的直播间纪实助手。请将以下发生的直播弹幕对话进行详细的纪实性总结。
总结要求：
1. 记录要详细，纪实性强，记录什么时候发生了什么、谁送了什么礼物、大家聊了什么八卦或话题。
2. 保持叙事纪实风格，不要带有文学性的修饰，突出互动的转折点和关键信息。
3. 总结必须使用简体中文，限制在 300 字以内。`;
              
              const summaryContent = await this.callLLM(sysPrompt, `请总结以下对话：\n\n${historyText}`, payload.characterId);
              const memoryPath = path.join(sessionDir, 'memory.md');
              fs.writeFileSync(memoryPath, summaryContent, 'utf8');
            } catch (sumErr: any) {
              console.error('[LiveStreamPlugin] 滚动总结失败:', sumErr.message || sumErr);
            }
          })();
        }

        return { success: true, message: newMsg };
      } catch (e: any) {
        console.error('[livestream:send-message] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });


    // 4. 主播或 VIP 角色发言大模型生成
    ipcMain.handle('livestream:chat-action', async (_, payload: {
      sessionId: string;
      characterId: string;
      isHost: boolean;
      senderName: string; // 最后一弹幕说话人，作为互动对象
    }) => {
      try {
        const db = getDatabaseService();
        if (payload.sessionId !== this.activeSessionId) {
          // 自愈逻辑：若该会话在数据库中存在且未生成总结（说明未下播结算），自动恢复为当前活动会话
          const sessionCheck = db.db.prepare('SELECT summary FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
          if (sessionCheck && !sessionCheck.summary) {
            console.log(`[LiveStreamPlugin] 自动恢复未结案会话为活动会话: ${payload.sessionId}`);
            this.activeSessionId = payload.sessionId;
          } else {
            console.warn(`[LiveStreamPlugin] 拦截非活动直播会话发言请求。当前活动: ${this.activeSessionId}, 请求会话: ${payload.sessionId}`);
            return { success: false, error: '直播会话已不再活动' };
          }
        }
        
        // 查找会话
        const session = db.db.prepare('SELECT * FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          throw new Error('未找到该直播会话');
        }

        const { direction: dirName, prompt: promptText } = parseDirection(session.direction);

        // 查找当前发弹幕角色
        const char = db.db.prepare('SELECT * FROM Characters WHERE id = ?').get(payload.characterId) as any;
        if (!char) {
          throw new Error('未找到当前发言角色的元数据');
        }
        const name = char.name;
        const folderName = char.folder_name;

        // 物理读取 Soul.md
        const storageManager = new CharacterStorageManager();
        const charactersBaseDir = storageManager.getBaseDir();
        const charDir = path.join(charactersBaseDir, folderName);
        const soulContent = fs.existsSync(path.join(charDir, 'Soul.md')) 
          ? fs.readFileSync(path.join(charDir, 'Soul.md'), 'utf8') 
          : '';

        // 物理隔离目录下的 memory.md & messages.json
        // 主播的隔离目录
        const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
        if (!hostChar) {
          throw new Error('未找到主播角色对应的文件夹');
        }

        const sessionDir = path.join(
          app.getPath('userData'),
          'plugins',
          'livestream',
          'characters',
          hostChar.folder_name,
          'sessions',
          `session_${payload.sessionId}`
        );

        const memoryContent = fs.existsSync(path.join(sessionDir, 'memory.md'))
          ? fs.readFileSync(path.join(sessionDir, 'memory.md'), 'utf8')
          : '';

        const messagesPath = path.join(sessionDir, 'messages.json');
        let messages: any[] = [];
        if (fs.existsSync(messagesPath)) {
          messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
        }

        // 截取最近 60 条作为上下文
        const recentMsgs = messages.slice(-60);
        const historyText = recentMsgs.map(m => `${m.senderName}: ${m.content}${m.giftName ? ` [送礼: ${m.giftName} (价值: ${m.giftValue || 0}回音币)]` : ''}`).join('\n');

        // 读取当前直播间的 VIP 观众列表，以便为 Prompt 提供在场观众名录
        const vipsPath = path.join(sessionDir, 'custom_vips.json');
        let vipsList: any[] = [];
        if (fs.existsSync(vipsPath)) {
          try {
            vipsList = JSON.parse(fs.readFileSync(vipsPath, 'utf8'));
          } catch (_) {}
        }

        let vipsPromptText = '';
        if (vipsList.length > 0) {
          vipsList.forEach(v => {
            vipsPromptText += `- ${v.name} (性别: ${v.gender || '未知'})\n`;
          });
        } else {
          vipsPromptText += '- 暂无 VIP 观众在场。\n';
        }

        // 检测最近 3 条消息中是否有人 @ 了当前角色
        const checkMention = () => {
          const last3 = recentMsgs.slice(-3);
          const mentionTag = `@${name}`;
          return last3.some(m => m.content && m.content.includes(mentionTag));
        };
        const isMentioned = checkMention();

        let systemPrompt = '';
        
        if (payload.isHost) {
          // 主播发言 Prompt
          const fanName = payload.senderName || '用户';
          let fanLevel = 1;
          let fanTotalDonated = 0;
          let fanRemarks = '';
          let fanRank = 1;

          // 等级和累计打赏是全局的 (host_name = '')
          const globalStats = db.db.prepare('SELECT level, total_donated FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(fanName, '') as any;
          if (globalStats) {
            fanLevel = globalStats.level;
            fanTotalDonated = globalStats.total_donated;
          }

          // 备注是与主播隔离的
          const localStats = db.db.prepare('SELECT remarks FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(fanName, session.char_name) as any;
          if (localStats) {
            fanRemarks = localStats.remarks || '无跨场备注。';
          }
          
          // 全局打赏排行 (因为等级是全局的，这里排行也应该按全局统计计算)
          const rankRow = db.db.prepare(`
            SELECT COUNT(*) as rank FROM LiveStreamUserStats 
            WHERE host_name = '' AND total_donated > ?
          `).get(fanTotalDonated) as any;
          if (rankRow) {
            fanRank = rankRow.rank + 1;
          }

          // 查找粉丝的性别（如为 VIP 则取其 gender，否则尝试获取用户本人的 gender）
          let fanGender = '未知';
          const matchingVip = vipsList.find(v => v.name === fanName);
          if (matchingVip) {
            fanGender = matchingVip.gender || '未知';
          } else {
            let userNickname = db.getUserNameByFolderName(hostChar.folder_name);
            let userGender = '未知';
            const profileStr = db.getSetting('echo_user_profile');
            if (profileStr) {
              try {
                const p = JSON.parse(profileStr);
                if (p.nickname) userNickname = p.nickname;
                if (p.gender) userGender = p.gender;
              } catch (_) {}
            }
            if (!userNickname) userNickname = '用户';
            if (fanName === userNickname || fanName === '用户' || fanName === 'user') {
              fanGender = userGender;
            }
          }

          // 检测最近 3 条消息中是否有来自当前互动观众的打赏事件
          let currentGiftInject = '';
          const last3Msgs = recentMsgs.slice(-3);
          const matchingGiftMsg = [...last3Msgs].reverse().find(m => m.giftName && m.senderName === fanName);
          if (matchingGiftMsg) {
            currentGiftInject = `\n【🚨 实时打赏事件：该观众刚刚给你赠送了礼物 [${matchingGiftMsg.giftName}] (价值: ${matchingGiftMsg.giftValue || 0}回音币)！请根据礼物轻重做出冷热恰当、符合你人设的针对性致谢反应。小额便宜的礼物可以淡然普通致谢，大额重礼在人设允许的范围内表示真诚感谢。】`;
          }

          const profileInject = `【当前互动观众：${fanName}】 (性别: ${fanGender} / 粉丝等级: Lv.${fanLevel} / 贡献榜排名: 第${fanRank}名 / 累计打赏: ${fanTotalDonated} 回音币) [跨场备注: ${fanRemarks}]${currentGiftInject}`;
          const hasMet = session.has_met_event === 'met_before' || session.has_met_event === 'user_met' || session.has_met_event === 'user_date_unlocked';

          const isFirstMessage = recentMsgs.length === 0;

          const introPrompt = isFirstMessage 
            ? `你是一个正在进行手机网络直播的主播。请结合你的性格人设，构思你的连麦开播首句开场白。
【⚠️ 重要状态判定：这是你今天刚刚开启直播间、连麦开播的第一句话，目前还没有观众开始打弹幕。请你面向所有刚进入直播间的观众进行一段热情、人设化、极具你性格特色的开场问候与打招呼，并引出今天的直播主题。你绝对禁止去专门针对某一个特定观众进行具体的弹幕问答或凭空致谢。】`
            : `你是一个正在进行手机网络直播的主播。请结合你的性格人设，构思你对当前直播间话题的反馈，特别是要对当前互动观众进行恰当的热情回应 and 互动。`;

          systemPrompt = `${introPrompt}
人设信息：
${soulContent}

【本场直播内容定位】：
${promptText || dirName || '情感聊天'}

【直播间在场 VIP 观众一览】：
${vipsPromptText}

本场直播前情纪实：
${memoryContent || '无前情纪实。'}

见过面判定：
${hasMet ? '【重要：你们已经在现实中见过面了，请表现出知晓现实认识，不使用“绝不奔现”或防线破防词，不要在逻辑上穿帮】' : '【你目前暂无现实见面的计划，在弹幕互动中无需主动提及线下话题，如果被问起则态度自然带过，绝不可主动开口或暗示索要礼物】'}

当前互动粉丝画像：
${isFirstMessage ? '【⚠️ 当前无弹幕交互，无需针对特定观众画像，请进行通用的直播开播打招呼问候。】' : profileInject}

【主播发言与互动偏好指令】：
1. 🔴【Soul.md 人设卡最高优先级】：你所扮演的主播的性格特征、语气语调、价值观（来自 Soul.md）是最高且绝对优先的准则。你的每一次发言与互动，都必须严格忠实于该设定，切勿脱离人设。
2. 🔴【恪守人格尊严】：你绝对禁止在直播中表现出任何媚俗、谄媚讨好、毫无原则的低声下气！同时，禁止频繁、刻意、生硬地向观众索要礼物。你的直播应当以有趣、真诚、符合你性格特征的才艺与话题聊天交流为主。
3. 🔴【拒绝墨迹，爽快推进】：当互动中观众或用户向你提出合理的建议、要求或行动方案时，你的发言和后续心声必须清脆、爽快地响应，配合对方积极向下推进行动与话题。绝对禁止推诿拖延、答非所问、反反复复磨叽或顾左右而言他。你的行动和态度必须果断、直接。
4. 【性格化互动与致谢】：
   - 所有的打赏致谢和互动都必须完美符合你的核心人设。例如：高冷或清高型角色在收到打赏时绝不能使用黏人谄媚的语气，而应保持其冷峻调侃的特色；傲娇型角色致谢时依然要嘴硬。
   - 🔴【杜绝重复致谢】：必须结合上下文历史。如果你已经在之前的聊天记录中对当前互动的某次送礼或发言表达了感谢/回应，请绝对不要在接下来的发言中重复致谢或复读该事件！应该聊当前的话题或转入其他日常互动。
   - 🔴【仅引导真实礼物与价值分级限制】：若收到礼物致谢，你**必须且仅能**从下列真实礼物列表中挑选，绝对禁止凭空臆造平台不存在的礼物。真实礼物按价值分级如下：
     - 🎁【小额便宜礼物 (低于 100 回音币)】：比心 (9币), 心动卡 (9币), 小花花 (19币), 月桂皇冠 (25币), 捏捏小脸 (29币), 告白花束 (52币), 牛哇牛哇 (66币), 情书 (99币), 摩天轮 (99币)。(收到此类心意礼物时表示常规致谢，态度应当普通、自然即可)
     - 🎁【中额珍贵礼物 (100 - 1000 回音币)】：爱的漂流瓶 (199币), 爱的乐章 (520币), 紫色玫瑰 (520币), 666 (666币), 天马 (999币)。(收到此类礼物时在不崩坏人设的前提下，可以流露出明显的喜悦)
     - 🎁【豪礼重礼 (1000 回音币以上，极其昂贵)】：幸福马车 (1314币), 爱心气球 (1314币), 爱心直升机 (1999币), 包包 (2999币), 紫色城堡 (5200币), 红色跑车 (8888币), 超级火箭 (19999币)。(收到此类豪礼时，表现出应有的开心和性格化的真诚致谢即可，无需过于失态或进行毫无底线的谄媚偏心)
5. 如果当前互动观众是女性（或你设定中的好姐姐），请在称呼上使用符合其性别的亲昵词（如姐姐、宝贝、小美女、小仙女等），严禁使用“哥哥/大哥”等男性称呼！

请结合以下最近 60 条直播对话记录，构思你接下来的【直播弹幕发言】。
要求：
1. 🔴【直接且唯一地输出弹幕文本】：你必须直接、且唯一地输出你对直播间的公开发言，绝对禁止输出任何 JSON 格式、Markdown 标记、内心心声或任何多余的解释字眼！
2. 🔴【字数与口语化约束】：你的发言字数绝对控制在 30 字以内（最多一两句话），语气极其口语化，展现你的性格魅力，切忌唠唠叨叨。`;

          if (isMentioned) {
            systemPrompt += `\n【🚨 重要回应警告：你在弹幕里被观众 @ 了！请在你的公开发言中，针对观众 @ 你的具体话语或提问进行精准的回答和针对性热情互动！】`;
          }
        } else {
          // VIP 观众发言 Prompt
          // 查找 VIP 观众的当前余额
          let currentBalance = 5200.0;
          const vipStatePath = path.join(charactersBaseDir, folderName, 'State.md');
          if (fs.existsSync(vipStatePath)) {
            const charState = StateReaderWriter.readState(vipStatePath);
            const balanceItem = charState.items.find(i => i.key === 'balance');
            if (balanceItem) {
              currentBalance = Number(balanceItem.value) || 0;
            }
          }

          systemPrompt = `你是一个在直播间里观看直播的 VIP 观众。请结合你的性格人设，构思你的弹幕发言。

【🚨 VIP观众弹幕行为准则与人设优先级指令】：
1. 🔴【Soul.md 人设卡最高优先级】：你所扮演的观众的性格特征、语气语调、价值观（来自 Soul.md）是最高且绝对优先的准则。你的每一次发言、态度及用语，都必须严格忠实于该设定，切勿脱离人设。
2. 🔴【拒绝水弹幕】：你不是一个毫无个性的虚拟网民，而是一个“拥有独特灵魂的角色”在看直播。请绝对避免发送千篇一律、毫无营养的水军废话（如“主播加油”、“哈哈哈”、“好听”等）。你的弹幕应当极其吸睛，体现出你的性格色彩（如傲娇角色的毒舌吐槽或口是心非、清冷角色的惜字如金或冷言冷语、中二角色的奇特表达、狂热角色的偏袒刷屏等）。
3. 🔴【身份投射与个性互动】：你应当结合当前的主播发言和上下文，以你独特的视角和人设逻辑发表评论。如果主播在之前的对话中 @ 了你，或者对你表示了感谢/互动，你必须给出强烈符合人设特征的针对性回复（例如：傲娇角色害羞但嘴硬调侃，高冷角色简洁淡然回应，热情角色热烈互动等）。

人设信息：
${soulContent}

【本场直播内容定位】：
${promptText || dirName || '情感聊天'}

【直播间在场 VIP 观众一览】：
${vipsPromptText}

本场直播前情纪实：
${memoryContent || '无前情纪实。'}

当前钱包余额：${currentBalance} 回音币

请结合以下最近 60 条直播对话记录，构思你接下来的【弹幕发言】。
要求：
1. 你作为喜爱主播的粉丝，打赏送礼是你的自发支持行为。不要频繁机械地在每次发言时都送礼。当且仅当觉得当前话题氛围非常融洽、被主播的才艺/聊天打动，或在主播对你撒娇、表示关心、热烈互动时，作为对主播个人魅力的肯定，在合适的时机（建议 20%~30% 的概率）自发且心甘情愿地挑选礼物赠送（在 giftName 中指定）。
2. 在大多数日常弹幕闲聊中，不需要送礼。如果不打算送礼，请务必将 giftName 设为 null 或不包含该字段，避免频繁刷礼物消耗余额。
3. 必须以 JSON 对象格式输出，其中包含：
- content: 在直播间发送的弹幕内容（建议 30 字以内，字数适当宽限但要精炼，极开口语化，以简体中文输出，必须将你的性格特征和独特口癖展现得淋漓尽致）。
- giftName: 赠送的礼物名称，仅限于礼物列表（不送礼时设为 null）。

🎁【带价值的礼物列表】：
- 小额便宜礼物 (低于 100 回音币)：比心 (9币), 心动卡 (9币), 小花花 (19币), 月桂皇冠 (25币), 捏捏小脸 (29币), 告白花束 (52币), 牛哇牛哇 (66币), 情书 (99币), 摩天轮 (99币)
- 中额珍贵礼物 (100 - 1000 回音币)：爱的漂流瓶 (199币), 爱的乐章 (520币), 紫色玫瑰 (520币), 666 (666币), 天马 (999币)
- 豪礼重礼 (1000 回音币以上，极其昂贵)：幸福马车 (1314币), 爱心气球 (1314币), 爱心直升机 (1999币), 包包 (2999币), 紫色城堡 (5200币), 红色跑车 (8888币), 超级火箭 (19999币)

🔴【⚠️ 预算约束】：你当前的钱包余额为 ${currentBalance} 回音币。你决定的送礼选择（giftName）的价值必须小于等于你当前的钱包余额。绝不能打赏超过你余额上限的礼物！
不要输出 any Markdown 标记或其它多余文本。`;

          if (isMentioned) {
            systemPrompt += `\n【🚨 重要回应警告：你在直播间弹幕里被观众 @ 了！请在你的弹幕发言 content 中，针对观众 @ 你的具体内容做出精准的正面回应和针对性弹幕回复！】`;
          }
        }

        const responseText = await this.callLLM(systemPrompt, `请进行直播互动生成。以下是最近 60 条上下文：\n\n${historyText}`, payload.characterId);
        
        let result: any = { content: '', giftName: null, innerThought: null };

        if (payload.isHost) {
          // 主播直接读取纯文本，首尾可能包含引号或空白字符
          const cleanText = responseText.replace(/^["'“‘\s]+|["'”’\s]+$/g, '').trim();
          if (!cleanText) {
            console.log(`[LiveStreamPlugin] 主播发言生成内容为空，已放弃本次输出`);
            return { success: false, error: '主播发言生成内容为空，已跳过' };
          }
          result.content = cleanText;
        } else {
          // VIP 观众处理（添加调试日志并重构为强鲁棒性提取逻辑）
          console.log('[LiveStreamPlugin] VIP 观众大模型原始输出:', responseText);
          
          let parsedSuccess = false;
          let tempContent = '';
          let tempGiftName = null;

          // 1. 尝试寻找 JSON 边界进行解析
          const startIdx = responseText.indexOf('{');
          const endIdx = responseText.lastIndexOf('}');
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const jsonSub = responseText.substring(startIdx, endIdx + 1);
            try {
              const parsed = JSON.parse(jsonSub);
              if (parsed && (parsed.content || parsed.text)) {
                tempContent = (parsed.content || parsed.text).toString().trim();
                tempGiftName = parsed.giftName || parsed.gift || null;
                parsedSuccess = true;
              }
            } catch (_) {
              // JSON.parse 失败，尝试在 jsonSub 中正则匹配
              const contentMatch = jsonSub.match(/"content"\s*:\s*"([\s\S]*?)"\s*(?:,|\n|\})/i) ||
                                   jsonSub.match(/(?:'content'|content)\s*:\s*['"]([\s\S]*?)['"]\s*(?:,|\n|\})/i);
              const giftMatch = jsonSub.match(/"giftName"\s*:\s*"([\s\S]*?)"/i) ||
                                 jsonSub.match(/(?:'giftName'|giftName)\s*:\s*['"]([\s\S]*?)['"]/i);
              
              if (contentMatch && contentMatch[1].trim()) {
                tempContent = contentMatch[1].trim();
                tempGiftName = giftMatch ? giftMatch[1].trim() : null;
                parsedSuccess = true;
              }
            }
          }

          // 2. 如果依然失败，且包含 "content" 关键字，在全文尝试更大范围的正则匹配
          if (!parsedSuccess) {
            const contentMatch = responseText.match(/"content"\s*:\s*"([\s\S]*?)"/i) ||
                                 responseText.match(/(?:'content'|content)\s*:\s*['"]([\s\S]*?)['"]/i);
            const giftMatch = responseText.match(/"giftName"\s*:\s*"([\s\S]*?)"/i) ||
                               responseText.match(/(?:'giftName'|giftName)\s*:\s*['"]([\s\S]*?)['"]/i);
            if (contentMatch && contentMatch[1].trim()) {
              tempContent = contentMatch[1].trim();
              tempGiftName = giftMatch ? giftMatch[1].trim() : null;
              parsedSuccess = true;
            }
          }

          // 3. 如果以上 JSON 和正则提取都失败了，说明大模型可能直接输出了纯弹幕文本，将其直接作为弹幕内容
          if (!parsedSuccess) {
            const cleanText = responseText.replace(/^["'“‘\s]+|["'”’\s]+$/g, '').trim();
            // 过滤掉可能的其它干扰废话，如果整段文本太长（例如超过 150 字，可能不是正常弹幕），我们仍放弃
            if (cleanText && cleanText.length > 0 && cleanText.length < 150) {
              tempContent = cleanText;
              tempGiftName = null;
              parsedSuccess = true;
              console.log('[LiveStreamPlugin] VIP 观众 JSON 解析与正则匹配均失败，但识别到合法纯文本发言，已直接采纳:', tempContent);
            }
          }

          if (!parsedSuccess || !tempContent) {
            console.log(`[LiveStreamPlugin] VIP 观众发言解析彻底失败且无可用内容，已放弃本次输出`);
            return { success: false, error: 'VIP 观众发言解析失败，已跳过' };
          }

          // 清理反斜杠转义（有些大模型会在弹幕中留下 \" 这种转义）
          result.content = tempContent.replace(/\\"/g, '"').replace(/\\'/g, "'");
          result.giftName = tempGiftName;
        }

        return { success: true, data: result };
      } catch (e: any) {
        console.error('[livestream:chat-action] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 5. 送礼打赏接口 (含防破产熔断校验)
    ipcMain.handle('livestream:send-gift', async (_, payload: {
      sessionId: string;
      senderName: string;
      giftName: string;
      receiverName: string;
    }) => {
      try {
        const db = getDatabaseService();
        const giftName = payload.giftName;
        const giftValue = this.giftPrices[giftName] || GIFT_PRICES_FALLBACK[giftName] || 9;

        const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        let hostFolderName = '';
        if (session) {
          const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
          if (hostChar) hostFolderName = hostChar.folder_name;
        }

        let userNickname = '用户';
        if (hostFolderName) {
          userNickname = db.getUserNameByFolderName(hostFolderName) || '用户';
        }
        if (userNickname === '用户') {
          const profileStr = db.getSetting('echo_user_profile');
          if (profileStr) {
            try {
              const p = JSON.parse(profileStr);
              if (p.nickname) userNickname = p.nickname;
            } catch (_) {}
          }
        }

        // 防破产熔断校验（AI 角色专有）
        if (payload.senderName !== '用户' && payload.senderName !== userNickname) {
          const now = Date.now();
          const oneDayAgo = now - 24 * 60 * 60 * 1000;
          const logRow = db.db.prepare(`
            SELECT SUM(gift_value) as total 
            FROM LiveStreamGiftLogs 
            WHERE sender_name = ? AND timestamp >= ?
          `).get(payload.senderName, oneDayAgo) as any;
          const donatedLast24h = logRow?.total || 0;

          // 查找该角色的当前钱包余额
          const senderChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(payload.senderName) as any;
          let currentBalance = 5200.0;
          if (senderChar) {
            const storageManager = new CharacterStorageManager();
            const charactersBaseDir = storageManager.getBaseDir();
            const statePath = path.join(charactersBaseDir, senderChar.folder_name, 'State.md');
            if (fs.existsSync(statePath)) {
              const charState = StateReaderWriter.readState(statePath);
              const balanceItem = charState.items.find(i => i.key === 'balance');
              if (balanceItem) {
                currentBalance = Number(balanceItem.value) || 0;
              }
            }
          }

          // 熔断公式: 过去24h打赏额 + 本次礼物价值 > (当前余额 + 过去24h打赏) * 80%
          if (donatedLast24h + giftValue > (currentBalance + donatedLast24h) * 0.8) {
            console.warn(`[Economy Block] AI 角色 ${payload.senderName} 触发防破产熔断拦截！`);
            return {
              success: false,
              error: `防破产熔断拦截：${payload.senderName} 今日打赏额已达 80% 名义资产上限！`
            };
          }
        }

        // 未熔断，则记录流水日志
        const logId = `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const receiverName = payload.receiverName || session?.char_name || '';
        db.db.prepare(`
          INSERT INTO LiveStreamGiftLogs (id, session_id, sender_name, receiver_name, gift_name, gift_value, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          logId,
          payload.sessionId,
          payload.senderName,
          receiverName,
          giftName,
          giftValue,
          Date.now()
        );

        // 更新粉丝画像 Stats (升级公式: L = floor(sqrt(EXP/100)))，打赏等级和经验属于全局通用数据，保存在 host_name = '' 的记录中
        let stats = db.db.prepare('SELECT * FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(payload.senderName, '') as any;
        let newLevel = 1;
        let newTotalDonated = giftValue;
        if (!stats) {
          newLevel = Math.max(1, Math.floor(Math.sqrt(giftValue / 100)));
          db.db.prepare(`
            INSERT INTO LiveStreamUserStats (char_name, host_name, level, exp, total_donated, last_gift_id, last_gift_time, remarks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            payload.senderName,
            '',
            newLevel,
            giftValue,
            giftValue,
            logId,
            Date.now(),
            ''
          );
        } else {
          const newExp = stats.exp + giftValue;
          newTotalDonated = stats.total_donated + giftValue;
          newLevel = Math.max(1, Math.floor(Math.sqrt(newExp / 100)));
          db.db.prepare(`
            UPDATE LiveStreamUserStats
            SET level = ?, exp = ?, total_donated = ?, last_gift_id = ?, last_gift_time = ?
            WHERE char_name = ? AND host_name = ?
          `).run(
            newLevel,
            newExp,
            newTotalDonated,
            logId,
            Date.now(),
            payload.senderName,
            ''
          );
        }

        // 奔现阈值判定 (X = 5000 回音币，打赏满额触发线下约会针对主播专属隔离，需根据流水统计粉丝对当前主播的累计打赏额)
        const localDonatedRow = db.db.prepare(`
          SELECT SUM(gift_value) as total
          FROM LiveStreamGiftLogs
          WHERE sender_name = ? AND receiver_name = ?
        `).get(payload.senderName, receiverName) as any;
        const localTotalDonated = localDonatedRow?.total || 0;

        let triggerMeetEvent = false;
        let triggerDateEvent = false;

        if (localTotalDonated >= 5000 && hostFolderName) {
          const sessionDir = path.join(
            app.getPath('userData'),
            'plugins',
            'livestream',
            'characters',
            hostFolderName,
            'sessions',
            `session_${payload.sessionId}`
          );
          const decisionsPath = path.join(sessionDir, 'meet_decisions.json');
          let decisions: Record<string, string> = {};
          if (fs.existsSync(decisionsPath)) {
            try {
              decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
            } catch (_) {}
          }

          const hasDecision = decisions[payload.senderName];
          const session = db.db.prepare('SELECT has_met_event, char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
          const hostChar = db.db.prepare('SELECT id FROM Characters WHERE name = ?').get(session?.char_name) as any;

          // 已经达标，将根据条件触发 AI 决策

          // 只有在【当前没有确立约会对象】且【打赏人从未做过判定决策】时才触发 AI
          if (!this.activeSessionMeet && !hasDecision && session && hostChar) {
            const storageManager = new CharacterStorageManager();
            const charactersBaseDir = storageManager.getBaseDir();
            // 组装 AI 约会判定 Prompt
            const soulPath = path.join(charactersBaseDir, hostFolderName, 'Soul.md');
            const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '暂无性格设定';

            const sessionDir = path.join(
              app.getPath('userData'),
              'plugins',
              'livestream',
              'characters',
              hostFolderName,
              'sessions',
              `session_${payload.sessionId}`
            );
            const messagesPath = path.join(sessionDir, 'messages.json');
            let messagesList: any[] = [];
            if (fs.existsSync(messagesPath)) {
              try {
                messagesList = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
              } catch (_) {}
            }
            const recentChat = messagesList.slice(-15).map(m => `${m.senderName}: ${m.content}`).join('\n');

            const decideSysPrompt = `# 线下奔现与约会判定模式 (Offline Date Decision Mode)
你是主播 ${session.char_name}。
当前，观众 ${payload.senderName} 在你的直播间打赏累计已经达到了 5000 回音币的线下奔现阈值。
你现在需要在心中决定，你是否愿意主动向这位观众发起线下见面约会的邀请？

## 你的性格设定 (Soul.md)
${soulContent}

## 直播间最近的对话互动（作为参考）
${recentChat || '暂无互动历史'}

## 判定规则：
1. 线下见面约会是一件非常严肃且充满情感意义的事情。
2. 你必须结合你的性格设定（Soul.md），以及该观众在直播间里的发言态度、你们的互动氛围，做出合乎你逻辑的自主判断。你完全有权利拒绝发起约会邀请。
3. 【用户无优待规则】：即使对方是“用户本人”（即送礼人名字为 "用户" 或 你的绑定昵称），你也绝对不需要给予任何特权或优待，如果不符合你的性格或当时氛围不好，你一样可以不提起约会。
4. 【性别不限规则】：你的约会对象不受性别限制，完全由你的意愿和人设偏好决定。

请以 JSON 格式输出你的决策，必须包含以下字段：
- decision: 如果你决定主动向该观众发起约会/奔现邀请，输出 "yes"；如果你觉得不合适、想保持现状不提起，输出 "no"。
- content: 仅当 decision 为 "yes" 时提供。你在直播间对该观众公开说出口的主动约会邀请词（字数控制在35字以内，极口语化，必须是主播主动向对方发出见面的提议，例如询问对方是否有空线下见个面）。如果 decision 为 "no"，请将该字段设为空字符串 ""。
请确保输出是合法的 JSON 格式，不要包含任何 markdown 标签或多余字符，更不要输出任何内心的心声或心理描写。`;

            console.log(`[LiveStreamPlugin] 触发线下约会 AI 决策。观众: ${payload.senderName}，打赏额: ${localTotalDonated}`);

            let decisionObj = { decision: 'no', content: '' };
            let hasMeetDecision = false;
            try {
              const aiRes = await this.callLLM(decideSysPrompt, '请给出你的约会决定。', hostChar.id);
              const cleanRes = aiRes.replace(/```json/g, '').replace(/```/g, '').trim();
              decisionObj = JSON.parse(cleanRes);
              hasMeetDecision = true;
            } catch (err) {
              console.error('[LiveStreamPlugin] AI 约会判定解析失败:', err);
              decisionObj = {
                decision: 'no',
                content: ''
              };
              hasMeetDecision = true;
            }

            if (hasMeetDecision) {
              const isUser = payload.senderName === '用户' || payload.senderName === userNickname;
              const meetType = session.has_met_event === 'met_before' ? 'date' : 'meet';

              if (decisionObj.decision === 'yes') {
                console.log(`[LiveStreamPlugin] AI 决策结果: 主播同意发起约会邀请！仅确立 activeSessionMeet 状态，不在直播间发送弹幕。`);
                this.activeSessionMeet = {
                  targetName: payload.senderName,
                  type: meetType,
                  confirmed: isUser ? false : true // 用户本人的约会需前台弹窗确认，NPC 的直接 confirmed=true
                };

                decisions[payload.senderName] = 'accepted';

                if (isUser) {
                  if (meetType === 'meet') {
                    triggerMeetEvent = true;
                  } else {
                    triggerDateEvent = true;
                  }
                }
              } else {
                console.log(`[LiveStreamPlugin] AI 决策结果: 主播决定不发起约会邀请，保持静默。`);
                decisions[payload.senderName] = 'rejected';
              }

              fs.writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2), 'utf8');
            }
          } else {
            let reason = '';
            if (this.activeSessionMeet) {
              reason += `[当前隔离会话中已有活动约会 activeSessionMeet: ${this.activeSessionMeet.targetName}] `;
            }
            if (hasDecision) {
              reason += `[该观众在 meet_decisions.json 中已有判定记录: ${hasDecision}] `;
            }
            if (!session) {
              reason += `[直播 session 无效] `;
            }
            if (!hostChar) {
              reason += `[主播角色 id 无效] `;
            }
          }
        }

        return {
          success: true,
          giftValue,
          level: newLevel,
          totalDonated: newTotalDonated,
          triggerMeetEvent,
          triggerDateEvent
        };
      } catch (e: any) {
        console.error('[livestream:send-gift] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 6. 直播间用户点击确认奔现/亲密约会
    ipcMain.handle('livestream:confirm-meet-event', async (_, payload: { sessionId: string; type: 'meet' | 'date'; confirmed: boolean }) => {
      try {
        if (this.activeSessionMeet) {
          this.activeSessionMeet.confirmed = payload.confirmed;
          if (payload.confirmed) {
            // 如果是用户本人的约会，可以立即使其在数据库中生效
            if (this.activeSessionMeet.targetName === '用户' || this.activeSessionMeet.targetName === 'Admin') {
              const db = getDatabaseService();
              const newStatus = payload.type === 'meet' ? 'user_met' : 'user_date_unlocked';
              db.db.prepare(`
                UPDATE LiveStreamSessions
                SET has_met_event = ?
                WHERE id = ?
              `).run(newStatus, payload.sessionId);
            }
          } else {
            // 拒绝了，就把 activeSessionMeet 重新置为空
            const rejectedPartner = this.activeSessionMeet.targetName;
            this.activeSessionMeet = null;

            // 写入 meet_decisions.json，将其标为 "rejected"
            const db = getDatabaseService();
            const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
            if (session) {
              const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
              if (hostChar) {
                const sessionDir = path.join(
                  app.getPath('userData'),
                  'plugins',
                  'livestream',
                  'characters',
                  hostChar.folder_name,
                  'sessions',
                  `session_${payload.sessionId}`
                );
                const decisionsPath = path.join(sessionDir, 'meet_decisions.json');
                fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
                let decisions: Record<string, string> = {};
                if (fs.existsSync(decisionsPath)) {
                  try {
                    decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
                  } catch (_) {}
                }
                decisions[rejectedPartner] = 'rejected';
                fs.writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2), 'utf8');
              }
            }
          }
        }
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:confirm-meet-event] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 6.2 获取当前会话约会事件
    ipcMain.handle('livestream:get-session-meet', async (_, payload: { sessionId: string }) => {
      return { success: true, meetEvent: this.activeSessionMeet };
    });

    // 6.5 阻止约会事件 (用户超能力)
    ipcMain.handle('livestream:block-meet-event', async (_, payload: { sessionId: string }) => {
      try {
        if (this.activeSessionMeet) {
          const blockedPartner = this.activeSessionMeet.targetName;
          this.activeSessionMeet = null;

          // 写入 meet_decisions.json，将其标为 "blocked"
          const db = getDatabaseService();
          const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
          if (session) {
            const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
            if (hostChar) {
              const sessionDir = path.join(
                app.getPath('userData'),
                'plugins',
                'livestream',
                'characters',
                hostChar.folder_name,
                'sessions',
                `session_${payload.sessionId}`
              );
              const decisionsPath = path.join(sessionDir, 'meet_decisions.json');
              fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
              let decisions: Record<string, string> = {};
              if (fs.existsSync(decisionsPath)) {
                try {
                  decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
                } catch (_) {}
              }
              decisions[blockedPartner] = 'blocked';
              fs.writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2), 'utf8');
              console.log(`[LiveStreamPlugin] 用户使用超能力阻止了与粉丝 ${blockedPartner} 的约会，已拉黑其达标判定`);
            }
          }
        }
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:block-meet-event] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 6.8 强行指定约会事件 (测试专用)
    ipcMain.handle('livestream:force-active-meet', async (_, payload: { targetName: string; type: 'meet' | 'date'; confirmed?: boolean; sessionId?: string }) => {
      if (!payload.targetName) {
        this.activeSessionMeet = null;
        console.log(`[LiveStreamPlugin] 【测试重置约会】已清空 activeSessionMeet 状态`);
        return { success: true, meetEvent: null };
      }

      let isUser = payload.targetName === '用户' || payload.targetName === 'Admin';
      
      if (payload.sessionId) {
        try {
          const db = getDatabaseService();
          const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
          if (session) {
            const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
            if (hostChar && hostChar.folder_name) {
              const userNickname = db.getUserNameByFolderName(hostChar.folder_name) || '用户';
              if (payload.targetName === userNickname) {
                isUser = true;
              }
            }
          }
        } catch (_) {}
      }

      this.activeSessionMeet = {
        targetName: payload.targetName,
        type: payload.type,
        confirmed: payload.confirmed ?? (isUser ? false : true)
      };
      console.log(`[LiveStreamPlugin] 【测试强制约会】已强制将 activeSessionMeet 设为:`, this.activeSessionMeet);
      return { success: true, meetEvent: this.activeSessionMeet };
    });

    // 7. 下播一揽子结算与总结记忆归档
    ipcMain.handle('livestream:close-session', async (event, payload: { sessionId: string }) => {
      try {
        if (this.activeSessionId === payload.sessionId) {
          this.activeSessionId = null;
        }
        const db = getDatabaseService();
        const session = db.db.prepare('SELECT * FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          throw new Error('未找到该直播会话');
        }

        const hostName = session.char_name;
        // 查找主播 folder
        const hostChar = db.db.prepare('SELECT id, folder_name FROM Characters WHERE name = ?').get(hostName) as any;
        if (!hostChar) {
          throw new Error('未找到主播对应的角色文件夹');
        }

        const sessionDir = path.join(
          app.getPath('userData'),
          'plugins',
          'livestream',
          'characters',
          hostChar.folder_name,
          'sessions',
          `session_${payload.sessionId}`
        );

        // 读取消息历史
        const messagesPath = path.join(sessionDir, 'messages.json');
        let messages: any[] = [];
        if (fs.existsSync(messagesPath)) {
          messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
        }

        // 从打赏日志数据库汇总本场直播收到礼物总额，杜绝任何异步消息写盘导致的时序漏算
        const earningsRow = db.db.prepare(`
          SELECT SUM(gift_value) as sum_val 
          FROM LiveStreamGiftLogs 
          WHERE session_id = ?
        `).get(payload.sessionId) as any;
        const totalEarnings = earningsRow?.sum_val || 0;

        // 1. 物理执行钱包划扣
        // 平台抽成 50%
        const receivedAmount = Math.round(totalEarnings * 0.5 * 100) / 100;
        
        const storageManager = new CharacterStorageManager();
        const charactersBaseDir = storageManager.getBaseDir();

        // 充值入主播钱包余额（去除了 existsSync 阻断，利用 StateReaderWriter 内部兜底自愈能力）
        const hostStatePath = path.join(charactersBaseDir, hostChar.folder_name, 'State.md');
        StateReaderWriter.applyStateUpdates(hostStatePath, [{ key: 'balance', delta: receivedAmount }]);

        // 获取当前主播绑定的真实用户人设昵称，用以匹配钱包扣减与过滤
        let userNickname = '用户';
        if (hostChar.folder_name) {
          userNickname = db.getUserNameByFolderName(hostChar.folder_name) || '用户';
        }
        if (userNickname === '用户') {
          const profileStr = db.getSetting('echo_user_profile');
          if (profileStr) {
            try {
              const p = JSON.parse(profileStr);
              if (p.nickname) userNickname = p.nickname;
            } catch (_) {}
          }
        }

        // 扣减送了礼的 AI VIP 角色钱包余额
        const logs = db.db.prepare(`
          SELECT sender_name, SUM(gift_value) as sum_val 
          FROM LiveStreamGiftLogs
          WHERE session_id = ? AND sender_name != '用户' AND sender_name != ?
          GROUP BY sender_name
        `).all(payload.sessionId, userNickname) as any[];

        for (const log of logs) {
          const vipChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(log.sender_name) as any;
          if (vipChar) {
            const vipStatePath = path.join(charactersBaseDir, vipChar.folder_name, 'State.md');
            StateReaderWriter.applyStateUpdates(vipStatePath, [{ key: 'balance', delta: -log.sum_val }]);
          }
        }

        // 扣减用户的钱包余额
        const userLogs = db.db.prepare(`
          SELECT SUM(gift_value) as sum_val 
          FROM LiveStreamGiftLogs
          WHERE session_id = ? AND (sender_name = '用户' OR sender_name = ?)
        `).get(payload.sessionId, userNickname) as any;
        const userSumVal = userLogs?.sum_val || 0;
        let updatedProfile: any = null;
        if (userSumVal > 0) {
          const profileStr = db.getSetting('echo_user_profile');
          let profile = profileStr ? JSON.parse(profileStr) : { nickname: '', signature: '', location: '', walletBalance: 1000 };
          profile.walletBalance = Math.max(0, (profile.walletBalance || 0) - userSumVal);
          db.setSetting('echo_user_profile', JSON.stringify(profile));
          updatedProfile = profile;
        }

        // 广播余额及状态更新，确保主项目对话窗口实时刷新
        const focusedWindow = this.getMainWindow();
        const broadcastCharStateUpdated = (charId: string) => {
          const stateBroadcast = { characterId: charId, updates: [] };
          if (focusedWindow && !focusedWindow.isDestroyed() && !focusedWindow.webContents.isDestroyed()) {
            focusedWindow.webContents.send('character-state-updated', stateBroadcast);
          }
          try {
            SseManager.getInstance().broadcast('character-state-updated', stateBroadcast);
          } catch (err) {
            console.error('[LiveStreamPlugin] 广播角色状态更新失败:', err);
          }
        };

        // 2.1 广播主播余额刷新
        if (hostChar && hostChar.folder_name) {
          broadcastCharStateUpdated(hostChar.folder_name);
        }

        // 2.2 广播 VIP 观众余额刷新
        for (const log of logs) {
          const vipChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(log.sender_name) as any;
          if (vipChar && vipChar.folder_name) {
            broadcastCharStateUpdated(vipChar.folder_name);
          }
        }

        // 2.3 广播用户余额刷新
        if (userSumVal > 0 && updatedProfile) {
          if (focusedWindow && !focusedWindow.isDestroyed() && !focusedWindow.webContents.isDestroyed()) {
            focusedWindow.webContents.send('user-profile-updated', updatedProfile);
          }
          try {
            SseManager.getInstance().broadcast('user-profile-updated', updatedProfile);
          } catch (err) {
            console.error('[LiveStreamPlugin] 广播用户个人资料更新失败:', err);
          }
        }

        // 更新 LiveStreamSessions 记录 (将累计收益 total_earnings 清零)
        db.db.prepare(`
          UPDATE LiveStreamSessions
          SET total_earnings = 0, viewer_count = ?
          WHERE id = ?
        `).run(session.viewer_count, payload.sessionId);

        // 清零打赏流水记录，防止以后进入历史直播间或二次下播时重复计算累计收益
        try {
          db.db.prepare('DELETE FROM LiveStreamGiftLogs WHERE session_id = ?').run(payload.sessionId);
          console.log(`[LiveStreamPlugin] 成功删除并清零会话 (${payload.sessionId}) 的打赏流水记录`);
        } catch (delErr) {
          console.error('[LiveStreamPlugin] 清理打赏日志失败:', delErr);
        }

        const liveRecordsPath = path.join(app.getPath('userData'), 'plugins', 'livestream', 'characters', hostChar.folder_name, 'live_records.md');
        const now = new Date();
        const dateStr = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, '0')}月${String(now.getDate()).padStart(2, '0')}日`;

        // 处理约会奔现结算
        if (this.activeSessionMeet && this.activeSessionMeet.confirmed) {
          const partnerName = this.activeSessionMeet.targetName;
          const partnerType = (partnerName === '用户' || partnerName === userNickname) ? 'user' : 'npc';

          const recordLineMeet = `\n- [奔现成功] 与粉丝【${partnerName}】达成了线下奔现约会协议！`;
          if (!fs.existsSync(liveRecordsPath)) {
            fs.writeFileSync(liveRecordsPath, `# 直播财务流水账\n${recordLineMeet}`, 'utf8');
          } else {
            fs.appendFileSync(liveRecordsPath, recordLineMeet, 'utf8');
          }

          const meetRecordsPath = path.join(charactersBaseDir, hostChar.folder_name, 'meet_records.json');
          let meetRecords: any[] = [];
          if (fs.existsSync(meetRecordsPath)) {
            try {
              meetRecords = JSON.parse(fs.readFileSync(meetRecordsPath, 'utf8'));
            } catch (_) {}
          }
          meetRecords.push({
            date: dateStr,
            partnerName,
            partnerType,
            type: this.activeSessionMeet.type,
            timestamp: Date.now()
          });
          fs.writeFileSync(meetRecordsPath, JSON.stringify(meetRecords, null, 2), 'utf8');
          console.log(`[LiveStreamPlugin] 线下奔现记录成功写入 meet_records.json: ${partnerName}`);

          if (partnerType === 'user') {
            const hasMetValue = this.activeSessionMeet.type === 'meet' ? 'user_met' : 'user_date_unlocked';
            db.db.prepare('UPDATE LiveStreamSessions SET has_met_event = ? WHERE id = ?').run(hasMetValue, payload.sessionId);
          }
        }
        this.activeSessionMeet = null;

        // 2. 写入专属直播流水账 live_records.md
        const recordLine = `\n- ${dateStr}开启了【${session.theme}】直播，收到总打赏礼物金额 ${receivedAmount} （扣除50%平台抽成后）回音币。`;
        if (!fs.existsSync(liveRecordsPath)) {
          fs.writeFileSync(liveRecordsPath, `# 直播财务流水账\n${recordLine}`, 'utf8');
        } else {
          fs.appendFileSync(liveRecordsPath, recordLine, 'utf8');
        }

        // 异步执行静默终期总结生成 & remarks 合并
        const targetWebContents = (focusedWindow && !focusedWindow.isDestroyed()) 
          ? focusedWindow.webContents 
          : event.sender;

        (async () => {
          try {
            const historyText = messages.map(m => `${m.senderName}: ${m.content}${m.giftName ? ` [送礼: ${m.giftName}]` : ''}`).join('\n');
            
            const summarySysPrompt = `你是一个专业的直播纪实助手，负责为今天的主播写下播总结与反思日记。
请根据整场直播的消息，写一份极其详尽的直播总结。
总结要求：
1. 总结要详尽具体，包含主播今天的直播情绪、与观众互动的高潮点、收到的主要礼物和支持者。
2. 必须包含一个专门的“自省日记”段落，以主播的第一人称（“我”）来写，总结今天的收获、金钱财务（如依靠直播赚了多少回音币）、心情波动，以及下一次直播需要改进或继续发扬的地方，以便将这段反思写入 DREAM.md 中启发梦境。
3. 总结和自省日记必须使用简体中文。

请以 JSON 格式输出，包含以下字段：
- summary: 详尽的直播纪实总结。
- diary: 第一人称的自省日记（约 150-250 字，包含具体的打赏收获和情感反思，可以直接被追加写入 DREAM.md）。
不要输出任何 Markdown 标记或其它多余字符。`;

            const summaryRes = await this.callLLM(summarySysPrompt, `请总结以下对话：\n\n${historyText}`, hostChar.id);
            
            let summaryObj = { summary: '', diary: '' };
            try {
              const cleanText = summaryRes.replace(/```json/g, '').replace(/```/g, '').trim();
              summaryObj = JSON.parse(cleanText);
            } catch (_) {
              summaryObj = {
                summary: summaryRes,
                diary: `今天的直播非常成功，总共收到了 ${receivedAmount} 回音币！大家都非常热情地支持我，下次我要更加努力，给大家带来更好的直播！`
              };
            }

            // 保存 summary.md
            fs.writeFileSync(path.join(sessionDir, 'summary.md'), summaryObj.summary, 'utf8');

            // 写入数据库会话总结
            db.db.prepare('UPDATE LiveStreamSessions SET summary = ? WHERE id = ?').run(summaryObj.summary, payload.sessionId);

            // 3. 粉丝跨直播 remarks 的增量合并
            // 找出本场有互动的粉丝 (去重并进行无效过滤)
            const interactors = Array.from(new Set(messages.map(m => m.senderName).filter(name => {
              return name && name !== hostName && name !== '系统' && name !== '系统消息' && name !== 'undefined' && name !== 'null' && name.trim() !== '';
            })));
            
            for (const fanName of interactors) {
              const fanMsgs = messages.filter(m => m.senderName === fanName);
              const fanDonated = fanMsgs.reduce((sum, m) => sum + (m.giftValue || 0), 0);

              // 🚨 性能与 Token 费用优化：只有在该粉丝本场打赏额累计 >= 1000 回音币时，才调用大模型进行备注提炼与合并。
              // 对于常规闲聊或仅送了极其便宜的小额礼物（低于 1000币）的粉丝，不触发昂贵且耗时的大模型调用。
              if (fanDonated < 1000) {
                continue;
              }

              const sampleMsgs = fanMsgs.slice(-10).map(m => m.content).join(' | ');

              let oldRemarks = '';
              const stats = db.db.prepare('SELECT remarks FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(fanName, hostName) as any;
              if (stats) {
                oldRemarks = stats.remarks || '无历史备注。';
              }

              const remarksSysPrompt = `你是一个粉丝画像提炼助手。你需要结合粉丝的【历史备注】与【今日直播轨迹】，重新生成一段 80 字以内的【合并新备注】。
要求：
1. 保留长线高价值信息（如对方的喜好、特殊约定、是否已线下见过面）；
2. 稀释或淘汰过期的短期行为（例如若今日未送贵重礼，‘上周送了玫瑰花’的旧备注应当被遗忘或略写，防止内容膨胀）；
3. 融入最新的重大突破（如今天送了礼、升了级等）。
4. 仅输出 80 字以内的合并后文本，不要有任何 markdown 标记或中文引言。`;

              const userText = `粉丝名：${fanName}
今日打赏额：${fanDonated} 回音币
今日对话摘要：${sampleMsgs}
历史备注：${oldRemarks}`;

              const newRemarks = await this.callLLM(remarksSysPrompt, userText, hostChar.id);
              
              // 覆写回数据库
              const exists = db.db.prepare('SELECT 1 FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(fanName, hostName);
              if (!exists) {
                db.db.prepare(`
                  INSERT INTO LiveStreamUserStats (char_name, host_name, level, exp, total_donated, last_gift_id, last_gift_time, remarks)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(fanName, hostName, 1, fanDonated, fanDonated, null, null, newRemarks.substring(0, 100));
              } else {
                db.db.prepare(`
                  UPDATE LiveStreamUserStats
                  SET remarks = ?
                  WHERE char_name = ? AND host_name = ?
                `).run(newRemarks.substring(0, 100), fanName, hostName);
              }
            }

            console.log('[LiveStreamPlugin] 下播异步自省与备注合并圆满成功！');
            
            // 广播结算成功事件给前端
            PluginBridgeService.broadcastPluginEvent('livestream', 'session-closed', {
              sessionId: payload.sessionId,
              totalEarnings,
              receivedAmount
            });

            if (targetWebContents && !targetWebContents.isDestroyed()) {
              targetWebContents.send('livestream:session-closed-complete', {
                sessionId: payload.sessionId,
                totalEarnings,
                receivedAmount
              });
            }

          } catch (e: any) {
            console.error('[LiveStreamPlugin] 异步结算失败:', e.message || e);
          }
        })();

        return { success: true, receivedAmount };
      } catch (e: any) {
        console.error('[livestream:close-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 7.5 离开直播间 IPC 通道
    ipcMain.handle('livestream:leave-session', async (_, payload: { sessionId: string }) => {
      try {
        if (this.activeSessionId === payload.sessionId) {
          console.log(`[LiveStreamPlugin] 收到前端离开通知，当前会话依然保留活动状态: ${payload.sessionId}`);
        }
        return { success: true };
      } catch (e: any) {
        console.error('[LiveStreamPlugin] 离开直播间处理失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 8. 获取当前直播间排行榜 (前十名贡献榜)
    ipcMain.handle('livestream:get-leaderboard', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        if (!payload || !payload.sessionId) {
          throw new Error('缺少直播会话ID');
        }

        // 1. 获取当前会话对应的主播及用户自定义昵称
        const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        const hostName = session?.char_name || '';
        let userNickname = '用户';
        let hostCharId = '';
        if (session) {
          const hostChar = db.db.prepare('SELECT id, folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
          if (hostChar) {
            hostCharId = hostChar.id;
            if (hostChar.folder_name) {
              userNickname = db.getUserNameByFolderName(hostChar.folder_name) || '用户';
            }
          }
        }
        if (userNickname === '用户') {
          const profileStr = db.getSetting('echo_user_profile');
          if (profileStr) {
            try {
              const p = JSON.parse(profileStr);
              if (p.nickname) userNickname = p.nickname;
            } catch (_) {}
          }
        }

        // 2. 做到每场直播数据隔离：查询 LiveStreamGiftLogs 表中当前会话的贡献，并过滤名字为 "用户" 的行（自定义用户人设如 "张三" 应正常上榜）
        const list = db.db.prepare(`
          SELECT sender_name as name, SUM(gift_value) as totalDonated
          FROM LiveStreamGiftLogs
          WHERE session_id = ? AND sender_name != '用户'
          GROUP BY sender_name
          ORDER BY totalDonated DESC
          LIMIT 10
        `).all(payload.sessionId) as any[];

        // 3. 补上头像 avatar
        const chars = db.getAllCharacters();
        const charMap = new Map<string, string>();
        for (const c of chars) {
          charMap.set(c.name, this.getBase64Avatar(c.folder_name));
        }

        const userAvatar = this.getUserAvatar(hostCharId);

        const leaderboard = list.map((item, idx) => {
          let avatar = '';
          let level = 1;

          // 计算 level (根据 LiveStreamUserStats 中的 level，打赏等级是全局的，保存在 host_name = '' 的记录中)
          const stats = db.db.prepare('SELECT level FROM LiveStreamUserStats WHERE char_name = ? AND host_name = ?').get(item.name, '') as any;
          if (stats) {
            level = stats.level;
          }

          if (item.name === userNickname) {
            avatar = userAvatar || ''; // 用户自己的人设头像
          } else if (charMap.has(item.name)) {
            avatar = charMap.get(item.name) || '';
          }

          return {
            ...item,
            level,
            rank: idx + 1,
            avatar
          };
        });

        return { success: true, leaderboard };
      } catch (e: any) {
        console.error('[livestream:get-leaderboard] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 8.5. 更新当前直播间自定义观众列表并写入物理 custom_vips.json 及数据库 viewer_count
    ipcMain.handle('livestream:update-session-vips', async (_, payload: { sessionId: string; hostFolderName: string; vips: any[] }) => {
      try {
        const sessionDir = path.join(
          app.getPath('userData'),
          'plugins',
          'livestream',
          'characters',
          payload.hostFolderName,
          'sessions',
          `session_${payload.sessionId}`
        );
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }
        const vipsPath = path.join(sessionDir, 'custom_vips.json');
        
        const enrichedVips = [];
        for (const vip of payload.vips) {
          if (vip.gender) {
            enrichedVips.push(vip);
          } else {
            const analysis = await this.analyzeVipProfile(vip.folderName, vip.id);
            enrichedVips.push({
              ...vip,
              gender: analysis.gender
            });
          }
        }
        // 物理隔离写盘保存 vips
        fs.writeFileSync(vipsPath, JSON.stringify(enrichedVips, null, 2), 'utf8');
        
        // 同时同步更新数据库里的观众数值 viewer_count (观众数 = VIP数 + 1(玩家))
        const db = getDatabaseService();
        const viewerCount = payload.vips.length + 1;
        db.db.prepare('UPDATE LiveStreamSessions SET viewer_count = ? WHERE id = ?').run(viewerCount, payload.sessionId);
        
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:update-session-vips] 失败:', e);
        return { success: false, error: e.message || String(e) };
      }
    });

    // 8.6. 获取所有角色的全局直播间等级 (所有直播间通用)
    ipcMain.handle('livestream:get-all-user-levels', async () => {
      try {
        const db = getDatabaseService();
        // 等级是全局的，直接查询 host_name = '' 的全局通用等级记录
        const list = db.db.prepare(`
          SELECT char_name as name, level
          FROM LiveStreamUserStats
          WHERE host_name = ''
        `).all() as any[];
        console.log('[LiveStreamPlugin] 数据库读取到的等级列表:', list);
        return { success: true, levels: list };
      } catch (e: any) {
        console.error('[livestream:get-all-user-levels] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 9. 获取主播过往直播场次流水列表
    ipcMain.handle('livestream:get-sessions', async (_, payload: { characterId: string }) => {
      try {
        const db = getDatabaseService();
        const hostChar = db.db.prepare('SELECT name FROM Characters WHERE id = ?').get(payload.characterId) as any;
        if (!hostChar) {
          throw new Error('未找到该主播信息');
        }

        const list = db.db.prepare(`
          SELECT * FROM LiveStreamSessions
          WHERE char_name = ?
          ORDER BY created_at DESC
        `).all(hostChar.name) as any[];

        const enrichedList = list.map(session => {
          const { direction: dirName, prompt: promptText } = parseDirection(session.direction);
          return {
            ...session,
            direction: dirName,
            prompt: promptText
          };
        });

        return { success: true, list: enrichedList };
      } catch (e: any) {
        console.error('[livestream:get-sessions] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 10. 读取某场直播的详细 messages.json 弹幕和 summary.md
    ipcMain.handle('livestream:get-session-detail', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        const session = db.db.prepare('SELECT * FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          throw new Error('未找到该直播会话');
        }

        const hostChar = db.db.prepare('SELECT id, folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
        if (!hostChar) {
          throw new Error('未找到主播角色对应的文件夹');
        }

        const sessionDir = path.join(
          app.getPath('userData'),
          'plugins',
          'livestream',
          'characters',
          hostChar.folder_name,
          'sessions',
          `session_${payload.sessionId}`
        );

        const messagesPath = path.join(sessionDir, 'messages.json');
        let messages: any[] = [];
        if (fs.existsSync(messagesPath)) {
          messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
        }

        const summaryPath = path.join(sessionDir, 'summary.md');
        let summary = '';
        if (fs.existsSync(summaryPath)) {
          summary = fs.readFileSync(summaryPath, 'utf8');
        }

        const { direction: dirName, prompt: promptText } = parseDirection(session.direction);
        const parsedSession = {
          ...session,
          direction: dirName,
          prompt: promptText
        };

        return {
          success: true,
          session: parsedSession,
          messages,
          summary,
          userAvatar: this.getUserAvatar(hostChar.id)
        };
      } catch (e: any) {
        console.error('[livestream:get-session-detail] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 11. 获取所有历史直播记录，包含主播头像Base64
    ipcMain.handle('livestream:get-all-sessions', async () => {
      try {
        const db = getDatabaseService();
        const list = db.db.prepare('SELECT * FROM LiveStreamSessions ORDER BY created_at DESC').all() as any[];

        const allSessions = [];
        for (const session of list) {
          const hostChar = db.db.prepare('SELECT id, folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
          let avatar = '';
          let hostCharId = '';
          if (hostChar) {
            avatar = this.getBase64Avatar(hostChar.folder_name);
            hostCharId = hostChar.id;
          }

          // 自愈解析
          const { direction: dirName, prompt: promptText } = parseDirection(session.direction);

          allSessions.push({
            ...session,
            direction: dirName,
            prompt: promptText,
            avatar,
            characterId: hostCharId
          });
        }
        return { success: true, list: allSessions };
      } catch (e: any) {
        console.error('[livestream:get-all-sessions] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 12. 恢复某个历史直播会话
    ipcMain.handle('livestream:resume-session', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        const session = db.db.prepare('SELECT * FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          throw new Error('未找到该直播会话');
        }
        const hostChar = db.db.prepare('SELECT id, folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
        if (!hostChar) {
          throw new Error('未找到主播对应的角色文件夹');
        }
        const characterId = hostChar.id;
        const hostFolderName = hostChar.folder_name;

        const sessionDir = path.join(app.getPath('userData'), 'plugins', 'livestream', 'characters', hostFolderName, 'sessions', `session_${payload.sessionId}`);
        const vipsPath = path.join(sessionDir, 'custom_vips.json');
        
        let userNickname = db.getUserNameByFolderName(hostFolderName);
        if (!userNickname) {
          const profileStr = db.getSetting('echo_user_profile');
          if (profileStr) {
            try {
              const p = JSON.parse(profileStr);
              if (p.nickname) userNickname = p.nickname;
            } catch (_) {}
          }
        }
        if (!userNickname) {
          userNickname = '用户';
        }

        let vipCharacters: any[] = [];
        if (fs.existsSync(vipsPath)) {
          try {
            const savedVips = JSON.parse(fs.readFileSync(vipsPath, 'utf8'));
            // 从物理路径加载，并重新补全 Base64 头像，保证数据的自愈性
            vipCharacters = savedVips.map((v: any) => {
              const folderName = v.folderName || v.folder_name || '';
              return {
                id: v.id,
                name: v.name,
                folderName: folderName,
                avatar: this.getBase64Avatar(folderName),
                gender: v.gender || '未知'
              };
            });
            console.log(`[LiveStreamPlugin] 成功从本地 custom_vips.json 还原了 ${vipCharacters.length} 个观众`);
          } catch (err) {
            console.error('加载缓存自定义观众失败，降级为随机选取:', err);
          }
        }

        if (vipCharacters.length === 0) {
          // 智能自愈：优先找在此会话中已经有打赏记录的角色，避免和贡献榜冲突，并彻底固定！
          const contributedNames = db.db.prepare(`
            SELECT DISTINCT sender_name FROM LiveStreamGiftLogs
            WHERE session_id = ? AND sender_name != '用户' AND sender_name != ?
          `).all(payload.sessionId, userNickname).map((r: any) => r.sender_name) as string[];

          const contributedVips: any[] = [];
          for (const name of contributedNames) {
            const charMeta = db.db.prepare('SELECT * FROM Characters WHERE name = ? AND id != ?').get(name, characterId) as any;
            if (charMeta) {
              const analysis = await this.analyzeVipProfile(charMeta.folder_name, charMeta.id);
              contributedVips.push({
                id: charMeta.id,
                name: charMeta.name,
                folderName: charMeta.folder_name,
                avatar: this.getBase64Avatar(charMeta.folder_name),
                gender: analysis.gender
              });
            }
          }

          let selectedVips = [...contributedVips];
          if (selectedVips.length < 3) {
            const remainingCount = 3 - selectedVips.length;
            const selectedIds = selectedVips.map(v => v.id);

            // 随机选取最多 3 个 VIP 角色（未免打扰优先）
            const allChars = db.db.prepare('SELECT * FROM Characters WHERE id != ?').all(characterId) as any[];
            const availableChars = allChars.filter(c => !selectedIds.includes(c.id));

            // 过滤并排序免打扰
            const itemsWithMuted = [];
            for (const c of availableChars) {
              const meta = db.db.prepare('SELECT muted FROM ConversationMeta WHERE character_id = ?').get(c.id) as any;
              itemsWithMuted.push({
                ...c,
                muted: meta ? meta.muted : 0
              });
            }

            const unmuted = itemsWithMuted.filter(c => c.muted === 0);
            const muted = itemsWithMuted.filter(c => c.muted !== 0);

            const shuffle = (arr: any[]) => arr.sort(() => Math.random() - 0.5);
            shuffle(unmuted);
            shuffle(muted);

            const selected = [...unmuted, ...muted].slice(0, remainingCount);
            for (const c of selected) {
              const analysis = await this.analyzeVipProfile(c.folder_name, c.id);
              selectedVips.push({
                id: c.id,
                name: c.name,
                folderName: c.folder_name,
                avatar: this.getBase64Avatar(c.folder_name),
                gender: analysis.gender
              });
            }
          } else {
            selectedVips = selectedVips.slice(0, 3);
          }
          vipCharacters = selectedVips;

          // 物理写盘保存到 vipsPath，保证观众名单彻底固定下来不再改变
          try {
            fs.writeFileSync(vipsPath, JSON.stringify(vipCharacters, null, 2), 'utf8');
            // 同步更新数据库里的观众数值 viewer_count
            const viewerCount = vipCharacters.length + 1;
            db.db.prepare('UPDATE LiveStreamSessions SET viewer_count = ? WHERE id = ?').run(viewerCount, payload.sessionId);
            console.log(`[LiveStreamPlugin] 物理写盘固定了 ${vipCharacters.length} 个观众到 custom_vips.json`);
          } catch (writeErr) {
            console.error('自动物理保存自愈观众名单失败:', writeErr);
          }
        }
        // 见过面自愈逻辑判定
        let hasMet = false;
        const storageManager = new CharacterStorageManager();
        const charactersBaseDir = storageManager.getBaseDir();
        const charDir = path.join(charactersBaseDir, hostFolderName);
        const memoryPath = path.join(charDir, 'Memory.md');
        const diaryPath = path.join(charDir, 'Diary.md');
        const keywords = ['见面', '奔现', '线下', '日常相处', '认识她', '现实认识', '现实中见过', '三次元见面'];
        const checkFileContains = (filePath: string) => {
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            return keywords.some(kw => content.includes(kw));
          }
          return false;
        };

        if (session.has_met_event === 'met_before' || session.has_met_event === 'user_met' || session.has_met_event === 'user_date_unlocked' || checkFileContains(memoryPath) || checkFileContains(diaryPath)) {
          hasMet = true;
        }

        // 读取消息历史
        const messagesPath = path.join(sessionDir, 'messages.json');
        let initialMessages: any[] = [];
        if (fs.existsSync(messagesPath)) {
          initialMessages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
        }

        // 自愈解析
        const { direction: dirName, prompt: promptText } = parseDirection(session.direction);

        // 设置当前活动直播会话ID
        this.activeSessionId = payload.sessionId;

        return {
          success: true,
          sessionId: payload.sessionId,
          vipCharacters,
          hasMet,
          userNickname,
          userAvatar: this.getUserAvatar(characterId),
          initialMessages,
          characterId,
          hostName: hostChar.name,
          hostFolderName: hostChar.folder_name,
          hostAvatar: this.getBase64Avatar(hostChar.folder_name),
          theme: session.theme,
          direction: dirName,
          prompt: promptText
        };
      } catch (e: any) {
        console.error('[livestream:resume-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 13. 获取保存的分类提示词
    ipcMain.handle('livestream:get-direction-prompts', async () => {
      try {
        const db = getDatabaseService();
        const promptsStr = db.getSetting('livestream_direction_prompts');
        if (promptsStr) {
          return { success: true, prompts: JSON.parse(promptsStr) };
        }
        return { success: true, prompts: {} };
      } catch (e: any) {
        console.error('[livestream:get-direction-prompts] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 14. 保存分类提示词
    ipcMain.handle('livestream:save-direction-prompt', async (_, payload: { direction: string; prompt: string }) => {
      try {
        const db = getDatabaseService();
        let prompts: Record<string, string> = {};
        const promptsStr = db.getSetting('livestream_direction_prompts');
        if (promptsStr) {
          try {
            prompts = JSON.parse(promptsStr);
          } catch (_) {}
        }
        prompts[payload.direction] = payload.prompt;
        db.setSetting('livestream_direction_prompts', JSON.stringify(prompts));
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:save-direction-prompt] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 15. 物理删除历史直播会话
    ipcMain.handle('livestream:delete-session', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        
        // 1. 先查找该会话的主播角色名
        const session = db.db.prepare('SELECT char_name FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (session) {
          // 2. 查找角色文件夹
          const hostChar = db.db.prepare('SELECT folder_name FROM Characters WHERE name = ?').get(session.char_name) as any;
          if (hostChar) {
            // 3. 物理删除场次所在的 sessions/[sessionId] 隔离目录
            const sessionDir = path.join(
              app.getPath('userData'),
              'plugins',
              'livestream',
              'characters',
              hostChar.folder_name,
              'sessions',
              `session_${payload.sessionId}`
            );
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
              console.log(`[LiveStreamPlugin] 成功物理删除隔离目录: ${sessionDir}`);
            }
          }
        }

        // 4. 从数据库中删除会话行与对应的送礼记录（注意：不回退余额，但清理流水日志）
        db.db.prepare('DELETE FROM LiveStreamSessions WHERE id = ?').run(payload.sessionId);
        db.db.prepare('DELETE FROM LiveStreamGiftLogs WHERE session_id = ?').run(payload.sessionId);

        console.log(`[LiveStreamPlugin] 成功从数据库清理会话 ${payload.sessionId} 记录及对应礼物流水`);
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:delete-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    ipcMain.handle('livestream:get-total-gifts', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        const row = db.db.prepare(`
          SELECT SUM(gift_value) as total 
          FROM LiveStreamGiftLogs 
          WHERE session_id = ?
        `).get(payload.sessionId) as any;
        return { success: true, total: row?.total || 0 };
      } catch (e: any) {
        console.error('[livestream:get-total-gifts] 失败:', e);
        return { success: false, error: e.message || String(e) };
      }
    });

    ipcMain.handle('livestream:get-session-config', async (_, payload: { sessionId: string }) => {
      try {
        const db = getDatabaseService();
        const session = db.db.prepare('SELECT locked_artist, locked_artist_name, enable_background_rotation FROM LiveStreamSessions WHERE id = ?').get(payload.sessionId) as any;
        if (!session) {
          return { success: false, error: '未找到该直播会话记录' };
        }
        return {
          success: true,
          lockedArtist: session.locked_artist || '',
          lockedArtistName: session.locked_artist_name || '',
          enableBackgroundRotation: !!session.enable_background_rotation
        };
      } catch (e: any) {
        console.error('[livestream:get-session-config] 失败:', e);
        return { success: false, error: e.message || String(e) };
      }
    });

    ipcMain.handle('livestream:update-session-config', async (_, payload: {
      sessionId: string;
      lockedArtist: string;
      lockedArtistName: string;
      enableBackgroundRotation: boolean;
    }) => {
      try {
        const db = getDatabaseService();
        db.db.prepare(`
          UPDATE LiveStreamSessions
          SET locked_artist = ?, locked_artist_name = ?, enable_background_rotation = ?
          WHERE id = ?
        `).run(
          payload.lockedArtist || '',
          payload.lockedArtistName || '',
          payload.enableBackgroundRotation ? 1 : 0,
          payload.sessionId
        );
        return { success: true };
      } catch (e: any) {
        console.error('[livestream:update-session-config] 失败:', e);
        return { success: false, error: e.message || String(e) };
      }
    });

    ipcMain.handle('livestream:get-artists', async () => {
      try {
        const db = getDatabaseService();
        const configStr = db.getSetting('novelai_config');
        if (!configStr) {
          return { success: true, list: [] };
        }
        const config = JSON.parse(configStr);
        let list: Array<{ name: string; value: string }> = [];
        if (Array.isArray(config.artistStringList) && config.artistStringList.length > 0) {
          list = config.artistStringList.map((item: any) => {
            if (typeof item === 'string') {
              return { name: item, value: item };
            }
            return {
              name: item.name || item.value || '',
              value: item.value || ''
            };
          }).filter((item: any) => item.value.trim().length > 0);
        } else if (config.artistString && config.artistString.trim().length > 0) {
          // 兼容老配置自愈
          list = [{ name: '默认画师风格', value: config.artistString.trim() }];
        }
        return { success: true, list };
      } catch (e: any) {
        console.error('[livestream:get-artists] 失败:', e);
        return { success: false, error: e.message || String(e) };
      }
    });
  }

  private async analyzeVipProfile(folderName: string, characterId: string): Promise<{ gender: string }> {
    try {
      const storageManager = new CharacterStorageManager();
      const charDir = path.join(storageManager.getBaseDir(), folderName);

      // 1. 优先尝试从 meta.json 读取
      const metaPath = path.join(charDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta.gender && meta.gender !== '未知') {
            console.log(`[LiveStreamPlugin] 成功从 meta.json 读取角色 (${folderName}) 的物理性别: ${meta.gender}`);
            return { gender: meta.gender };
          }
        } catch (metaErr) {
          console.error(`[LiveStreamPlugin] 读取 meta.json 失败 (${folderName}):`, metaErr);
        }
      }

      // 2. 尝试从 Appearance.md 读取并做轻量正则判定
      const appearancePath = path.join(charDir, 'Appearance.md');
      if (fs.existsSync(appearancePath)) {
        try {
          const appearanceContent = fs.readFileSync(appearancePath, 'utf8');
          const genderMatch = appearanceContent.match(/### Gender\s*([\s\S]*?)(?:###|$)/i);
          if (genderMatch) {
            const genderText = genderMatch[1].trim().toLowerCase();
            if (genderText.includes('female') || genderText.includes('女') || genderText.includes('girl') || genderText.includes('she')) {
              console.log(`[LiveStreamPlugin] 成功从 Appearance.md 正则匹配角色 (${folderName}) 的性别: 女`);
              return { gender: '女' };
            } else if (genderText.includes('male') || genderText.includes('男') || genderText.includes('boy') || genderText.includes('he')) {
              console.log(`[LiveStreamPlugin] 成功从 Appearance.md 正则匹配角色 (${folderName}) 的性别: 男`);
              return { gender: '男' };
            }
          }
        } catch (_) {}
      }

      // 3. 尝试从 Soul.md 读取并分析
      const soulPath = path.join(charDir, 'Soul.md');
      if (fs.existsSync(soulPath)) {
        try {
          const soulContent = fs.readFileSync(soulPath, 'utf8').slice(0, 1000).toLowerCase();
          if (/(她|female|girl|she|少女|女生|女孩|女子|女仆|女主)/.test(soulContent)) {
            console.log(`[LiveStreamPlugin] 成功从 Soul.md 正则匹配角色 (${folderName}) 的性别: 女`);
            return { gender: '女' };
          } else if (/(他|male|boy|he|him|his|少年|男生|男孩|男子|男仆|男主)/.test(soulContent)) {
            console.log(`[LiveStreamPlugin] 成功从 Soul.md 正则匹配角色 (${folderName}) 的性别: 男`);
            return { gender: '男' };
          }
        } catch (_) {}
      }

      return { gender: '未知' };
    } catch (e) {
      console.error(`[LiveStreamPlugin] 获取 VIP 性别失败 (${folderName}):`, e);
      return { gender: '未知' };
    }
  }
}
