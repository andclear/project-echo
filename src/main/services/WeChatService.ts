import fs from 'fs';
import { join } from 'path';
import { app, BrowserWindow } from 'electron';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { WeChatClient } from './WeChatClient';
import { NovelAiService } from './NovelAiService';
import crypto from 'crypto';
import QRCode from 'qrcode';

/**
 * 微信个人号接入核心单例守护服务，管理状态机、长轮询、红包过滤、命令路由器等核心业务
 */
export class WeChatService {
  private static instance: WeChatService;
  private client: WeChatClient;
  private isRunning: boolean = false;
  private shutdownSignal: boolean = false;
  private currentQR: string = '';

  private constructor() {
    this.client = new WeChatClient();
  }

  public static getInstance(): WeChatService {
    if (!WeChatService.instance) {
      WeChatService.instance = new WeChatService();
    }
    return WeChatService.instance;
  }

  /**
   * 获取微信当前的运行状态
   */
  public getStatus(): any {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    const accountId = db.getSetting('wechat_account_id');
    const enabled = db.getSetting('wechat_enabled') === '1';

    return {
      enabled,
      connected: !!token,
      accountId: accountId || null,
      qrcodeUrl: db.getSetting('wechat_qrcode_url') || null,
      mappings: db.getWeChatMappings()
    };
  }

  /**
   * 启动微信后台长轮询收信守护任务
   */
  public async startService(): Promise<void> {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    const enabled = db.getSetting('wechat_enabled') === '1';

    if (!enabled || !token) {
      console.log('[WeChatService] 微信启用状态为关或缺失 token，跳过后台守护服务启动。');
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;
    this.shutdownSignal = false;
    console.log('[WeChatService] 微信长轮询后台监听进程已成功唤醒运行中...');

    // 绑定最新的 API 基础域名
    const savedBaseUrl = db.getSetting('wechat_base_url');
    if (savedBaseUrl) {
      this.client.setBaseUrl(savedBaseUrl);
    }

    // 异步执行主收信循环
    this.pollLoop().catch(err => {
      console.error('[WeChatService] 微信长轮询主守护进程发生异常中断:', err);
      this.isRunning = false;
    });
  }

  /**
   * 关闭与断开微信长轮询
   */
  public async stopService(): Promise<void> {
    this.shutdownSignal = true;
    this.isRunning = false;
    console.log('[WeChatService] 微信长轮询收信后台守护进程已成功注销安全退出。');
  }

  /**
   * 获取所有好友与本地角色的绑定映射关系
   */
  private getFriendMappings(): Record<string, string> {
    const db = getDatabaseService();
    return db.getWeChatMappings();
  }

  /**
   * 发送普通的微信文本消息
   */
  private async sendWeChatText(toUserId: string, text: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    if (!token) return;

    try {
      await this.client.requestJson(
        'POST',
        'ilink/bot/sendmessage',
        {
          base_info: { channel_version: 'project-echo' },
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [
              {
                type: 1,
                text_item: { text }
              }
            ]
          }
        },
        token
      );
    } catch (err: any) {
      const apiErr = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[WeChatService] 向用户 ${toUserId} 发送文本消息失败:`, apiErr);
    }
  }

  /**
   * 触发/取消微信好友的 “正在输入...” 状态展示
   */
  private async sendWeChatTyping(toUserId: string, contextToken: string, isTyping: boolean): Promise<void> {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    if (!token) return;

    try {
      // 1. 获取输入凭证 (ticket)
      const configRes = await this.client.requestJson(
        'POST',
        'ilink/bot/getconfig',
        {
          ilink_user_id: toUserId,
          context_token: contextToken,
          base_info: { channel_version: 'project-echo' }
        },
        token
      );

      const ticket = configRes?.typing_ticket;
      if (ticket) {
        // 2. 发送输入状态 status: 1 (开始) | 2 (取消)
        await this.client.requestJson(
          'POST',
          'ilink/bot/sendtyping',
          {
            ilink_user_id: toUserId,
            typing_ticket: ticket,
            status: isTyping ? 1 : 2,
            base_info: { channel_version: 'project-echo' }
          },
          token
        );
      }
    } catch (err: any) {
      console.warn('[WeChatService] 模拟微信打字中状态失败:', err.message);
    }
  }

  /**
   * 向微信 CDN 上传并发送图片消息
   */
  private async uploadAndSendWeChatImage(toUserId: string, localImgPath: string, imageBuffer: Buffer, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    if (!token) return;

    const fileKey = crypto.randomUUID().replace(/-/g, '');
    const aesKeyHex = crypto.randomBytes(16).toString('hex');
    const rawSize = imageBuffer.length;
    const rawFileMd5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const ciphertextPaddedSize = this.client.getAesPaddedSize(rawSize);

    try {
      // 1. 向 iLink API 申请上传通道 URL 
      const uploadUrlRes = await this.client.requestJson(
        'POST',
        'ilink/bot/getuploadurl',
        {
          filekey: fileKey,
          media_type: 1, // 1: 图片
          to_user_id: toUserId,
          rawsize: rawSize,
          rawfilemd5: rawFileMd5,
          filesize: ciphertextPaddedSize,
          no_need_thumb: true,
          aeskey: aesKeyHex,
          base_info: { channel_version: 'project-echo' }
        },
        token
      );

      const uploadParam = uploadUrlRes?.upload_param || '';
      const uploadFullUrl = uploadUrlRes?.upload_full_url || '';

      // 2. 本地 AES 加密并上传到微信 C2C CDN，获取下载凭证
      const downloadParam = await this.client.uploadToCDN(
        uploadFullUrl,
        uploadParam,
        fileKey,
        aesKeyHex,
        imageBuffer
      );

      // 3. 将 Base64 编码后的 AES 密匙与凭证发送给微信端好友
      const aesKeyBase64 = Buffer.from(aesKeyHex).toString('base64');
      await this.client.requestJson(
        'POST',
        'ilink/bot/sendmessage',
        {
          base_info: { channel_version: 'project-echo' },
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: crypto.randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: contextToken,
            item_list: [
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: downloadParam,
                    aes_key: aesKeyBase64,
                    encrypt_type: 1
                  },
                  mid_size: ciphertextPaddedSize
                }
              }
            ]
          }
        },
        token
      );
      console.log('[WeChatService] 微信端加密图片发送大获成功！');
    } catch (err: any) {
      console.error('[WeChatService] 加密发送图片消息异常失败:', err.message);
      throw err;
    }
  }

  /**
   * 微信增量消息拉取长轮询主循环
   */
  private async pollLoop(): Promise<void> {
    const db = getDatabaseService();
    while (!this.shutdownSignal) {
      const token = db.getSetting('wechat_token');
      const enabled = db.getSetting('wechat_enabled') === '1';

      if (!enabled || !token) {
        await this.stopService();
        break;
      }

      try {
        const syncBuf = db.getSetting('wechat_sync_buf') || '';
        db.setSetting('wechat_heartbeat', `Sending getupdates at ${new Date().toISOString()}`);
        const data = await this.client.requestJson(
          'POST',
          'ilink/bot/getupdates',
          {
            base_info: { channel_version: 'project-echo' },
            get_updates_buf: syncBuf
          },
          token,
          null,
          45000 // 专属定制超长超时 45 秒，避免 30 秒超时断连死循环，保证微信消息毫秒级送达！
        );

        db.setSetting('wechat_heartbeat', `Received response at ${new Date().toISOString()} with code ${data?.errcode}`);

        if (data && (!data.errcode || data.errcode === 0)) {
          // 1. 成功拉取，更新同步游标缓存
          if (data.get_updates_buf !== undefined) {
            db.setSetting('wechat_sync_buf', data.get_updates_buf);
          }

          // 2. 循环处理消息
          const msgs = data.msgs || [];
          for (const msg of msgs) {
            if (this.shutdownSignal) break;
            await this.handleIncomingMessage(msg);
          }
        } else {
          // 接口层面错误，可能 token 离线失效
          if (data && data.errcode === -14) {
            console.warn('[WeChatService] 微信 UIN 托管会话超时离线，物理清理 Token，等待重新扫码...');
            db.setSetting('wechat_last_error', `${new Date().toISOString()}: UIN session offline, errcode ${data.errcode}`);
            this.forceLogout();
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      } catch (err: any) {
        console.error('[WeChatService] 增量长轮询发生网络异常，5秒后自动重载重试:', err.message);
        try {
          db.setSetting('wechat_last_error', `${new Date().toISOString()}: ${err.message}\nStack: ${err.stack}`);
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * 会话离线时强制安全复位
   */
  private forceLogout(): void {
    const db = getDatabaseService();
    db.setSetting('wechat_token', '');
    db.setSetting('wechat_sync_buf', '');
    db.setSetting('wechat_account_id', '');
    db.setSetting('wechat_qrcode_url', '');
    this.stopService();

    // 广播通知前端 UI 微信已离线解绑
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
      windows[0].webContents.send('wechat-status-updated', this.getStatus());
    }
  }

  /**
   * 处理单条微信消息 (含群聊拦截、红包过滤与命令分发)
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    const fromUser = msg.from_user_id; // 微信好友 ID
    const itemList = msg.item_list || [];
    const contextToken = msg.context_token; // 微信发信上下文 Token

    if (!fromUser) return;

    // 【红线一】：严防死守，绝对不允许接入微信群聊！
    // 如果消息结构体里包含 group_id、或者 message_type 为群聊特征，直接拦截丢弃
    if (msg.group_id || msg.is_group_chat || msg.message_type === 3) {
      console.log('[WeChatService] 拦截到微信群聊消息，安全丢弃，本系统只服务单聊。');
      return;
    }

    // 【红线二】：拦截红包消息，绝不进行 AI 推理
    const hasRedPacket = itemList.some((item: any) => {
      return item.type === 6 || (item.type === 1 && item.text_item?.text?.includes('[微信红包]'));
    });

    if (hasRedPacket) {
      console.log(`[WeChatService] 拦截到微信好友 ${fromUser} 投递的红包/系统转账，不注入 AI，友好回执！`);
      await this.sendWeChatText(
        fromUser,
        '小主，红包已收到啦！但作为数字生命的我目前还无法物理收取实体红包哦，心意我领啦~ 🐾',
        contextToken
      );
      return;
    }

    // 缓存微信好友的最新 context_token
    const db = getDatabaseService();
    db.setSetting(`wechat_context_token_${fromUser}`, contextToken || '');

    // 3. 提取好友文本与媒体消息
    let textContent = '';
    let imageItem = null;

    for (const item of itemList) {
      if (item.type === 1) {
        textContent = (item.text_item?.text || '').trim();
      } else if (item.type === 2) {
        imageItem = item.image_item;
      }
    }

    const mappings = this.getFriendMappings();
    const boundCharId = mappings[fromUser];
    let finalUserMessage = textContent;

    if (imageItem && imageItem.media) {
      const encryptQueryParam = imageItem.media.encrypt_query_param;
      const aesKeyBase64 = imageItem.media.aes_key;

      if (encryptQueryParam && aesKeyBase64) {
        try {
          console.log('[WeChatService] 收到微信好友图片消息，正在尝试从 CDN 下载并解密...');
          const imageBuffer = await this.client.downloadAndDecryptMedia(encryptQueryParam, aesKeyBase64);

          // 获取当前绑定的角色 folder_name 用于保存图片到 media 目录
          if (boundCharId) {
            const charRow = db.db.prepare('SELECT folder_name FROM Characters WHERE id = ?').get(boundCharId) as { folder_name: string } | undefined;
            if (charRow) {
              const storageManager = new CharacterStorageManager();
              const mediaDir = join(storageManager.getBaseDir(), charRow.folder_name, 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }
              const filename = `wechat_recv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`;
              const fullPath = join(mediaDir, filename);
              fs.writeFileSync(fullPath, imageBuffer);

              finalUserMessage = `[wechat_image_media]:media/${filename}`;
              console.log('[WeChatService] 微信图片消息成功下载解密并保存至:', fullPath);
            }
          } else {
            // 兜底降级：未绑定角色时，将图片消息设为普通文字以触发选秀引导
            finalUserMessage = '[图片消息]';
          }
        } catch (err: any) {
          console.error('[WeChatService] 下载解密微信图片消息失败:', err);
        }
      }
    }

    if (!finalUserMessage) return;

    // 4. 路由微信斜杠命令
    if (finalUserMessage.startsWith('/')) {
      try {
        await this.routeSlashCommand(fromUser, finalUserMessage, contextToken);
      } catch (err: any) {
        console.error('[WeChatService] 路由并执行微信命令发生异常:', err);
        await this.sendWeChatText(fromUser, `❌ 指令执行异常: ${err.message || err}`, contextToken);
      }
      return;
    }

    // 5. 普通对话消息处理
    if (!boundCharId) {
      // 【先导提示】：新好友未绑定时，拦截一切对话，展示角色列表引导选秀
      await this.sendCharacterListMenu(fromUser, contextToken);
      return;
    }

    // 6. 执行核心对话流与 PC 客户端气泡同步
    await this.processConversationFlow(fromUser, boundCharId, finalUserMessage, contextToken);
  }

  /**
   * 路由与分发微信斜杠命令
   */
  private async routeSlashCommand(fromUser: string, text: string, contextToken: string): Promise<void> {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const arg = text.substring(command.length).trim(); // 提取命令参数

    const db = getDatabaseService();
    const mappings = this.getFriendMappings();
    const boundCharId = mappings[fromUser];

    switch (command) {
      case '/help':
        const helpText = `💡【Echo 微信接入斜杠命令指南】💡\n\n` +
          `👉 /选秀 : 查看数字生命角色列表\n` +
          `👉 /选秀 [序号] : 选择并绑定该角色进行对话\n` +
          `👉 /清除记忆 : 物理彻底清空当前绑定角色的历史与记忆\n` +
          `👉 /生图 : 绘制当前角色专属精美写真(可在命令后空格叠加自定义场景词，如: /生图 泳装 户外)\n` +
          `👉 /help : 显示本命令指南`;
        await this.sendWeChatText(fromUser, helpText, contextToken);
        break;

      case '/选秀':
        if (!arg) {
          await this.sendCharacterListMenu(fromUser, contextToken);
        } else {
          // 极致健壮性保护：物理清洗掉微信用户因复制指南而极易带入的各类中英文括号、中括号和空格
          const cleanArg = arg.replace(/[\[\]\(\)\s［］（）]/g, '');
          if (!cleanArg) {
            await this.sendCharacterListMenu(fromUser, contextToken);
          } else {
            await this.switchCharacterBinding(fromUser, parseInt(cleanArg, 10), contextToken);
          }
        }
        break;

      case '/清除记忆':
        if (!boundCharId) {
          await this.sendWeChatText(fromUser, '❌ 您当前尚未绑定任何角色，请发送【/选秀 序号】选择角色！', contextToken);
          return;
        }
        await this.executeClearMemory(fromUser, boundCharId, contextToken);
        break;

      case '/生图':
        if (!boundCharId) {
          await this.sendWeChatText(fromUser, '❌ 您当前尚未绑定任何角色，无法进行 AI 绘图，请发送【/选秀 序号】选择角色！', contextToken);
          return;
        }
        await this.executeAIImageGeneration(fromUser, boundCharId, arg, contextToken);
        break;

      default:
        await this.sendWeChatText(fromUser, '❓ 未知指令。发送【/help】可以查看支持的指令指南哦~', contextToken);
        break;
    }
  }

  /**
   * 发送角色后宫序号列表 (先导菜单)
   */
  private async sendCharacterListMenu(fromUser: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();

    if (characters.length === 0) {
      await this.sendWeChatText(
        fromUser,
        '😿 本系统目前还没有导入任何数字生命，请先去 PC 客户端导入角色后再聊吧！',
        contextToken
      );
      return;
    }

    let menu = `👑【Echo 数字生命角色列表】👑\n\n`;
    characters.forEach((char, index) => {
      menu += `${index + 1}. **${char.name}**\n`;
    });
    menu += `\n👉 首次使用或需要更换绑定，请发送【/选秀 序号】(如: /选秀 1) 宠幸对应的角色。绑定后您的微信对话将专属于该角色。`;

    await this.sendWeChatText(fromUser, menu, contextToken);
  }

  /**
   * 绑定并切换微信对话角色 (物理写入 bindings 映射表)
   */
  private async switchCharacterBinding(fromUser: string, index: number, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    const targetIdx = index - 1;

    if (isNaN(index) || targetIdx < 0 || targetIdx >= characters.length) {
      await this.sendWeChatText(fromUser, '⚠️ 选秀序号无效，请回复【/选秀】重新核对列表序号发送！', contextToken);
      return;
    }

    const targetChar = characters[targetIdx];
    const mappings = this.getFriendMappings();
    mappings[fromUser] = targetChar.id;

    // 1. 将新映射字典存入 Settings 表
    db.saveWeChatMapping(mappings);

    // 2. 仅向微信端下发绑定切换成功提示回执，而不发送并保存 first_mes 欢迎句
    const successTip = `✨ 已成功绑定并宠幸角色 [${targetChar.name}]！现在您可以直接发消息与她聊天了哦~ 🐾`;
    await this.sendWeChatText(fromUser, successTip, contextToken);

    // 3. 广播通知 PC 前端客户端更新 mappings 绑定表格状态
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
      windows[0].webContents.send('wechat-status-updated', this.getStatus());
    }
  }

  /**
   * /清除记忆 (物理彻底清盘，完美复用本地 reset 逻辑)
   */
  private async executeClearMemory(fromUser: string, characterId: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) return;

    try {
      console.log(`[WeChatService] 正在根据微信指令 /清除记忆 物理重置角色 [${char.name}]...`);
      
      // A. 清空 SQLite 对话历史
      db.deleteChatHistory(characterId);
      db.setSetting('clear_chat_at_' + characterId, '0');

      // B. 重置 Memory.md 初始框架
      const storageManager = new CharacterStorageManager();
      const folderName = char.folder_name;
      const memoryInitContent = `<!--\n{\n  "stm": [],\n  "ltm": {}\n}\n-->\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n暂无短期记忆。\n\n## 长期记忆 (Long-Term Memory)\n暂无长期记忆。`;
      storageManager.writeCharacterFile(folderName, 'Memory.md', memoryInitContent);
      storageManager.writeCharacterFile(folderName, 'Schedule.md', '暂无日程');
      storageManager.writeCharacterFile(folderName, 'Goals.md', '暂无长期目标');

      // C. 清空角色 USER 画像 (非全局 USER.md)
      const charUserPath = join(storageManager.getBaseDir(), folderName, 'USER.md');
      // 写入空白画像数组
      fs.writeFileSync(charUserPath, '<!--\n[]\n-->\n# 角色对用户的画像侧写\n暂无细节画像积累。', 'utf-8');

      // D. 置空 Summary.md 缓存
      const summaryPath = join(storageManager.getBaseDir(), folderName, 'Summary.md');
      if (fs.existsSync(summaryPath)) {
        fs.writeFileSync(summaryPath, '', 'utf-8');
      }

      await this.sendWeChatText(fromUser, `✨ 已成功将角色 [${char.name}] 的历史聊天与记忆库物理彻底清空，您可以开启全新的浪漫了！`, contextToken);

      // E. 同步广播通知 PC 前端客户端重载刷新 UI
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
        windows[0].webContents.send('chat-history-cleared', { characterId });
      }
    } catch (err: any) {
      await this.sendWeChatText(fromUser, `❌ 记忆清理发生异常: ${err.message}`, contextToken);
    }
  }

  /**
   * /生图 (对接 NovelAI 物理生图，本地同步落盘并回发微信)
   */
  private async executeAIImageGeneration(fromUser: string, characterId: string, prompt: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const configStr = db.getSetting('novelai_config');
    if (!configStr) {
      await this.sendWeChatText(fromUser, '⚠️ 您的客户端尚未配置 NovelAI 接口参数，请前往 PC 客户端设置中心进行配置！', contextToken);
      return;
    }

    const config = JSON.parse(configStr);
    if (!config.apiKey || config.apiKey.trim() === '') {
      await this.sendWeChatText(fromUser, '⚠️ 尚未配置 API Key，无法生成图片。', contextToken);
      return;
    }

    await this.sendWeChatText(fromUser, '🎨 正在为您绘制精美插画中，请稍候片刻...', contextToken);

    try {
      const char = db.getAllCharacters().find(c => c.id === characterId)!;
      const folderName = char.folder_name;
      const storageManager = new CharacterStorageManager();

      // 1. 读取角色外貌固定特征提示词
      let appearancePrompt = '';
      const appearanceContent = storageManager.readCharacterFile(folderName, 'Appearance.md');
      if (appearanceContent) {
        const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
        if (tagsMatch) {
          appearancePrompt = tagsMatch[1].trim();
        }
      }

      // 2. 拼接绘图提示词
      const userPrompt = prompt?.trim() || '';
      let finalPrompt = '';
      if (appearancePrompt) {
        finalPrompt = userPrompt ? `${appearancePrompt}, ${userPrompt}` : appearancePrompt;
      } else {
        finalPrompt = userPrompt || '1girl, masterpiece, very aesthetic, best quality';
      }

      // 3. 注入画师串与质量后缀
      if (config.artistString?.trim()) {
        finalPrompt = `${config.artistString.trim()}, ${finalPrompt}`;
      }
      if (config.qualityPrompt?.trim()) {
        finalPrompt = `${finalPrompt}, ${config.qualityPrompt.trim()}`;
      }

      const dims = config.defaultDimensions || 'portrait';

      // 4. 调用现有的 NovelAiService.generateImage 生成二进制 buffer
      const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

      // 5. 双向物理同步：将图片写入对应角色的 media 目录
      const mediaDir = join(storageManager.getBaseDir(), folderName, 'media');
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const filename = `wechat_${Date.now()}.png`;
      const localImgPath = join(mediaDir, filename);
      fs.writeFileSync(localImgPath, imageBuffer);

      // 3. 将生图信息物理写入 Messages 表，方便 PC 客户端同步
      const newImgMsg = {
        id: `wechat_img_${Date.now()}`,
        character_id: characterId,
        role: 'assistant',
        content: `[wechat_image_media]:media/${filename}`,
        timestamp: Date.now(),
        token_usage: 0
      };
      db.saveMessage(newImgMsg);

      // 4. 发送 IPC 同步给渲染层前端进行气泡极速渲染 (附加 base64)
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
        windows[0].webContents.send('receive-message', {
          ...newImgMsg,
          imageBase64: `data:image/png;base64,${imageBuffer.toString('base64')}`
        });
      }

      // 5. 加密文件并利用 C2C CDN 回发给手机微信端好友
      await this.uploadAndSendWeChatImage(fromUser, localImgPath, imageBuffer, contextToken);
    } catch (err: any) {
      await this.sendWeChatText(fromUser, `❌ 绘图失败: ${err.message}`, contextToken);
    }
  }

  /**
   * 处理微信与大模型的普通对话流程 (含 PC 客户端实时同步、分句打字发信与整洁落盘)
   */
  private async processConversationFlow(fromUser: string, characterId: string, userMessage: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      await this.sendWeChatText(fromUser, '⚠️ 系统尚未配置大模型，请在客户端先保存配置。', contextToken);
      return;
    }
    const settings = JSON.parse(configStr);
    const modelAdapter = new ModelAdapter(settings.primary, settings.secondary);

    // 1. 双向同步：将用户的微信发信内容物理写入数据库，同步 PC 端
    const userMsg = {
      id: `wechat_u_${Date.now()}`,
      character_id: characterId,
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
      token_usage: 0
    };
    db.saveMessage(userMsg);

    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
      windows[0].webContents.send('receive-message', userMsg);
    }

    // 2. 模拟微信端“正在打字输入...”状态以获得极佳等待体验
    this.sendWeChatTyping(fromUser, contextToken, true);

    try {
      // 3. 构建历史记忆并调用大模型推理
      const history = db.getChatHistory(characterId, 15);
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(characterId) },
        ...history.map(m => {
          let content = m.content;
          if (content.startsWith('[wechat_image_media]:')) {
            content = '（用户发来了一张图片）';
          }
          return {
            role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: content
          };
        }),
        { role: 'user', content: userMessage.startsWith('[wechat_image_media]:') ? '（用户发来了一张图片）' : userMessage }
      ];

      const response = await modelAdapter.chat(chatMessages, { usePrimary: true });
      const finalAIResponse = response.content.trim();

      // 4. 【特化发信解耦】：微信端根据对话模式决定发信策略
      const chatMode = settings.chatMode || 'descriptive';

      // 关闭微信输入态
      this.sendWeChatTyping(fromUser, contextToken, false);

      if (chatMode === 'dialogue') {
        // 纯文字对话模式：切句分句带呼吸感打字发送
        const sentences = finalAIResponse.match(/[^。！？\n]+[。！？\n]*/g) || [finalAIResponse];
        for (const sentence of sentences) {
          const cleanStr = sentence.trim();
          if (!cleanStr) continue;

          // 基础延迟 1 秒，每字多延迟 50 毫秒，最大限制 4 秒 (打字效果)
          const delay = Math.min(4000, 1000 + cleanStr.length * 50);
          await new Promise(resolve => setTimeout(resolve, delay));

          await this.sendWeChatText(fromUser, cleanStr, contextToken);
        }
      } else {
        // 动作描写模式 & 导演模式：一次性完整发送，根据总字数保留基础打字延迟
        const delay = Math.min(5000, 1500 + finalAIResponse.length * 20);
        await new Promise(resolve => setTimeout(resolve, delay));

        await this.sendWeChatText(fromUser, finalAIResponse, contextToken);
      }

      // 5. 【特化落盘解耦】：本地 SQLite 仅记入 1 条整洁记录，广播给客户端推入 1 个大气泡！
      const assistantMsg = {
        id: `wechat_a_${Date.now()}`,
        character_id: characterId,
        role: 'assistant',
        content: finalAIResponse,
        timestamp: Date.now(),
        token_usage: 0
      };
      db.saveMessage(assistantMsg);

      if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
        windows[0].webContents.send('receive-message', assistantMsg);
      }
    } catch (err: any) {
      this.sendWeChatTyping(fromUser, contextToken, false);
      await this.sendWeChatText(fromUser, `😿 对不起，我的系统脑电波似乎发生了一点异常: ${err.message}`, contextToken);
    }
  }

  /**
   * 组装角色系统人设 System Prompt
   */
  private buildSystemPrompt(characterId: string): string {
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId)!;
    const folderName = char.folder_name;

    const storageManager = new CharacterStorageManager();
    const soulPath = join(storageManager.getBaseDir(), folderName, 'Soul.md');
    const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8').trim() : '一个神秘人。';

    return `你现在需要扮演名为 ${char.name} 的角色在微信单聊中与用户直接对话聊天。
请你绝对严格遵守你的核心人设定位于说话风格：
${soulContent}

注意事项：
- 严格遵循你的核心人设，用简体中文回复，聊天时语气要自然、拟真，符合你和用户的好友关系。
- 微信消息字数不宜过于臃肿死板，每次回复控制在 150 字以内。
- 严禁输出任何 XML 标记、Markdown 特殊修饰（如加粗 **、代码块等），只输出纯净的可阅读文本气泡内容。`;
  }

  /**
   * 启动微信 Scheme 登录二维码请求并监听扫码状态 (严格 1 次限制)
   */
  public async requestQRAndStartLogin(): Promise<string> {
    const db = getDatabaseService();
    
    // 强制复位，清除原先可能残留的所有会话配置，严格执行 1 次绑定限制
    db.setSetting('wechat_token', '');
    db.setSetting('wechat_sync_buf', '');
    db.setSetting('wechat_account_id', '');
    db.setSetting('wechat_qrcode_url', '');

    try {
      const data = await this.client.requestJson('GET', 'ilink/bot/get_bot_qrcode?bot_type=3');
      if (data && data.qrcode && data.qrcode_img_content) {
        // 在本地毫秒级将微信真正用于授权绑定的 qrcode_img_content 官方跳转链接转换成完美兼容的高保真 Base64 PNG 图片，彻底切断外网 SSL 握手阻碍
        const localQRBase64 = await QRCode.toDataURL(data.qrcode_img_content, { margin: 1.5, width: 220 });
        db.setSetting('wechat_qrcode_url', localQRBase64);
        
        // 物理锁定当前的活动二维码游标
        this.currentQR = data.qrcode;

        // 异步开启轮询校验
        this.pollQRStatus(data.qrcode).catch(err => {
          console.error('[WeChatService] 扫码确认状态轮询发生异常:', err);
        });

        // 广播最新的微信状态让前端重置
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
          windows[0].webContents.send('wechat-status-updated', this.getStatus());
        }

        return localQRBase64; // 返回本地 Base64 二维码大图片给前端 Vue 直接绑定
      } else {
        throw new Error('二维码响应结果异常');
      }
    } catch (err: any) {
      console.error('[WeChatService] 获取扫码二维码失败:', err.message);
      throw err;
    }
  }

  /**
   * 轮询监控微信二维码扫码状态
   */
  private async pollQRStatus(qrcode: string): Promise<void> {
    const db = getDatabaseService();
    let tick = 0;

    while (tick < 30) { // 微信扫码有效期限额 5 分钟 (约 30 次)
      if (this.shutdownSignal) break;
      
      // 物理死锁防线：检测到当前活动的扫码二维码已发生更新，立刻无痛退出旧协程，拒绝多路并发限流
      if (qrcode !== this.currentQR) {
        console.log('[WeChatService] 检测到最新的绑定二维码生成，主动销毁注销旧的扫码协程:', qrcode);
        break;
      }

      try {
        const data = await this.client.requestJson(
          'GET',
          `ilink/bot/get_qrcode_status?qrcode=${qrcode}`,
          null,
          null
        );

        const status = data.status || 'wait';

        if (status === 'confirmed' && data.bot_token) {
          console.log('[WeChatService] 用户扫码托管授权登录成功！');

          db.setSetting('wechat_token', data.bot_token);
          db.setSetting('wechat_account_id', data.ilink_bot_id || 'wechat_robot');
          db.setSetting('wechat_sync_buf', ''); // 重置游标
          if (data.baseurl) {
            db.setSetting('wechat_base_url', data.baseurl);
            this.client.setBaseUrl(data.baseurl);
          }

          // 缓存并清理 wechat_qrcode_url
          db.setSetting('wechat_qrcode_url', '');

          // 瞬间开启实时长轮询守护收信任务！
          db.setSetting('wechat_enabled', '1');
          await this.startService();

          // 广播通知前端 Vue 设置页面扫码绑定成功，切换至详情列表看板
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
            windows[0].webContents.send('wechat-login-confirmed', this.getStatus());
          }
          break;
        }

        if (status === 'expired' || status === 'cancel') {
          console.log('[WeChatService] 二维码扫码已物理失效或用户拒绝授权绑定。');
          db.setSetting('wechat_qrcode_url', '');
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
            windows[0].webContents.send('wechat-status-updated', this.getStatus());
          }
          break;
        }

        // wait 状态继续轮询
        await new Promise(resolve => setTimeout(resolve, 10000)); // 每 10 秒轮询一次
        tick++;
      } catch (err: any) {
        console.error('[WeChatService] 轮询扫码状态网络短暂异常:', err.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // 只有当当前退出的是最新的活动轮询时，才允许兜底复位 wechat_qrcode_url 并同步前端状态，防止旧协程越权破坏最新生成的二维码
    if (this.currentQR === qrcode) {
      db.setSetting('wechat_qrcode_url', '');
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0 && !windows[0].webContents.isDestroyed()) {
        windows[0].webContents.send('wechat-status-updated', this.getStatus());
      }
    }
  }
}
