import { reactive, ref, watch } from 'vue'

export interface Song {
  songmid: string
  name: string
  singer: string
  albumName: string
  interval: string
  durationSec: number
  source: string
  img: string
  qualitys: string[]
}

export interface Playlist {
  id: string
  name: string
  created_at: number
}

export interface LyricLine {
  time: number
  text: string
}

export interface Comment {
  id: string
  userName: string
  avatar: string
  content: string
  timeStr: string
  likedCount: number
}

export interface DownloadTask {
  id: string
  songmid: string
  name: string
  singer: string
  albumName: string
  quality: string
  filePath: string
  status: number // 0:下载中, 1:已完成, 2:失败
  progress: number
}

// 封装全局音乐播放 Store (单例)
class MusicPlayerStore {
  public audio: HTMLAudioElement | null = null
  
  // 核心响应式状态
  public state = reactive({
    // 播放器状态
    isPlaying: false,
    currentSong: null as Song | null,
    playQueue: [] as Song[],
    currentQueueIndex: -1,
    currentTime: 0,
    duration: 0,
    volume: 75, // 0 - 100
    loopMode: 'listLoop', // 'listLoop' | 'random' | 'singleLoop'
    quality: '128k', // '128k' | '320k' | 'flac'
    isMuted: false,
    playUrl: '',
    statusText: '', // 状态或错误提示文字，常驻底栏展示
    
    // 歌词与展示
    lyricLines: [] as LyricLine[],
    tlyricLines: [] as LyricLine[], // 翻译歌词
    currentLyricIndex: -1,
    rawLyricText: '',
    
    // 网易云歌曲评论
    comments: [] as Comment[],
    commentsTotal: 0,
    commentsPage: 1,
    commentsLoading: false,

    // 用户自建播放列表与收藏夹
    playlists: [] as Playlist[],
    favoriteSongs: [] as Song[], // 收藏夹 ID 固为 'love'
    currentSelectedPlaylistSongs: [] as Song[],
    activePlaylistId: 'love', // 默认选中收藏列表

    // 桌面歌词与常规设置
    enableDesktopLyric: false,
    isDesktopLyricLocked: true,
    autoSkipOnError: true,
    downloadPath: '',

    // 下载状态列表
    downloadTasks: [] as DownloadTask[]
  })

  constructor() {
    if (typeof window !== 'undefined') {
      this.audio = new Audio()
      this.initAudioListeners()
      this.loadSettings()
      this.loadPersistedQueue()
      this.syncFromDb()
      this.initQueuePersistWatchers()
    }
  }

  // 1. 初始化 HTML5 Audio 的各类监听器
  private initAudioListeners() {
    if (!this.audio) return

    this.audio.volume = this.state.volume / 100

    this.audio.addEventListener('timeupdate', () => {
      if (this.audio) {
        this.state.currentTime = this.audio.currentTime
        this.updateLyricIndex()
      }
    })

    this.audio.addEventListener('durationchange', () => {
      if (this.audio) {
        this.state.duration = this.audio.duration || 0
      }
    })

    this.audio.addEventListener('ended', () => {
      this.playNext(true) // 歌曲自然播放完，根据循环模式跳入下一首
    })

    this.audio.addEventListener('error', (e) => {
      console.error('[Audio Engine] 歌曲播放发生异常，错误信息:', e)
      
      // 物理防呆拦截：如果 currentSong 已经为空（例如用户调用了 stop()），说明这是停播引起的源置空报错，直接拦截
      if (!this.state.currentSong) {
        return
      }

      // 开启了播放错误自动切换下一首
      if (this.state.autoSkipOnError) {
        console.warn('[Audio Engine] 正在尝试进行播放错误换源重试或自动跳过...')
        // 延时 2 秒自动跳过，防止接口连续报错造成死循环
        setTimeout(() => {
          this.playNext(true)
        }, 2000)
      }
    })
  }

  // 2. 从本地 SQLite 数据库中同步数据
  public async syncFromDb() {
    try {
      // 获取用户所有自建播放列表
      const listRes = await (window as any).api.invoke('db-music-get-playlists')
      if (listRes.success) {
        this.state.playlists = listRes.lists
      }

      // 获取“我的收藏”歌曲
      const favRes = await (window as any).api.invoke('db-music-get-songs', 'love')
      if (favRes.success) {
        this.state.favoriteSongs = favRes.songs
      }

      // 刷新当前选中的播放列表歌曲
      this.loadPlaylistSongs(this.state.activePlaylistId)

      // 获取下载任务列表
      const dlRes = await (window as any).api.invoke('db-music-get-downloads')
      if (dlRes.success) {
        this.state.downloadTasks = dlRes.list
      }

      // 同步下载进度的 IPC 监听器
      ;(window as any).api.receive('music-download-progress', (data: { id: string; progress: number; status?: number }) => {
        const task = this.state.downloadTasks.find(t => t.id === data.id)
        if (task) {
          task.progress = data.progress
          if (data.status !== undefined) {
            task.status = data.status
          }
        } else {
          // 刷新列表
          this.refreshDownloadTasks()
        }
      })
    } catch (err) {
      console.error('[Store] 数据库同步异常:', err)
    }
  }

  private async refreshDownloadTasks() {
    const dlRes = await (window as any).api.invoke('db-music-get-downloads')
    if (dlRes.success) {
      this.state.downloadTasks = dlRes.list
    }
  }

  // 3. 读取本地 Settings 中对音质和下载的配置
  private async loadSettings() {
    const quality = localStorage.getItem('music_play_quality') || '128k'
    const autoSkip = localStorage.getItem('music_auto_skip_error') !== 'false'
    const deskLrc = localStorage.getItem('music_enable_desktop_lyric') === 'true'
    
    this.state.quality = quality
    this.state.autoSkipOnError = autoSkip
    this.state.enableDesktopLyric = deskLrc
    
    // 如果开机时开启了桌面歌词
    if (deskLrc) {
      (window as any).api.invoke('lyric-window-toggle', { enable: true })
      const bgColor = localStorage.getItem('music_lyric_bg_color') || 'rgba(15, 23, 42, 0.45)'
      const textColor = localStorage.getItem('music_lyric_text_color') || 'linear-gradient(135deg, #a5b4fc, #818cf8, #6366f1)'
      ;(window as any).api.invoke('lyric-window-update-theme', { bgColor, textColor })
    }

    // 动态获取当前用户本机的物理音乐下载路径
    try {
      const res = await (window as any).api.invoke('music-get-download-path')
      if (res.success && res.path) {
        this.state.downloadPath = res.path
      }
    } catch (e) {
      console.error('[Store] 获取物理下载存储路径异常:', e)
    }
  }

  private loadPersistedQueue() {
    try {
      const queueStr = localStorage.getItem('music_play_queue')
      const indexStr = localStorage.getItem('music_current_queue_index')
      const songStr = localStorage.getItem('music_current_song')

      if (queueStr) {
        this.state.playQueue = JSON.parse(queueStr)
      }
      if (indexStr) {
        this.state.currentQueueIndex = parseInt(indexStr, 10)
      }
      if (songStr) {
        this.state.currentSong = JSON.parse(songStr)
      }
      
      // 恢复音频就绪（不发声）
      if (this.state.currentSong && this.audio) {
        (window as any).api.invoke('get-music-url', {
          songmid: this.state.currentSong.songmid,
          name: this.state.currentSong.name,
          singer: this.state.currentSong.singer,
          durationSec: this.state.currentSong.durationSec || 240,
          quality: this.state.quality,
          source: this.state.currentSong.source || 'wy'
        }).then((res: any) => {
          if (res.success && res.url && this.audio) {
            this.state.playUrl = res.url
            this.audio.src = res.url
          }
        }).catch(() => {})
      }
    } catch (e) {
      console.error('[Store] 恢复播放队列持久化数据失败:', e)
    }
  }

  private initQueuePersistWatchers() {
    watch(
      () => this.state.playQueue,
      (newQueue) => {
        localStorage.setItem('music_play_queue', JSON.stringify(newQueue))
      },
      { deep: true }
    )

    watch(
      () => this.state.currentQueueIndex,
      (newIdx) => {
        localStorage.setItem('music_current_queue_index', String(newIdx))
      }
    )

    watch(
      () => this.state.currentSong,
      (newSong) => {
        localStorage.setItem('music_current_song', newSong ? JSON.stringify(newSong) : '')
      }
    )
  }

  // 4. 音乐播放与暂停控制核心
  public async playSong(song: Song, customQueue?: Song[]) {
    if (!this.audio) return

    try {
      this.state.currentSong = song
      this.state.isPlaying = false
      this.state.currentTime = 0
      this.state.duration = 0
      this.state.statusText = '' // 播放前重置错误信息

      // 如果有传入的自定义队列，重置播放队列
      if (customQueue && customQueue.length > 0) {
        this.state.playQueue = [...customQueue]
      } else {
        // 如果队列中不存在这首歌，追加进去
        if (!this.state.playQueue.some(s => s.songmid === song.songmid)) {
          this.state.playQueue.push(song)
        }
      }

      this.state.currentQueueIndex = this.state.playQueue.findIndex(s => s.songmid === song.songmid)

      // A. 请求直链链接 (包含自动换源机制)
      const res = await (window as any).api.invoke('get-music-url', {
        songmid: song.songmid,
        name: song.name,
        singer: song.singer,
        durationSec: song.durationSec || 240,
        quality: this.state.quality,
        source: song.source || 'wy'
      })

      if (res.success && res.url) {
        this.state.playUrl = res.url
        this.state.statusText = '' // 清空错误提示
        this.audio.src = res.url
        this.audio.play()
        this.state.isPlaying = true
        
        // B. 同步抓取歌词
        this.fetchLyric(song.songmid)

        // C. 同步抓取网易云评论
        this.state.commentsPage = 1
        this.fetchComments(song.songmid)
      } else {
        this.state.statusText = res.error || '解析播放链接失败，请重试'
        this.state.isPlaying = false
      }
    } catch (err: any) {
      console.error('[Store] 播放歌曲异常:', err.message)
      this.state.statusText = err.message || '播放歌曲发生未知异常'
      this.state.isPlaying = false
    }
  }

  // 暂停与继续播放
  public togglePlay() {
    if (!this.audio || !this.state.currentSong) return
    if (this.state.isPlaying) {
      this.audio.pause()
      this.state.isPlaying = false
    } else {
      this.audio.play()
      this.state.isPlaying = true
    }
  }

  // 停止播放
  public stop() {
    if (this.audio) {
      this.audio.pause()
      this.audio.src = ''
    }
    this.state.isPlaying = false
    this.state.currentSong = null
    this.state.currentTime = 0
    this.state.duration = 0
    this.state.lyricLines = []
    this.state.currentLyricIndex = -1
    this.updateDesktopLyric('')
    
    // 如果桌面歌词窗口是开启状态，也将其物理关闭，并重置其状态
    if (this.state.enableDesktopLyric) {
      this.state.enableDesktopLyric = false
      localStorage.setItem('music_enable_desktop_lyric', 'false')
      ;(window as any).api.invoke('lyric-window-toggle', { enable: false })
    }
  }

  // 调节音量 (0 - 100)
  public setVolume(v: number) {
    this.state.volume = v
    if (this.audio) {
      this.audio.volume = v / 100
    }
    if (v > 0) {
      this.state.isMuted = false
    }
  }

  // 静音切换
  public toggleMute() {
    this.state.isMuted = !this.state.isMuted
    if (this.audio) {
      this.audio.volume = this.state.isMuted ? 0 : this.state.volume / 100
    }
  }

  // 品质切换并无缝重新播放
  public setQuality(q: string) {
    this.state.quality = q
    localStorage.setItem('music_play_quality', q)
    
    // 如果正在播放歌曲，重新解析链接并无缝接轨播放
    if (this.state.currentSong && this.state.isPlaying) {
      const curTime = this.state.currentTime
      this.playSong(this.state.currentSong).then(() => {
        if (this.audio) {
          this.audio.currentTime = curTime
        }
      })
    }
  }

  // ====== 循环模式与切歌算法 ======
  public playNext(isAuto: boolean = false) {
    // 物理防呆拦截：若在自动跳歌时 currentSong 已被彻底停播置空，说明处于主动停播状态，直接拦截切歌
    if (isAuto && !this.state.currentSong) return

    if (this.state.playQueue.length === 0) return

    let nextIndex = this.state.currentQueueIndex
    const len = this.state.playQueue.length

    if (this.state.loopMode === 'singleLoop' && isAuto) {
      // 单曲循环且是自动播放完，不改变 index
    } else if (this.state.loopMode === 'random') {
      nextIndex = Math.floor(Math.random() * len)
    } else {
      // 顺序播放或列表循环
      nextIndex = (this.state.currentQueueIndex + 1) % len
    }

    this.state.currentQueueIndex = nextIndex
    const nextSong = this.state.playQueue[nextIndex]
    if (nextSong) {
      this.playSong(nextSong)
    }
  }

  public playPrev() {
    if (this.state.playQueue.length === 0) return

    let prevIndex = this.state.currentQueueIndex
    const len = this.state.playQueue.length

    if (this.state.loopMode === 'random') {
      prevIndex = Math.floor(Math.random() * len)
    } else {
      prevIndex = (this.state.currentQueueIndex - 1 + len) % len
    }

    this.state.currentQueueIndex = prevIndex
    const prevSong = this.state.playQueue[prevIndex]
    if (prevSong) {
      this.playSong(prevSong)
    }
  }

  // ====== 歌词获取与精细解析 ======
  private async fetchLyric(songmid: string) {
    try {
      this.state.lyricLines = []
      this.state.tlyricLines = []
      this.state.currentLyricIndex = -1
      
      const res = await (window as any).api.invoke('wy-get-lyric', songmid)
      if (res.success && res.lyric) {
        this.state.rawLyricText = res.lyric
        this.state.lyricLines = this.parseLrc(res.lyric)
        if (res.tlyric) {
          this.state.tlyricLines = this.parseLrc(res.tlyric)
        }
      } else {
        this.state.rawLyricText = ''
        this.state.lyricLines = [{ time: 0, text: '回音音乐 - 暂无歌词' }]
      }
    } catch (_) {
      this.state.lyricLines = [{ time: 0, text: '歌词加载异常' }]
    }
  }

  // 纯 JS/TS 时间戳歌词行解析器
  private parseLrc(lrcText: string): LyricLine[] {
    const lines = lrcText.split('\n')
    const result: LyricLine[] = []
    const timeExp = /\[(\d+):(\d+)(?:\.(\d+))?\]/g

    for (let line of lines) {
      line = line.trim()
      if (!line) continue

      // 一行歌词可能包含多个时间戳，例如 [00:12.34][01:23.45]歌词
      const matches = line.match(/\[\d+:\d+(?:\.\d+)?\]/g)
      const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim()
      
      if (matches) {
        for (const match of matches) {
          const timeResult = timeExp.exec(match)
          timeExp.lastIndex = 0 // 重置正则偏移量
          if (timeResult) {
            const min = parseInt(timeResult[1])
            const sec = parseInt(timeResult[2])
            const ms = timeResult[3] ? parseInt(timeResult[3].padEnd(3, '0').substring(0, 3)) : 0
            const totalSec = min * 60 + sec + ms / 1000
            result.push({ time: totalSec, text })
          }
        }
      }
    }

    // 必须按照时间先后进行升序排序，以防有些原词顺序错乱
    return result.sort((a, b) => a.time - b.time)
  }

  // 毫秒级匹配计算出当前处于哪一句话
  private updateLyricIndex() {
    if (this.state.lyricLines.length === 0) return

    const curTime = this.state.currentTime
    let index = -1

    for (let i = 0; i < this.state.lyricLines.length; i++) {
      if (curTime >= this.state.lyricLines[i].time) {
        index = i
      } else {
        break
      }
    }

    if (index !== this.state.currentLyricIndex) {
      this.state.currentLyricIndex = index
      const curLrc = this.state.lyricLines[index]?.text || ''
      this.updateDesktopLyric(curLrc)
    }
  }

  // ====== 桌面歌词同步渲染 ======
  private updateDesktopLyric(text: string) {
    if (this.state.enableDesktopLyric) {
      (window as any).api.invoke('lyric-window-update', text)
    }
  }

  public toggleDesktopLyric() {
    this.state.enableDesktopLyric = !this.state.enableDesktopLyric
    localStorage.setItem('music_enable_desktop_lyric', String(this.state.enableDesktopLyric))
    
    ;(window as any).api.invoke('lyric-window-toggle', {
      enable: this.state.enableDesktopLyric,
      lyricText: this.state.currentSong ? (this.state.lyricLines[this.state.currentLyricIndex]?.text || '') : '回音音乐 - 聆听世界'
    })

    if (this.state.enableDesktopLyric) {
      const bgColor = localStorage.getItem('music_lyric_bg_color') || 'rgba(15, 23, 42, 0.45)'
      const textColor = localStorage.getItem('music_lyric_text_color') || 'linear-gradient(135deg, #a5b4fc, #818cf8, #6366f1)'
      ;(window as any).api.invoke('lyric-window-update-theme', { bgColor, textColor })
    }
  }

  // ====== 抓取网易云评论列表 ======
  public async fetchComments(songmid: string, loadMore = false) {
    if (this.state.commentsLoading) return
    this.state.commentsLoading = true
    try {
      const res = await (window as any).api.invoke('wy-get-comments', {
        songmid,
        page: this.state.commentsPage,
        limit: 20
      })
      if (res.success) {
        if (loadMore) {
          this.state.comments.push(...res.comments)
        } else {
          this.state.comments = res.comments
        }
        this.state.commentsTotal = res.total
      }
    } catch (_) {
    } finally {
      this.state.commentsLoading = false
    }
  }

  public loadMoreComments() {
    if (!this.state.currentSong) return
    this.state.commentsPage += 1
    this.fetchComments(this.state.currentSong.songmid, true)
  }

  // ====== 播放列表与歌曲收藏本地存储 CRUD 触发 ======
  public async createPlaylist(name: string) {
    const res = await (window as any).api.invoke('db-music-create-playlist', name)
    if (res.success) {
      await this.syncFromDb()
    }
  }

  public async deletePlaylist(id: string) {
    const res = await (window as any).api.invoke('db-music-delete-playlist', id)
    if (res.success) {
      if (this.state.activePlaylistId === id) {
        this.state.activePlaylistId = 'love'
      }
      await this.syncFromDb()
    }
  }

  public async loadPlaylistSongs(playlistId: string) {
    this.state.activePlaylistId = playlistId
    const res = await (window as any).api.invoke('db-music-get-songs', playlistId)
    if (res.success) {
      this.state.currentSelectedPlaylistSongs = res.songs
    }
  }

  // 点亮红心 (收藏 / 取消收藏)
  public async toggleFavorite(song: Song) {
    if (!song) return
    try {
      const songmidStr = String(song.songmid)
      const isFav = this.state.favoriteSongs.some(s => String(s.songmid) === songmidStr)
      if (isFav) {
        // 从收藏夹移除
        await (window as any).api.invoke('db-music-remove-song', {
          playlist_id: 'love',
          songmid: song.songmid,
          source: song.source || 'wy'
        })
      } else {
        // 添加到收藏夹
        // 关键：song 可能是 Vue reactive Proxy，qualitys 是 Proxy 数组，
        // Electron Structured Clone 无法序列化 Proxy，必须用展开运算符创建普通值
        const res = await (window as any).api.invoke('db-music-add-song', {
          playlist_id: 'love',
          songmid: String(song.songmid || ''),
          name: String(song.name || '未知歌曲'),
          singer: String(song.singer || '群星'),
          albumName: String(song.albumName || ''),
          interval: String(song.interval || '00:00'),
          source: String(song.source || 'wy'),
          qualitys: song.qualitys ? [...song.qualitys] : ['128k'], // 展开 Proxy 数组为普通数组
          img: String(song.img || '')
        })
        if (!res || !res.success) {
          throw new Error(res?.error || '收藏写入数据库失败，请重试')
        }
      }
      await this.syncFromDb()
    } catch (e: any) {
      console.error('[Store] 收藏/取消收藏失败:', e)
      this.state.statusText = `❤️ 收藏失败: ${e.message || '请重试'}`
    }
  }

  public isFavorited(songmid: string | number): boolean {
    return this.state.favoriteSongs.some(s => String(s.songmid) === String(songmid))
  }

  // 添加到自建列表（加入空值防御 + IPC 返回值校验）
  public async addSongToCustomPlaylist(playlistId: string, song: Song) {
    if (!song) return
    // 关键：song 可能是 Vue reactive Proxy，qualitys 是 Proxy 数组，
    // Electron Structured Clone 无法序列化 Proxy，必须展开为普通值
    const res = await (window as any).api.invoke('db-music-add-song', {
      playlist_id: String(playlistId || ''),
      songmid: String(song.songmid || ''),
      name: String(song.name || '未知歌曲'),
      singer: String(song.singer || '群星'),
      albumName: String(song.albumName || ''),
      interval: String(song.interval || '00:00'),
      source: String(song.source || 'wy'),
      qualitys: song.qualitys ? [...song.qualitys] : ['128k'], // 展开 Proxy 数组为普通数组
      img: String(song.img || '')
    })
    // 检查主进程返回值，失败时抛出异常让调用层感知
    if (!res || !res.success) {
      throw new Error(res?.error || '添加到播放列表失败，请重试')
    }
    await this.syncFromDb()
  }

  // 从特定列表中移除歌曲
  public async removeSongFromPlaylist(playlistId: string, songmid: string, source: string) {
    await (window as any).api.invoke('db-music-remove-song', {
      playlist_id: playlistId,
      songmid,
      source
    })
    await this.syncFromDb()
  }

  // ====== 音乐物理下载与进度追踪 ======
  public async downloadSong(song: Song) {
    try {
      // 首先获取该品质下的下载链接 (不让自动换源，优先网易云，若下架则在主进程自动换源)
      const resUrl = await (window as any).api.invoke('get-music-url', {
        songmid: song.songmid,
        name: song.name,
        singer: song.singer,
        durationSec: song.durationSec || 240,
        quality: this.state.quality,
        source: song.source || 'wy'
      })

      if (!resUrl.success || !resUrl.url) {
        alert('无法获取该歌曲的下载播放链接')
        return
      }

      // 获取下歌词用于物理写入
      let lyricText = ''
      const lrcRes = await (window as any).api.invoke('wy-get-lyric', song.songmid)
      if (lrcRes.success && lrcRes.lyric) {
        lyricText = lrcRes.lyric
      }

      // 调用主进程发起流式下载
      const dlRes = await (window as any).api.invoke('music-download-song', {
        songmid: song.songmid,
        name: song.name,
        singer: song.singer,
        albumName: song.albumName,
        quality: this.state.quality,
        durationSec: song.durationSec || 240,
        imgUrl: song.img,
        lyricText,
        playUrl: resUrl.url
      })

      if (dlRes.success) {
        await this.syncFromDb()
      } else {
        alert(dlRes.error || '加入下载任务失败')
      }
    } catch (err: any) {
      console.error('[Store] 下载任务异常:', err.message)
    }
  }

  // 打开本地文件夹
  public openDownloadFolder(pathStr: string) {
    (window as any).api.invoke('music-open-folder', pathStr)
  }

  // 物理删除下载记录
  public async deleteDownloadTask(id: string) {
    await (window as any).api.invoke('db-music-delete-download', id)
    await this.syncFromDb()
  }
}

// 导出单例实例
export const musicPlayerStore = new MusicPlayerStore()
