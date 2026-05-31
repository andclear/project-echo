# 微信个人微信接入 (weixin_oc) 项目功能实现方案

本方案针对本项目中**“限制最多接入 1 个微信号”**、**“支持 `/选秀` 角色菜单与切换”**、**“支持 `/清除记忆` 等命令”**、**“消息双向同步”**、**“红包拦截与打字连发特化”** 等核心业务需求，提供完整的 Electron 架构设计与代码落地规范。

> [!IMPORTANT]
> 本方案完全不依赖任何本地微信 Hook 挂机，亦不接入任何微信群聊（技术上只对私聊好友触发），完全在主进程中实现业务逻辑闭环。

---

## 一、 系统配置与数据库映射设计 (持久化层)

由于需要限制 **“最多只能接入 1 个微信号”** 且需要保存 **“微信好友与本地数字生命角色”** 的绑定映射，我们利用 SQLite 中现有的 `Settings` 全局设置表进行物理持久化。

### 1. 全局持久化键值规范
我们将以下 Key 写入全局 `Settings` 表：

| 键名 (Key) | 数据类型 (Value) | 业务用途 |
| :--- | :--- | :--- |
| `wechat_enabled` | `string` (`"0"` \| `"1"`) | 全局微信服务是否开启的门控开关 |
| `wechat_token` | `string` (Bearer 令牌) | 唯一托管微信号扫码登录成功后的身份令牌 |
| `wechat_account_id` | `string` | 托管微信号在 iLink 侧的唯一 ID |
| `wechat_sync_buf` | `string` (增量游标) | 用于 `/ilink/bot/getupdates` 的增量长轮询同步游标 |
| `wechat_qrcode_url` | `string` | 微信扫码 scheme 链接 (用于生成页面二维码) |
| `wechat_friend_mappings` | `string` (JSON 字符串) | 微信好友与本站角色的映射字典 (例如：`{"wxid_f123": "char_A"}`) |

### 2. 好友与角色绑定字典结构
`wechat_friend_mappings` 在数据库中以 JSON 文本存储，结构设计如下：
```json
{
  "微信加密好友ID (from_user_id)": "绑定的本地角色ID (character_id)"
}
```

---

## 二、 微信接入后台守护服务 (WeChatService)

在 `src/main/services/` 下物理创建 `WeChatService.ts`。该服务为单例模式，控制微信的初始化、登录长轮询、收信处理及消息拦截。

### 1. 核心骨架实现 (主进程)
```typescript
import { join } from 'path';
import { app, BrowserWindow } from 'electron';
import { getDatabaseService } from '../db/database';
import { ModelAdapter } from '../models/ModelAdapter';
import { CharacterStorageManager } from '../utils/CharacterStorageManager'; // 假设的路径
import axios from 'axios';

export class WeChatService {
  private static instance: WeChatService;
  private isRunning: boolean = false;
  private shutdownSignal: boolean = false;

  private constructor() {}

  public static getInstance(): WeChatService {
    if (!WeChatService.instance) {
      WeChatService.instance = new WeChatService();
    }
    return WeChatService.instance;
  }

  /**
   * 启动微信后台守护轮询任务
   */
  public async startService(): Promise<void> {
    const db = getDatabaseService();
    const token = db.getSetting('wechat_token');
    
    if (!token) {
      console.log('[WeChatService] 缺失 wechat_token，服务暂不启动，等待扫码绑定。');
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;
    this.shutdownSignal = false;
    console.log('[WeChatService] 微信接入服务已成功启动，开始长轮询监听...');

    // 异步拉取，不阻塞主进程启动
    this.pollLoop().catch(err => {
      console.error('[WeChatService] 长轮询发生未捕获异常:', err);
      this.isRunning = false;
    });
  }

  /**
   * 关闭与断开微信接入
   */
  public async stopService(): Promise<void> {
    this.shutdownSignal = true;
    this.isRunning = false;
    console.log('[WeChatService] 微信服务已接收到关闭指令。');
  }

  /**
   * 长轮询收信主循环
   */
  private async pollLoop(): Promise<void> {
    const db = getDatabaseService();
    while (!this.shutdownSignal) {
      const token = db.getSetting('wechat_token');
      if (!token) {
        await this.stopService();
        break;
      }

      try {
        const syncBuf = db.getSetting('wechat_sync_buf') || '';
        
        // 调用 iLink AI 获取增量消息接口
        const response = await axios.post(
          'https://ilinkai.weixin.qq.com/ilink/bot/getupdates',
          {
            base_info: { channel_version: "project-echo" },
            get_updates_buf: syncBuf
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'AuthorizationType': 'ilink_bot_token',
              'Authorization': `Bearer ${token}`
            },
            timeout: 35000 // 微信长轮询超时 35 秒
          }
        );

        const data = response.data;
        if (data && data.ret === 0 && data.errcode === 0) {
          // 1. 更新拉取游标并存盘
          if (data.get_updates_buf) {
            db.setSetting('wechat_sync_buf', data.get_updates_buf);
          }

          // 2. 遍历并分发消息列表
          const msgs = data.msgs || [];
          for (const msg of msgs) {
            await this.handleIncomingMessage(msg);
          }
        }
      } catch (err: any) {
        console.error('[WeChatService] 轮询周期异常，5秒后自动重试:', err.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * 处理单条入站消息 (含过滤、红包拦截与命令路由)
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    const fromUser = msg.from_user_id; // 微信好友 ID
    const itemList = msg.item_list || [];
    const contextToken = msg.context_token; // 极其重要：发信所需的上下文 Token

    if (!fromUser) return;

    // 【门控一】：严防死守，绝对不允许群聊消息接入！
    // 微信群聊消息判定 (若含有群聊特有字段或 message_type，直接丢弃)
    if (msg.group_id || msg.is_group_chat || msg.message_type === 3) {
      console.log('[WeChatService] 拦截到群聊消息，安全跳过，不予接入。');
      return;
    }

    // 【门控二】：拦截红包类消息
    const hasRedPacket = itemList.some((item: any) => {
      // 判定是否是红包类型，或文本中显式匹配了 [微信红包]
      return item.type === 6 || (item.type === 1 && item.text_item?.text?.includes('[微信红包]'));
    });

    if (hasRedPacket) {
      console.log(`[WeChatService] 成功拦截来自好友 ${fromUser} 的红包消息`);
      await this.sendWeChatText(
        fromUser, 
        '小主，红包已收到啦！但作为数字生命的我目前还无法物理收取红包哦，心意我领啦~ 🐾',
        contextToken
      );
      return; // 拦截成功，不再大模型推理
    }

    // 缓存好友的最新 context_token
    const db = getDatabaseService();
    db.setSetting(`wechat_context_token_${fromUser}`, contextToken || '');

    // 3. 提取好友文本内容
    let textContent = '';
    const textItem = itemList.find((item: any) => item.type === 1);
    if (textItem) {
      textContent = (textItem.text_item?.text || '').trim();
    }

    if (!textContent) return;

    // 4. 斜杠命令路由器判断
    if (textContent.startsWith('/')) {
      await this.routeSlashCommand(fromUser, textContent, contextToken);
      return;
    }

    // 5. 普通对话：校验是否已经绑定了数字生命角色
    const mappings = this.getFriendMappings();
    const boundCharId = mappings[fromUser];

    if (!boundCharId) {
      // 【先导提示逻辑】：如果尚未绑定角色，直接列出菜单要求进行选秀绑定
      await this.sendCharacterListMenu(fromUser, contextToken);
      return;
    }

    // 6. 核心对话流触发与同步
    await this.processConversationFlow(fromUser, boundCharId, textContent, contextToken);
  }
}
```

---

## 三、 斜杠命令路由与业务实现 (命令层)

主进程接收微信命令，完全与现有客户端核心功能对接。

### 1. 命令解析与分发
```typescript
  private async routeSlashCommand(fromUser: string, text: string, contextToken: string): Promise<void> {
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();
    const arg = parts[1] || '';

    const db = getDatabaseService();
    const mappings = this.getFriendMappings();
    const boundCharId = mappings[fromUser];

    switch (command) {
      case '/help':
        const helpText = `💡【Echo 微信接入斜杠命令指南】💡\n\n` +
          `👉 /选秀 : 查看数字生命角色列表\n` +
          `👉 /选秀 [序号] : 选择并绑定与该角色聊天\n` +
          `👉 /清除记忆 : 物理彻底清空当前绑定角色的历史与记忆\n` +
          `👉 /生图 : 绘制当前角色专属精美写真(可在命令后空格叠加自定义场景词，如: /生图 泳装 户外)\n` +
          `👉 /help : 显示本帮助指南`;
        await this.sendWeChatText(fromUser, helpText, contextToken);
        break;

      case '/选秀':
        if (!arg) {
          // 未传序号，展示角色列表
          await this.sendCharacterListMenu(fromUser, contextToken);
        } else {
          // 传入序号，执行绑定切换
          await this.switchCharacterBinding(fromUser, parseInt(arg, 10), contextToken);
        }
        break;

      case '/清除记忆':
        if (!boundCharId) {
          await this.sendWeChatText(fromUser, '❌ 您当前尚未绑定任何角色，请先使用【/选秀】选择角色！', contextToken);
          return;
        }
        await this.executeClearMemory(fromUser, boundCharId, contextToken);
        break;

      case '/生图':
        if (!boundCharId) {
          await this.sendWeChatText(fromUser, '❌ 您当前尚未绑定任何角色，无法为您生图哦。请先使用【/选秀】！', contextToken);
          return;
        }
        await this.executeAIImageGeneration(fromUser, boundCharId, arg, contextToken);
        break;

      default:
        await this.sendWeChatText(fromUser, '❓ 未知指令，发送【/help】可以查看支持的指令指南哦~', contextToken);
        break;
    }
  }
```

### 2. `/选秀` 绑定切换物理实现
```typescript
  private async sendCharacterListMenu(fromUser: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();

    if (characters.length === 0) {
      await this.sendWeChatText(fromUser, '😿 您的 Echo 系统中目前还没有导入任何数字生命，请先去客户端导入角色哦！', contextToken);
      return;
    }

    let menu = `👑【Echo 数字生命角色列表】👑\n\n`;
    characters.forEach((char, index) => {
      menu += `${index + 1}. **${char.name}**\n`;
    });
    menu += `\n👉 发送【/选秀 序号】(如 /选秀 1) 来挑选您宠幸的角色绑定吧！之后我将以她的人设完全为您服务。`;
    
    await this.sendWeChatText(fromUser, menu, contextToken);
  }

  private async switchCharacterBinding(fromUser: string, index: number, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const characters = db.getAllCharacters();
    const targetIdx = index - 1;

    if (isNaN(index) || targetIdx < 0 || targetIdx >= characters.length) {
      await this.sendWeChatText(fromUser, '⚠️ 选秀序号无效，请重新核对序号发送！', contextToken);
      return;
    }

    const targetChar = characters[targetIdx];
    const mappings = this.getFriendMappings();
    mappings[fromUser] = targetChar.id;
    
    // 保存回 Settings
    db.setSetting('wechat_friend_mappings', JSON.stringify(mappings));

    // 绑定成功，发送角色的 first_mes 欢迎语
    const welcome = targetChar.first_mes || `你好，我是 ${targetChar.name}，很高兴在微信上与你重逢！🐾`;
    
    await this.sendWeChatText(fromUser, welcome, contextToken);
    
    // 双向保存至本地 Messages 库以同步客户端
    db.saveMessage({
      id: `wechat_welcome_${Date.now()}`,
      character_id: targetChar.id,
      role: 'assistant',
      content: welcome,
      timestamp: Date.now(),
      token_usage: 0
    });
  }
```

### 3. `/清除记忆` 复用现有物理清空
```typescript
  private async executeClearMemory(fromUser: string, characterId: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const char = db.getAllCharacters().find(c => c.id === characterId);
    if (!char) return;

    try {
      // 🚀 完全复用现有的 clear-history-and-memory 后台物理清除逻辑！
      db.deleteChatHistory(characterId);
      db.setSetting('clear_chat_at_' + characterId, '0');

      const storageManager = new CharacterStorageManager();
      const folderName = char.folder_name;

      const memoryInitContent = `<!--\n{\n  "stm": [],\n  "ltm": {}\n}\n-->\n# 记忆存储区\n\n## 短期记忆 (Short-Term Memory)\n暂无短期记忆。\n\n## 长期记忆 (Long-Term Memory)\n暂无长期记忆。`;
      storageManager.writeCharacterFile(folderName, 'Memory.md', memoryInitContent);
      storageManager.writeCharacterFile(folderName, 'Schedule.md', '暂无日程');
      storageManager.writeCharacterFile(folderName, 'Goals.md', '暂无长期目标');

      const charUserPath = join(storageManager.getBaseDir(), folderName, 'USER.md');
      // 引入项目的 UserProfileReaderWriter
      UserProfileReaderWriter.writeCharacterProfile(charUserPath, []);

      // 清空 Summary 缓存
      const summaryPath = join(storageManager.getBaseDir(), folderName, 'Summary.md');
      if (fs.existsSync(summaryPath)) {
        fs.writeFileSync(summaryPath, '', 'utf-8');
      }

      await this.sendWeChatText(fromUser, `✨ 已成功将角色 [${char.name}] 的历史聊天与记忆库物理彻底清空，您可以开启全新的浪漫了！`, contextToken);
      
      // 广播给客户端前端刷新 UI 
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send('chat-history-cleared', { characterId });
      }
    } catch (err: any) {
      await this.sendWeChatText(fromUser, `❌ 记忆清理发生异常: ${err.message}`, contextToken);
    }
  }
```

### 4. `/生图` 对接 NovelAi
```typescript
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
      const finalPrompt = prompt || '1girl, masterpiece, very aesthetic, best quality';
      const dims = config.defaultDimensions || 'portrait';
      
      // 1. 调用项目现有的 NovelAiService.generateImage
      const imageBuffer = await NovelAiService.generateImage(config, finalPrompt, dims);

      // 2. 双向物理同步：写入角色 media/ 目录
      const char = db.getAllCharacters().find(c => c.id === characterId)!;
      const folderName = char.folder_name;
      const storageManager = new CharacterStorageManager();
      const mediaDir = join(storageManager.getBaseDir(), folderName, 'media');
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      const filename = `wechat_${Date.now()}.png`;
      const localImgPath = join(mediaDir, filename);
      fs.writeFileSync(localImgPath, imageBuffer);

      // 3. 落盘数据库以同步 PC 客户端展现
      const newImgMsg = {
        id: `wechat_img_${Date.now()}`,
        character_id: characterId,
        role: 'assistant',
        content: `[wechat_image_media]:media/${filename}`,
        timestamp: Date.now(),
        token_usage: 0
      };
      db.saveMessage(newImgMsg);

      // 4. 广播推送给 Electron 渲染层实时同步
      const windows = BrowserWindow.getAllWindows();
      if (windows.length > 0) {
        windows[0].webContents.send('receive-message', {
          ...newImgMsg,
          imageBase64: `data:image/png;base64,${imageBuffer.toString('base64')}`
        });
      }

      // 5. 将生图通过 iLink 加密通道发送给微信端
      // a. 申请上传通道，获取 upload_param 等元数据
      // b. 对 imageBuffer 进行 AES-128 ECB 加密 + PKCS7 Padding，并 POST 传至 CDN 
      // c. 提取 x-encrypted-param 并通过 /ilink/bot/sendmessage 发送类型 2 (图片) 载荷
      await this.uploadAndSendWeChatImage(fromUser, localImgPath, imageBuffer, contextToken);

    } catch (err: any) {
      await this.sendWeChatText(fromUser, `❌ 绘图失败: ${err.message}`, contextToken);
    }
  }
```

---

## 四、 对话数据双向落盘与流式分段连发

微信端接收到普通对话消息，我们让大模型推理，实现**“微信端分句连发，本地仅写 1 条记录”**的极致效果。

### 1. 对话流与同步处理
```typescript
  private async processConversationFlow(fromUser: string, characterId: string, userMessage: string, contextToken: string): Promise<void> {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      await this.sendWeChatText(fromUser, '⚠️ 系统尚未配置大模型，请在客户端先保存配置。', contextToken);
      return;
    }
    const settings = JSON.parse(configStr);
    const modelAdapter = new ModelAdapter(settings.primary, settings.secondary);

    // 1. 保存用户的微信发信记录并实时同步至 PC 客户端
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
    if (windows.length > 0) {
      windows[0].webContents.send('receive-message', userMsg);
    }

    // 2. 模拟微信端的“正在输入”状态以提升视觉体验
    this.sendWeChatTyping(fromUser, contextToken, true);

    try {
      // 3. 构建大模型消息并推理
      const history = db.getChatHistory(characterId, 15);
      const chatMessages = [
        { role: 'system', content: this.buildSystemPrompt(characterId) },
        ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
        { role: 'user', content: userMessage }
      ];

      const response = await modelAdapter.chat(chatMessages, { usePrimary: true });
      let finalAIResponse = response.content.trim();

      // 4. 【特化处理一】：微信端分句打字连发
      // 按照标点符号、分段符号切割文本
      const sentenceRegex = /[^。！？\n]+[。！？\n]*/g;
      const sentences = finalAIResponse.match(sentenceRegex) || [finalAIResponse];

      // 关闭“正在输入”状态
      this.sendWeChatTyping(fromUser, contextToken, false);

      // 循环异步连发，模拟打字呼吸感
      for (const sentence of sentences) {
        const cleanSentence = sentence.trim();
        if (!cleanSentence) continue;

        // 基础延迟 1 秒，每字多延迟 50 毫秒，最大限制 4 秒
        const delay = Math.min(4000, 1000 + cleanSentence.length * 50);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        await this.sendWeChatText(fromUser, cleanSentence, contextToken);
      }

      // 5. 【特化处理二】：整洁落盘
      // 本地数据库有且仅记入 1 条完整文字气泡记录，并向客户端推送 1 个长消息气泡！
      const assistantMsg = {
        id: `wechat_a_${Date.now()}`,
        character_id: characterId,
        role: 'assistant',
        content: finalAIResponse,
        timestamp: Date.now(),
        token_usage: 0
      };
      db.saveMessage(assistantMsg);

      if (windows.length > 0) {
        windows[0].webContents.send('receive-message', assistantMsg);
      }

    } catch (err: any) {
      this.sendWeChatTyping(fromUser, contextToken, false);
      await this.sendWeChatText(fromUser, `😿 对不起，我的系统发生故障啦: ${err.message}`, contextToken);
    }
  }
```

---

## 五、 二维码扫码登录流程与状态轮询

以下是主进程获取二维码与长轮询扫码状态并确认登录的链路实现：

```typescript
  /**
   * 启动扫码监听任务 (仅允许 1 次，重复触发会解绑旧连接)
   */
  public async requestQRAndStartLogin(): Promise<string> {
    const db = getDatabaseService();
    
    // 强制先清空原有的 token 与绑定状态，保证最多只存 1 个微信号
    db.setSetting('wechat_token', '');
    db.setSetting('wechat_sync_buf', '');
    db.setSetting('wechat_account_id', '');

    try {
      const response = await axios.get(
        'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3',
        { headers: { 'Content-Type': 'application/json' } }
      );

      const data = response.data;
      if (data && data.qrcode && data.qrcode_img_content) {
        db.setSetting('wechat_qrcode_url', data.qrcode_img_content);
        
        // 启动异步状态校验长轮询任务
        this.pollQRStatus(data.qrcode).catch(err => {
          console.error('[WeChatService] 轮询二维码状态异常:', err);
        });

        return data.qrcode_img_content; // 返回给渲染层 Vue 用以绘制二维码
      } else {
        throw new Error('微信接口响应格式异常');
      }
    } catch (err: any) {
      throw new Error(`获取二维码失败: ${err.message}`);
    }
  }

  /**
   * 循环监测扫码确认状态
   */
  private async pollQRStatus(qrcode: string): Promise<void> {
    const db = getDatabaseService();
    let retryCount = 0;

    while (retryCount < 30) { // 限制 5 分钟 (每次约 10 秒)
      try {
        const response = await axios.get(
          `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${qrcode}`,
          {
            headers: {
              'Content-Type': 'application/json',
              'iLink-App-ClientVersion': '1'
            },
            timeout: 15000
          }
        );

        const data = response.data;
        const status = data.status || 'wait';

        if (status === 'confirmed' && data.bot_token) {
          console.log('[WeChatService] 扫码绑定确认成功！账号 ID:', data.ilink_bot_id);
          
          db.setSetting('wechat_token', data.bot_token);
          db.setSetting('wechat_account_id', data.ilink_bot_id || '');
          db.setSetting('wechat_sync_buf', ''); // 重置游标

          // 开启实时消息接收服务
          this.startService();

          // 广播通知前端设置页面扫码登录成功
          const windows = BrowserWindow.getAllWindows();
          if (windows.length > 0) {
            windows[0].webContents.send('wechat-login-confirmed', { accountId: data.ilink_bot_id });
          }
          break;
        }

        if (status === 'expired' || status === 'cancel') {
          console.log('[WeChatService] 二维码已过期或用户取消扫码。');
          break;
        }

        // wait 状态继续轮询
        await new Promise(resolve => setTimeout(resolve, 3000));
        retryCount++;
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
```

---

## 六、 数据库版本升级、容错与向下兼容规程 (更新版本规范对接)

根据项目的 [更新版本指南.md](file:///Users/lillian/github/project-echo/%E6%9B%B4%E6%96%B0%E7%89%88%E6%9C%AC%E6%8C%87%E5%8D%97.md) 规定，在发布新版本且涉及本地数据库变更时，必须通过 **数据库事务级增量迁移机制** 进行处理，严禁硬编码修改或重置用户数据库。

针对本微信个人号接入项目功能实现方案，我们进行了极其严密的数据库兼容性评估：

### 1. 为什么本方案天然规避了 ALTER TABLE 的发布风险？
* **非侵入式设计**：本方案中所有的微信服务状态数据（Token、同步游标、接入开关）和好友与角色的逻辑映射表（`wechat_friend_mappings` JSON）全部持久化存储在原有的 `Settings` 键值表中。
* **零物理表结构变更**：我们在发布该功能的新版本时，**不需要**在 SQLite 中执行任何 `ALTER TABLE` 或 `CREATE TABLE`。这意味着：
  - **不需要**在 [database.ts](file:///Users/lillian/github/project-echo/src/main/db/database.ts) 的 `migrations` 中追加新的迁移对象；
  - **不需要**提升全局版本号 `schema_version`；
  - **完全规避**了由于数据库升级失败导致用户本地数据回滚或损坏的任何重大风险，实现了 100% 的向下物理兼容。

---

### 2. 未来演进：若需引入物理微信数据表（如 WechatFriends）时的增量迁移规程
如果在后续版本的高级功能演进中（例如需要独立出一张微信好友备注、头像物理路径存储表），必须严格执行以下升级规程：

1. **更新数据库版本号**：
   在 `database.ts` 初始化或更新迁移时，若当前最新版本是 `v3`，我们需要将本次增量升级定义为 `v4`。
2. **在 migrations 数组末梢追加 v4 升级事务**：
   ```typescript
   // 示例：未来如果需要增加 WechatFriends 表时的增量更新规范
   {
     version: 4,
     up: (db: Database.Database) => {
       // 🚀 健壮地增量建表，防止 duplicate table 报错
       db.exec(`
         CREATE TABLE IF NOT EXISTS WechatFriends (
           friend_id TEXT PRIMARY KEY,
           nickname TEXT NOT NULL,
           avatar_path TEXT,
           bound_character_id TEXT NOT NULL,
           last_chat_ts INTEGER
         );
       `);
       console.log('[Database Migration] v4 微信好友扩展数据表升级顺利完成！');
     }
   }
   ```
3. **保证容错性**：
   - 必须使用 `CREATE TABLE IF NOT EXISTS`。
   - 所有 SQL 均包含在 SQLite WAL 事务中保护，确保无痛刷新。

