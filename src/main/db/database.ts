import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

export class DatabaseService {
  public db: Database.Database

  // 发布订阅：支持多个订阅者同时监听消息保存事件
  private onMessageSavedCallbacks: Array<(msg: any) => void> = []

  /**
   * 注册消息保存事件监听器（支持多个监听器，新注册的追加而不覆盖）
   */
  public onMessageSaved(callback: (msg: any) => void): void {
    this.onMessageSavedCallbacks.push(callback)
  }

  /**
   * 兼容旧接口（单例模式）—— 实际追加到订阅列表
   * @deprecated 请使用 onMessageSaved 替代
   */
  public registerOnMessageSaved(callback: (msg: any) => void): void {
    this.onMessageSavedCallbacks.push(callback)
  }

  constructor() {
    // 获取用户数据主目录
    const userDataPath = app.getPath('userData')
    const dbDir = join(userDataPath, 'database')

    // 确保数据库目录存在
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = join(dbDir, 'echo')
    console.log(`[Database] 正在初始化本地数据库: ${dbPath}`)

    // 实例化 sqlite 数据库
    this.db = new Database(dbPath)
    
    // 启用 WAL 模式以提升并发读写性能
    this.db.pragma('journal_mode = WAL')

    // 初始化表结构
    this.initTables()
  }

  /**
   * 初始化数据库表
   */
  private initTables(): void {
    // 创建全局设置表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    // 创建聊天记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Messages (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        token_usage INTEGER DEFAULT 0
      );
    `)

    // 创建角色元数据表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        first_mes TEXT,
        created_at INTEGER NOT NULL
      );
    `)

    // 创建朋友圈表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Moments (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        likes INTEGER DEFAULT 0,
        liked INTEGER DEFAULT 0
      );
    `)

    // 创建论坛表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ForumPosts (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        views INTEGER DEFAULT 0,
        replies_count INTEGER DEFAULT 0,
        board_id TEXT DEFAULT 'tech'
      );
    `)

    // 创建朋友圈评论表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS MomentComments (
        id TEXT PRIMARY KEY,
        moment_id TEXT NOT NULL,
        character_id TEXT,
        author_name TEXT NOT NULL,
        author_avatar TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reply_to_comment_id TEXT,
        reply_to_name TEXT
      );
    `)

    // 创建朋友圈点赞表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS MomentLikes (
        moment_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (moment_id, character_id)
      );
    `)

    // 创建论坛评论表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ForumComments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        character_id TEXT,
        author_name TEXT NOT NULL,
        author_avatar TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reply_to_comment_id TEXT,
        reply_to_name TEXT
      );
    `)

    // 创建统一收藏表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Favorites (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `)

    // ====== 音乐功能专属数据表 ======
    // 1. 音乐自建播放列表表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS MusicPlaylists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)

    // 2. 音乐播放列表单曲关联表 (playlist_id 可为 'love' 或自建列表 ID)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS MusicPlaylistSongs (
        playlist_id TEXT NOT NULL,
        songmid TEXT NOT NULL,
        name TEXT NOT NULL,
        singer TEXT NOT NULL,
        albumName TEXT NOT NULL,
        interval TEXT NOT NULL,
        source TEXT NOT NULL,
        qualitys TEXT NOT NULL, -- 以 JSON 字符串存储支持的音质数组
        img TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, songmid, source)
      );
    `)

    // 3. 音乐下载历史与任务记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS MusicDownloads (
        id TEXT PRIMARY KEY, -- songmid_source_quality
        songmid TEXT NOT NULL,
        name TEXT NOT NULL,
        singer TEXT NOT NULL,
        albumName TEXT NOT NULL,
        quality TEXT NOT NULL,
        filePath TEXT NOT NULL,
        status INTEGER NOT NULL, -- 0:下载中, 1:已完成, 2:失败
        progress REAL DEFAULT 0.0,
        timestamp INTEGER NOT NULL
      );
    `)

    // 4. 新放大模型物理调用统计记录表 (ModelStats)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ModelStats (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        model_role TEXT NOT NULL, -- 'primary' | 'secondary'
        model_name TEXT NOT NULL,
        token_usage INTEGER DEFAULT 0
      );
    `)

    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_model_stats_ts ON ModelStats (timestamp);`)
    } catch (_) {}

    // 执行数据库事务级增量迁移
    this.runDatabaseMigrations()

    // ====== 新增群聊功能表定义 ======
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS GroupChats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        chat_mode TEXT DEFAULT 'descriptive',
        created_at INTEGER NOT NULL
      );
    `)

    try {
      const pragma = this.db.pragma("table_info(GroupChats)") as any[]
      const hasCol = pragma.some((c: any) => c.name === 'chat_mode')
      if (!hasCol) {
        this.db.exec("ALTER TABLE GroupChats ADD COLUMN chat_mode TEXT DEFAULT 'descriptive';")
        console.log("[Database Auto-heal] 成功为已存在的 GroupChats 表追加 chat_mode 字段！")
      }
    } catch (err) {
      console.error("[Database Auto-heal Error] 检查并追加 chat_mode 字段失败:", err)
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS GroupMembers (
        group_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        PRIMARY KEY (group_id, character_id)
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ProfileBindings (
        target_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL
      );
    `)

    // 🚀 防爆自愈防线：确保 Novels 表及 NovelChapters.novel_id 必然物理存在，不受 schema_version 的限制
    try {
      const pragma = this.db.pragma("table_info(NovelChapters)") as any[]
      const hasCol = pragma.some((c: any) => c.name === 'novel_id')
      if (!hasCol) {
        this.db.exec("ALTER TABLE NovelChapters ADD COLUMN novel_id TEXT DEFAULT NULL;")
        console.log("[Database Auto-heal] 成功为 NovelChapters 追加 novel_id 字段！")
      }
    } catch (_) {}

    try {
      const pragma = this.db.pragma("table_info(Novels)") as any[]
      const hasCol = pragma.some((c: any) => c.name === 'cover_path')
      if (!hasCol) {
        this.db.exec("ALTER TABLE Novels ADD COLUMN cover_path TEXT DEFAULT NULL;")
        console.log("[Database Auto-heal] 成功为 Novels 追加 cover_path 字段！")
      }
    } catch (_) {}

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Novels (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cover TEXT,
        cover_path TEXT,
        unread_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `)

    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON NovelChapters (novel_id, chapter_index);")
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_novels_char ON Novels (character_id);")
    } catch (_) {}

    // 如果 Novels 表里为空，但 NovelChapters 里有旧数据，说明需要将老数据补物理迁移至 Novels 中
    try {
      const novelsCount = this.db.prepare('SELECT COUNT(*) as count FROM Novels').get() as { count: number }
      const chaptersCount = this.db.prepare('SELECT COUNT(*) as count FROM NovelChapters').get() as { count: number }
      if (novelsCount.count === 0 && chaptersCount.count > 0) {
        console.log('[Database Auto-heal] 检测到 Novels 为空而 NovelChapters 有数据，开始强行执行老数据平滑迁移！')
        
        const characters = this.db.prepare('SELECT id, name FROM Characters').all() as any[]
        const charMap = new Map<string, string>()
        for (const c of characters) {
          charMap.set(c.id, c.name)
        }

        const oldCharIds = this.db.prepare('SELECT DISTINCT character_id FROM NovelChapters').all() as { character_id: string }[]
        for (const row of oldCharIds) {
          const characterId = row.character_id
          const charName = charMap.get(characterId) || '未知角色'

          // 获取绑定的人设卡姓名
          let bindingProfileId: string | null = null
          try {
            const bindRow = this.db.prepare('SELECT profile_id FROM ProfileBindings WHERE target_id = ?').get(characterId) as { profile_id: string } | undefined
            if (bindRow) {
              bindingProfileId = bindRow.profile_id
            }
          } catch (_) {}

          // 获取用户名
          let userName: string | null = null
          try {
            const userDataPath = app.getPath('userData')
            const targetProfilesDir = join(userDataPath, 'config', 'user_profiles')

            let userProfilePath = ''
            if (bindingProfileId) {
              userProfilePath = join(targetProfilesDir, `${bindingProfileId}.md`)
            }
            if ((!userProfilePath || !fs.existsSync(userProfilePath)) && fs.existsSync(targetProfilesDir)) {
              const files = fs.readdirSync(targetProfilesDir).filter((f: string) => f.endsWith('.md'))
              if (files.length > 0) {
                files.sort()
                userProfilePath = join(targetProfilesDir, files[0])
              }
            }

            if (userProfilePath && fs.existsSync(userProfilePath)) {
              const content = fs.readFileSync(userProfilePath, 'utf-8')
              const match = content.match(/<!--([\s\S]*?)-->/)
              if (match && match[1]) {
                try {
                  const parsed = JSON.parse(match[1].trim())
                  if (parsed && parsed.name) {
                    userName = String(parsed.name)
                  }
                } catch (_) {}
              }
              if (!userName) {
                const nameMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?姓名(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/)
                if (nameMatch && nameMatch[1]) {
                  userName = nameMatch[1].trim()
                }
              }
            }
          } catch (e) {
            console.error('[Database Auto-heal] 读取用户人设文件失败:', e)
          }

          const finalUserName = userName || '用户'
          const bookTitle = `${finalUserName}与${charName}`
          const novelId = `${characterId}_legacy`

          // 创建 Novels 里的书籍记录
          try {
            this.db.prepare(`
              INSERT INTO Novels (id, character_id, title, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title
            `).run(novelId, characterId, bookTitle, Date.now())
          } catch (e) {
            console.error('[Database Auto-heal] 创建或更新老小说书籍失败:', e)
          }

          // 更新旧章节的 novel_id 归宿
          try {
            this.db.prepare(`
              UPDATE NovelChapters
              SET novel_id = ?
              WHERE character_id = ? AND novel_id IS NULL
            `).run(novelId, characterId)
          } catch (e) {
            console.error('[Database Auto-heal] 关联老章节失败:', e)
          }
          
          console.log(`[Database Auto-heal] 成功完成遗留小说《${bookTitle}》的平滑自愈绑定！`)
        }
      }
    } catch (err: any) {
      console.error('[Database Auto-heal] 自愈老数据物理迁移时发生未知异常:', err.message || err)
    }

    // 初始化设备唯一 ID (device_id)
    const existingDeviceId = this.getSetting('device_id')
    if (!existingDeviceId) {
      const newDeviceId = 'device_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
      this.setSetting('device_id', newDeviceId)
    }

    // 自动修复遗留小说标题
    this.autoHealLegacyNovelsTitle()

    console.log('[Database] 数据表结构初始化顺利完成！')
  }

  /**
   * 数据库事务级增量迁移机制
   */
  private runDatabaseMigrations(): void {
    // 1. 定义迁移队列，版本号从小到大
    const migrations = [
      {
        version: 2,
        up: (db: Database.Database) => {
          // 🚀 核心防错：检查 board_id 列是否已物理存在，防止 duplicate column name 导致迁移事务崩溃回滚！
          const pragma = db.pragma("table_info(ForumPosts)") as any[]
          const hasBoardId = pragma.some(col => col.name === 'board_id')
          if (!hasBoardId) {
            db.exec("ALTER TABLE ForumPosts ADD COLUMN board_id TEXT DEFAULT 'tech';")
          }
        }
      },
      {
        version: 3,
        up: (db: Database.Database) => {
          // 🚀 核心防错：检查 Messages 表的各扩展列是否存在，避免覆盖安装时的冗余报错
          const pragma = db.pragma("table_info(Messages)") as any[]
          const cols = ['prompt_tokens', 'completion_tokens', 'cached_tokens', 'sender_id']
          for (const col of cols) {
            const hasCol = pragma.some(c => c.name === col)
            if (!hasCol) {
              db.exec(`ALTER TABLE Messages ADD COLUMN ${col} INTEGER DEFAULT NULL;`)
            }
          }
        }
      },
      {
        version: 4,
        up: (db: Database.Database) => {
          // 🚀 为 Messages 表新增 is_proactive 字段，用于标记角色主动搭讪消息
          // 搭讪消息需要保持独立，不参与 mergeChatHistory 的连续气泡合并
          const pragma = db.pragma("table_info(Messages)") as any[]
          const hasCol = pragma.some((c: any) => c.name === 'is_proactive')
          if (!hasCol) {
            db.exec(`ALTER TABLE Messages ADD COLUMN is_proactive INTEGER DEFAULT 0;`)
          }
        }
      },
      {
        version: 5,
        up: (db: Database.Database) => {
          // 创建本地意见反馈记录表
          db.exec(`
            CREATE TABLE IF NOT EXISTS UserFeedbacks (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              type TEXT NOT NULL,
              contact TEXT,
              status TEXT NOT NULL DEFAULT 'pending',
              created_at INTEGER NOT NULL
            );
          `);
        }
      },
      {
        version: 6,
        up: (db: Database.Database) => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS NovelChapters (
              id TEXT PRIMARY KEY,
              character_id TEXT NOT NULL,
              chapter_index INTEGER NOT NULL,
              title TEXT NOT NULL,
              content TEXT NOT NULL,
              summary TEXT NOT NULL,
              dialogue_start_ts INTEGER NOT NULL,
              dialogue_end_ts INTEGER NOT NULL,
              token_count INTEGER DEFAULT 0,
              rating INTEGER DEFAULT 0,
              created_at INTEGER NOT NULL
            );
          `);
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_novel_chapters_char ON NovelChapters (character_id, chapter_index);`);
          } catch (_) {}
        }
      },
      {
        version: 7,
        up: (db: Database.Database) => {
          // ── 1. Messages 表扩展字段（round_id / seq / msg_type）──
          const msgPragma = db.pragma("table_info(Messages)") as any[]
          const msgCols = msgPragma.map((c: any) => c.name)

          if (!msgCols.includes('round_id')) {
            db.exec(`ALTER TABLE Messages ADD COLUMN round_id TEXT DEFAULT NULL;`)
          }
          if (!msgCols.includes('seq')) {
            db.exec(`ALTER TABLE Messages ADD COLUMN seq INTEGER DEFAULT 0;`)
          }
          if (!msgCols.includes('msg_type')) {
            db.exec(`ALTER TABLE Messages ADD COLUMN msg_type TEXT DEFAULT 'text';`)
          }

          // round_id 索引（断线重连补偿查询用）
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_round_id ON Messages (round_id);`)
          } catch (_) {}

          // character_id + timestamp 复合索引（消息列表分页查询性能优化）
          try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_char_ts ON Messages (character_id, timestamp);`)
          } catch (_) {}

          // ── 2. 新建 ConversationMeta 表（替代散落在 Settings 表中的 conversation_meta_* key）──
          db.exec(`
            CREATE TABLE IF NOT EXISTS ConversationMeta (
              character_id TEXT PRIMARY KEY,
              unread       INTEGER NOT NULL DEFAULT 0,
              pinned       INTEGER NOT NULL DEFAULT 0,
              muted        INTEGER NOT NULL DEFAULT 0,
              hidden       INTEGER NOT NULL DEFAULT 0,
              last_msg_ts  INTEGER NOT NULL DEFAULT 0
            );
          `)

          // ── 3. 迁移旧 Settings 表中的 conversation_meta_* 数据到新表 ──
          try {
            const oldMetas = db.prepare(
              "SELECT key, value FROM Settings WHERE key LIKE 'conversation_meta_%'"
            ).all() as any[]
            const insertMeta = db.prepare(`
              INSERT OR IGNORE INTO ConversationMeta
                (character_id, unread, pinned, muted, hidden, last_msg_ts)
              VALUES (?, ?, ?, ?, ?, 0)
            `)
            for (const row of oldMetas) {
              try {
                const charId = row.key.replace('conversation_meta_', '')
                const meta = JSON.parse(row.value)
                insertMeta.run(
                  charId,
                  meta.unread || 0,
                  meta.pinned ? 1 : 0,
                  meta.muted ? 1 : 0,
                  meta.hidden ? 1 : 0
                )
              } catch (_) {}
            }
          } catch (_) {}

          // ── 4. 初始化一次性匿名设备量统计状态 ──
          try {
            const checkReport = db.prepare("SELECT value FROM Settings WHERE key = 'telemetry_reported'").get() as any
            if (!checkReport) {
              db.prepare("INSERT INTO Settings (key, value) VALUES ('telemetry_reported', '0')").run()
            }
          } catch (_) {}
        }
      },
      {
        version: 8,
        up: (db: Database.Database) => {
          // 🚀 物理迁移：为 GroupChats 表新增 chat_mode 字段，默认 'descriptive'
          const pragma = db.pragma("table_info(GroupChats)") as any[]
          const hasCol = pragma.some((c: any) => c.name === 'chat_mode')
          if (!hasCol) {
            db.exec("ALTER TABLE GroupChats ADD COLUMN chat_mode TEXT DEFAULT 'descriptive';")
          }
          // 🚀 物理迁移：新增 ProfileBindings 绑定关系表
          db.exec(`
            CREATE TABLE IF NOT EXISTS ProfileBindings (
              target_id TEXT PRIMARY KEY,
              profile_id TEXT NOT NULL
            );
          `)
        }
      },
      {
        version: 9,
        up: (db: Database.Database) => {
          // 1. 结构变更：添加 novel_id 字段及创建 Novels 表
          const pragma = db.pragma("table_info(NovelChapters)") as any[]
          const hasCol = pragma.some((c: any) => c.name === 'novel_id')
          if (!hasCol) {
            db.exec("ALTER TABLE NovelChapters ADD COLUMN novel_id TEXT DEFAULT NULL;")
          }

          db.exec(`
            CREATE TABLE IF NOT EXISTS Novels (
              id TEXT PRIMARY KEY,
              character_id TEXT NOT NULL,
              title TEXT NOT NULL,
              cover TEXT,
              unread_count INTEGER DEFAULT 0,
              created_at INTEGER NOT NULL
            );
          `)

          try {
            db.exec("CREATE INDEX IF NOT EXISTS idx_novel_chapters_novel ON NovelChapters (novel_id, chapter_index);")
            db.exec("CREATE INDEX IF NOT EXISTS idx_novels_char ON Novels (character_id);")
          } catch (_) {}

          // 2. 老章节自愈平滑升级迁移 (老用户的小说也应该自动更改为当前的命名方式)
          try {
            const characters = db.prepare('SELECT id, name FROM Characters').all() as any[]
            const charMap = new Map<string, string>()
            for (const c of characters) {
              charMap.set(c.id, c.name)
            }

            const oldCharIds = db.prepare('SELECT DISTINCT character_id FROM NovelChapters').all() as { character_id: string }[]
            for (const row of oldCharIds) {
              const characterId = row.character_id
              const charName = charMap.get(characterId) || '未知角色'

              // 获取绑定的人设卡姓名
              let bindingProfileId: string | null = null
              try {
                const bindRow = db.prepare('SELECT profile_id FROM ProfileBindings WHERE target_id = ?').get(characterId) as { profile_id: string } | undefined
                if (bindRow) {
                  bindingProfileId = bindRow.profile_id
                }
              } catch (_) {}

              // 获取用户名
              let userName: string | null = null
              try {
                const { app } = require('electron')
                const { join } = require('path')
                const fs = require('fs')
                const userDataPath = app.getPath('userData')
                const targetProfilesDir = join(userDataPath, 'config', 'user_profiles')

                let userProfilePath = ''
                if (bindingProfileId) {
                  userProfilePath = join(targetProfilesDir, `${bindingProfileId}.md`)
                }
                if ((!userProfilePath || !fs.existsSync(userProfilePath)) && fs.existsSync(targetProfilesDir)) {
                  const files = fs.readdirSync(targetProfilesDir).filter((f: string) => f.endsWith('.md'))
                  if (files.length > 0) {
                    files.sort()
                    userProfilePath = join(targetProfilesDir, files[0])
                  }
                }

                if (userProfilePath && fs.existsSync(userProfilePath)) {
                  const content = fs.readFileSync(userProfilePath, 'utf-8')
                  const match = content.match(/<!--([\s\S]*?)-->/)
                  if (match && match[1]) {
                    try {
                      const parsed = JSON.parse(match[1].trim())
                      if (parsed && parsed.name) {
                        userName = String(parsed.name)
                      }
                    } catch (_) {}
                  }
                  if (!userName) {
                    const nameMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?姓名(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/)
                    if (nameMatch && nameMatch[1]) {
                      userName = nameMatch[1].trim()
                    }
                  }
                }
              } catch (e) {
                console.error('[Migration v9] 读取用户人设文件失败:', e)
              }

              const finalUserName = userName || '用户'
              const bookTitle = `${finalUserName}与${charName}`
              const novelId = `${characterId}_legacy`

              // 创建 Novels 里的书籍记录
              try {
                db.prepare(`
                  INSERT INTO Novels (id, character_id, title, created_at)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET title = excluded.title
                `).run(novelId, characterId, bookTitle, Date.now())
              } catch (e) {
                console.error('[Migration v9] 创建或更新老小说书籍失败:', e)
              }

              // 更新旧章节的 novel_id 归宿
              try {
                db.prepare(`
                  UPDATE NovelChapters
                  SET novel_id = ?
                  WHERE character_id = ? AND novel_id IS NULL
                `).run(novelId, characterId)
              } catch (e) {
                console.error('[Migration v9] 关联老章节失败:', e)
              }
            }
          } catch (err) {
            console.error('[Migration v9] 物理迁移老小说数据失败:', err)
          }
        }
      }
    ]

    // 2. 获取当前数据库版本，无则默认为 1
    const currentVersionStr = this.getSetting('schema_version')
    const currentVersion = currentVersionStr ? parseInt(currentVersionStr, 10) : 1

    const pendingMigrations = migrations.filter(m => m.version > currentVersion)
    if (pendingMigrations.length === 0) {
      console.log(`[Database] 当前数据库结构已是最新版本 (v${currentVersion})，无需迁移。`)
      return
    }

    console.log(`[Database] 检测到待执行的迁移序列: 从 v${currentVersion} 升级至 v${migrations[migrations.length - 1].version}`)

    try {
      // 3. 采用 better-sqlite3 提供的 transaction 进行绝对安全的事务升级
      const executeMigrations = this.db.transaction(() => {
        for (const migration of pendingMigrations) {
          console.log(`[Database] 正在执行数据库迁移：v${migration.version}...`)
          migration.up(this.db)
          this.setSetting('schema_version', migration.version.toString())
        }
      })

      executeMigrations()
      console.log('[Database] 数据库结构事务级迁移全部顺利完成！')
    } catch (err: any) {
      console.error('[Database] 数据库迁移中途失败，事务已自动安全回滚！错误详情:', err.message)
    }
  }

  /**
   * 获取全局设置项
   */
  public getSetting(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM Settings WHERE key = ?')
    const row = stmt.get(key) as { value: string } | undefined
    return row ? row.value : null
  }

  /**
   * 保存或更新全局设置项
   */
  public setSetting(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO Settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    stmt.run(key, value)
  }

  /**
   * 获取微信好友到本地数字生命角色的映射绑定关系字典
   */
  public getWeChatMappings(): Record<string, string> {
    const raw = this.getSetting('wechat_friend_mappings')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch (_) {
      return {}
    }
  }

  /**
   * 保存微信好友到本地数字生命角色的映射绑定关系字典
   */
  public saveWeChatMapping(mappings: Record<string, string>): void {
    this.setSetting('wechat_friend_mappings', JSON.stringify(mappings))
  }


  /**
   * 保存聊天消息
   */
  /**
   * 保存聊天消息（完整版，支持 v7 新增字段：round_id / seq / msg_type）
   */
  public saveMessage(msg: {
    id: string
    character_id: string
    role: string
    content: string
    timestamp: number
    token_usage: number
    prompt_tokens?: number
    completion_tokens?: number
    cached_tokens?: number
    sender_id?: string
    is_proactive?: number  // 1 = 角色主动搭讪消息，不参与连续气泡合并
    round_id?: string      // 轮次 ID（v7 新增）
    seq?: number           // 轮次内序号（v7 新增）
    msg_type?: string      // 消息类型（v7 新增）
  }): void {
    let finalContent = msg.content
    if (finalContent && finalContent.startsWith('[wechat_custom_emoji]:')) {
      try {
        const jsonStr = finalContent.substring('[wechat_custom_emoji]:'.length)
        const emojiData = JSON.parse(jsonStr)
        if (emojiData.base64 && emojiData.id) {
          delete emojiData.base64
          finalContent = `[wechat_custom_emoji]:${JSON.stringify(emojiData)}`
        }
      } catch (_) {}
    }

    const stmt = this.db.prepare(`
      INSERT INTO Messages
        (id, character_id, role, content, timestamp, token_usage,
         prompt_tokens, completion_tokens, cached_tokens,
         sender_id, is_proactive, round_id, seq, msg_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      msg.id,
      msg.character_id,
      msg.role,
      finalContent,
      msg.timestamp,
      msg.token_usage,
      msg.prompt_tokens !== undefined ? msg.prompt_tokens : null,
      msg.completion_tokens !== undefined ? msg.completion_tokens : null,
      msg.cached_tokens !== undefined ? msg.cached_tokens : null,
      msg.sender_id !== undefined ? msg.sender_id : null,
      msg.is_proactive !== undefined ? msg.is_proactive : 0,
      msg.round_id !== undefined ? msg.round_id : null,
      msg.seq !== undefined ? msg.seq : 0,
      msg.msg_type !== undefined ? msg.msg_type : 'text'
    )

    // 触发所有已注册的消息保存监听器
    for (const cb of this.onMessageSavedCallbacks) {
      try {
        cb(msg)
      } catch (err) {
        console.error('[DatabaseService] 触发 onMessageSaved 回调异常:', err)
      }
    }
  }

  /**
   * 物理更新消息内容（主要用于更新红包的领取或退回状态）
   */
  public updateMessageContent(id: string, content: string): void {
    const stmt = this.db.prepare('UPDATE Messages SET content = ? WHERE id = ?')
    stmt.run(content, id)
  }

  /**
   * 物理删除单条聊天消息
   */
  public deleteMessage(id: string): void {
    const stmt = this.db.prepare('DELETE FROM Messages WHERE id = ?')
    stmt.run(id)
  }

  /**
   * 获取最近的聊天历史记录
   */
  public getChatHistory(characterId: string, limit: number = 20, beforeTimestamp?: number): any[] {
    let rows: any[]
    if (beforeTimestamp !== undefined && beforeTimestamp !== null) {
      // 分页拉取：只获取指定时间戳之前的历史消息
      const stmt = this.db.prepare(`
        SELECT * FROM Messages
        WHERE character_id = ? AND timestamp < ?
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      rows = stmt.all(characterId, beforeTimestamp, limit)
    } else {
      // 默认拉取：获取最新的历史消息
      const stmt = this.db.prepare(`
        SELECT * FROM Messages
        WHERE character_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      rows = stmt.all(characterId, limit)
    }
    // 按时间升序返回，以符合对话顺序要求
    return rows.reverse()
  }

  /**
   * 保存或更新角色元数据
   */
  public saveCharacterMetadata(char: {
    id: string
    name: string
    avatar: string
    folder_name: string
    first_mes?: string
    created_at: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO Characters (id, name, avatar, folder_name, first_mes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        avatar = excluded.avatar,
        folder_name = excluded.folder_name,
        first_mes = excluded.first_mes,
        created_at = excluded.created_at
    `)
    stmt.run(char.id, char.name, char.avatar, char.folder_name, char.first_mes || '', char.created_at)
  }

  /**
   * 获取所有已导入角色
   */
  public getAllCharacters(): any[] {
    const stmt = this.db.prepare('SELECT * FROM Characters ORDER BY created_at DESC')
    return stmt.all()
  }

  /**
   * 删除角色元数据
   */
  public deleteCharacter(id: string): void {
    const stmt = this.db.prepare('DELETE FROM Characters WHERE id = ?')
    stmt.run(id)
  }

  /**
   * 删除特定角色的所有聊天记录
   */
  public deleteChatHistory(characterId: string): void {
    const stmt = this.db.prepare('DELETE FROM Messages WHERE character_id = ?')
    stmt.run(characterId)

    // 🚀 清空聊天历史时，同步重置该小说写手的活跃书籍和时间线起点，确保物理清空判定绝对准确
    const stmtSettings = this.db.prepare('DELETE FROM Settings WHERE key IN (?, ?, ?)')
    stmtSettings.run(
      `current_active_novel_id_${characterId}`,
      `novel_start_ts_${characterId}`,
      `last_novel_chapter_end_ts_${characterId}`
    )
  }

  /**
   * 按关键词搜索特定角色的所有聊天历史（全文匹配）
   */
  public searchChatHistory(characterId: string, keyword: string, limit: number = 200): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM Messages
      WHERE character_id = ? AND content LIKE ? AND content NOT LIKE '[character_diary]%'
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    const rows = stmt.all(characterId, `%${keyword}%`, limit) as any[]
    // 按时间升序返回，以符合阅读习惯
    return rows.reverse()
  }

  /**
   * 获取某角色今天用户发送的消息总数
   */
  public getTodayUserMessageCount(characterId: string): number {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayStartTs = todayStart.getTime()
    const stmt = this.db.prepare("SELECT COUNT(*) as count FROM Messages WHERE character_id = ? AND role = 'user' AND timestamp >= ?")
    const row = stmt.get(characterId, todayStartTs) as { count: number } | undefined
    return row ? row.count : 0
  }

  /**
   * 写入大模型物理调用记录统计，用于数据面板精准分析
   */
  public recordModelCall(modelRole: 'primary' | 'secondary', modelName: string, tokenUsage: number): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO ModelStats (id, timestamp, model_role, model_name, token_usage)
        VALUES (?, ?, ?, ?, ?)
      `)
      stmt.run(
        `stat_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        Date.now(),
        modelRole,
        modelName,
        tokenUsage
      )
      console.log(`[Database] 成功记入一次模型调用统计: role=${modelRole}, name=${modelName}, tokens=${tokenUsage}`)
    } catch (err: any) {
      console.error('[Database] 记入模型调用统计异常:', err.message)
    }
  }

  /**
   * 保存朋友圈动态
   */
  public saveMoment(moment: {
    id: string
    character_id: string
    author_name: string
    author_avatar: string
    content: string
    timestamp: number
    likes: number
    liked?: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO Moments (id, character_id, author_name, author_avatar, content, timestamp, likes, liked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        likes = excluded.likes,
        liked = excluded.liked
    `)
    stmt.run(
      moment.id,
      moment.character_id,
      moment.author_name,
      moment.author_avatar,
      moment.content,
      moment.timestamp,
      moment.likes,
      moment.liked || 0
    )
  }

  /**
   * 获取所有朋友圈动态
   */
  public getAllMoments(limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM Moments
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(limit)
  }

  /**
   * 点赞/取消点赞朋友圈动态
   */
  public toggleLikeMoment(id: string, liked: number): void {
    const stmt = this.db.prepare(`
      UPDATE Moments
      SET liked = ?, likes = likes + ?
      WHERE id = ?
    `)
    stmt.run(liked, liked === 1 ? 1 : -1, id)
  }

  /**
   * 保存论坛帖子
   */
  public saveForumPost(post: {
    id: string
    character_id: string
    author_name: string
    author_avatar: string
    title: string
    content: string
    timestamp: number
    views: number
    replies_count: number
    board_id?: string // 支持传入板块 ID
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO ForumPosts (id, character_id, author_name, author_avatar, title, content, timestamp, views, replies_count, board_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        views = excluded.views,
        replies_count = excluded.replies_count,
        board_id = COALESCE(excluded.board_id, ForumPosts.board_id) -- 当更新时保留或更新 board_id
    `)
    stmt.run(
      post.id,
      post.character_id,
      post.author_name,
      post.author_avatar,
      post.title,
      post.content,
      post.timestamp,
      post.views,
      post.replies_count,
      post.board_id || 'tech' // 默认归属于 'tech' (科技前沿)
    )
  }

  /**
   * 获取所有论坛帖子
   */
  public getAllForumPosts(limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ForumPosts
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(limit)
  }

  /**
   * 清除跟特定角色相关的所有 Settings 字段
   */
  public clearCharacterSettings(characterId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM Settings
      WHERE key LIKE ?
    `)
    stmt.run(`%_${characterId}%`)
  }

  /**
   * 朋友圈评论读写
   */
  public getMomentComments(momentId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM MomentComments WHERE moment_id = ? ORDER BY timestamp ASC')
    return stmt.all(momentId)
  }

  public saveMomentComment(comment: {
    id: string
    moment_id: string
    character_id: string | null
    author_name: string
    author_avatar: string
    content: string
    timestamp: number
    reply_to_comment_id?: string | null
    reply_to_name?: string | null
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO MomentComments (id, moment_id, character_id, author_name, author_avatar, content, timestamp, reply_to_comment_id, reply_to_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      comment.id,
      comment.moment_id,
      comment.character_id,
      comment.author_name,
      comment.author_avatar,
      comment.content,
      comment.timestamp,
      comment.reply_to_comment_id || null,
      comment.reply_to_name || null
    )
  }

  /**
   * 朋友圈点赞读写
   */
  public getMomentLikes(momentId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM MomentLikes WHERE moment_id = ? ORDER BY timestamp ASC')
    return stmt.all(momentId)
  }

  public saveMomentLike(like: {
    moment_id: string
    character_id: string
    author_name: string
    timestamp: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO MomentLikes (moment_id, character_id, author_name, timestamp)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(like.moment_id, like.character_id, like.author_name, like.timestamp)
  }

  public removeMomentLike(momentId: string, characterId: string): void {
    const stmt = this.db.prepare('DELETE FROM MomentLikes WHERE moment_id = ? AND character_id = ?')
    stmt.run(momentId, characterId)
  }

  /**
   * 论坛评论读写
   */
  public getForumComments(postId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM ForumComments WHERE post_id = ? ORDER BY timestamp ASC')
    return stmt.all(postId)
  }

  public saveForumComment(comment: {
    id: string
    post_id: string
    character_id: string | null
    author_name: string
    author_avatar: string
    content: string
    timestamp: number
    reply_to_comment_id?: string | null
    reply_to_name?: string | null
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO ForumComments (id, post_id, character_id, author_name, author_avatar, content, timestamp, reply_to_comment_id, reply_to_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      comment.id,
      comment.post_id,
      comment.character_id,
      comment.author_name,
      comment.author_avatar,
      comment.content,
      comment.timestamp,
      comment.reply_to_comment_id || null,
      comment.reply_to_name || null
    )
  }

  public getForumPostsByBoard(boardId: string, limit: number = 50): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM ForumPosts
      WHERE board_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(boardId, limit)
  }

  public incrementForumPostViews(postId: string): void {
    const stmt = this.db.prepare('UPDATE ForumPosts SET views = views + 1 WHERE id = ?')
    stmt.run(postId)
  }

  public incrementForumPostReplies(postId: string): void {
    const stmt = this.db.prepare('UPDATE ForumPosts SET replies_count = replies_count + 1 WHERE id = ?')
    stmt.run(postId)
  }

  /**
   * 收藏功能读写
   */
  public addFavorite(fav: {
    id: string
    type: string
    target_id: string
    character_id: string
    author_name: string
    author_avatar: string
    title: string | null
    content: string
    timestamp: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO Favorites (id, type, target_id, character_id, author_name, author_avatar, title, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      fav.id,
      fav.type,
      fav.target_id,
      fav.character_id,
      fav.author_name,
      fav.author_avatar,
      fav.title,
      fav.content,
      fav.timestamp
    )
  }

  public removeFavorite(type: string, targetId: string): void {
    const stmt = this.db.prepare('DELETE FROM Favorites WHERE type = ? AND target_id = ?')
    stmt.run(type, targetId)
  }

  public isFavoriteExist(type: string, targetId: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM Favorites WHERE type = ? AND target_id = ? LIMIT 1')
    const row = stmt.get(type, targetId)
    return !!row
  }

  public getFavoritesByType(type: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM Favorites WHERE type = ? ORDER BY timestamp DESC')
    return stmt.all(type)
  }

  public getFavoritesAll(): any[] {
    const stmt = this.db.prepare('SELECT * FROM Favorites ORDER BY timestamp DESC')
    return stmt.all()
  }

  // ====== 音乐播放列表相关数据库方法 ======
  public createMusicPlaylist(id: string, name: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO MusicPlaylists (id, name, created_at)
      VALUES (?, ?, ?)
    `)
    stmt.run(id, name, Date.now())
  }

  public deleteMusicPlaylist(id: string): void {
    const stmt1 = this.db.prepare('DELETE FROM MusicPlaylists WHERE id = ?')
    stmt1.run(id)
    const stmt2 = this.db.prepare('DELETE FROM MusicPlaylistSongs WHERE playlist_id = ?')
    stmt2.run(id)
  }

  public getMusicPlaylists(): any[] {
    const stmt = this.db.prepare('SELECT * FROM MusicPlaylists ORDER BY created_at DESC')
    return stmt.all()
  }

  public addSongToPlaylist(song: {
    playlist_id: string
    songmid: string
    name: string
    singer: string
    albumName: string
    interval: string
    source: string
    qualitys: string
    img: string
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO MusicPlaylistSongs (playlist_id, songmid, name, singer, albumName, interval, source, qualitys, img, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      song.playlist_id || '',
      song.songmid || '',
      song.name || '未知歌曲',
      song.singer || '群星',
      song.albumName || '',
      song.interval || '00:00',
      song.source || 'wy',
      song.qualitys || '["128k"]',
      song.img || '',
      Date.now()
    )
  }

  public removeSongFromPlaylist(playlistId: string, songmid: string, source: string): void {
    const stmt = this.db.prepare('DELETE FROM MusicPlaylistSongs WHERE playlist_id = ? AND songmid = ? AND source = ?')
    stmt.run(playlistId, songmid, source)
  }

  public getSongsFromPlaylist(playlistId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM MusicPlaylistSongs WHERE playlist_id = ? ORDER BY added_at DESC')
    return stmt.all(playlistId)
  }

  public isSongInPlaylist(playlistId: string, songmid: string, source: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM MusicPlaylistSongs WHERE playlist_id = ? AND songmid = ? AND source = ? LIMIT 1')
    const row = stmt.get(playlistId, songmid, source)
    return !!row
  }

  // ====== 音乐下载相关数据库方法 ======
  public saveDownloadTask(task: {
    id: string
    songmid: string
    name: string
    singer: string
    albumName: string
    quality: string
    filePath: string
    status: number
    progress: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO MusicDownloads (id, songmid, name, singer, albumName, quality, filePath, status, progress, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      task.id,
      task.songmid,
      task.name,
      task.singer,
      task.albumName,
      task.quality,
      task.filePath,
      task.status,
      task.progress,
      Date.now()
    )
  }

  public updateDownloadProgress(id: string, progress: number, status: number): void {
    const stmt = this.db.prepare('UPDATE MusicDownloads SET progress = ?, status = ? WHERE id = ?')
    stmt.run(progress, status, id)
  }

  public getDownloads(): any[] {
    const stmt = this.db.prepare('SELECT * FROM MusicDownloads ORDER BY timestamp DESC')
    return stmt.all()
  }

  public deleteDownload(id: string): void {
    const stmt = this.db.prepare('DELETE FROM MusicDownloads WHERE id = ?')
    stmt.run(id)
  }

  // ====== 群聊相关数据库方法 ======
  
  /**
   * 保存或更新群聊会话元数据
   */
  public saveGroupChat(group: { id: string; name: string; avatar?: string; created_at: number }): void {
    const stmt = this.db.prepare(`
      INSERT INTO GroupChats (id, name, avatar, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        avatar = COALESCE(excluded.avatar, GroupChats.avatar)
    `)
    stmt.run(group.id, group.name, group.avatar || null, group.created_at)
  }

  /**
   * 获取指定群聊会话
   */
  public getGroupChat(id: string): any {
    const stmt = this.db.prepare('SELECT * FROM GroupChats WHERE id = ?')
    return stmt.get(id)
  }

  /**
   * 获取群聊专属聊天模式
   */
  public getGroupChatMode(id: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT chat_mode FROM GroupChats WHERE id = ?')
      const row = stmt.get(id) as { chat_mode: string } | undefined
      return row ? row.chat_mode : null
    } catch (_) {
      return null
    }
  }

  /**
   * 更新群聊专属聊天模式
   */
  public setGroupChatMode(id: string, mode: string): void {
    try {
      const stmt = this.db.prepare('UPDATE GroupChats SET chat_mode = ? WHERE id = ?')
      stmt.run(mode, id)
    } catch (_) { }
  }

  /**
   * 获取所有群聊会话
   */
  public getAllGroupChats(): any[] {
    const stmt = this.db.prepare('SELECT * FROM GroupChats ORDER BY created_at DESC')
    return stmt.all()
  }

  /**
   * 删除群聊会话（级联删除成员关系与消息历史记录）
   */
  public deleteGroupChat(id: string): void {
    // 物理清空群聊本身
    const stmt1 = this.db.prepare('DELETE FROM GroupChats WHERE id = ?')
    stmt1.run(id)
    // 物理清空群聊成员映射关系
    const stmt2 = this.db.prepare('DELETE FROM GroupMembers WHERE group_id = ?')
    stmt2.run(id)
    // 物理清空群聊聊天消息历史
    const stmt3 = this.db.prepare('DELETE FROM Messages WHERE character_id = ?')
    stmt3.run(id)
  }

  /**
   * 保存群聊成员（先清空再重新写入映射）
   */
  public saveGroupMembers(groupId: string, memberIds: string[]): void {
    // 开启事务处理，确保成员映射一致性
    const deleteStmt = this.db.prepare('DELETE FROM GroupMembers WHERE group_id = ?')
    const insertStmt = this.db.prepare('INSERT INTO GroupMembers (group_id, character_id) VALUES (?, ?)')
    
    const transaction = this.db.transaction((members: string[]) => {
      deleteStmt.run(groupId)
      for (const memberId of members) {
        insertStmt.run(groupId, memberId)
      }
    })
    
    transaction(memberIds)
  }

  /**
   * 获取特定群聊包含的所有 AI 成员 ID 列表
   */
  public getGroupMembers(groupId: string): any[] {
    const stmt = this.db.prepare('SELECT character_id FROM GroupMembers WHERE group_id = ?')
    const rows = stmt.all(groupId) as { character_id: string }[]
    return rows.map(r => r.character_id)
  }

  /**
   * 更新群聊名称
   */
  public updateGroupName(groupId: string, name: string): void {
    const stmt = this.db.prepare('UPDATE GroupChats SET name = ? WHERE id = ?')
    stmt.run(name, groupId)
  }

  /**
   * 更新群聊拼贴头像文件名或 Base64
   */
  public updateGroupAvatar(groupId: string, avatar: string): void {
    const stmt = this.db.prepare('UPDATE GroupChats SET avatar = ? WHERE id = ?')
    stmt.run(avatar, groupId)
  }

  /**
   * 关闭数据库连接
   */
  public close(): void {
    this.db.close()
  }

  // ====== AI 小说写手相关数据库方法 ======
  
  public insertNovel(novel: { id: string; character_id: string; title: string; cover?: string | null; created_at: number }): void {
    const stmt = this.db.prepare('INSERT INTO Novels (id, character_id, title, cover, created_at) VALUES (?, ?, ?, ?, ?)')
    stmt.run(novel.id, novel.character_id, novel.title, novel.cover || null, novel.created_at)
  }

  public getActiveNovelId(characterId: string): string | null {
    return this.getSetting(`current_active_novel_id_${characterId}`)
  }

  public setActiveNovelId(characterId: string, novelId: string | null): void {
    if (novelId) {
      this.setSetting(`current_active_novel_id_${characterId}`, novelId)
    } else {
      this.db.prepare('DELETE FROM Settings WHERE key = ?').run(`current_active_novel_id_${characterId}`)
    }
  }

  public getNovelChapterCountByNovelId(novelId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM NovelChapters WHERE novel_id = ?')
    const row = stmt.get(novelId) as { count: number } | undefined
    return row ? row.count : 0
  }

  public getNovelChapterCount(characterId: string): number {
    const activeNovelId = this.getActiveNovelId(characterId)
    if (activeNovelId) {
      return this.getNovelChapterCountByNovelId(activeNovelId)
    }
    const row = this.db.prepare('SELECT id FROM Novels WHERE character_id = ? ORDER BY created_at DESC LIMIT 1').get(characterId) as { id: string } | undefined
    if (row) {
      return this.getNovelChapterCountByNovelId(row.id)
    }
    return 0
  }

  public getNovelChaptersByNovelId(novelId: string): any[] {
    const stmt = this.db.prepare(`
      SELECT id, character_id, novel_id, chapter_index, title, summary, dialogue_start_ts, dialogue_end_ts, token_count, rating, created_at
      FROM NovelChapters
      WHERE novel_id = ?
      ORDER BY chapter_index ASC
    `)
    return stmt.all(novelId)
  }

  public getNovelChapters(characterId: string): any[] {
    const activeNovelId = this.getActiveNovelId(characterId)
    if (activeNovelId) {
      return this.getNovelChaptersByNovelId(activeNovelId)
    }
    const row = this.db.prepare('SELECT id FROM Novels WHERE character_id = ? ORDER BY created_at DESC LIMIT 1').get(characterId) as { id: string } | undefined
    if (row) {
      return this.getNovelChaptersByNovelId(row.id)
    }
    return []
  }

  public getNovelChapterContent(chapterId: string): { content: string } | null {
    const stmt = this.db.prepare('SELECT content FROM NovelChapters WHERE id = ?')
    const row = stmt.get(chapterId) as { content: string } | undefined
    return row || null
  }

  public insertNovelChapter(chapter: {
    id: string
    character_id: string
    novel_id?: string | null
    chapter_index: number
    title: string
    content: string
    summary: string
    dialogue_start_ts: number
    dialogue_end_ts: number
    token_count: number
    rating: number
    created_at: number
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO NovelChapters (id, character_id, novel_id, chapter_index, title, content, summary, dialogue_start_ts, dialogue_end_ts, token_count, rating, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      chapter.id,
      chapter.character_id,
      chapter.novel_id || null,
      chapter.chapter_index,
      chapter.title,
      chapter.content,
      chapter.summary,
      chapter.dialogue_start_ts,
      chapter.dialogue_end_ts,
      chapter.token_count,
      chapter.rating,
      chapter.created_at
    )
  }

  public updateNovelChapterContent(chapterId: string, content: string, summary: string, title: string): void {
    const stmt = this.db.prepare('UPDATE NovelChapters SET content = ?, summary = ?, title = ? WHERE id = ?')
    stmt.run(content, summary, title, chapterId)
  }

  public updateNovelChapterRating(chapterId: string, rating: number): void {
    const stmt = this.db.prepare('UPDATE NovelChapters SET rating = ? WHERE id = ?')
    stmt.run(rating, chapterId)
  }

  public deleteNovelChapter(chapterId: string): void {
    // 1. 获取原章节的 novel_id、character_id 和 dialogue_end_ts 信息
    const info = this.db.prepare('SELECT novel_id, character_id, dialogue_end_ts FROM NovelChapters WHERE id = ?').get(chapterId) as { novel_id: string; character_id: string; dialogue_end_ts: number } | undefined
    
    // 2. 物理删除该章节
    const stmt = this.db.prepare('DELETE FROM NovelChapters WHERE id = ?')
    stmt.run(chapterId)

    if (info) {
      const { novel_id, character_id } = info
      const activeNovelId = this.getActiveNovelId(character_id)
      
      // 3. 如果被删除的这一章是当前活跃小说的章节，且 last_novel_chapter_end_ts 正好指向被删除这一章的终点（说明删除了最新的最后一章）
      const lastEndTsKey = `last_novel_chapter_end_ts_${character_id}`
      const currentLastEndTs = parseInt(this.getSetting(lastEndTsKey) || '0', 10)
      
      if (activeNovelId === novel_id && currentLastEndTs === info.dialogue_end_ts) {
        // 查找出当前活跃小说在删除后最大的章节
        const lastChapter = this.db.prepare('SELECT dialogue_end_ts FROM NovelChapters WHERE novel_id = ? ORDER BY chapter_index DESC LIMIT 1').get(novel_id) as { dialogue_end_ts: number } | undefined
        
        if (lastChapter) {
          // 如果还有其他章节，把 last_novel_chapter_end_ts 退回到新的最后一章的结束时间戳，以供后续无缝续章
          this.setSetting(lastEndTsKey, lastChapter.dialogue_end_ts.toString())
        } else {
          // 如果删光了所有章节，把 last_novel_chapter_end_ts 重置为这本小说的起跑起点 startTs
          const startTs = this.getSetting(`novel_start_ts_${character_id}`) || '0'
          this.setSetting(lastEndTsKey, startTs)
        }
      }
    }
  }

  public sumMessageTokensSince(characterId: string, afterTs: number): number {
    const stmt = this.db.prepare(`
      SELECT SUM(token_usage) as total_tokens
      FROM Messages
      WHERE character_id = ? AND timestamp > ?
    `)
    const row = stmt.get(characterId, afterTs) as { total_tokens: number | null } | undefined
    return row?.total_tokens ?? 0
  }

  // ══════════════════════════════════════════════════════════
  // ConversationMeta CRUD（v7 新增）
  // ══════════════════════════════════════════════════════════

  /**
   * 获取指定会话的元数据
   * 若不存在则自动初始化并返回默认值
   */
  public getConversationMeta(characterId: string): {
    character_id: string; unread: number; pinned: boolean;
    muted: boolean; hidden: boolean; last_msg_ts: number
  } {
    const stmt = this.db.prepare(
      'SELECT * FROM ConversationMeta WHERE character_id = ?'
    )
    const row = stmt.get(characterId) as any
    if (row) {
      return {
        character_id: row.character_id,
        unread: row.unread,
        pinned: !!row.pinned,
        muted: !!row.muted,
        hidden: !!row.hidden,
        last_msg_ts: row.last_msg_ts
      }
    }
    // 自动初始化
    this.db.prepare(`
      INSERT OR IGNORE INTO ConversationMeta
        (character_id, unread, pinned, muted, hidden, last_msg_ts)
      VALUES (?, 0, 0, 0, 0, 0)
    `).run(characterId)
    return { character_id: characterId, unread: 0, pinned: false, muted: false, hidden: false, last_msg_ts: 0 }
  }

  /**
   * 获取所有会话的元数据列表
   */
  public getAllConversationMeta(): Array<{
    character_id: string; unread: number; pinned: boolean;
    muted: boolean; hidden: boolean; last_msg_ts: number
  }> {
    const rows = this.db.prepare('SELECT * FROM ConversationMeta').all() as any[]
    return rows.map(row => ({
      character_id: row.character_id,
      unread: row.unread,
      pinned: !!row.pinned,
      muted: !!row.muted,
      hidden: !!row.hidden,
      last_msg_ts: row.last_msg_ts
    }))
  }

  /**
   * 原子更新 ConversationMeta 的单个字段
   * 若记录不存在则自动创建
   */
  public setConversationMetaField(
    characterId: string,
    field: 'unread' | 'pinned' | 'muted' | 'hidden' | 'last_msg_ts',
    value: number
  ): void {
    this.db.prepare(`
      INSERT INTO ConversationMeta (character_id, unread, pinned, muted, hidden, last_msg_ts)
      VALUES (?, 0, 0, 0, 0, 0)
      ON CONFLICT(character_id) DO NOTHING
    `).run(characterId)
    this.db.prepare(`UPDATE ConversationMeta SET ${field} = ? WHERE character_id = ?`)
      .run(value, characterId)
  }

  /**
   * 将指定会话的未读计数原子加 1，同时更新 last_msg_ts
   * 返回更新后的最新 unread 数量
   */
  public incrementUnread(characterId: string, timestamp: number): number {
    // 确保记录存在
    this.db.prepare(`
      INSERT INTO ConversationMeta (character_id, unread, pinned, muted, hidden, last_msg_ts)
      VALUES (?, 0, 0, 0, 0, 0)
      ON CONFLICT(character_id) DO NOTHING
    `).run(characterId)

    // 原子自增并更新时间戳
    this.db.prepare(`
      UPDATE ConversationMeta
      SET unread = unread + 1, last_msg_ts = ?
      WHERE character_id = ?
    `).run(timestamp, characterId)

    // 返回更新后的值
    const row = this.db.prepare(
      'SELECT unread FROM ConversationMeta WHERE character_id = ?'
    ).get(characterId) as { unread: number } | undefined
    return row?.unread ?? 1
  }

  /**
   * 批量 UPSERT ConversationMeta（用于导入/还原时同步）
   */
  public upsertConversationMeta(meta: {
    character_id: string
    unread?: number
    pinned?: boolean
    muted?: boolean
    hidden?: boolean
    last_msg_ts?: number
  }): void {
    this.db.prepare(`
      INSERT INTO ConversationMeta (character_id, unread, pinned, muted, hidden, last_msg_ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        unread = excluded.unread,
        pinned = excluded.pinned,
        muted = excluded.muted,
        hidden = excluded.hidden,
        last_msg_ts = excluded.last_msg_ts
    `).run(
      meta.character_id,
      meta.unread ?? 0,
      meta.pinned ? 1 : 0,
      meta.muted ? 1 : 0,
      meta.hidden ? 1 : 0,
      meta.last_msg_ts ?? 0
    )
  }

  /**
   * 获取会话绑定的人设 ID
   */
  public getProfileBinding(targetId: string): string | null {
    try {
      const stmt = this.db.prepare('SELECT profile_id FROM ProfileBindings WHERE target_id = ?')
      const row = stmt.get(targetId) as { profile_id: string } | undefined
      return row ? row.profile_id : null
    } catch (_) {
      return null
    }
  }

  /**
   * 设置会话绑定的人设 ID
   */
  public setProfileBinding(targetId: string, profileId: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO ProfileBindings (target_id, profile_id)
        VALUES (?, ?)
        ON CONFLICT(target_id) DO UPDATE SET profile_id = excluded.profile_id
      `)
      stmt.run(targetId, profileId)
    } catch (err: any) {
      console.error('[Database] 保存人设绑定失败:', err.message)
    }
  }

  /**
   * 解绑人设
   */
  public deleteProfileBinding(targetId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM ProfileBindings WHERE target_id = ?')
      stmt.run(targetId)
    } catch (err: any) {
      console.error('[Database] 删除人设绑定失败:', err.message)
    }
  }

  /**
   * 根据角色 ID 获取当前绑定的（或首个人设卡兜底的）用户姓名，未配置时返回 null
   */
  public getUserNameByCharacterId(characterId: string | null): string | null {
    let userName: string | null = null
    try {
      let userProfilePath = ''
      const userDataPath = app.getPath('userData')
      const targetProfilesDir = join(userDataPath, 'config', 'user_profiles')
      
      let bindingProfileId: string | null = null
      if (characterId) {
        bindingProfileId = this.getProfileBinding(characterId)
      }
      
      if (bindingProfileId) {
        userProfilePath = join(targetProfilesDir, `${bindingProfileId}.md`)
      }

      if ((!userProfilePath || !fs.existsSync(userProfilePath)) && fs.existsSync(targetProfilesDir)) {
        const files = fs.readdirSync(targetProfilesDir).filter(f => f.endsWith('.md'))
        if (files.length > 0) {
          files.sort()
          userProfilePath = join(targetProfilesDir, files[0])
        }
      }

      if (userProfilePath && fs.existsSync(userProfilePath)) {
        const content = fs.readFileSync(userProfilePath, 'utf-8')
        // 1. 尝试解析 HTML 注释中的 JSON 块以获得姓名
        const match = content.match(/<!--([\s\S]*?)-->/)
        if (match && match[1]) {
          try {
            const parsed = JSON.parse(match[1].trim())
            if (parsed && parsed.name) {
              userName = String(parsed.name)
            }
          } catch (_) {}
        }
        // 2. 备用容错：如果注释中无姓名，则从 Markdown 语法行正则捕获姓名
        if (!userName) {
          const nameMatch = content.match(/(?:^|\n)[-\s*]*(?:\*\*|)?姓名(?:\*\*|)?\s*[：:]\s*([^\n\r]*)/)
          if (nameMatch && nameMatch[1]) {
            userName = nameMatch[1].trim()
          }
        }
      }
    } catch (e) {
      console.error('[DatabaseService] 获取用户姓名失败:', e)
    }
    return userName
  }

  /**
   * 根据角色 folder_name 获取当前绑定的（或首个人设卡兜底的）用户姓名，未配置时返回 null
   */
  public getUserNameByFolderName(folderName: string | null): string | null {
    if (!folderName) return null
    try {
      const charRow = this.db.prepare('SELECT id FROM Characters WHERE folder_name = ?').get(folderName) as { id: string } | undefined
      if (charRow) {
        return this.getUserNameByCharacterId(charRow.id)
      }
    } catch (e) {
      console.error('[DatabaseService] 根据 folderName 获取用户姓名失败:', e)
    }
    return this.getUserNameByCharacterId(null)
  }

  /**
   * 自动修复/自愈老用户的遗留小说名称，自动更改为当前的命名方式：
   * `<角色名>与<角色当前绑定的用户人设名字> 的故事`
   */
  /**
   * 获取中文小括号的卷册后缀（自愈用）
   */
  private getChineseVolumeSuffix(num: number): string {
    const chineseNums = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十']
    if (num <= 20) {
      return `（卷${chineseNums[num]}）`
    }
    return `（卷${num}）`
  }

  /**
   * 自动修复/自愈老用户的遗留小说名称，自动更改为当前的命名方式：
   * `<用户姓名>与<角色名>（卷二）`
   * 特别防线：若用户自己修改过书名，则予以豁免保护，绝对不覆盖用户自定义标题。
   */
  private autoHealLegacyNovelsTitle(): void {
    try {
      // 检查表是否存在，防止早期初始化冲突
      const hasTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Novels'").get()
      if (!hasTable) return

      const characters = this.db.prepare('SELECT id, name FROM Characters').all() as any[]
      const charMap = new Map<string, string>()
      for (const c of characters) {
        charMap.set(c.id, c.name)
      }

      // 针对每个角色，分别按创建时间排序，重新校准其所有小说标题，防止重名导致卷册混乱
      for (const [characterId, charName] of charMap.entries()) {
        const userName = this.getUserNameByCharacterId(characterId) || '用户'
        const baseTitle = `${userName}与${charName}`

        // 获取该角色的所有小说，按创建时间由早到晚排序
        const novels = this.db.prepare("SELECT * FROM Novels WHERE character_id = ? ORDER BY created_at ASC").all(characterId) as any[]
        if (novels.length === 0) continue

        // 先统计各个标题的出现次数，以判定是否因为旧 Bug 导致了“重名重卷”
        const titleCounts = new Map<string, number>()
        for (const n of novels) {
          const t = n.title || ''
          titleCounts.set(t, (titleCounts.get(t) || 0) + 1)
        }

        for (let i = 0; i < novels.length; i++) {
          const novel = novels[i]

          // 0. 特别防线：若用户自己修改过书名，则予以豁免保护，绝对不覆盖用户自定义标题。
          const isCustomized = this.getSetting(`novel_title_customized_${novel.id}`) === '1'
          if (isCustomized) {
            continue
          }

          const title = novel.title || ''

          // 判定此书是否属于待自愈范围：
          // A. 包含旧版的“的故事”或“_No_”字样。
          // B. 与同角色下的其他小说发生了“完全重名”（说明是由于之前的 Bug 导致的重名，必须重排）。
          const isLegacyFormat = title.includes(' 的故事') || title.includes('_No_')
          const isDuplicate = (titleCounts.get(title) || 0) > 1

          if (isLegacyFormat || isDuplicate) {
            let expectedTitle = baseTitle
            if (i > 0) {
              expectedTitle = `${baseTitle}${this.getChineseVolumeSuffix(i + 1)}`
            }

            if (title !== expectedTitle) {
              console.log(`[Database Auto-heal] 重构校准小说书名 (时间线排第 ${i + 1} 卷): "${title}" -> "${expectedTitle}"`)
              this.db.prepare('UPDATE Novels SET title = ? WHERE id = ?').run(expectedTitle, novel.id)
              // 更新映射计数，确保下一轮循环感知
              titleCounts.set(title, (titleCounts.get(title) || 0) - 1)
            }
          }
        }
      }
    } catch (err) {
      console.error('[Database Auto-heal] 升级老用户小说书名失败:', err)
    }
  }
}

// 导出单例实例
let dbInstance: DatabaseService | null = null

export function getDatabaseService(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService()
  }
  return dbInstance
}

/**
 * 物理重置数据库单例（在导入覆盖数据前，释放文件句柄锁）
 */
export function resetDatabaseService(): void {
  if (dbInstance) {
    try {
      dbInstance.close()
      console.log('[Database] 数据库连接已安全关闭释放')
    } catch (err: any) {
      console.error('[Database] 关闭数据库连接异常:', err.message)
    }
    dbInstance = null
  }
}

