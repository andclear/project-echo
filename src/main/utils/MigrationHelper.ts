import { app } from 'electron'
import fs from 'fs'
import { join } from 'path'
import { getDatabaseService } from '../db/database'
import { UserProfileReaderWriter } from './UserProfileReaderWriter'
import { CharacterStorageManager } from './CharacterStorageManager'

/**
 * 🚀 静默数据迁移 V4：对聊天记录表中的自定义表情包大体积 Base64 进行脱水清洗
 * 将 Messages 表中所有带 Base64 原始图片大字段的自定义表情包 JSON，安全剔除 base64 字段，彻底瘦身数据库
 */
export function performEmojiBase64DecoupleMigration() {
  try {
    const db = getDatabaseService()
    const done = db.getSetting('emoji_base64_migration_done_v4')
    if (done === '1') {
      console.log('[Migration] 表情包 Base64 数据库瘦身迁移 V4 已在之前完成，静默跳过。')
      return
    }

    console.log('[Migration] 🚀 开始执行一次性的表情包 Base64 数据库瘦身物理迁移 V4...')
    
    // 找出所有可能带有自定义表情包大字段的历史消息
    const rows = db.db.prepare("SELECT id, content FROM Messages WHERE content LIKE '[wechat_custom_emoji]:%'").all() as { id: string; content: string }[]
    
    if (rows.length === 0) {
      console.log('[Migration] 未发现历史表情包消息记录，跳过 V4。')
      db.setSetting('emoji_base64_migration_done_v4', '1')
      return
    }

    let count = 0
    const updateStmt = db.db.prepare('UPDATE Messages SET content = ? WHERE id = ?')

    // 使用事务以确保批量更新的极致性能与安全
    const runUpdates = db.db.transaction(() => {
      const emojisDir = join(app.getPath('userData'), 'custom_emojis')
      if (!fs.existsSync(emojisDir)) {
        fs.mkdirSync(emojisDir, { recursive: true })
      }
      for (const row of rows) {
        try {
          const jsonStr = row.content.substring('[wechat_custom_emoji]:'.length)
          const emojiData = JSON.parse(jsonStr)
          // 如果存在 base64 大字段，且具有 id
          if (emojiData.base64 && emojiData.id) {
            // 🚀 防破图自愈防线：若物理脱水文件不存在，则先在脱水消息前将其安全物理写入 custom_emojis 中
            const possibleExts = ['webp', 'gif', 'png', 'jpg', 'jpeg']
            const filePathPrefix = join(emojisDir, emojiData.id)
            const exists = possibleExts.some(ext => fs.existsSync(`${filePathPrefix}.${ext}`))
            if (!exists) {
              const match = emojiData.base64.match(/^data:image\/(png|jpg|jpeg|webp|gif);base64,/)
              const ext = match ? match[1] : 'webp'
              const base64Data = emojiData.base64.replace(/^data:image\/(png|jpg|jpeg|webp|gif);base64,/, '')
              fs.writeFileSync(`${filePathPrefix}.${ext}`, Buffer.from(base64Data, 'base64'))
              console.log(`[Migration-V4] 成功为已脱水的历史表情消息补写物理文件: ${emojiData.id}.${ext}`)
            }

            delete emojiData.base64
            const cleanedContent = `[wechat_custom_emoji]:${JSON.stringify(emojiData)}`
            updateStmt.run(cleanedContent, row.id)
            count++
          }
        } catch (_) {}
      }
    })

    runUpdates()
    
    db.setSetting('emoji_base64_migration_done_v4', '1')
    console.log(`[Migration] ✨ 表情包 Base64 瘦身自愈迁移 V4 顺利完成，共清洗了 ${count} 条大表情包消息！`)
  } catch (err) {
    console.error('[Migration] ✘ 执行表情包 Base64 数据库瘦身迁移 V4 发生异常:', err)
  }
}

// 17.5 增量物理迁移老用户个人人设辅助函数 (提至全局作用域)
export function migrateLegacyUserProfile() {
  try {
    const db = getDatabaseService()
    const done = db.getSetting('legacy_user_profile_migration_done_v5')
    if (done === '1') {
      return
    }

    console.log('[Migration] 🚀 开始执行一次性的老人设物理迁移与角色绑定自愈 V5...')

    const configDir = join(app.getPath('userData'), 'config')
    const legacyUserPath = join(configDir, 'USER.md')
    const targetProfilesDir = join(configDir, 'user_profiles')

    let profileIdToBind = ''

    // 1. 如果旧 USER.md 存在，执行物理迁移
    if (fs.existsSync(legacyUserPath)) {
      try {
        console.log('[Migration-V5] 发现老用户 USER.md，开始执行物理迁移到 user_profiles/...')
        const rawContent = fs.readFileSync(legacyUserPath, 'utf8')
        const profile = UserProfileReaderWriter.readGlobalProfile(legacyUserPath)
        
        const name = (profile.name || 'user').trim()
        const storageManager = new CharacterStorageManager()
        const pinyinName = storageManager.convertToPinyin(name)
        
        if (!fs.existsSync(targetProfilesDir)) {
          fs.mkdirSync(targetProfilesDir, { recursive: true })
        }
        
        const targetFileName = `${pinyinName}_1.md`
        const targetPath = join(targetProfilesDir, targetFileName)
        
        if (!fs.existsSync(targetPath)) {
          const pureMarkdown = rawContent.replace(/<!--[\s\S]*?-->/g, '').trim()
          const newMetadata = {
            avatar: '',
            name: name,
            gender: '其他',
            age: profile.age || '',
            description: '自 USER.md 兼容性迁移的设定卡'
          }
          const fileComment = `<!--\n${JSON.stringify(newMetadata, null, 2)}\n-->`
          const newFileContent = `${fileComment}\n\n${pureMarkdown}`
          fs.writeFileSync(targetPath, newFileContent, 'utf8')
          console.log(`[Migration-V5] 已成功物理迁移老用户个人设定至 ${targetPath}`)
        }
        
        profileIdToBind = targetFileName.replace(/\.md$/, '')
        
        // 物理删除旧 USER.md
        fs.unlinkSync(legacyUserPath)
        console.log('[Migration-V5] 旧的 USER.md 已物理删除')
      } catch (migrateFileErr) {
        console.error('[Migration-V5] 迁移 USER.md 物理文件失败:', migrateFileErr)
      }
    }

    // 2. 补救防线：如果 USER.md 不存在（此前版本已被删除），但 user_profiles 目录下有人设卡，则提取第一个人设卡进行绑定自愈
    if (!profileIdToBind && fs.existsSync(targetProfilesDir)) {
      try {
        const files = fs.readdirSync(targetProfilesDir).filter(f => f.endsWith('.md'))
        if (files.length > 0) {
          files.sort()
          profileIdToBind = files[0].replace(/\.md$/, '')
          console.log(`[Migration-V5] 发现已迁移的人设卡: [${profileIdToBind}]，准备进行绑定自愈`)
        }
      } catch (readDirErr) {
        console.error('[Migration-V5] 读取 user_profiles 目录失败:', readDirErr)
      }
    }

    // 3. 执行静默绑定关系建立
    if (profileIdToBind) {
      try {
        const characters = db.getAllCharacters()
        let bindCount = 0
        for (const char of characters) {
          const charId = char.id
          const isGroup = !!db.getGroupChat(charId)
          if (!isGroup) {
            const currentBinding = db.getProfileBinding(charId)
            if (!currentBinding) {
              db.setProfileBinding(charId, profileIdToBind)
              bindCount++
              console.log(`[Migration-V5] 成功自动为历史角色 [${char.name} (${charId})] 静默绑定老用户人设 [${profileIdToBind}]`)
            }
          }
        }
        console.log(`[Migration-V5] 绑定自愈完成，共建立绑定关系 ${bindCount} 个`)
      } catch (bindErr) {
        console.error('[Migration-V5] 静默绑定角色人设关系失败:', bindErr)
      }
    }

    // 4. 写入迁移成功标记，锁死防线
    db.setSetting('legacy_user_profile_migration_done_v5', '1')
    console.log('[Migration] ✨ 老用户个人设定卡物理迁移与角色绑定自愈 V5 全部顺利完成！')
  } catch (err) {
    console.error('[Migration] ✘ 执行老人设迁移与角色绑定自愈 V5 过程中发生异常:', err)
  }
}
