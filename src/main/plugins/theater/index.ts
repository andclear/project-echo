import { app, dialog, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'fs';
import { join } from 'path';
import { IPlugin } from '../PluginManager';
import { TheaterService } from './TheaterService';
import { TheaterStageService } from './TheaterStageService';
import { getDatabaseService } from '../../db/database';
import { ChatMessage, ModelAdapter } from '../../models/ModelAdapter';
import { PluginBridgeService } from '../../services/PluginBridgeService';
import { SseManager } from '../../services/SseManager';

export class TheaterPlugin implements IPlugin {
  public readonly name = 'TheaterPlugin';
  private theaterService!: TheaterService;
  private theaterStageService!: TheaterStageService;

  public init(): void {
    this.theaterService = new TheaterService();
    this.theaterStageService = new TheaterStageService();
  }

  private getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : BrowserWindow.getFocusedWindow();
  }

  public registerIpcHandlers(): void {
    // 1. 大剧院游玩：初始化进入大剧院会话 (支持参演列表初置)
    ipcMain.handle('theater-create-stage-session', async (_, payload: { themeId: string; playerCharName: string; activeCharNames?: string[]; openingDirection?: string }) => {
      try {
        const result = await this.theaterStageService.createSession(payload.themeId, payload.playerCharName, payload.activeCharNames, payload.openingDirection);
        return { success: true, ...result };
      } catch (e: any) {
        console.error('[IPC theater-create-stage-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 2. 大剧院游玩：手动更新会话中的参演角色登场列表
    ipcMain.handle('theater-update-session-participating-characters', async (_, payload: { sessionId: string; activeNames: string[] }) => {
      try {
        const result = this.theaterStageService.updateSessionParticipatingCharacters(payload.sessionId, payload.activeNames);
        return result;
      } catch (e: any) {
        console.error('[IPC theater-update-session-participating-characters] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 3. 大剧院游玩：动态添加全局状态栏
    ipcMain.handle('theater-add-session-status-bar', async (_, payload: {
      sessionId: string;
      statusBar: {
        name: string;
        type: 'number' | 'text';
        min?: number;
        max?: number;
        initialValue: number | string;
        description?: string;
        aiRule?: string;
      }
    }) => {
      try {
        const result = await this.theaterStageService.addSessionStatusBar(payload.sessionId, payload.statusBar);
        return { success: true, characterStates: result };
      } catch (e: any) {
        console.error('[IPC theater-add-session-status-bar] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 4. 大剧院游玩：获取会话状态
    ipcMain.handle('theater-get-stage-state', async (_, payload: { sessionId: string }) => {
      try {
        const result = this.theaterStageService.getSessionState(payload.sessionId);
        return { success: true, state: result };
      } catch (e: any) {
        console.error('[IPC theater-get-stage-state] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 5. 大剧院游玩：执行下一步（含用户发言）
    ipcMain.handle('theater-execute-stage-step', async (event, payload: { sessionId: string; userText?: string }) => {
      try {
        const focusedWindow = this.getMainWindow();
        const targetWebContents = (focusedWindow && !focusedWindow.isDestroyed()) 
          ? focusedWindow.webContents 
          : event.sender;
        
        // 异步执行剧场推进，释放局域网连接，让 SSE 保持高吞吐
        (async () => {
          try {
            const result = await this.theaterStageService.executeStep(payload.sessionId, payload.userText, (npcAction) => {
              try {
                if (targetWebContents && !targetWebContents.isDestroyed()) {
                  targetWebContents.send('theater-npc-action-chunk', npcAction);
                }
                PluginBridgeService.broadcastPluginEvent('theater', 'npc-action-chunk', npcAction);
                if ((npcAction as any)?.type === 'next-options-cleared') {
                  PluginBridgeService.broadcastPluginEvent('theater', 'next-options-cleared', npcAction);
                } else if ((npcAction as any)?.type === 'stage-state-updated') {
                  PluginBridgeService.broadcastPluginEvent('theater', 'stage-state-updated', npcAction);
                }
              } catch (err: any) {
                console.warn('[IPC theater-execute-stage-step] 实时推送消息失败:', err.message || err);
              }
            });

            // 推进成功：广播“异步完成”事件
            const completePayload = {
              role: 'system',
              content: '[演绎完成]',
              type: 'theater-step-completed',
              sessionId: payload.sessionId
            };
            if (targetWebContents && !targetWebContents.isDestroyed()) {
              targetWebContents.send('theater-npc-action-chunk', completePayload);
            }
            PluginBridgeService.broadcastPluginEvent('theater', 'npc-action-chunk', completePayload);
          } catch (e: any) {
            console.error('[IPC theater-execute-stage-step] 异步执行失败:', e);
            const errorPayload = {
              role: 'system',
              content: `[演绎错误]: ${e.message || String(e)}`,
              type: 'theater-step-failed',
              error: e.message || String(e)
            };
            if (targetWebContents && !targetWebContents.isDestroyed()) {
              targetWebContents.send('theater-npc-action-chunk', errorPayload);
            }
            PluginBridgeService.broadcastPluginEvent('theater', 'npc-action-chunk', errorPayload);
          }
        })();

        return { success: true, status: 'processing' };
      } catch (e: any) {
        console.error('[IPC theater-execute-stage-step] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 6. 大剧院游玩：修改/更新 Agent 提示词配置
    ipcMain.handle('theater-update-agent-prompts', async (_, payload: { sessionId: string; prompts: Record<string, any> }) => {
      try {
        this.theaterStageService.updateAgentPrompts(payload.sessionId, payload.prompts);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC theater-update-agent-prompts] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 7. 大剧院游玩：手动修改角色属性/状态值/背包/余额
    ipcMain.handle('theater-update-character-state', async (_, payload: {
      sessionId: string;
      charName: string;
      statePayload: {
        status_bars?: Record<string, number | string>;
        backpack?: Array<{ name: string; quantity: number }>;
        balance?: number;
        relations?: string;
      }
    }) => {
      try {
        this.theaterStageService.updateCharacterState(payload.sessionId, payload.charName, payload.statePayload);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC theater-update-character-state] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 8. 大剧院游玩：查找活跃会话记录
    ipcMain.handle('theater-find-active-session', async (_, payload: { themeId: string }) => {
      try {
        const result = this.theaterStageService.findActiveSession(payload.themeId);
        return { success: true, ...result };
      } catch (e: any) {
        console.error('[IPC theater-find-active-session] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 9. 大剧院游玩：手动更新角色 Soul 设定
    ipcMain.handle('theater-edit-character-soul', async (_, payload: { themeId: string; charName: string; newSoul: string }) => {
      try {
        this.theaterStageService.editCharacterSoul(payload.themeId, payload.charName, payload.newSoul);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC theater-edit-character-soul] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 10. 大剧院：获取所有剧本列表
    ipcMain.handle('theater-list-themes', async () => {
      try {
        return { success: true, list: this.theaterService.listThemes() };
      } catch (e: any) {
        console.error('[IPC theater-list-themes] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 11. 大剧院：一句话生成世界观/剧本背景
    ipcMain.handle('theater-ai-generate-background', async (_, payload: { prompt: string; type: 'world' | 'scenario' }) => {
      try {
        const result = await this.theaterService.generateBackground(payload.prompt, payload.type);
        return { success: true, content: result };
      } catch (e: any) {
        console.error('[IPC theater-ai-generate-background] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 12. 大剧院：AI 结合剧本背景发散生成多角色
    ipcMain.handle('theater-ai-generate-characters', async (_, payload: { backgroundText: string; maxCount?: number }) => {
      try {
        const result = await this.theaterService.generateCharacters(payload.backgroundText, payload.maxCount);
        return { success: true, list: result };
      } catch (e: any) {
        console.error('[IPC theater-ai-generate-characters] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 13. 大剧院：导入 PNG / JSON 角色卡并智能提炼多角色/世界观关系
    ipcMain.handle('theater-parse-character-card', async (event, payload: { filePath?: string; uint8ArrayData?: number[] }) => {
      try {
        let result: any;
        const onProgress = (data: any) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('theater-import-progress', data);
          }
          SseManager.getInstance().broadcast('theater-import-progress', data);
          PluginBridgeService.broadcastPluginEvent('theater', 'import-progress', data);
        };

        if (payload.uint8ArrayData) {
          const buffer = Buffer.from(payload.uint8ArrayData);
          result = await this.theaterService.parseCharacterCardFromBuffer(buffer, onProgress);
        } else if (payload.filePath) {
          result = await this.theaterService.parseCharacterCard(payload.filePath, onProgress);
        } else {
          throw new Error('未提供有效的解析参数');
        }
        return { success: true, data: result };
      } catch (e: any) {
        console.error('[IPC theater-parse-character-card] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 13-2. 大剧院：获取当前卡片导入的最新进度（为 Web 模式下 SSE 掉线/不通时提供轮询自愈兜底）
    ipcMain.handle('theater-get-import-progress', async () => {
      try {
        const progress = this.theaterService.getCurrentImportProgress();
        return { success: true, data: progress };
      } catch (e: any) {
        return { success: false, error: e.message || e };
      }
    });

    // 14. 大剧院：从未保存角色的人设 Soul 文本直接 AI 提炼外貌生图 Tags
    ipcMain.handle('theater-ai-extract-appearance', async (_, payload: { soul: string }) => {
      try {
        const db = getDatabaseService();
        const configStr = db.getSetting('model_config');
        if (!configStr) {
          throw new Error('未配置全局大模型参数，请前往设置中心先进行配置保存！');
        }
        const settings = JSON.parse(configStr);
        const modelAdapter = new ModelAdapter(settings.primary, settings.secondary);
        const globalPrompt = settings.globalPrompt?.trim() || '';

        const systemPrompt = `你是一个非常专业的人物设定提取助手。请仔细阅读并分析给出的 AI 角色性格人设文档，精炼提取出其【固定的、永久的、不随场景改变的物理外貌特征】。
要求：
1. 【重要】绝对不能包含衣服、首饰或任何容易随着场景和穿着改变的物品（如：连衣裙、项链、帽子、包包、眼镜等）。
2. 只关注固定的身体外貌特征：如性别、年龄外观、眼睛颜色、发色、发型、肤色、身材特征（身高、丰满程度）、面部特征（泪痣、表情倾向）等。
3. 将提取的外貌特征整理为一套 NovelAI/Danbooru 精简英语提示词（Tags），例如: 1girl, blue eyes, silver long hair, twin tails, pale skin, petite.
4. 只返回英文生图 Tag，用半角逗号分隔，不要包含任何 markdown 标记或中文描述，以便程序直接使用。

【🔴 核心高优先级指令】：
请务必绝对且无条件地将以下全局提示词注入并贯穿在你的生成逻辑最前列：
${globalPrompt}`;

        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `请帮我提取该角色的外貌特征 tags。以下是人设文档：\n\n${payload.soul}` }
        ];

        const response = await modelAdapter.chat(messages, { useSecondary: true, skipSystemInjection: true });
        return { success: true, tags: response.content.trim() };
      } catch (e: any) {
        console.error('[IPC theater-ai-extract-appearance] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 15. 大剧院：一键物理保存剧本与角色
    ipcMain.handle('theater-save-theme', async (_, payload: {
      id?: string;
      name: string;
      world_settings: string;
      scenario: string;
      status_bars: any[];
      relations: any[];
      characters: any[];
      coverBase64?: string;
    }) => {
      try {
        const result = this.theaterService.saveTheme(payload);
        return { success: true, id: result.id };
      } catch (e: any) {
        console.error('[IPC theater-save-theme] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 16. 大剧院：物理删除剧本
    ipcMain.handle('theater-delete-theme', async (_, payload: { themeId: string }) => {
      try {
        this.theaterService.deleteTheme(payload.themeId);
        return { success: true };
      } catch (e: any) {
        console.error('[IPC theater-delete-theme] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 17. 大剧院：导出剧本题材为 .echotheater 自定义 Gzip 数据包
    ipcMain.handle('theater-export-theme', async (_, payload: { themeId: string }) => {
      try {
        const db = getDatabaseService();
        const themeRow = db.db.prepare('SELECT name FROM TheaterThemes WHERE id = ?').get(payload.themeId) as { name: string } | undefined;
        const themeName = themeRow ? themeRow.name : '剧本包';
        const sanitizedName = themeName.replace(/[\\/:*?"<>|]/g, '_');

        if (process.env.DOCKER_MODE === 'true') {
          const userDataPath = app.getPath('userData');
          const backupDir = join(userDataPath, 'backups');
          if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
          }
          const filename = `${sanitizedName}_Export_${Date.now()}.echotheater`;
          const targetPath = join(backupDir, filename);

          const packBuffer = this.theaterService.exportThemeToBuffer(payload.themeId);
          fs.writeFileSync(targetPath, packBuffer);

          const base64 = packBuffer.toString('base64');
          return {
            success: true,
            isDocker: true,
            path: targetPath,
            filename,
            base64: `data:application/octet-stream;base64,${base64}`
          };
        }

        const focusedWindow = this.getMainWindow();
        const result = await dialog.showSaveDialog(focusedWindow!, {
          title: '导出剧本题材包',
          defaultPath: `${sanitizedName}.echotheater`,
          filters: [
            { name: '回音剧本题材包', extensions: ['echotheater'] }
          ]
        });

        if (result.canceled || !result.filePath) {
          return { success: false, error: '用户取消了导出', canceled: true };
        }

        const packBuffer = this.theaterService.exportThemeToBuffer(payload.themeId);
        fs.writeFileSync(result.filePath, packBuffer);

        return { success: true, path: result.filePath };
      } catch (e: any) {
        console.error('[IPC theater-export-theme] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 18. 大剧院：导入剧本题材包 .echotheater
    ipcMain.handle('theater-import-theme', async (_, payload?: { base64?: string }) => {
      try {
        if (payload?.base64) {
          const cleanBase64 = payload.base64.replace(/^data:application\/octet-stream;base64,/, '').replace(/^data:\w+\/\w+;base64,/, '');
          const packBuffer = Buffer.from(cleanBase64, 'base64');
          const result = this.theaterService.importThemeFromBuffer(packBuffer);
          return result;
        }

        if (process.env.DOCKER_MODE === 'true') {
          return { success: false, error: 'Docker 模式下不支持直接打开文件选择框，请通过 Web 界面上传导入！' };
        }

        const focusedWindow = this.getMainWindow();
        const result = await dialog.showOpenDialog(focusedWindow!, {
          title: '导入剧本题材包',
          filters: [
            { name: '回音剧本题材包', extensions: ['echotheater'] }
          ],
          properties: ['openFile']
        });

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: '用户取消了选择', canceled: true };
        }

        const filePath = result.filePaths[0];
        const packBuffer = fs.readFileSync(filePath);
        const importRes = this.theaterService.importThemeFromBuffer(packBuffer);
        return importRes;
      } catch (e: any) {
        console.error('[IPC theater-import-theme] 失败:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 19. 大剧院：获取 AI 绘图的配置状态 (决定是否显示 AI 绘制头像按钮)
    ipcMain.handle('theater-get-drawing-status', async () => {
      try {
        const db = getDatabaseService();
        const configStr = db.getSetting('novelai_config');
        if (configStr) {
          const config = JSON.parse(configStr);
          const hasDrawing = !!(config.apiKey && config.apiKey.trim());
          return { success: true, hasDrawing };
        }
        return { success: true, hasDrawing: false };
      } catch (_) {
        return { success: true, hasDrawing: false };
      }
    });

    // 20. 大剧院：读取本地插画图片文件并转换为 Base64
    ipcMain.handle('theater-read-image', async (_, filePath: string) => {
      try {
        if (!fs.existsSync(filePath)) {
          return { success: false, error: '插图物理文件不存在，请检查后台生成状态。' };
        }
        const data = fs.readFileSync(filePath);
        const base64 = data.toString('base64');
        return { success: true, base64: `data:image/png;base64,${base64}` };
      } catch (e: any) {
        console.error('[IPC theater-read-image] 读取插图物理文件异常:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 21. 大剧院：物理删除剧情消息（及其本地插图文件）
    ipcMain.handle('theater-delete-message', async (_, payload: { sessionId: string; messageId: string }) => {
      try {
        console.log('[IPC] 收到大剧院删除消息请求，ID:', payload.messageId, '会话:', payload.sessionId);
        return this.theaterStageService.deleteMessage(payload.sessionId, payload.messageId);
      } catch (e: any) {
        console.error('[IPC theater-delete-message] 删除插图消息异常:', e);
        return { success: false, error: e.message || e };
      }
    });

    // 22. 大剧院：清空当前剧本的全部运行时数据，保留题材配置以便重新开始
    ipcMain.handle('theater-reset-theme-runtime', async (_, payload: { sessionId: string }) => {
      try {
        const result = this.theaterStageService.resetThemeRuntimeBySession(payload.sessionId);
        return { success: true, ...result };
      } catch (e: any) {
        console.error('[IPC theater-reset-theme-runtime] 清空剧本运行数据异常:', e);
        return { success: false, error: e.message || e };
      }
    });
  }
}
