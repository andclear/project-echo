import { getDatabaseService } from '../../db/database';
import { ModelAdapter, ChatMessage } from '../../models/ModelAdapter';
import { CharacterStorageManager } from '../../utils/CharacterStorageManager';
import { PluginBridgeService } from '../../services/PluginBridgeService';
import { app } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import * as crypto from 'crypto';

// ── 本地对称加密（AES-256-CBC）防护线 ──
const ENCRYPTION_ALGORITHM = 'aes-256-cbc';

function getEncryptionKey(): Buffer {
  const db = getDatabaseService();
  // 使用本地设备独一无二的 device_id 派生 256 位密钥。此 ID 存留在本地 Settings 表中，绝不上传
  const deviceId = db.getSetting('device_id') || 'shudong_fallback_aes_key_salt';
  return crypto.createHash('sha256').update(deviceId).digest();
}

function encryptText(text: string): string {
  if (!text) return '';
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('[Shudong Crypto] 本地加密失败，退回明文:', err);
    return text;
  }
}

function decryptText(encryptedText: string): string {
  if (!encryptedText) return '';
  // 如果不包含 ":" 则是之前的明文数据，直接返回
  if (!encryptedText.includes(':')) {
    return encryptedText;
  }
  try {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    if (iv.length !== 16) {
      return encryptedText;
    }
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // 若解密失败，回退原数据以确保用户数据不丢失
    return encryptedText;
  }
}

export class ShudongService {
  private getModelAdapter(): ModelAdapter {
    const db = getDatabaseService();
    const configStr = db.getSetting('model_config');
    if (!configStr) {
      throw new Error('系统尚未配置大模型，请前往“系统设置-大模型设置”进行配置并保存。');
    }
    const settings = JSON.parse(configStr);
    return new ModelAdapter(settings.primary, settings.secondary);
  }

  /**
   * 1. 获取所有树洞卡片列表（包含评论）
   */
  public listCards(): any[] {
    const db = getDatabaseService();
    // 获取所有卡片，按时间倒序
    const cards = db.db.prepare(`
      SELECT * FROM ShudongCards ORDER BY timestamp DESC
    `).all() as any[];

    // 获取所有评论，按时间正序
    const comments = db.db.prepare(`
      SELECT sc.*, c.folder_name
      FROM ShudongComments sc
      LEFT JOIN Characters c ON sc.character_id = c.id
      ORDER BY sc.timestamp ASC
    `).all() as any[];

    // 分组 comments
    const commentsMap: { [cardId: string]: any[] } = {};
    for (const c of comments) {
      if (!commentsMap[c.card_id]) {
        commentsMap[c.card_id] = [];
      }
      commentsMap[c.card_id].push(c);
    }

    // 组装并解密 card 内容
    return cards.map(card => ({
      id: card.id,
      content: decryptText(card.content),
      image_name: card.image_name,
      disclosed: card.disclosed === 1,
      timestamp: card.timestamp,
      comments: commentsMap[card.id] || []
    }));
  }

  /**
   * 辅助方法：在保存/更新卡片时，将正文中引用的所有临时图片物理剪切/移动到正式目录下
   */
  private moveTempImagesToOfficial(content: string): void {
    const shudongImagesDir = join(app.getPath('userData'), 'plugins', 'shudong_images');
    const shudongImagesTempDir = join(app.getPath('userData'), 'plugins', 'shudong_images_temp');
    
    // 正则匹配图片名称
    const imageReg = /\/api\/shudong\/image\?name=([a-zA-Z0-9_\-\.]+)/g;
    let match;
    while ((match = imageReg.exec(content)) !== null) {
      const imageName = match[1];
      if (imageName) {
        const tempPath = join(shudongImagesTempDir, imageName);
        const officialPath = join(shudongImagesDir, imageName);
        if (fs.existsSync(tempPath)) {
          try {
            // 物理移动
            fs.renameSync(tempPath, officialPath);
            console.log(`[Shudong] 临时图片成功转正并存储: ${imageName}`);
          } catch (e) {
            console.error(`[Shudong] 物理转移图片失败:`, e);
          }
        }
      }
    }
  }

  /**
   * 2. 创建秘密卡片
   */
  public async createCard(content: string, imageName: string | null, disclosed: boolean): Promise<string> {
    const db = getDatabaseService();
    const cardId = `sdcard_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const timestamp = Date.now();
    const disclosedInt = disclosed ? 1 : 0;
    const encryptedContent = encryptText(content);

    // 处理临时图片物理转正
    this.moveTempImagesToOfficial(content);

    const stmt = db.db.prepare(`
      INSERT INTO ShudongCards (id, content, image_name, disclosed, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(cardId, encryptedContent, imageName, disclosedInt, timestamp);

    // 广播卡片更新事件
    PluginBridgeService.broadcastPluginEvent('shudong', 'card-updated', { cardId });

    // 如果勾选向角色披露，则触发异步评论生成
    if (disclosed) {
      // 避免阻塞返回，使用异步执行
      this.generateCommentsAsync(cardId, content);
    }

    return cardId;
  }

  /**
   * 2.5 更新秘密卡片
   */
  public async updateCard(cardId: string, content: string, imageName: string | null, disclosed: boolean): Promise<void> {
    const db = getDatabaseService();
    const disclosedInt = disclosed ? 1 : 0;
    const encryptedContent = encryptText(content);

    // 处理临时图片物理转正
    this.moveTempImagesToOfficial(content);

    const stmt = db.db.prepare(`
      UPDATE ShudongCards
      SET content = ?, image_name = ?, disclosed = ?
      WHERE id = ?
    `);
    stmt.run(encryptedContent, imageName, disclosedInt, cardId);

    // 如果转为公开披露给角色，且当前没有任何角色评论，则异步触发评论生成
    const existingComments = db.db.prepare('SELECT COUNT(*) as count FROM ShudongComments WHERE card_id = ?').get(cardId) as { count: number };
    if (disclosed && (!existingComments || existingComments.count === 0)) {
      this.generateCommentsAsync(cardId, content);
    }

    // 广播卡片更新事件
    PluginBridgeService.broadcastPluginEvent('shudong', 'card-updated', { cardId });
  }

  /**
   * 3. 删除树洞卡片
   */
  public deleteCard(cardId: string): void {
    const db = getDatabaseService();
    
    // 查出该卡片，获取主图片名
    const card = db.db.prepare('SELECT * FROM ShudongCards WHERE id = ?').get(cardId) as any;
    if (!card) return;

    const shudongImagesDir = join(app.getPath('userData'), 'plugins', 'shudong_images');

    // 1. 如果有主图片，物理硬删除它
    if (card.image_name) {
      const mainImagePath = join(shudongImagesDir, card.image_name);
      if (fs.existsSync(mainImagePath)) {
        try {
          fs.unlinkSync(mainImagePath);
          console.log(`[Shudong] 已物理删除主图片: ${card.image_name}`);
        } catch (e) {
          console.error(`[Shudong] 物理删除主图片失败:`, e);
        }
      }
    }

    // 2. 解密内容以提取其中所有嵌入式图片 (形如 /api/shudong/image?name=xxx)
    const content = decryptText(card.content);
    const imageReg = /\/api\/shudong\/image\?name=([a-zA-Z0-9_\-\.]+)/g;
    let match;
    while ((match = imageReg.exec(content)) !== null) {
      const embeddedImageName = match[1];
      if (embeddedImageName) {
        const embeddedImagePath = join(shudongImagesDir, embeddedImageName);
        if (fs.existsSync(embeddedImagePath)) {
          try {
            fs.unlinkSync(embeddedImagePath);
            console.log(`[Shudong] 已物理删除嵌入式图片: ${embeddedImageName}`);
          } catch (e) {
            console.error(`[Shudong] 物理删除嵌入式图片失败:`, e);
          }
        }
      }
    }

    // 3. 删除数据库中的卡片与评论
    db.db.prepare('DELETE FROM ShudongCards WHERE id = ?').run(cardId);
    db.db.prepare('DELETE FROM ShudongComments WHERE card_id = ?').run(cardId);

    // 4. 广播卡片更新事件
    PluginBridgeService.broadcastPluginEvent('shudong', 'card-updated', { deletedCardId: cardId });
  }

  /**
   * 4. 异步为卡片生成 AI 角色的温暖治愈回复
   */
  private async generateCommentsAsync(cardId: string, plainContent: string): Promise<void> {
    try {
      const db = getDatabaseService();
      
      // 1. 获取全部角色和免打扰状态
      const chars = db.db.prepare(`
        SELECT c.id, c.name, c.avatar, c.folder_name, IFNULL(cm.muted, 0) as muted
        FROM Characters c
        LEFT JOIN ConversationMeta cm ON c.id = cm.character_id
      `).all() as any[];

      if (chars.length === 0) {
        console.log('[Shudong AI] 系统内未找到任何角色，跳过评论生成');
        return;
      }

      // 2. 分离未免打扰和免打扰角色，并随机打乱
      const unmuted = chars.filter(c => c.muted === 0);
      const muted = chars.filter(c => c.muted === 1);

      const shuffle = (arr: any[]) => {
        const result = [...arr];
        for (let i = result.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
      };

      const shuffledUnmuted = shuffle(unmuted);
      const shuffledMuted = shuffle(muted);

      // 优先选择未开启免打扰的角色，截取前3个
      const selectedChars = [...shuffledUnmuted, ...shuffledMuted].slice(0, 3);
      console.log(`[Shudong AI] 为树洞卡片 ${cardId} 选中的评论角色为:`, selectedChars.map(c => c.name));

      const storageManager = new CharacterStorageManager();
      const modelAdapter = this.getModelAdapter();

      // 3. 对每个选中的角色生成暖心留言评论
      for (const char of selectedChars) {
        try {
          // 读取 Soul.md 性格设定
          const soulPath = join(storageManager.getBaseDir(), char.folder_name, 'Soul.md');
          const soulContent = fs.existsSync(soulPath) 
            ? fs.readFileSync(soulPath, 'utf-8').trim() 
            : '一个神秘的倾听者。';

          // 构建温暖治愈评论提示词
          const systemPrompt = `你是具有以下人物设定 (Soul.md) 的角色 ${char.name}。
【人物设定】：
${soulContent}

用户在她的私密个人树洞中写下了以下一段心声/日记：
"""
${plainContent}
"""

请根据你的人物设定，包括语气、说话习惯、性格态度和对待用户的立场，写下一条 80 ~ 150 字左右的简短暖心治愈评论。这只是一条单向的暖心留言卡片，用户不需要也不可能回复你，请写出最温暖、有共鸣且契合人设的贴心评价。
要求：
1. 语言温暖、温柔治愈，符合人设口吻。例如傲娇角色应表现出卸下防备的别扭心疼，高冷角色以认真且专注的语气陪伴。
2. 长度在 80 到 150 字左右。
3. 绝对不要包含任何 XML 标签、Markdown 格式化符号（如 ** 等）或旁白括号，只输出你想对用户说的话。`;

          const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: '请对我的这篇树洞写一条治愈评论。' }
          ];

          // 调起辅助大模型（options: { useSecondary: true }）独立扮演和撰写
          const response = await modelAdapter.chat(messages, {
            useSecondary: true,
            skipGlobalPrompt: true,
            characterId: char.id,
            characterName: char.name
          });

          const commentContent = response.content ? response.content.trim() : '随时陪在你身边。';
          const commentId = `sdcmt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
          
          // 写入数据库
          const stmtInsertComment = db.db.prepare(`
            INSERT INTO ShudongComments (id, card_id, character_id, character_name, avatar, content, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          stmtInsertComment.run(commentId, cardId, char.id, char.name, char.avatar, commentContent, Date.now());

          console.log(`[Shudong AI] 角色 ${char.name} 生成治愈评论完成。`);
        } catch (charErr: any) {
          console.error(`[Shudong AI] 为角色 ${char.name} 生成评论失败:`, charErr.message || charErr);
        }
      }

      // 所有角色的评论生成完成后，重新广播通知前端数据更新
      PluginBridgeService.broadcastPluginEvent('shudong', 'card-updated', { cardId });
    } catch (err: any) {
      console.error('[Shudong AI] 异步生成角色评论整体异常:', err.message || err);
    }
  }
}
