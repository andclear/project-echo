import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

export class DatabaseService {
  public db: Database.Database
  private onMessageSavedCallback: ((msg: any) => void) | null = null

  public registerOnMessageSaved(callback: (msg: any) => void): void {
    this.onMessageSavedCallback = callback
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
        created_at INTEGER NOT NULL
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS GroupMembers (
        group_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        PRIMARY KEY (group_id, character_id)
      );
    `)

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
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO Messages (id, character_id, role, content, timestamp, token_usage, prompt_tokens, completion_tokens, cached_tokens, sender_id, is_proactive)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      msg.id,
      msg.character_id,
      msg.role,
      msg.content,
      msg.timestamp,
      msg.token_usage,
      msg.prompt_tokens !== undefined ? msg.prompt_tokens : null,
      msg.completion_tokens !== undefined ? msg.completion_tokens : null,
      msg.cached_tokens !== undefined ? msg.cached_tokens : null,
      msg.sender_id !== undefined ? msg.sender_id : null,
      msg.is_proactive !== undefined ? msg.is_proactive : 0
    )

    if (this.onMessageSavedCallback) {
      try {
        this.onMessageSavedCallback(msg)
      } catch (err) {
        console.error('[DatabaseService] 触发 saveMessage 回调异常:', err)
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
  }

  /**
   * 按关键词搜索特定角色的所有聊天历史（全文匹配）
   */
  public searchChatHistory(characterId: string, keyword: string, limit: number = 200): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM Messages
      WHERE character_id = ? AND content LIKE ?
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

