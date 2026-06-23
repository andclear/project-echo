import { ipcMain, BrowserWindow, dialog } from 'electron';
import { IPlugin } from '../PluginManager';
import { ShudongService } from './ShudongService';
import * as fs from 'fs';
import { join, extname } from 'path';
import { app } from 'electron';

export class ShudongPlugin implements IPlugin {
  public readonly name = 'ShudongPlugin';
  private shudongService!: ShudongService;

  public init(): void {
    this.shudongService = new ShudongService();
    // 确保 shudong_images 文件夹必然存在
    const shudongImagesDir = join(app.getPath('userData'), 'plugins', 'shudong_images');
    if (!fs.existsSync(shudongImagesDir)) {
      fs.mkdirSync(shudongImagesDir, { recursive: true });
    }

    // 确保 shudong_images_temp 文件夹必然存在并清空它以防止缓存残留
    const shudongImagesTempDir = join(app.getPath('userData'), 'plugins', 'shudong_images_temp');
    if (!fs.existsSync(shudongImagesTempDir)) {
      fs.mkdirSync(shudongImagesTempDir, { recursive: true });
    } else {
      try {
        const files = fs.readdirSync(shudongImagesTempDir);
        for (const file of files) {
          fs.unlinkSync(join(shudongImagesTempDir, file));
        }
        console.log('[ShudongPlugin] 已成功清空临时图片文件夹');
      } catch (e) {
        console.error('[ShudongPlugin] 清空临时图片文件夹失败:', e);
      }
    }
  }

  public registerIpcHandlers(): void {
    // 1. 获取所有秘密卡片列表
    ipcMain.handle('shudong-list-cards', async () => {
      try {
        const list = this.shudongService.listCards();
        return { success: true, list };
      } catch (e: any) {
        console.error('[IPC shudong-list-cards] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 2. 创建秘密卡片
    ipcMain.handle('shudong-create-card', async (_, payload: { content: string; imageName: string | null; disclosed: boolean }) => {
      try {
        const cardId = await this.shudongService.createCard(payload.content, payload.imageName, payload.disclosed);
        return { success: true, cardId };
      } catch (e: any) {
        console.error('[IPC shudong-create-card] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 2.5 更新秘密卡片
    ipcMain.handle('shudong-update-card', async (_, payload: { cardId: string; content: string; imageName: string | null; disclosed: boolean }) => {
      try {
        await this.shudongService.updateCard(payload.cardId, payload.content, payload.imageName, payload.disclosed);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC shudong-update-card] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 3. 删除秘密卡片
    ipcMain.handle('shudong-delete-card', async (_, payload: { cardId: string }) => {
      try {
        this.shudongService.deleteCard(payload.cardId);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC shudong-delete-card] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 3.5 清空临时图片文件夹
    ipcMain.handle('shudong-clear-temp-images', async () => {
      try {
        const shudongImagesTempDir = join(app.getPath('userData'), 'plugins', 'shudong_images_temp');
        if (fs.existsSync(shudongImagesTempDir)) {
          const files = fs.readdirSync(shudongImagesTempDir);
          for (const file of files) {
            fs.unlinkSync(join(shudongImagesTempDir, file));
          }
        }
        return { success: true };
      } catch (e: any) {
        console.error('[IPC shudong-clear-temp-images] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 4. 选择/上传图片（自适应 Electron 桌面端原生文件对话框 与 浏览器/Web 端 base64 数据）—— 保存到临时文件夹
    ipcMain.handle('shudong-upload-image', async (event, payload?: { base64?: string; ext?: string }) => {
      const shudongImagesTempDir = join(app.getPath('userData'), 'plugins', 'shudong_images_temp');
      if (!fs.existsSync(shudongImagesTempDir)) {
        fs.mkdirSync(shudongImagesTempDir, { recursive: true });
      }

      // 4.1 如果是 Web/Mobile 端传入了 base64 数据
      if (payload && payload.base64) {
        try {
          const base64Data = payload.base64.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, 'base64');
          const ext = payload.ext || '.png';
          const newFileName = `img_${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
          const targetPath = join(shudongImagesTempDir, newFileName);
          fs.writeFileSync(targetPath, buffer);
          return { success: true, imageName: newFileName };
        } catch (e: any) {
          console.error('[IPC shudong-upload-image Base64] 失败:', e);
          return { success: false, error: e.message || String(e) };
        }
      }

      // 4.2 否则，在 Electron 本地使用 dialog 打开选择器
      try {
        const windows = BrowserWindow.getAllWindows();
        const focusedWindow = windows.length > 0 ? windows[0] : BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(focusedWindow!, {
          title: '选择树洞图片',
          filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
          properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, canceled: true };
        }

        const sourcePath = result.filePaths[0];
        const ext = extname(sourcePath).toLowerCase() || '.png';
        const newFileName = `img_${Date.now()}_${Math.floor(Math.random() * 10000)}${ext}`;
        const targetPath = join(shudongImagesTempDir, newFileName);
        fs.copyFileSync(sourcePath, targetPath);
        return { success: true, imageName: newFileName };
      } catch (err: any) {
        console.error('[IPC shudong-upload-image Dialog] 失败:', err);
        return { success: false, error: err.message || String(err) };
      }
    });
  }
}
