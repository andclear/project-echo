import fs from 'fs';
import { join } from 'path';
import { app, BrowserWindow } from 'electron';
import { getDatabaseService } from '../db/database';
import { ModelAdapter, ChatMessage } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager';
import { WeChatClient } from './WeChatClient';
import { mergeChatHistory, cleanContentForLLM, formatUserImageForLLM } from '../utils/ChatHistoryMerger';
import { NovelAiService } from './NovelAiService';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { MessageBusService } from './MessageBusService';

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
        } catch (_) { }
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

              // 微信端接收图片消息进行多模态分析
              let imgDesc = '';
              try {
                const configStr = db.getSetting('model_config');
                if (configStr) {
                  const modelSettings = JSON.parse(configStr);
                  const modelAdapter = new ModelAdapter(modelSettings.primary, modelSettings.secondary);
                  const imageBase64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;
                  imgDesc = await modelAdapter.analyzeImage(imageBase64);
                }
              } catch (err) {
                console.error('[WeChatService] 微信图片识别多模态分析发生异常:', err);
              }

              if (imgDesc) {
                finalUserMessage = `[wechat_image_media]:media/${filename}[image_desc:${imgDesc}]`;
              } else {
                finalUserMessage = `[wechat_image_media]:media/${filename}`;
              }
              console.log('[WeChatService] 微信图片消息成功下载解密并保存至:', fullPath);
            }
          } else {
            // 兜底降级：未绑定角色时，将图片消息设为普通文字以触发选秀引导
            finalUserMessage = '（用户发来了一张图片）';
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
          `👉 /选秀 : 查看角色列表\n` +
          `👉 /选秀 [序号] : 选择并绑定该角色进行对话，不需要输入[]\n` +
          `👉 /清除记忆 : 物理彻底清空当前绑定角色的历史与记忆\n` +
          `👉 /生图 : 触发当前角色的AI绘图功能\n` +
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
  /**
   * /生图 (对接 NovelAI 物理生图，本地同步落盘并回发微信)
   * 🚀 智能上下文情境提炼升级版：彻底阻断用户传参，AI 伴侣根据 15 条会话上下文进行高保真意境生图
   */
  private async executeAIImageGeneration(fromUser: string, characterId: string, prompt: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();

    // 1. 检测绘图配置
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

    // 2. 检测大模型配置并初始化 ModelAdapter
    const modelConfigStr = db.getSetting('model_config');
    if (!modelConfigStr) {
      await this.sendWeChatText(fromUser, '⚠️ 客户端尚未配置全局大模型，无法进行会话上下文意境分析，请先在 PC 客户端保存设置！', contextToken);
      return;
    }

    await this.sendWeChatText(fromUser, '🎨 正在深入分析我们的聊天记忆，为你精心描绘当前情景中，请稍候片刻...', contextToken);

    try {
      const modelSettings = JSON.parse(modelConfigStr);
      const modelAdapter = new ModelAdapter(modelSettings.primary, modelSettings.secondary);

      const char = db.getAllCharacters().find(c => c.id === characterId)!;
      const folderName = char.folder_name;
      const storageManager = new CharacterStorageManager();

      // 3. 读取角色外貌固定特征提示词
      let appearancePrompt = '';
      const appearanceContent = storageManager.readCharacterFile(folderName, 'Appearance.md');
      if (appearanceContent) {
        const tagsMatch = appearanceContent.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
        if (tagsMatch) {
          appearancePrompt = tagsMatch[1].trim();
        }
      }

      // 4. 获取聊天记忆、长期记忆与性格灵魂
      const baseDir = storageManager.getBaseDir();
      const soulPath = join(baseDir, folderName, 'Soul.md');
      const soulContent = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf8') : '';
      const memoryPath = join(baseDir, folderName, 'Memory.md');
      const memoryContent = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf8') : '暂无记忆';

      // 🚀 微信生图意境自省自适应提取合并
      const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive';
      const isDialogue = chatMode === 'dialogue';
      const limit = isDialogue ? 45 : 15;
      const rawHistory = db.getChatHistory(characterId, limit);
      const history = isDialogue ? mergeChatHistory(rawHistory) : rawHistory;
      // 过滤掉 AI 生成图片消息（assistant 图片），用户图片保留占位文字
      const contextText = history
        .filter((h: any) => !(h.role === 'assistant' && (h.content || '').startsWith('[wechat_image_media]:')))
        .map((h: any) => {
          const label = h.role === 'user' ? '用户' : '角色';
          const content = (h.role === 'user' && (h.content || '').startsWith('[wechat_image_media]:')
            ? formatUserImageForLLM(h.content)
            : cleanContentForLLM(h.content));
          return `${label}: ${content}`;
        }).join('\n');

      // 5. 注入与 PC 客户端 100% 对称的 NovelAI 4.5 双角色隔离 Pipe 黄金指令
      const systemPrompt = `你是一个非常专业且具有极高艺术审美的 NovelAI 4.5 Full 绘图提示词生成大师。
请你仔细阅读并深度结合 AI 角色的性格设定 (Soul.md)、记忆系统 (Memory.md) 以及他们之间最近的聊天上下文对话内容，为当前场景构思并生成一副精美的文生图（T2I）提示词。

你的核心目标是生成一个能反映【当前聊天气氛、角色动作、神情、周围环境以及画面细节】的 NovelAI 绘图 Prompt。

【🔴 极其重要的 NovelAI 4.5 黄金生图规范】：
1. 你的返回必须包含两个部分：
   - 英文生图 Tags (英文逗号分隔的 NovelAI Danbooru 风格 Tag 提示词)。
   - 中文画面内容描述 (一两句话简述画面中发生了什么，包括角色和 NPC 的互动细节)。
2. 【Danbooru 标签层级】：提示词必须是以英文逗号分隔的 Danbooru Tag，单词权重从左到右递减。请严格遵循以下结构排列：
   [主体数量 (Subject Count)], [角色特征/动作], [环境背景], [天气/时间], [光效/氛围], [画面视角/构图], [艺术画质 Tag]
   - 主体数量必须作为第一个 Tag！例如："1girl"（单人）、"1boy, 1girl"（情侣）、"no humans"（风景/纯景物，此时必须在最前面加入 "background dataset" 标签，以及 "no humans" 开头）。
3. 🔴【多角色 Pipe 分隔符 "|" 黄金语法】：当画面中出现 2 个及以上角色（例如你与用户、或与NPC）时，你必须使用 Pipe 分隔符 "|" 进行角色与其属性的物理强隔离！语法结构如下：
   基础提示词（人数/环境/构图/氛围/画质标签） | 角色1类型, 角色名称/特征, 角色1表情服装, source#/[action] 动作 | 角色2类型, 特征, 角色2表情服装, target#/[action] 动作
   - 【互动动作前缀】：多角色互动时，必须使用 source# (动作发起者)、target# (动作接受者) 或 mutual# (共同发生动作) 进行肢体姿态锚定，彻底解决肢体黏连和特征乱串问题！
     - 拥抱：source#embrace 与 target#embrace
     - 摸头：source#headpat 与 target#headpat
     - 牵手：双方均使用 mutual#handholding
     - 互相注视：source#looking at another 与 target#being looked at
4. 【NovelAI 4.5 必加画质 Tag】：提示词尾部必须全量附加官方高画质标签："very aesthetic, masterpiece, best quality, highres, no text, no watermark"。
5. 🔞【NSFW 场景强制规范】：仔细判断聊天上下文中是否存在性暗示、亲密接触、色情描写、裸露、成人互动等 NSFW 内容。若存在，则必须在生图提示词中尽可能多地使用 Danbooru NSFW 标签（例如：nsfw, explicit, nude, naked, topless, bottomless, nipples, pussy, penis, sex, vaginal, oral, cum, cum on body, orgasm, spread legs, missionary, doggy style, from behind, ahegao, moaning 等）来精准还原场景气氛。不得因为内容敏感就主动回避或弱化 NSFW 描写，忠实还原上下文是首要原则。
6. 你的输出必须严格按照以下格式排版，请勿将输出内容包裹在任何 markdown 代码块中，直接以纯文本形式输出：
### Image Prompt
(在这里输出当前场景的生图 Tag)

### Image Description
(在这里用中文对画面做一个简述。)`;

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `【角色设定 Soul.md】：\n${soulContent}\n\n【角色记忆 Memory.md】：\n${memoryContent}\n\n【最近聊天上下文】：\n${contextText}\n\n请帮我生成当前画面场景的生图 Prompt 和描述。` }
      ];

      // 调用副大模型进行意境推理提取
      const response = await modelAdapter.chat(messages, { useSecondary: true, skipSystemInjection: true });
      const raw = response.content.trim();

      let extractedPrompt = '';
      let extractedDesc = '';

      const promptMatch = raw.match(/### Image Prompt\s*([\s\S]*?)(?:### Image Description|$)/i);
      const descMatch = raw.match(/### Image Description\s*([\s\S]*)/i);

      if (promptMatch) extractedPrompt = promptMatch[1].trim();
      if (descMatch) extractedDesc = descMatch[1].trim();

      // 智能兜底自愈防空
      if (!extractedPrompt) {
        extractedPrompt = raw.replace(/<\/?[^>]+(>|$)/g, "").trim() || '1girl, portrait, smiling';
      }
      if (!extractedDesc) {
        extractedDesc = '这是我为你绘制的专属写真哦。';
      }

      // 6. 前置发送大模型精心构思出的中文画面描述气泡给微信端好友
      await this.sendWeChatText(fromUser, `🎨 “${extractedDesc} 🐾”`, contextToken);

      // 7. 黄金公式拼装生图 Tags：[画师风格] + [固定外貌] + [当前动作场景] + [质量词后缀]
      let finalPrompt = appearancePrompt
        ? `${appearancePrompt}, ${extractedPrompt}`
        : extractedPrompt;

      // 仅在固定模式下预拼画师串，随机模式由 NovelAiService.generateImage 内部统一随机拼接
      if (!config.randomArtist && config.artistString?.trim()) {
        finalPrompt = `${config.artistString.trim()}, ${finalPrompt}`;
      }
      if (config.qualityPrompt?.trim()) {
        finalPrompt = `${finalPrompt}, ${config.qualityPrompt.trim()}`;
      }

      const dims = config.defaultDimensions || 'portrait';

      // 8. 调用 NovelAiService 绘图生成二进制 Buffer
      const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

      // 9. 物理同步至 media 目录
      const mediaDir = join(storageManager.getBaseDir(), folderName, 'media');
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const filename = `wechat_${Date.now()}.png`;
      const localImgPath = join(mediaDir, filename);
      fs.writeFileSync(localImgPath, imageBuffer);

      // 保存元数据 .json 描述
      const metaFilename = filename.replace('.png', '.json');
      const metaFullPath = join(mediaDir, metaFilename);
      const metadata = {
        prompt: finalPrompt,
        negativePrompt: config.negativePrompt || '',
        dimensions: dims,
        timestamp: Date.now(),
        prefixType: 'chat'
      };
      fs.writeFileSync(metaFullPath, JSON.stringify(metadata, null, 2));

      // 通过 MessageBusService 存盘并推送微信生图消息（PC 端实时同步）
      const imgMsgId = `wechat_img_${Date.now()}`;
      MessageBusService.getInstance().publish({
        id: imgMsgId,
        round_id: imgMsgId,
        seq: 0,
        character_id: characterId,
        role: 'assistant',
        msg_type: 'image',
        content: `[wechat_image_media]:media/${filename}`,
        timestamp: Date.now(),
        token_usage: 0
      });

      // 11. 加密图片并推送到微信 CDN C2C 通道，回发给手机微信端好友
      await this.uploadAndSendWeChatImage(fromUser, localImgPath, imageBuffer, contextToken);
    } catch (err: any) {
      await this.sendWeChatText(fromUser, `❌ 绘图失败: ${err.message || err}`, contextToken);
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

    // 1. 双向同步：将用户的微信发信内容通过 MessageBusService 存盘并推送到 PC 端
    const userMsgId = `wechat_u_${Date.now()}`;
    const userMsgTs = Date.now();
    MessageBusService.getInstance().publish({
      id: userMsgId,
      round_id: userMsgId,
      seq: 0,
      character_id: characterId,
      role: 'user',
      msg_type: 'text',
      content: userMessage,
      timestamp: userMsgTs,
      token_usage: 0
    }, { skipUnreadUpdate: true });

    // 2. 模拟微信端“正在打字输入...”状态以获得极佳等待体验
    this.sendWeChatTyping(fromUser, contextToken, true);

    try {
      // 3. 构建历史记忆并调用大模型推理 (自适应双门限合并还原)
      const chatMode = db.getSetting(`chat_mode_${characterId}`) || 'descriptive';
      const isDialogue = chatMode === 'dialogue';
      const limit = isDialogue ? 45 : 15;
      const rawHistory = db.getChatHistory(characterId, limit);
      const history = isDialogue ? mergeChatHistory(rawHistory) : rawHistory;
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(characterId) },
        // 过滤掉 AI 生成图片消息（assistant 图片），保留用户图片占位符
        ...history
          .filter((m: any) => !(m.role === 'assistant' && (m.content || '').startsWith('[wechat_image_media]:')))
          .map((m: any) => {
            const content = (m.role === 'user' && (m.content || '').startsWith('[wechat_image_media]:')
              ? formatUserImageForLLM(m.content)
              : cleanContentForLLM(m.content));
            return {
              role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
              content: content
            };
          }),
        { role: 'user', content: userMessage.startsWith('[wechat_image_media]:') ? formatUserImageForLLM(userMessage) : cleanContentForLLM(userMessage) }
      ];

      const response = await modelAdapter.chat(chatMessages, { usePrimary: true });
      // 物理剔除思维链标签（<think>、<thinking>、<cot> 及其内容），确保微信端和 PC 端气泡均为净化后内容
      const rawAIResponse = response.content.trim();
      const fullThinkReg = /<(cot|think|thinking)>[\s\S]*?<\/\1>/gi;
      const halfThinkReg = /<(cot|think|thinking)>[\s\S]*$/gi;
      const finalAIResponse = rawAIResponse
        .replace(fullThinkReg, '')
        .replace(halfThinkReg, '')
        .trim();

      // 4. 【特化发信解耦】：微信端根据对话模式决定发信策略 (重用已获取的专属 chatMode)

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

      // 5. 通过 MessageBusService 存盘 AI 回复并推送到 PC 端
      const assistantMsgId = `wechat_a_${Date.now()}`;
      MessageBusService.getInstance().publish({
        id: assistantMsgId,
        round_id: userMsgId,
        seq: 1,
        character_id: characterId,
        role: 'assistant',
        msg_type: 'text',
        content: finalAIResponse,
        timestamp: Date.now(),
        token_usage: 0
      });
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
