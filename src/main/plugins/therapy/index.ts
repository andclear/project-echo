import { ipcMain, BrowserWindow } from 'electron';
import { IPlugin } from '../PluginManager';
import { TherapyService } from './TherapyService';
import { getDatabaseService } from '../../db/database';
import { PluginBridgeService } from '../../services/PluginBridgeService';

export class TherapyPlugin implements IPlugin {
  public readonly name = 'TherapyPlugin';
  private therapyService!: TherapyService;

  public init(): void {
    this.therapyService = new TherapyService();
  }

  private getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : BrowserWindow.getFocusedWindow();
  }

  public registerIpcHandlers(): void {
    const db = getDatabaseService();

    // 1. 检查免责声明是否已签署
    ipcMain.handle('therapy-is-disclaimer-accepted', async () => {
      try {
        const accepted = db.getSetting('therapy_disclaimer_accepted');
        return { success: true, accepted: accepted === '1' };
      } catch (e: any) {
        console.error('[IPC therapy-is-disclaimer-accepted] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 2. 签署接受免责声明
    ipcMain.handle('therapy-accept-disclaimer', async () => {
      try {
        db.setSetting('therapy_disclaimer_accepted', '1');
        return { success: true };
      } catch (e: any) {
        console.error('[IPC therapy-accept-disclaimer] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 3. 获取所有心理按摩会话（倾听时光）
    ipcMain.handle('therapy-list-sessions', async () => {
      try {
        const list = this.therapyService.listSessions();
        return { success: true, list };
      } catch (e: any) {
        console.error('[IPC therapy-list-sessions] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 4. 新建心理按摩会话（倾听时光）
    ipcMain.handle('therapy-create-session', async (_, payload: { characterId: string; title: string }) => {
      try {
        const sessionId = await this.therapyService.createSession(payload.characterId, payload.title);
        return { success: true, sessionId };
      } catch (e: any) {
        console.error('[IPC therapy-create-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 5. 删除会话
    ipcMain.handle('therapy-delete-session', async (_, payload: { sessionId: string }) => {
      try {
        this.therapyService.deleteSession(payload.sessionId);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC therapy-delete-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 6. 获取会话历史记录
    ipcMain.handle('therapy-get-session-history', async (_, payload: { sessionId: string }) => {
      try {
        const history = this.therapyService.getSessionHistory(payload.sessionId);
        return { success: true, history };
      } catch (e: any) {
        console.error('[IPC therapy-get-session-history] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 7. 发送用户消息并异步流式输出 AI 回复
    ipcMain.handle('therapy-send-message', async (event, payload: { sessionId: string; userText: string }) => {
      try {
        const focusedWindow = this.getMainWindow();
        const targetWebContents = (focusedWindow && !focusedWindow.isDestroyed())
          ? focusedWindow.webContents
          : event.sender;

        // 异步执行大模型对话，并通过 IPC Chunk 及 SSE 广播实时回传进度
        (async () => {
          try {
            for await (const chunk of this.therapyService.sendMessageStream(payload.sessionId, payload.userText)) {
              const eventPayload = {
                sessionId: payload.sessionId,
                content: chunk.content,
                done: chunk.done,
                isCrisis: chunk.isCrisis || false
              };

              // 向桌面端 Electron 窗口发送 Chunk
              if (targetWebContents && !targetWebContents.isDestroyed()) {
                targetWebContents.send('therapy-message-chunk', eventPayload);
              }

              // 同时向 SSE 广播（供移动端 / 浏览器同步渲染）
              PluginBridgeService.broadcastPluginEvent('therapy', 'message-chunk', eventPayload);
            }
          } catch (err: any) {
            console.error('[TherapyService Stream] 异步流生成失败:', err);
            const errPayload = {
              sessionId: payload.sessionId,
              content: `[AI倾听失败]: ${err.message || String(err)}`,
              done: true,
              error: err.message || String(err)
            };
            if (targetWebContents && !targetWebContents.isDestroyed()) {
              targetWebContents.send('therapy-message-chunk', errPayload);
            }
            PluginBridgeService.broadcastPluginEvent('therapy', 'message-chunk', errPayload);
          }
        })();

        return { success: true, status: 'processing' };
      } catch (e: any) {
        console.error('[IPC therapy-send-message] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 8. 批量删除指定消息
    ipcMain.handle('therapy-delete-messages', async (_, payload: { messageIds: string[]; sessionId: string }) => {
      try {
        this.therapyService.deleteMessages(payload.messageIds, payload.sessionId);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC therapy-delete-messages] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });
  }
}
