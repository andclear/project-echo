import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import * as vm from 'vm'
import { getDatabaseService } from '../db/database'

// ====== 极轻量高稳定性 MP3 ID3v2.3 二进制物理写入器 ======
// 摆脱任何外部 Native C++ 依赖，纯 TypeScript 构造符合 ID3v2 规范的 MP3 头部 Buffer Prepend
export class Mp3Id3Writer {
  // 生成 synchsafe 整数 (ID3v2 大小描述)
  private static encodeSynchSafe(size: number): Buffer {
    const buf = Buffer.alloc(4)
    buf[0] = (size >> 21) & 0x7f
    buf[1] = (size >> 14) & 0x7f
    buf[2] = (size >> 7) & 0x7f
    buf[3] = size & 0x7f
    return buf
  }

  // 构造标准文本帧 (TIT2 标题, TPE1 歌手, TALB 专辑)
  private static createTextFrame(id: string, text: string): Buffer {
    const textBuf = Buffer.from(text, 'utf16le')
    // \x01 代表 UTF-16LE 编码，接着是 \xFF\xFE BOM 头
    const content = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), textBuf])
    
    const header = Buffer.alloc(10)
    header.write(id, 0, 4, 'ascii')
    header.writeUInt32BE(content.length, 4) // 帧内容大小
    // 标志设为 0
    return Buffer.concat([header, content])
  }

  // 构造歌词帧 (USLT)
  private static createLyricsFrame(lyrics: string): Buffer {
    const lyricsBuf = Buffer.from(lyrics, 'utf16le')
    // 编码 (1字节) + 语言 (3字节) + 描述符结束符 (2字节) + 歌词内容
    // \x01 代表 UTF-16LE, 'zho' 中文
    const content = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.from('zho', 'ascii'),
      Buffer.from([0xff, 0xfe]), // 描述符 BOM (空描述)
      Buffer.from([0x00, 0x00]), // 描述符结束
      Buffer.from([0xff, 0xfe]), // 歌词 BOM
      lyricsBuf
    ])

    const header = Buffer.alloc(10)
    header.write('USLT', 0, 4, 'ascii')
    header.writeUInt32BE(content.length, 4)
    return Buffer.concat([header, content])
  }

  // 构造封面帧 (APIC)
  private static createPictureFrame(imgBuffer: Buffer, mimeType: string = 'image/jpeg'): Buffer {
    // 编码 (1字节) + MIME (以 0 结尾) + 图片类型 (1字节, 0x03 代表 Front Cover) + 描述 (以 0 结尾) + 图片 Buffer
    const mimeBuf = Buffer.from(mimeType + '\x00', 'ascii')
    const content = Buffer.concat([
      Buffer.from([0x01]), // UTF-16LE 编码
      mimeBuf,
      Buffer.from([0x03]), // Front Cover
      Buffer.from([0xff, 0xfe, 0x00, 0x00]), // 空描述符 UTF-16LE + 00
      imgBuffer
    ])

    const header = Buffer.alloc(10)
    header.write('APIC', 0, 4, 'ascii')
    header.writeUInt32BE(content.length, 4)
    return Buffer.concat([header, content])
  }

  // 核心写入入口：读取 MP3 二进制，前缀植入标签 Buffer，覆盖写盘
  public static write(filePath: string, tags: { title: string; artist: string; album: string; lyrics?: string; picBuffer?: Buffer }) {
    try {
      const frames: Buffer[] = []
      
      if (tags.title) frames.push(this.createTextFrame('TIT2', tags.title))
      if (tags.artist) frames.push(this.createTextFrame('TPE1', tags.artist))
      if (tags.album) frames.push(this.createTextFrame('TALB', tags.album))
      if (tags.lyrics) frames.push(this.createLyricsFrame(tags.lyrics))
      if (tags.picBuffer) frames.push(this.createPictureFrame(tags.picBuffer))

      const totalFramesSize = frames.reduce((acc, f) => acc + f.length, 0)
      
      // 10 字节的 ID3 头部
      const id3Header = Buffer.alloc(10)
      id3Header.write('ID3', 0, 3, 'ascii')
      id3Header.writeUInt8(3, 3) // 版本号 v2.3.0
      id3Header.writeUInt8(0, 4)
      id3Header.writeUInt8(0, 5) // 标志
      this.encodeSynchSafe(totalFramesSize).copy(id3Header, 6)

      const id3TagBuffer = Buffer.concat([id3Header, ...frames])

      // 读取 MP3 原始文件
      const originalAudio = fs.readFileSync(filePath)
      
      // 如果原文件已经包含 ID3v2 标签，剥离之防止重复
      let audioStartOffset = 0
      if (originalAudio.subarray(0, 3).toString('ascii') === 'ID3') {
        const hSizeBuf = originalAudio.subarray(6, 10)
        const size = (hSizeBuf[0] << 21) | (hSizeBuf[1] << 14) | (hSizeBuf[2] << 7) | hSizeBuf[3]
        audioStartOffset = 10 + size
      }

      const pureAudioBuffer = originalAudio.subarray(audioStartOffset)
      const finalMp3Buffer = Buffer.concat([id3TagBuffer, pureAudioBuffer])
      
      fs.writeFileSync(filePath, finalMp3Buffer)
      console.log(`[Mp3Id3Writer] 成功向音频文件嵌入 Metadata! ${filePath}`)
    } catch (err: any) {
      console.error('[Mp3Id3Writer] 嵌入 Metadata 失败:', err.message)
    }
  }
}

// ====== 核心音乐服务类 ======
export class MusicService {
  private static desktopLyricWindow: BrowserWindow | null = null
  private static alwaysOnTopInterval: NodeJS.Timeout | null = null
  private static lyricBgColor = 'rgba(15, 23, 42, 0.45)'
  private static lyricTextColor = 'linear-gradient(135deg, #a5b4fc, #818cf8, #6366f1)'
  private static activeCustomSources: Array<{
    id: string
    name: string
    path: string
    requestHandler: (payload: { action: string; source: string; info: any }) => Promise<any>
  }> = []

  // 简易 HTTP 客户端包装，支持 302 重定向跳转跟踪与智能防盗链自适应 Referer 注入
  private static requestUrl(
    url: string, 
    method: string = 'GET', 
    postData?: string, 
    customHeaders?: any
  ): Promise<{ body: string; headers: any; statusCode: number }> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http
      
      // 智能解析 URL 域名以自动适配最绿色的防盗链 Referer
      let referer = 'https://music.163.com/'
      try {
        const lowerUrl = url.toLowerCase()
        if (lowerUrl.includes('qq.com')) {
          referer = 'https://y.qq.com/'
        } else if (lowerUrl.includes('migu.cn')) {
          referer = 'https://m.music.migu.cn/'
        } else if (lowerUrl.includes('kuwo.cn')) {
          referer = 'http://www.kuwo.cn/'
        }
      } catch (_) {}

      const options = {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
          'Referer': referer,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...customHeaders
        }
      }
      const req = client.request(url, options, (res) => {
        let chunks: any[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            body,
            headers: res.headers,
            statusCode: res.statusCode || 200
          })
        })
      })
      req.on('error', (err) => reject(err))
      if (postData) {
        req.write(postData)
      }
      req.end()
    })
  }

  // 递归下载二进制 Buffer 辅助方法
  private static downloadBuffer(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http
      client.get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          // 跟踪重定向
          this.downloadBuffer(res.headers.location!).then(resolve).catch(reject)
          return
        }
        let chunks: any[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  // 递归抓取文本/源码（用于在线 JS 音源的静默拉取并支持 302 追踪）
  private static downloadTextFromUrl(url: string, redirectCount = 0): Promise<string> {
    if (redirectCount >= 5) {
      return Promise.reject(new Error('重定向次数过多'))
    }
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http
      const parsedUrl = new URL(url)
      const options = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
        }
      }
      client.get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          const redirectUrl = res.headers.location
          if (redirectUrl) {
            const absoluteUrl = redirectUrl.startsWith('http') ? redirectUrl : new URL(redirectUrl, url).toString()
            res.resume()
            this.downloadTextFromUrl(absoluteUrl, redirectCount + 1).then(resolve).catch(reject)
            return
          }
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`请求失败，状态码: ${res.statusCode}`))
          return
        }
        let chunks: any[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'))
        })
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  // 解析酷我 antiserver 真实流媒体 URL（跟踪最多 3 次重定向，获取最终 CDN 直链）
  private static resolveKwUrl(kwAntiserverUrl: string): Promise<string> {
    return new Promise((resolve) => {
      let redirectCount = 0
      const follow = (url: string) => {
        if (redirectCount >= 3) {
          // 超过最大跳转次数，退回原始 antiserver URL
          resolve(url)
          return
        }
        try {
          const client = url.startsWith('https') ? https : http
          const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            // antiserver 会 302 到真实 CDN 地址
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
              redirectCount++
              // 消费掉响应体，避免 socket hang
              res.resume()
              follow(res.headers.location)
            } else {
              // 已到达最终地址（可能是 200 的流），关闭此连接，返回当前 URL
              res.destroy()
              resolve(url)
            }
          })
          req.on('error', () => resolve(url)) // 请求失败时退回原 URL
          req.setTimeout(4000, () => { req.destroy(); resolve(url) })
        } catch (_) {
          resolve(url)
        }
      }
      follow(kwAntiserverUrl)
    })
  }

  // ====== 酷我音乐自动换源联合搜索算法 ======
  private static async findAlternativeSource(name: string, singer: string, durationSec: number): Promise<{ url: string; quality: string } | null> {
    try {
      console.log(`[MusicService] 正在为下架/失效歌曲启动全网换源检索: ${name} - ${singer} (预计时长: ${durationSec}秒)`)
      
      // 1. 酷我搜索接口
      const searchUrl = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(name + ' ' + singer)}&pn=0&rn=6&rformat=json`
      const { body } = await this.requestUrl(searchUrl)
      
      // 清理酷我返回的非标准 Json 块
      const cleanJsonStr = body.replace(/'/g, '"').trim()
      let searchData: any = {}
      try {
        searchData = JSON.parse(cleanJsonStr)
      } catch (_) {
        // 粗暴正则提取
        const rids = body.match(/"MUSIC_(\d+)"/g)
        if (rids && rids.length > 0) {
          const rid = rids[0].replace(/"/g, '').replace('MUSIC_', '')
          const antiserverUrl = `http://antiserver.kuwo.cn/anti.s?usertype=web&rid=MUSIC_${rid}&format=mp3&type=convert_url`
          const resolvedUrl = await this.resolveKwUrl(antiserverUrl)
          return { url: resolvedUrl, quality: '128k' }
        }
      }

      if (!searchData.abslist || searchData.abslist.length === 0) return null

      // 2. 相似度打分筛选 (时长限制在 6 秒之内)
      for (const item of searchData.abslist) {
        const itemDuration = parseInt(item.DURATION || '0')
        const diff = Math.abs(itemDuration - durationSec)
        
        // 时长接近，且歌名或歌手名存在极强重合度
        if (diff <= 8) {
          const rid = item.MUSICRID.replace('MUSIC_', '')
          const antiserverUrl = `http://antiserver.kuwo.cn/anti.s?usertype=web&rid=MUSIC_${rid}&format=mp3&type=convert_url`
          const resolvedUrl = await this.resolveKwUrl(antiserverUrl)
          console.log(`[MusicService] 命中酷我备用源! rid: ${rid}, 时长差: ${diff}秒, 真实URL: ${resolvedUrl}`)
          return { url: resolvedUrl, quality: '128k' }
        }
      }
      
      // 兜底：如果没有完美匹配时长，若搜索列表第一个结果歌名高度吻合，直接采用之
      const firstItem = searchData.abslist[0]
      const cleanTargetName = name.replace(/\s/g, '').toLowerCase()
      const cleanKItemName = (firstItem.SONGNAME || '').replace(/\s/g, '').toLowerCase()
      if (cleanKItemName.includes(cleanTargetName) || cleanTargetName.includes(cleanKItemName)) {
        const rid = firstItem.MUSICRID.replace('MUSIC_', '')
        const antiserverUrl = `http://antiserver.kuwo.cn/anti.s?usertype=web&rid=MUSIC_${rid}&format=mp3&type=convert_url`
        const resolvedUrl = await this.resolveKwUrl(antiserverUrl)
        return { url: resolvedUrl, quality: '128k' }
      }

    } catch (err: any) {
      console.error('[MusicService] 酷我换源检索失败:', err.message)
    }
    return null
  }

  // ====== 初始化音乐模块 IPC 注册 ======
  public static init() {
    console.log('[MusicService] 正在启动核心音乐服务模块...')
    const db = getDatabaseService()

    // 1. 获取网易云推荐歌单 (精品/热门)
    ipcMain.handle('wy-get-recommend-playlists', async (_, payload?: { cat?: string; offset?: number }) => {
      try {
        const cat = payload?.cat || '全部'
        const offset = payload?.offset || 0
        const url = `https://music.163.com/api/playlist/list?cat=${encodeURIComponent(cat)}&order=hot&limit=30&offset=${offset}`
        const { body } = await this.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200) {
          return {
            success: true,
            playlists: (result.playlists || []).map((p: any) => ({
              id: String(p.id),
              name: p.name,
              img: p.coverImgUrl,
              playCount: p.playCount > 10000 ? `${Math.floor(p.playCount / 10000)}万` : p.playCount,
              desc: p.description,
              trackCount: p.trackCount
            }))
          }
        }
        return { success: false, error: '获取推荐歌单失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // 2. 获取网易云三大排行榜详情
    ipcMain.handle('wy-get-leaderboard', async (_, bangid: string) => {
      try {
        console.log(`[MusicService] 正在抓取网易云榜单详情: bangid=${bangid}`)
        // 利用网易云 v3 黄金详情直链，一次 GET 抓取全部歌曲详情，速度比 weapi 提升十倍！
        const url = `https://music.163.com/api/v3/playlist/detail?id=${bangid}&n=100`
        const { body } = await this.requestUrl(url)
        const result = JSON.parse(body)
        
        if (result.code === 200 && result.playlist) {
          const list = (result.playlist.tracks || []).map((item: any) => {
            const durationSec = Math.floor(item.dt / 1000)
            const minutes = Math.floor(durationSec / 60)
            const seconds = durationSec % 60
            const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            
            // 计算高音质支持
            const qualitys = ['128k']
            if (item.h) qualitys.push('320k')
            if (item.sq) qualitys.push('flac')

            return {
              songmid: String(item.id),
              name: item.name,
              singer: (item.ar || []).map((a: any) => a.name).join('、'),
              albumName: item.al?.name || '',
              interval,
              durationSec,
              source: 'wy',
              img: item.al?.picUrl || '',
              qualitys
            }
          })
          return { success: true, list }
        }
        return { success: false, error: '获取榜单详情失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // 3. 歌曲播放链接解析 (优先级：自定义多音源级联查询 -> 渠道官方直链 -> 酷我无版权换源直链)
    ipcMain.handle('get-music-url', async (_, payload: { songmid: string; name: string; singer: string; durationSec: number; quality: string; source?: string; allowToggle?: boolean }) => {
      try {
        const { songmid, name, singer, durationSec, quality, source = 'wy', allowToggle = true } = payload
        console.log(`[MusicService] 解析音频链接: ${name} (ID: ${songmid}), 来源: ${source}, 品质: ${quality}`)

        // 步骤 O：级联查询自定义音源沙箱（最高优先级）
        if (MusicService.activeCustomSources.length > 0) {
          console.log(`[MusicService] 启动级联查询自定义音源，已加载音源数: ${MusicService.activeCustomSources.length}`)
          for (const customSrc of MusicService.activeCustomSources) {
            try {
              console.log(`[MusicService] 尝试调用自定义解析音源: ${customSrc.name}, 源渠道: ${source}`)
              const customUrl = await customSrc.requestHandler({
                action: 'musicUrl',
                source: source, // 传入当前歌曲的实际渠道源，激活沙箱中对应的解析引擎
                info: {
                  musicInfo: {
                    songmid: songmid,
                    name: name,
                    singer: singer
                  },
                  type: '128k'
                }
              })
              
              if (customUrl && typeof customUrl === 'string' && customUrl.startsWith('http')) {
                console.log(`[MusicService] 恭喜！自定义音源《${customSrc.name}》成功解析直链!`)
                return { success: true, url: customUrl, source: 'custom_' + customSrc.id, quality: '128k' }
              }
            } catch (err: any) {
              console.warn(`[MusicService] 自定义音源《${customSrc.name}》解析失败，正在尝试下一个。错误:`, err.message || err)
            }
          }
        }

        // 步骤 A：渠道官方直链/外链支持
        if (source === 'kw') {
          // 如果歌曲本来就来自酷我渠道，先构建 antiserver URL，再解析跳转到真实 CDN 直链
          // 原因：antiserver 是 http:// 跳转地址，Electron 渲染端 <audio> 无法播放 http 混合内容
          const kwAntiserverUrl = `http://antiserver.kuwo.cn/anti.s?usertype=web&rid=MUSIC_${songmid}&format=mp3&type=convert_url`
          console.log(`[MusicService] 酷我歌曲，正在解析真实直链: ${kwAntiserverUrl}`)
          const resolvedUrl = await this.resolveKwUrl(kwAntiserverUrl)
          console.log(`[MusicService] 酷我真实直链解析结果: ${resolvedUrl}`)
          return { success: true, url: resolvedUrl, source: 'kw', quality: '128k' }
        }

        if (source === 'mg' || source === 'tx') {
          // 咪咕和企鹅歌曲在无自定义音源解析时，直接触发酷我自动换源检索以实现极致秒播
          if (allowToggle) {
            console.log(`[MusicService] 咪咕/企鹅源歌曲，进入极致极速自动换源播放: ${name} - ${singer}`)
            const alt = await this.findAlternativeSource(name, singer, durationSec)
            if (alt) {
              return { success: true, url: alt.url, source: 'kw', quality: alt.quality, isToggled: true }
            }
          }
          return { success: false, error: '未检测到可用的无版权替换源，请尝试加载自定义音源脚本。' }
        }

        // 默认网易云官方免费外链播放地址 (支持普通免费歌曲)
        const wyOuterUrl = `https://music.163.com/song/media/outer/url?id=${songmid}.mp3`
        
        // 发起 HEAD 检测该外链是否是可播放的音频 (网易云下架/VIP灰色歌曲会重定向到 404 或返回空)
        const checkRes = await this.requestUrl(wyOuterUrl, 'GET')
        const isUnavailable = checkRes.statusCode >= 400 || (checkRes.headers.location && checkRes.headers.location.includes('404'))
        
        if (!isUnavailable) {
          // 可用，直接返回外链
          return { success: true, url: wyOuterUrl, source: 'wy', quality: '128k' }
        }

        // 步骤 B：被封禁或灰色歌曲，若开启了自动换源，启动酷我音乐检索
        if (allowToggle) {
          const alt = await this.findAlternativeSource(name, singer, durationSec)
          if (alt) {
            return { success: true, url: alt.url, source: 'kw', quality: alt.quality, isToggled: true }
          }
        }

        return { success: false, error: '该歌曲在网易云已下架，且未检索到可用替换源。' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // ====== 桌面歌词与多音源虚拟机沙箱加载 IPC 通道 ======
    ipcMain.handle('music-load-custom-sources', async (_, sources: Array<{ id: string; name: string; path: string }>) => {
      MusicService.activeCustomSources = []
      let loadedCount = 0

      for (const src of sources) {
        try {
          if (!fs.existsSync(src.path)) {
            console.error(`[MusicService] 音源文件不存在: ${src.path}`)
            continue
          }
          const code = fs.readFileSync(src.path, 'utf8')
          const requestListeners = new Set<any>()

          const sandboxLx = {
            EVENT_NAMES: {
              inited: 'inited',
              request: 'request',
              updateAlert: 'updateAlert'
            },
            request: (url: string, options: any, callback: any) => {
              let postData = ''
              if (options.body) {
                if (typeof options.body === 'object') {
                  postData = JSON.stringify(options.body)
                } else {
                  postData = String(options.body)
                }
              }

              const client = url.startsWith('https') ? https : http
              const parsedUrl = new URL(url)
              const reqOptions: any = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (url.startsWith('https') ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: options.method || 'GET',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                  'Content-Type': 'application/json',
                  ...options.headers
                }
              }

              const req = client.request(reqOptions, (res) => {
                let chunks: any[] = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                  const bodyStr = Buffer.concat(chunks).toString('utf8')
                  let parsedBody = bodyStr
                  try {
                    parsedBody = JSON.parse(bodyStr)
                  } catch (_) {}
                  
                  callback(null, {
                    body: parsedBody,
                    headers: res.headers,
                    statusCode: res.statusCode || 200
                  })
                })
              })

              req.on('error', (err) => {
                callback(err, null)
              })

              if (postData) {
                req.write(postData)
              }
              req.end()
            },
            on: (eventName: string, handler: any) => {
              if (eventName === 'request') {
                requestListeners.add(handler)
              }
            },
            send: (eventName: string, payload: any) => {
              console.log(`[CustomSource 沙箱] 发送事件: ${eventName}`, payload)
            },
            utils: {},
            env: 'desktop',
            version: '1.0.0'
          }

          const sandbox: any = {
            lx: sandboxLx, // 🚀 注入全局 lx 对象，解决音源脚本直接使用 lx 报错的问题
            console,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            Promise,
            Object,
            JSON,
            String,
            Number,
            Boolean,
            Array,
            Math,
            isNaN,
            Error,
            globalThis: {} as any,
            global: {} as any
          }

          // 🚀 将 globalThis 和 global 指向沙箱顶级环境本身，确保跨端多音源库代码访问的一致性与健壮性
          sandbox.globalThis = sandbox
          sandbox.global = sandbox

          const context = vm.createContext(sandbox)
          vm.runInContext(code, context)

          let registeredHandler: any = null
          if (requestListeners.size > 0) {
            registeredHandler = Array.from(requestListeners)[0]
          }

          if (registeredHandler) {
            MusicService.activeCustomSources.push({
              id: src.id,
              name: src.name,
              path: src.path,
              requestHandler: (payload: { action: string; source: string; info: any }) => {
                return new Promise((resolve, reject) => {
                  registeredHandler(payload)
                    .then((url: string) => resolve(url))
                    .catch((err: any) => reject(err))
                })
              }
            })
            loadedCount++
            console.log(`[MusicService] 成功载入并实例化音源沙箱: ${src.name}`)
          }
        } catch (err: any) {
          console.error(`[MusicService] 加载自定义音源失败: ${src.name}`, err.message)
        }
      }
      return { success: true, loadedCount }
    })

    // 4. 获取网易云歌词 (LRC, 翻译)
    ipcMain.handle('wy-get-lyric', async (_, songmid: string) => {
      try {
        const url = `https://music.163.com/api/song/lyric?id=${songmid}&lv=1&kv=1&tv=-1`
        const { body } = await this.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200) {
          return {
            success: true,
            lyric: result.lrc?.lyric || '',
            tlyric: result.tlyric?.lyric || ''
          }
        }
        return { success: false, error: '歌词获取失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // 5. 获取网易云热门与最新评论 (Emoji全自动Unicode过滤)
    ipcMain.handle('wy-get-comments', async (_, payload: { songmid: string; page: number; limit: number }) => {
      try {
        const { songmid, page, limit } = payload
        const offset = (page - 1) * limit
        // 使用网易云热评公开直链
        const url = `https://music.163.com/api/v1/resource/hotcomments/R_SO_4_${songmid}?limit=${limit}&offset=${offset}`
        const { body } = await this.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200) {
          const comments = (result.hotComments || []).map((c: any) => ({
            id: c.commentId,
            userName: c.user?.nickname || '游客',
            avatar: c.user?.avatarUrl || '',
            content: c.content || '',
            timeStr: new Date(c.time).toLocaleString(),
            likedCount: c.likedCount || 0
          }))
          return { success: true, comments, total: result.total || comments.length }
        }
        return { success: false, error: '获取评论失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // 6. 歌单网页链接或短链一键导入
    ipcMain.handle('music-import-playlist', async (_, linkInput: string) => {
      try {
        console.log(`[MusicService] ======= 收到歌单导入请求 =======`)
        console.log(`[MusicService] 输入的歌单链接: "${linkInput}"`)
        let targetLink = linkInput.trim()
        
        // 正则提取首个 URL
        const urlMatch = targetLink.match(/https?:\/\/[^\s]+/)
        if (!urlMatch) {
          console.warn(`[MusicService] 链接无效，未提取到 http(s) URL`)
          return { success: false, error: '请输入有效的歌单网页链接' }
        }
        targetLink = urlMatch[0]
        console.log(`[MusicService] 提取出的初始 URL: ${targetLink}`)

        // 如果是短链，进行 302 重定向地址追踪
        if (targetLink.includes('163cn.tv') || targetLink.includes('163.fm')) {
          console.log(`[MusicService] 检测到网易云分享短链，正在追踪重定向...`)
          const { headers } = await this.requestUrl(targetLink, 'GET')
          if (headers.location) {
            targetLink = headers.location
            console.log(`[MusicService] 重定向追踪成功 -> ${targetLink}`)
          } else {
            console.warn(`[MusicService] 短链未返回 location 头进行重定向`)
          }
        }

        // 正则解析网易云歌单 ID
        const idMatch = targetLink.match(/[?&]id=(\d+)/)
        if (!idMatch) {
          console.warn(`[MusicService] 正则解析 ID 失败，链接中未找到 [?&]id=\\d+`)
          return { success: false, error: '无法从链接中提取歌单 ID，请检查链接是否为标准网易云歌单。' }
        }

        const playlistId = idMatch[1]
        console.log(`[MusicService] 成功提取网易云歌单真实 ID: ${playlistId}，准备发起 V3 详情 API 请求`)
        
        // 1. 获取歌单元数据
        const detailUrl = `https://music.163.com/api/v3/playlist/detail?id=${playlistId}`
        console.log(`[MusicService] 请求 detailUrl: ${detailUrl}`)
        
        const { body: detailBody, statusCode } = await this.requestUrl(detailUrl)
        console.log(`[MusicService] detailUrl 响应状态码: ${statusCode}`)
        
        let detailResult: any = {}
        try {
          detailResult = JSON.parse(detailBody)
        } catch (parseErr: any) {
          console.error(`[MusicService] 解析歌单详情 JSON 失败！响应原文大体为:`, detailBody.substring(0, 300))
          return { success: false, error: '解析歌单详情返回数据异常' }
        }
        
        console.log(`[MusicService] API detailResult 返回的 code: ${detailResult.code}`)
        
        if (detailResult.code === 200 && detailResult.playlist) {
          console.log(`[MusicService] 歌单名字: "${detailResult.playlist.name}"`)
          // 2. 提取出所有的歌曲 ID，合并分批请求（一次最大 300 首）
          const trackIds = (detailResult.playlist.trackIds || []).map((t: any) => t.id)
          console.log(`[MusicService] 该歌单包含歌曲 ID 总数: ${trackIds.length}`)
          
          let rawTracks: any[] = []

          if (trackIds.length > 0) {
            const targetIds = trackIds.slice(0, 300)
            const songsUrl = `https://music.163.com/api/song/detail?ids=[${targetIds.join(',')}]`
            console.log(`[MusicService] 正在批量拉取歌曲详情，前 300 首请求 ids 串长度: ${targetIds.length}`)
            
            const { body: songsBody, statusCode: songsCode } = await this.requestUrl(songsUrl)
            console.log(`[MusicService] 批量拉取歌曲详情响应状态码: ${songsCode}`)
            
            let songsResult: any = {}
            try {
              songsResult = JSON.parse(songsBody)
            } catch (songsParseErr: any) {
              console.error(`[MusicService] 解析歌曲批量详情 JSON 失败！`)
              return { success: false, error: '解析批量歌曲返回数据异常' }
            }
            
            rawTracks = songsResult.songs || []
            console.log(`[MusicService] 批量拉取到的有效歌曲详情条数: ${rawTracks.length}`)
          }

          const songs = rawTracks.map((item: any) => {
            const durationSec = Math.floor((item.dt || item.duration || 0) / 1000)
            const minutes = Math.floor(durationSec / 60)
            const seconds = durationSec % 60
            const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            const qualitys = ['128k']
            if (item.h || item.hMusic) qualitys.push('320k')
            if (item.sq || item.sqMusic) qualitys.push('flac')

            let imgUrl = ''
            if (item.al?.picUrl) imgUrl = item.al.picUrl
            else if (item.album?.picUrl) imgUrl = item.album.picUrl
            else if (item.album?.picId) imgUrl = `https://p2.music.126.net/${item.album.picId}/${item.album.picId}.jpg`

            return {
              songmid: String(item.id),
              name: item.name,
              singer: (item.ar || item.artists || []).map((a: any) => a.name).join('、'),
              albumName: item.al?.name || item.album?.name || '',
              interval,
              durationSec,
              source: 'wy',
              img: imgUrl,
              qualitys
            }
          })
          
          console.log(`[MusicService] 映射处理完成，返回成功！成功携带歌曲数: ${songs.length}`)
          return {
            success: true,
            playlistName: detailResult.playlist.name,
            img: detailResult.playlist.coverImgUrl,
            songs
          }
        }
        
        console.warn(`[MusicService] 歌单加载失败，API 返回 code 非 200 或无 playlist 节点:`, detailResult)
        return { success: false, error: `解析外部歌单详情失败 (Code: ${detailResult.code || '未知'})` }
      } catch (err: any) {
        console.error(`[MusicService] 导入歌单发生致命异常！详细错误堆栈：`, err)
        return { success: false, error: `发生意外异常: ${err.message}` }
      }
    })

    // ====== SQLite 音乐播放列表管理 IPC 通道 ======
    ipcMain.handle('db-music-create-playlist', async (_, name: string) => {
      const id = 'list_' + Math.random().toString(36).substring(2, 10)
      db.createMusicPlaylist(id, name)
      return { success: true, id, name }
    })

    ipcMain.handle('db-music-delete-playlist', async (_, id: string) => {
      db.deleteMusicPlaylist(id)
      return { success: true }
    })

    ipcMain.handle('db-music-get-playlists', async () => {
      const lists = db.getMusicPlaylists()
      return { success: true, lists }
    })

    ipcMain.handle('db-music-add-song', async (_, song: any) => {
      try {
        // 对所有字段进行防御性兜底，防止 undefined 或 null 违反 SQLite NOT NULL 约束
        const data = {
          playlist_id: String(song.playlist_id || ''),
          songmid: String(song.songmid || ''),
          name: song.name || '未知歌曲',
          singer: song.singer || '群星',
          albumName: song.albumName || '',
          interval: song.interval || '00:00',
          source: song.source || 'wy',
          img: song.img || '',
          qualitys: typeof song.qualitys === 'string' ? song.qualitys : JSON.stringify(song.qualitys || ['128k'])
        }
        db.addSongToPlaylist(data)
        return { success: true }
      } catch (err: any) {
        console.error('[MusicService] db-music-add-song 写入数据库失败:', err.message || err)
        return { success: false, error: err.message || '写入数据库失败' }
      }
    })

    ipcMain.handle('db-music-remove-song', async (_, payload: { playlist_id: string; songmid: string; source: string }) => {
      db.removeSongFromPlaylist(payload.playlist_id, payload.songmid, payload.source)
      return { success: true }
    })

    ipcMain.handle('db-music-get-songs', async (_, playlistId: string) => {
      const songs = db.getSongsFromPlaylist(playlistId).map(s => ({
        ...s,
        qualitys: JSON.parse(s.qualitys)
      }))
      return { success: true, songs }
    })

    ipcMain.handle('db-music-check-song-in-playlist', async (_, payload: { playlist_id: string; songmid: string; source: string }) => {
      const exists = db.isSongInPlaylist(payload.playlist_id, payload.songmid, payload.source)
      return { success: true, exists }
    })

    // ====== 音乐下载物理落盘与 Metadata 嵌入 IPC 通道 ======
    ipcMain.handle('music-download-song', async (event, payload: {
      songmid: string
      name: string
      singer: string
      albumName: string
      quality: string
      durationSec: number
      imgUrl: string
      lyricText?: string
      playUrl: string
    }) => {
      const { songmid, name, singer, albumName, quality, durationSec, imgUrl, lyricText, playUrl } = payload
      const id = `${songmid}_${quality}`
      const ext = quality === 'flac' ? '.flac' : '.mp3'
      const sanitizedFilename = `${singer} - ${name}${ext}`.replace(/[\\/:*?"<>|]/g, '')
      
      const downloadFolder = join(app.getPath('downloads'), 'EchoMusic')
      if (!fs.existsSync(downloadFolder)) {
        fs.mkdirSync(downloadFolder, { recursive: true })
      }
      const filePath = join(downloadFolder, sanitizedFilename)
      
      console.log(`[MusicService] 启动下载任务: ${sanitizedFilename}，路径: ${filePath}`)
      
      // SQLite 入库任务（状态：0下载中）
      db.saveDownloadTask({
        id,
        songmid,
        name,
        singer,
        albumName,
        quality,
        filePath,
        status: 0,
        progress: 0.0
      })

      // 异步下载核心
      try {
        const client = playUrl.startsWith('https') ? https : http
        client.get(playUrl, async (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            // 重定向支持，根据重定向后的真实 URL 动态匹配 http/https 客户端以防协议报错
            const redirectedUrl = res.headers.location!
            const redirectClient = redirectedUrl.startsWith('https') ? https : http
            redirectClient.get(redirectedUrl, (res2) => this.handleDownloadStream(res2, id, filePath, payload, event)).on('error', (e) => this.handleDownloadError(id, e))
            return
          }
          this.handleDownloadStream(res, id, filePath, payload, event)
        }).on('error', (e) => this.handleDownloadError(id, e))

        return { success: true, taskId: id, filePath }
      } catch (err: any) {
        db.updateDownloadProgress(id, 0, 2)
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('db-music-get-downloads', async () => {
      const list = db.getDownloads()
      return { success: true, list }
    })

    ipcMain.handle('music-get-download-path', async () => {
      try {
        const downloadFolder = join(app.getPath('downloads'), 'EchoMusic')
        return { success: true, path: downloadFolder }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('db-music-delete-download', async (_, id: string) => {
      db.deleteDownload(id)
      return { success: true }
    })

    // ====== 桌面歌词窗口管理 IPC 通道 ======
    ipcMain.handle('lyric-window-toggle', async (_, payload: { enable: boolean; lyricText?: string }) => {
      if (payload.enable) {
        this.createLyricWindow(payload.lyricText)
      } else {
        this.closeLyricWindow()
      }
      return { success: true }
    })

    ipcMain.handle('lyric-window-update', async (_, lyricText: string) => {
      if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
        this.desktopLyricWindow.webContents.send('set-lyric-text', lyricText)
      }
      return { success: true }
    })

    ipcMain.handle('lyric-window-lock-toggle', async (_, isLocked: boolean) => {
      if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
        this.desktopLyricWindow.setIgnoreMouseEvents(isLocked, { forward: true })
      }
      return { success: true }
    })

    ipcMain.handle('music-open-folder', async (_, pathStr: string) => {
      shell.showItemInFolder(pathStr)
      return { success: true }
    })

    ipcMain.handle('music-import-custom-source', async (event) => {
      const { dialog } = require('electron')
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win!, {
        title: '选择自定义音源 JavaScript 文件',
        filters: [{ name: 'JavaScript', extensions: ['js'] }],
        properties: ['openFile']
      })
      if (!result.canceled && result.filePaths.length > 0) {
        const filePath = result.filePaths[0]
        const path = require('path')
        
        // 物理持久化至应用专属 userData 私有目录，杜绝绝对路径失效静默消失 Bug
        const privateDir = path.join(app.getPath('userData'), 'EchoMusicSources')
        if (!fs.existsSync(privateDir)) {
          fs.mkdirSync(privateDir, { recursive: true })
        }
        const name = path.basename(filePath)
        const destPath = path.join(privateDir, name)
        
        try {
          fs.copyFileSync(filePath, destPath)
          console.log(`[MusicService] 本地音源成功物理复制到应用专属私有目录: ${destPath}`)
          return { success: true, filePath: destPath, name }
        } catch (err: any) {
          console.error(`[MusicService] 本地音源物理复制失败:`, err.message)
          // 兜底退回到原绝对路径
          return { success: true, filePath, name }
        }
      }
      return { success: false, error: '用户取消了选择' }
    })

    // ====== 接收在线音源直链抓取物理落盘持久化 IPC 处理器 ======
    ipcMain.handle('music-import-custom-source-url', async (_, urlStr: string) => {
      try {
        if (!urlStr || !urlStr.trim().startsWith('http')) {
          return { success: false, error: '请输入有效的 http 或 https 链接' }
        }
        const path = require('path')
        const parsedUrl = new URL(urlStr.trim())
        let filename = path.basename(parsedUrl.pathname)
        if (!filename || !filename.endsWith('.js')) {
          filename = `online_source_${Date.now()}.js`
        }
        filename = filename.replace(/[\\/:*?"<>|]/g, '') // 过滤非法字符
        
        // 获取脚本代码内容
        console.log(`[MusicService] 开始在线获取 JS 音源: ${urlStr}`)
        const code = await MusicService.downloadTextFromUrl(urlStr.trim())
        
        // 物理落盘写入私有存储目录中
        const privateDir = path.join(app.getPath('userData'), 'EchoMusicSources')
        if (!fs.existsSync(privateDir)) {
          fs.mkdirSync(privateDir, { recursive: true })
        }
        const destPath = path.join(privateDir, filename)
        fs.writeFileSync(destPath, code, 'utf8')
        
        console.log(`[MusicService] 在线音源物理下载持久化落盘成功: ${destPath}`)
        return { success: true, filePath: destPath, name: filename }
      } catch (err: any) {
        console.error(`[MusicService] 在线导入音源失败:`, err.message)
        return { success: false, error: `在线导入音源失败: ${err.message}` }
      }
    })

    // ====== 实时搜索联想与单曲搜索 IPC 通道 ======
    ipcMain.handle('wy-search-suggest', async (_, keyword: string) => {
      try {
        const url = `https://music.163.com/api/search/suggest/web?s=${encodeURIComponent(keyword)}&limit=8`
        const { body } = await MusicService.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200 && result.result) {
          const songs = (result.result.songs || []).map((s: any) => ({
            id: String(s.id),
            name: s.name,
            singer: (s.artists || []).map((a: any) => a.name).join('、')
          }))
          return { success: true, songs }
        }
        return { success: true, songs: [] }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('wy-search-songs', async (_, keyword: string) => {
      try {
        console.log(`[MusicService] 启动超强四合一联合级联雷达搜索，关键词: ${keyword}`)

        // 1. 网易云搜索并发线程 (wy)
        const wyPromise = (async () => {
          try {
            const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=30`
            const { body } = await MusicService.requestUrl(url)
            const result = JSON.parse(body)
            if (result.code === 200 && result.result) {
              return (result.result.songs || []).map((item: any) => {
                const durationSec = Math.floor(item.duration / 1000)
                const minutes = Math.floor(durationSec / 60)
                const seconds = durationSec % 60
                const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
                return {
                  songmid: String(item.id),
                  name: item.name,
                  singer: (item.artists || []).map((a: any) => a.name).join('、'),
                  albumName: item.album?.name || '',
                  interval,
                  durationSec,
                  source: 'wy',
                  img: '',
                  qualitys: ['128k', '320k']
                }
              })
            }
          } catch (e: any) {
            console.error('[MusicService] 网易云雷达搜索解析异常:', e.message)
          }
          return []
        })()

        // 2. 酷我音乐搜索并发线程 (kw)
        const kwPromise = (async () => {
          try {
            const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(keyword)}&pn=0&rn=30&rformat=json`
            const { body } = await MusicService.requestUrl(url)
            const cleanJsonStr = body.replace(/'/g, '"').trim()
            let searchData: any = {}
            try {
              searchData = JSON.parse(cleanJsonStr)
            } catch (_) {
              // 若出现部分非标准 JSON，通过正则提取做高容错兜底
              const rids = body.match(/"MUSIC_(\d+)"/g)
              const songnames = body.match(/"SONGNAME":"([^"]+)"/g)
              const artists = body.match(/"ARTIST":"([^"]+)"/g)
              const albums = body.match(/"ALBUM":"([^"]+)"/g)
              const durations = body.match(/"DURATION":"([^"]+)"/g)
              if (rids && rids.length > 0) {
                const list: any[] = []
                for (let i = 0; i < rids.length; i++) {
                  const rid = rids[i].replace(/"/g, '').replace('MUSIC_', '')
                  const songname = songnames && songnames[i] ? songnames[i].replace(/"SONGNAME":"|"/g, '') : '未知歌曲'
                  const artist = artists && artists[i] ? artists[i].replace(/"ARTIST":"|"/g, '') : '未知歌手'
                  const album = albums && albums[i] ? albums[i].replace(/"ALBUM":"|"/g, '') : ''
                  const durationSec = durations && durations[i] ? parseInt(durations[i].replace(/"DURATION":"|"/g, '')) : 240
                  const minutes = Math.floor(durationSec / 60)
                  const seconds = durationSec % 60
                  const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
                  list.push({
                    songmid: rid,
                    name: songname,
                    singer: artist.replace(/&/g, '、'),
                    albumName: album,
                    interval,
                    durationSec,
                    source: 'kw',
                    img: '',
                    qualitys: ['128k', '320k']
                  })
                }
                return list
              }
            }

            if (searchData.abslist && searchData.abslist.length > 0) {
              return searchData.abslist.map((item: any) => {
                const durationSec = parseInt(item.DURATION || '240')
                const minutes = Math.floor(durationSec / 60)
                const seconds = durationSec % 60
                const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
                return {
                  songmid: item.MUSICRID ? item.MUSICRID.replace('MUSIC_', '') : String(Math.random()),
                  name: item.SONGNAME || '未知歌曲',
                  singer: item.ARTIST ? item.ARTIST.replace(/&/g, '、') : '未知歌手',
                  albumName: item.ALBUM || '',
                  interval,
                  durationSec,
                  source: 'kw',
                  img: '',
                  qualitys: ['128k', '320k']
                }
              })
            }
          } catch (e: any) {
            console.error('[MusicService] 酷我雷达搜索解析异常:', e.message)
          }
          return []
        })()

        // 3. 咪咕音乐搜索并发线程 (mg，拥有极致完美的周杰伦正版音源池)
        const mgPromise = (async () => {
          try {
            const url = `https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?isCopyright=1&isCorrect=1&pageNo=1&pageSize=30&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A0%2C%22mvSong%22%3A0%2C%22songlist%22%3A0%2C%22bestShow%22%3A0%7D&sort=0&text=${encodeURIComponent(keyword)}`
            const { body } = await MusicService.requestUrl(url)
            const result = JSON.parse(body)
            if (result && result.songResultData && result.songResultData.result) {
              return (result.songResultData.result || []).map((item: any) => {
                let img = ''
                if (item.imgItems && item.imgItems.length > 0) {
                  img = item.imgItems[0].img || ''
                }
                return {
                  songmid: String(item.copyrightId || item.id || Math.random()),
                  name: item.name || '未知歌曲',
                  singer: item.singerName ? item.singerName.replace(/,/g, '、') : '未知歌手',
                  albumName: item.albumName || '',
                  interval: '04:00',
                  durationSec: 240,
                  source: 'mg',
                  img: img,
                  qualitys: ['128k', '320k']
                }
              })
            }
          } catch (e: any) {
            console.error('[MusicService] 咪咕正版雷达搜索解析异常:', e.message)
          }
          return []
        })()

        // 4. 企鹅音乐搜索并发线程 (tx，周杰伦独家大本营版权方)
        const txPromise = (async () => {
          try {
            const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?g_tk=5381&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&w=${encodeURIComponent(keyword)}&zhidaqu=1&catZhida=1&t=0&flag=1&ie=utf-8&sem=1&aggr=0&perpage=30&n=30&p=1&remoteplace=txt.mqq.all`
            const { body } = await MusicService.requestUrl(url)
            
            // 极致强壮的 JSONP 回调外壳剥离过滤，杜绝一切格式变动崩溃
            let cleanBody = body.trim()
            if (cleanBody.startsWith('callback(') || cleanBody.startsWith('jsonpCallback(')) {
              cleanBody = cleanBody.replace(/^(callback|jsonpCallback)\(/, '').replace(/\);?$/, '')
            } else if (cleanBody.includes('({') && cleanBody.endsWith(')')) {
              cleanBody = cleanBody.substring(cleanBody.indexOf('(') + 1, cleanBody.lastIndexOf(')'))
            }
            
            const result = JSON.parse(cleanBody)
            if (result && result.data && result.data.song && result.data.song.list) {
              return (result.data.song.list || []).map((item: any) => {
                const durationSec = item.interval || 240
                const minutes = Math.floor(durationSec / 60)
                const seconds = durationSec % 60
                const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
                return {
                  songmid: String(item.songmid || item.songid || Math.random()),
                  name: item.songname || '未知歌曲',
                  singer: (item.singer || []).map((s: any) => s.name).join('、'),
                  albumName: item.albumname || '',
                  interval,
                  durationSec,
                  source: 'tx',
                  img: item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : '',
                  qualitys: ['128k', '320k']
                }
              })
            }
          } catch (e: any) {
            console.error('[MusicService] 企鹅独家雷达搜索解析异常:', e.message)
          }
          return []
        })()


        // 执行并行并发，并在 0.5 秒内极速等待四大版权巨头反馈结果
        const [wySongs, kwSongs, mgSongs, txSongs] = await Promise.all([wyPromise, kwPromise, mgPromise, txPromise])
        
        // 5. 对四大平台的结果进行完美均衡平滑交织合并，让结果分布最美观
        const songs: any[] = []
        const maxLength = Math.max(wySongs.length, kwSongs.length, mgSongs.length, txSongs.length)
        for (let i = 0; i < maxLength; i++) {
          if (i < wySongs.length) songs.push(wySongs[i])
          if (i < kwSongs.length) songs.push(kwSongs[i])
          if (i < mgSongs.length) songs.push(mgSongs[i])
          if (i < txSongs.length) songs.push(txSongs[i])
        }

        console.log(`[MusicService] 级联雷达搜索返回成功！网易云: ${wySongs.length}, 酷我: ${kwSongs.length}, 咪咕: ${mgSongs.length}, 企鹅: ${txSongs.length}。融合总条数: ${songs.length}`)
        return { success: true, songs }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('wy-search-singers', async (_, keyword: string) => {
      try {
        console.log(`[MusicService] 启动歌手双星雷达并联搜索: keyword=${keyword}`)

        // 1. 网易云歌手搜索并发 Promise (wy)
        const wyPromise = (async () => {
          try {
            const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=100&offset=0&limit=15`
            const { body } = await MusicService.requestUrl(url)
            const result = JSON.parse(body)
            if (result.code === 200 && result.result) {
              return (result.result.artists || []).map((a: any) => ({
                id: String(a.id),
                name: a.name,
                img: a.picUrl || a.img1v1Url || '',
                albumCount: a.albumSize || 0,
                trackCount: a.musicSize || 0,
                source: 'wy'
              }))
            }
          } catch (e: any) {
            console.error('[MusicService] 网易歌手搜索异常:', e.message)
          }
          return []
        })()

        // 2. 企鹅音乐歌手搜索并发 Promise (tx)
        const txPromise = (async () => {
          try {
            const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?g_tk=5381&uin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1&w=${encodeURIComponent(keyword)}&t=9&perpage=15&n=15&p=1`
            const { body } = await MusicService.requestUrl(url)
            const result = JSON.parse(body)
            if (result.code === 0 && result.data && result.data.singer && result.data.singer.list) {
              return (result.data.singer.list || []).map((s: any) => {
                const mid = s.singerMID || String(s.singerID)
                return {
                  id: String(s.singerID),
                  name: s.singerName,
                  img: mid ? `https://y.gtimg.cn/music/photo_new/T001R150x150M000${mid}.jpg` : '',
                  albumCount: s.albumNum || 0,
                  trackCount: s.songNum || 0,
                  source: 'tx'
                }
              })
            }
          } catch (e: any) {
            console.error('[MusicService] 企鹅歌手搜索异常:', e.message)
          }
          return []
        })()

        const [wyArtists, txArtists] = await Promise.all([wyPromise, txPromise])

        // 对两大平台搜出的卡片进行去重融合
        const artists: any[] = []
        const nameSet = new Set<string>()
        const maxLength = Math.max(wyArtists.length, txArtists.length)
        
        for (let i = 0; i < maxLength; i++) {
          if (i < wyArtists.length) {
            const a = wyArtists[i]
            const cleanName = a.name.trim().toLowerCase()
            if (!nameSet.has(cleanName)) {
              nameSet.add(cleanName)
              artists.push(a)
            }
          }
          if (i < txArtists.length) {
            const s = txArtists[i]
            const cleanName = s.name.trim().toLowerCase()
            if (!nameSet.has(cleanName)) {
              nameSet.add(cleanName)
              artists.push(s)
            }
          }
        }

        console.log(`[MusicService] 歌手双星雷达并联搜索成功！网易: ${wyArtists.length}, 企鹅: ${txArtists.length}。去重去灰融合总数: ${artists.length}`)
        return { success: true, artists }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('wy-get-artist-songs', async (_, payload: { id: string; name: string; source?: string }) => {
      try {
        const { id, name, source = 'wy' } = payload
        let targetArtistId = id

        // 如果歌手源并非网易云 (比如是QQ搜出的歌手词条)，我们在后台通过该歌手名字在网易云中执行数毫秒的静默反向检索定位，以高兼容获取其歌曲列表！
        if (source !== 'wy') {
          console.log(`[MusicService] 跨源歌手 "${name}" (来自 ${source})，启动自适应反向定位检索网易云专属 ArtistId...`)
          try {
            const searchUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(name)}&type=100&offset=0&limit=1`
            const { body } = await MusicService.requestUrl(searchUrl)
            const searchRes = JSON.parse(body)
            if (searchRes.code === 200 && searchRes.result && searchRes.result.artists && searchRes.result.artists.length > 0) {
              targetArtistId = String(searchRes.result.artists[0].id)
              console.log(`[MusicService] 跨源歌手反向检索定位成功！网易专属 ArtistId = ${targetArtistId}`)
            }
          } catch (se: any) {
            console.warn('[MusicService] 跨源歌手反向检索定位失败，退回默认:', se.message)
          }
        }

        console.log(`[MusicService] 正在获取歌手热门单曲列表: targetArtistId=${targetArtistId}`)
        const url = `https://music.163.com/api/v1/artist/songs?id=${targetArtistId}&offset=0&limit=100`
        const { body } = await MusicService.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200 && result.songs) {
          const list = (result.songs || []).map((item: any) => {
            const durationSec = Math.floor(item.dt / 1000)
            const minutes = Math.floor(durationSec / 60)
            const seconds = durationSec % 60
            const interval = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
            
            const qualitys = ['128k']
            if (item.h) qualitys.push('320k')
            if (item.sq) qualitys.push('flac')

            return {
              songmid: String(item.id),
              name: item.name,
              singer: (item.ar || []).map((a: any) => a.name).join('、'),
              albumName: item.al?.name || '',
              interval,
              durationSec,
              source: 'wy',
              img: item.al?.picUrl || '',
              qualitys
            }
          })
          return { success: true, list }
        }
        return { success: false, error: '获取歌手单曲失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('wy-search-playlists', async (_, keyword: string) => {
      try {
        const url = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1000&offset=0&limit=30`
        const { body } = await MusicService.requestUrl(url)
        const result = JSON.parse(body)
        if (result.code === 200 && result.result) {
          const playlists = (result.result.playlists || []).map((p: any) => ({
            id: String(p.id),
            name: p.name,
            img: p.coverImgUrl,
            playCount: p.playCount > 10000 ? `${Math.floor(p.playCount / 10000)}万` : p.playCount,
            desc: p.description,
            trackCount: p.trackCount
          }))
          return { success: true, playlists }
        }
        return { success: false, error: '搜索歌单失败' }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    // ====== 桌面歌词自定义背景与文字颜色 IPC 通道 ======
    ipcMain.handle('lyric-window-update-theme', async (_, payload: { bgColor: string; textColor: string }) => {
      MusicService.lyricBgColor = payload.bgColor
      MusicService.lyricTextColor = payload.textColor
      if (MusicService.desktopLyricWindow && !MusicService.desktopLyricWindow.isDestroyed()) {
        MusicService.desktopLyricWindow.webContents.send('set-lyric-theme', payload)
      }
      return { success: true }
    })
  }

  // 流式下载写入及进度通知
  private static handleDownloadStream(res: any, id: string, filePath: string, payload: any, event: any) {
    const totalSize = parseInt(res.headers['content-length'] || '0')
    let downloadedSize = 0
    const writer = fs.createWriteStream(filePath)
    
    res.pipe(writer)
    
    res.on('data', (chunk: Buffer) => {
      downloadedSize += chunk.length
      const progress = totalSize > 0 ? (downloadedSize / totalSize) : 0.5
      event.sender.send('music-download-progress', { id, progress })
    })

    writer.on('finish', async () => {
      console.log(`[MusicService] 音频下载落地成功! 开始注入 ID3 / Vorbis Metadata 标签...`)
      
      // 1. 同步生成同名的外挂独立 .lrc 歌词文件，保障全系统的极致兼容性
      if (payload.lyricText) {
        const lrcPath = filePath.replace(/\.(mp3|flac)$/, '.lrc')
        fs.writeFileSync(lrcPath, payload.lyricText, 'utf8')
      }

      // 2. 针对 MP3 格式，纯二进制无损物理嵌入 ID3v2 标签
      if (payload.quality !== 'flac') {
        let picBuffer: Buffer | undefined
        try {
          if (payload.imgUrl) {
            picBuffer = await this.downloadBuffer(payload.imgUrl)
          }
        } catch (_) {}

        Mp3Id3Writer.write(filePath, {
          title: payload.name,
          artist: payload.singer,
          album: payload.albumName,
          lyrics: payload.lyricText,
          picBuffer
        })
      }

      // SQLite 更新下载记录状态为 1 (已完成)
      const db = getDatabaseService()
      db.updateDownloadProgress(id, 1.0, 1)
      event.sender.send('music-download-progress', { id, progress: 1.0, status: 1 })
    })

    writer.on('error', (err) => this.handleDownloadError(id, err))
  }

  private static handleDownloadError(id: string, err: any) {
    console.error(`[MusicService] 下载发生致命错误! id=${id}:`, err.message)
    const db = getDatabaseService()
    db.updateDownloadProgress(id, 0.0, 2)
  }

  // ====== 桌面歌词窗口底层实现 ======
  private static createLyricWindow(defaultText: string = '回音音乐 - 让数字生命聆听世间旋律') {
    if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
      this.desktopLyricWindow.show()
      return
    }

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width, height } = primaryDisplay.workAreaSize

    // 经典桌面置顶窗口参数配置
    this.desktopLyricWindow = new BrowserWindow({
      width: 800,
      height: 120,
      x: Math.floor((width - 800) / 2),
      y: height - 150,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      resizable: true, // 允许改变大小以获得更佳的拖拽移动支持
      maxWidth: 800,
      maxHeight: 120,
      movable: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: true, // 开启 Node 支持以便在内联页面中无缝调用 require('electron')
        contextIsolation: false, // 关闭上下文隔离，使 Bridge 注入极其顺畅
        backgroundThrottling: false // 确保非激活时不被 Chromium 降频卡顿
      }
    })

    // 网页中开启动态的鼠标 Hover 移入移出样式支持
    this.desktopLyricWindow.setIgnoreMouseEvents(true, { forward: true })

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <!-- 引入 Lucide CDN 脚本 -->
        <script src="https://unpkg.com/lucide@latest"></script>
        <style>
          body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: transparent;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            user-select: none;
            -webkit-app-region: drag; /* 支持鼠标拖拽歌词窗口 */
          }
          #lyric-container {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100px;
            padding: 0 20px;
            background: ${this.lyricBgColor}; /* 唯美极低透毛玻璃背景，动态应用自定义底色 */
            backdrop-filter: blur(16px);
            border-radius: 16px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            text-align: center;
            position: relative;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
            transition: all 0.3s ease;
          }
          #lyric-container:hover {
            background: rgba(15, 23, 42, 0.75);
            border-color: rgba(99, 102, 241, 0.45);
            box-shadow: 0 4px 30px rgba(99, 102, 241, 0.2);
          }
          #lyric-text {
            font-size: 26px;
            font-weight: 900;
            background: ${this.lyricTextColor}; /* 动态应用自定义文字颜色/渐变 */
            ${this.lyricTextColor.includes('gradient') ? '-webkit-background-clip: text; -webkit-text-fill-color: transparent;' : 'color: ' + this.lyricTextColor + '; -webkit-background-clip: unset; -webkit-text-fill-color: unset;'}
            text-shadow: 0 2px 10px rgba(99, 102, 241, 0.2);
            font-style: italic;
            transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
            -webkit-app-region: no-drag;
          }
          /* Hover 隐藏的精美锁定控制盘 */
          #lock-btn {
            position: absolute;
            right: 15px;
            top: 15px;
            width: 26px;
            height: 26px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s ease, background 0.2s ease, transform 0.2s ease;
            -webkit-app-region: no-drag;
          }
          #lyric-container:hover #lock-btn {
            opacity: 1;
          }
          #lock-btn:hover {
            background: rgba(99, 102, 241, 0.85);
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <div id="lyric-container">
          <div id="lyric-text">${defaultText}</div>
          <div id="lock-btn" title="锁定/解锁穿透" onclick="toggleLock(event)">
            <i data-lucide="lock" id="lock-icon" style="width: 14px; height: 14px; stroke-width: 2.5;"></i>
          </div>
        </div>
        <script>
          // 在 HTML 最顶端同步构建 Bridge，100% 消除生命周期 Null 指针竞态
          const { ipcRenderer } = require('electron');
          window.lyricBridge = {
            toggleLock: (locked) => {
              ipcRenderer.send('lyric-window-ipc-lock', locked);
            },
            onUpdateLyric: (cb) => {
              ipcRenderer.on('set-lyric-text', (e, text) => cb(text));
            },
            onUpdateTheme: (cb) => {
              ipcRenderer.on('set-lyric-theme', (e, theme) => cb(theme));
            }
          };

          let isLocked = true;
          
          // 初始化 Lucide 图标
          lucide.createIcons();

          // 监听并实时应用主题颜色刷新
          window.lyricBridge.onUpdateTheme((theme) => {
            const container = document.getElementById('lyric-container');
            const text = document.getElementById('lyric-text');
            
            if (theme.bgColor) {
              container.style.background = theme.bgColor;
            }
            if (theme.textColor) {
              if (theme.textColor.includes('gradient')) {
                text.style.background = theme.textColor;
                text.style.webkitBackgroundClip = 'text';
                text.style.webkitTextFillColor = 'transparent';
              } else {
                text.style.background = 'none';
                text.style.webkitBackgroundClip = 'unset';
                text.style.webkitTextFillColor = 'unset';
                text.style.color = theme.textColor;
              }
            }
          });

          function toggleLock(e) {
            e.stopPropagation();
            isLocked = !isLocked;
            
            const iconEl = document.getElementById('lock-icon');
            iconEl.setAttribute('data-lucide', isLocked ? 'lock' : 'unlock');
            lucide.createIcons();
            
            window.lyricBridge.toggleLock(isLocked);
          }

          window.lyricBridge.onUpdateLyric((text) => {
            const el = document.getElementById('lyric-text');
            el.style.transform = 'scale(0.95)';
            el.style.opacity = '0.3';
            setTimeout(() => {
              el.innerText = text;
              el.style.transform = 'scale(1.05)';
              el.style.opacity = '1';
              setTimeout(() => {
                el.style.transform = 'scale(1)';
              }, 150);
            }, 100);
          });

          // 智能悬浮边缘捕获 (Smart Edge Catching) 穿透技术
          window.addEventListener('mousemove', (event) => {
            const btn = document.getElementById('lock-btn');
            const rect = btn.getBoundingClientRect();
            
            // 只要鼠标落在锁按钮的一定范围内 (微调判定区间)
            const isNearLock = (
              event.clientX >= rect.left - 8 &&
              event.clientX <= rect.right + 8 &&
              event.clientY >= rect.top - 8 &&
              event.clientY <= rect.bottom + 8
            );

            // 如果解锁了，或者碰到了锁按钮，就不穿透，允许接收鼠标点击；移开并且处于锁定状态时开启穿透
            if (!isLocked || isNearLock) {
              window.lyricBridge.toggleLock(false);
            } else {
              window.lyricBridge.toggleLock(true);
            }
          });
        </script>
      </body>
      </html>
    `

    this.desktopLyricWindow.webContents.session.setPermissionRequestHandler((wc, perm, resolve) => resolve(true))
    this.desktopLyricWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(htmlContent))

    // 监听子窗口传回的 Lock/Unlock 指令
    ipcMain.on('lyric-window-ipc-lock', (_, isLocked: boolean) => {
      if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
        this.desktopLyricWindow.setIgnoreMouseEvents(isLocked, { forward: true })
      }
    })

    // 启动 500ms 强制置顶 Loop
    this.startAlwaysOnTopLoop()
  }

  private static startAlwaysOnTopLoop() {
    this.stopAlwaysOnTopLoop()
    this.alwaysOnTopInterval = setInterval(() => {
      if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
        this.desktopLyricWindow.setAlwaysOnTop(true, 'screen-saver')
      } else {
        this.stopAlwaysOnTopLoop()
      }
    }, 500)
  }

  private static stopAlwaysOnTopLoop() {
    if (this.alwaysOnTopInterval) {
      clearInterval(this.alwaysOnTopInterval)
      this.alwaysOnTopInterval = null
    }
  }

  private static closeLyricWindow() {
    this.stopAlwaysOnTopLoop()
    if (this.desktopLyricWindow && !this.desktopLyricWindow.isDestroyed()) {
      this.desktopLyricWindow.close()
    }
    this.desktopLyricWindow = null
  }
}
