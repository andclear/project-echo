import { ipcMain, app } from 'electron'
import { IPlugin } from '../PluginManager'
import { PluginBridgeService } from '../../services/PluginBridgeService'
import * as fs from 'fs'
import { join } from 'path'
import { getDatabaseService } from '../../db/database'

// 获取绑定给特定角色的画像卡内容并作为文本返回，若无绑定则用首个人设卡兜底
const getBindingProfileContent = (characterId?: string): string => {
  try {
    const db = getDatabaseService()
    let bindingProfileId = characterId ? db.getProfileBinding(characterId) : null

    const userDataPath = app.getPath('userData')
    const targetProfilesDir = join(userDataPath, 'config', 'user_profiles')

    // 如果没有特定绑定，则默认兜底读取首个人设卡
    if (!bindingProfileId && fs.existsSync(targetProfilesDir)) {
      const files = fs.readdirSync(targetProfilesDir).filter(f => f.endsWith('.md'))
      if (files.length > 0) {
        files.sort()
        bindingProfileId = files[0].replace(/\.md$/, '')
      }
    }

    if (bindingProfileId) {
      const profilePath = join(targetProfilesDir, `${bindingProfileId}.md`)
      if (fs.existsSync(profilePath)) {
        return fs.readFileSync(profilePath, 'utf8')
      }
    }
  } catch (e) {
    console.error('[TruthGamePlugin] 获取绑定画像卡内容失败:', e)
  }
  return ''
}

const validateTruthSessionId = (sessionId: string): string => {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error('非法的真心话局 sessionId，仅允许字母、数字、下划线和短横线')
  }
  return sessionId
}

export class TruthGamePlugin implements IPlugin {
  public readonly name = 'TruthGamePlugin'
  public readonly views = ['truth-game']

  public init(): void {
    console.log('[TruthGamePlugin] 正在初始化《真心话真心话》小游戏插件...')
  }

  public registerIpcHandlers(): void {
    // 1. 获取所有解锁角色元数据
    ipcMain.handle('truth-get-characters', async () => {
      try {
        const list = PluginBridgeService.getCharacters()
        return { success: true, list }
      } catch (e: any) {
        console.error('[IPC truth-get-characters] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })

    // 2. 获取特定角色的完整上下文（人设卡、记忆、汇总、用户中心人设等）
    ipcMain.handle('truth-get-character-context', async (_, payload: { characterId: string; folderName: string }) => {
      try {
        const allData = PluginBridgeService.getCharacterAllData(payload.characterId, payload.folderName)
        const userProfile = PluginBridgeService.getUserPersonalProfile()
        return { success: true, allData, userProfile }
      } catch (e: any) {
        console.error('[IPC truth-get-character-context] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })

    // 3. 大模型调用通道，自动注入系统全局提示词，且支持辅助模型静默降级并处理角色绑定画像
    ipcMain.handle('truth-generate-llm-response', async (_, payload: { messages: any[]; characterId?: string }) => {
      try {
        if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
          throw new Error('LLM 调用参数 messages 必须为非空数组！')
        }
        for (const msg of payload.messages) {
          if (!msg || typeof msg !== 'object' || !msg.role || msg.content === undefined) {
            throw new Error('messages 数组中每个元素必须严格包含 role 和 content 字段！')
          }
          if (!['system', 'user', 'assistant'].includes(msg.role)) {
            throw new Error(`非法的 role 字段: "${msg.role}"，必须在 'system' | 'user' | 'assistant' 之间！`)
          }
        }

        // 获取当前角色绑定的用户画像正文，既兼容旧占位符，也独立注入画像上下文
        const userProfileContent = getBindingProfileContent(payload.characterId)
        const userProfilePrompt = `【用户画像设定】\n${userProfileContent || '(暂无用户专属画像设定)'}`
        for (const msg of payload.messages) {
          if (msg && typeof msg === 'object' && typeof msg.content === 'string') {
            msg.content = msg.content.replace(/{{user_profile}}/g, userProfileContent || '(暂无用户专属画像设定)')
          }
        }
        payload.messages.unshift({ role: 'system', content: userProfilePrompt })

        // 🔴 需求 1：在所有 AI 调用消息的最前部，注入设置常规配置里的全局提示词
        const globalPrompt = PluginBridgeService.getGlobalPrompt()
        if (globalPrompt) {
          payload.messages.unshift({ role: 'system', content: globalPrompt })
        }

        // 使用宿主系统的 chat 桥接调用（允许 ModelAdapter 自动进行专属人设的 {{user}} 名字和画像内容替换）
        const response = await PluginBridgeService.chat(payload.messages, { 
          useSecondary: true, 
          skipGlobalPrompt: true, 
          characterId: payload.characterId 
        })
        return { success: true, content: response.content }
      } catch (e: any) {
        console.error('[IPC truth-generate-llm-response] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })

    // 4. 获取历史游玩局列表
    ipcMain.handle('truth-list-sessions', async () => {
      try {
        const storageDir = join(app.getPath('userData'), 'plugins', 'truth-game')
        if (!fs.existsSync(storageDir)) {
          fs.mkdirSync(storageDir, { recursive: true })
          return { success: true, list: [] }
        }

        const files = fs.readdirSync(storageDir)
        const list: any[] = []

        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              const filePath = join(storageDir, file)
              const content = fs.readFileSync(filePath, 'utf8')
              const session = JSON.parse(content)
              list.push(session)
            } catch (err) {
              console.error(`解析真心话局历史文件 ${file} 失败:`, err)
            }
          }
        }

        // 按最后游玩时间降序排列
        list.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
        return { success: true, list }
      } catch (e: any) {
        console.error('[IPC truth-list-sessions] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })

    // 5. 保存或更新游玩局文件
    ipcMain.handle('truth-save-session', async (_, payload: { session: any }) => {
      try {
        const { session } = payload
        if (!session || !session.id) {
          throw new Error('保存的 Session 必须包含合法的 id 字段')
        }

        const storageDir = join(app.getPath('userData'), 'plugins', 'truth-game')
        if (!fs.existsSync(storageDir)) {
          fs.mkdirSync(storageDir, { recursive: true })
        }

        const safeSessionId = validateTruthSessionId(session.id)
        const filePath = join(storageDir, `session_${safeSessionId}.json`)
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8')
        return { success: true }
      } catch (e: any) {
        console.error('[IPC truth-save-session] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })

    // 6. 删除游玩局历史文件
    ipcMain.handle('truth-delete-session', async (_, payload: { sessionId: string }) => {
      try {
        const { sessionId } = payload
        if (!sessionId) {
          throw new Error('未指定要删除的 sessionId')
        }

        const storageDir = join(app.getPath('userData'), 'plugins', 'truth-game')
        const safeSessionId = validateTruthSessionId(sessionId)
        const filePath = join(storageDir, `session_${safeSessionId}.json`)
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
        return { success: true }
      } catch (e: any) {
        console.error('[IPC truth-delete-session] 失败:', e)
        return { success: false, error: e.message || e }
      }
    })
  }
}
