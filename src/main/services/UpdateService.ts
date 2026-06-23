import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import fs from 'fs'
import https from 'https'
import { spawn, exec } from 'child_process'
import { DatabaseService } from '../db/database'
import { SseManager } from './SseManager'

// 1. 版本升级数据结构定义
interface PlatformUpdate {
  url: string
}

interface UpdateConfig {
  version: string
  changelog: string
  platforms: {
    win32?: PlatformUpdate
    darwin_x64?: PlatformUpdate
    darwin_arm64?: PlatformUpdate
    linux?: PlatformUpdate
  }
}

export class UpdateService {
  private static instance: UpdateService
  private isChecking = false
  private isDownloading = false
  private downloadedFilePath = ''
  private latestVersionInfo: UpdateConfig | null = null

  // Gitee 静态版本配置文件发布地址
  private readonly updateUrl = 'https://gitee.com/andclear/echo/raw/master/update.json'

  private constructor() {}

  public static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService()
    }
    return UpdateService.instance
  }

  /**
   * 启动时自动检查更新（每天仅执行一次）
   */
  public startAutoCheck(mainWindow: BrowserWindow, dbService: DatabaseService): void {
    // 延迟 5 秒启动自动更新检查，避免卡顿应用初始化加载
    setTimeout(async () => {
      try {
        const lastCheckTimeStr = dbService.getSetting('last_update_check_time')
        const lastCheckTime = lastCheckTimeStr ? parseInt(lastCheckTimeStr, 10) : 0
        const now = Date.now()

        // 24 小时检查一次 (24 * 60 * 60 * 1000 = 86400000ms)
        if (now - lastCheckTime > 86400000) {
          console.log('[UpdateService] 距离上次自动检查已超过24小时，正在启动后台检查更新...')
          // 更新检查时间戳
          dbService.setSetting('last_update_check_time', now.toString())
          await this.checkForUpdates(mainWindow, dbService, false)
        } else {
          console.log('[UpdateService] 距离上次自动检查不足24小时，本次启动跳过自动更新。')
        }
      } catch (err: any) {
        console.error('[UpdateService] 启动自动检查异常:', err.message)
      }
    }, 5000)
  }

  /**
   * 发起版本更新检查
   * @param mainWindow 主窗口实例
   * @param dbService 数据库服务实例，用于获取或设定设置项
   * @param manual 是否是手动点击触发
   */
  public async checkForUpdates(
    mainWindow: BrowserWindow,
    dbService: DatabaseService,
    manual: boolean
  ): Promise<any> {
    if (this.isChecking) {
      return { success: false, message: '正在检查更新中，请勿重复操作...' }
    }

    this.isChecking = true
    if (manual) {
      mainWindow.webContents.send('update-check-status', { status: 'checking' })
    }

    try {
      console.log(`[UpdateService] 正在请求更新配置文件: ${this.updateUrl}`)
      const config = await this.fetchUpdateConfig()
      this.latestVersionInfo = config

      const currentVersion = getRealAppVersion()
      const hasNewVersion = this.isNewerVersion(currentVersion, config.version)

      console.log(`[UpdateService] 当前版本: v${currentVersion}, 最新版本: v${config.version}, 是否有更新: ${hasNewVersion}`)

      if (!hasNewVersion) {
        this.isChecking = false
        const latestPayload = {
          status: 'latest',
          currentVersion
        }
        if (manual) {
          mainWindow.webContents.send('update-check-status', latestPayload)
        }
        SseManager.getInstance().broadcast('update-check-status', latestPayload)
        return { success: true, hasUpdate: false, message: '当前已是最新版本' }
      }

      // 获取当前系统适用的安装包 URL
      const downloadUrl = this.getDownloadUrl(config)
      if (!downloadUrl) {
        this.isChecking = false
        console.warn(`[UpdateService] 未检测到当前平台对应的安装包链接。`)
        if (manual) {
          mainWindow.webContents.send('update-check-status', {
            status: 'error',
            message: '未找到适用于当前系统的安装包'
          })
        }
        return { success: false, message: '不支持当前平台或无适用下载包' }
      }

      this.isChecking = false
      
      // 有更新，通知渲染层已发现新版本
      const isDockerMode = process.env.DOCKER_MODE === 'true'
      
      const updateFoundPayload = {
        status: 'update-found',
        version: config.version,
        changelog: config.changelog,
        isDocker: isDockerMode
      }
      
      mainWindow.webContents.send('update-check-status', updateFoundPayload)
      SseManager.getInstance().broadcast('update-check-status', updateFoundPayload)

      // 🚀 如果是 Docker 部署环境下：优雅熔断后续的静默包下载，防止在容器内执行无意义的下载操作
      if (isDockerMode) {
        console.log('[UpdateService] 检测到当前处于 Docker 部署模式，已将更新提示推送至前端，优雅阻断后台二进制包下载。')
        return { success: true, hasUpdate: true, version: config.version, isDocker: true }
      }

      // 启动常规桌面端静默后台下载
      this.downloadUpdate(mainWindow, downloadUrl, config.version)

      return { success: true, hasUpdate: true, version: config.version }
    } catch (err: any) {
      this.isChecking = false
      console.error('[UpdateService] 检查更新失败:', err.message)
      if (manual) {
        mainWindow.webContents.send('update-check-status', {
          status: 'error',
          message: `连接更新服务器失败: ${err.message}`
        })
      }
      return { success: false, message: err.message }
    }
  }

  /**
   * 静默后台下载更新包
   */
  private doDownload(
    mainWindow: BrowserWindow,
    url: string,
    localFilePath: string,
    latestVersion: string,
    redirectDepth: number
  ): void {
    if (redirectDepth > 8) {
      this.handleDownloadError(mainWindow, new Error('重定向次数过多（超过 8 次），已自动熔断'))
      return
    }

    const fileStream = fs.createWriteStream(localFilePath)

    const request = https.get(url, (response) => {
      // 跟随所有 3xx 重定向（Gitee Release → OSS/CDN 可能有多级）
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          console.log(`[UpdateService] 跟随第 ${redirectDepth + 1} 层重定向: ${redirectUrl}`)
          fileStream.close()
          try { fs.unlinkSync(localFilePath) } catch (_) {}
          this.doDownload(mainWindow, redirectUrl, localFilePath, latestVersion, redirectDepth + 1)
          return
        }
      }

      if (response.statusCode !== 200) {
        fileStream.close()
        try { fs.unlinkSync(localFilePath) } catch (_) {}
        this.handleDownloadError(mainWindow, new Error(`HTTP 状态码异常: ${response.statusCode}`))
        return
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
      let downloadedBytes = 0

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100)
          const progressPayload = { progress: percent }
          mainWindow.webContents.send('update-download-progress', progressPayload)
          SseManager.getInstance().broadcast('update-download-progress', progressPayload)
        }
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        fileStream.close()
        this.isDownloading = false
        const fileSize = fs.existsSync(localFilePath) ? fs.statSync(localFilePath).size : 0
        console.log(`[UpdateService] 更新包下载完成！路径: ${localFilePath}, 大小: ${fileSize} 字节`)

        const downloadedPayload = {
          status: 'downloaded',
          version: latestVersion,
          changelog: this.latestVersionInfo?.changelog || ''
        }
        mainWindow.webContents.send('update-download-status', downloadedPayload)
        SseManager.getInstance().broadcast('update-download-status', downloadedPayload)
      })

      fileStream.on('error', (err) => {
        this.handleDownloadError(mainWindow, err)
      })
    })

    request.on('error', (err) => {
      fileStream.close()
      try { fs.unlinkSync(localFilePath) } catch (_) {}
      this.handleDownloadError(mainWindow, err)
    })
  }

  private downloadUpdate(mainWindow: BrowserWindow, url: string, latestVersion: string): void {
    if (this.isDownloading) {
      console.log('[UpdateService] 正在后台下载更新包，请勿重复下载...')
      return
    }

    this.isDownloading = true
    mainWindow.webContents.send('update-download-progress', { progress: 0 })

    const tempDir = join(app.getPath('temp'), 'echo-updates')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // 🔒 修复：从 URL 中剥离 query string 再提取文件名。
    // Gitee/CDN 重定向后的 URL 通常带有签名参数（如 ?Expires=xxx&Signature=xxx），
    // 若不剥离，文件名会含 ?，在 Windows 上是非法字符，导致路径无效、文件无法创建。
    const urlWithoutQuery = url.split('?')[0]
    const urlParts = urlWithoutQuery.split('/')
    const rawFileName = urlParts[urlParts.length - 1] || `Echo-Setup-${latestVersion}`
    // 再次去除文件名中可能出现的其他非法字符（Windows 不允许 < > : " / \ | ? *）
    const safeFileName = rawFileName.replace(/[<>:"/\\|?*]/g, '_')
    const localFilePath = join(tempDir, safeFileName)
    this.downloadedFilePath = localFilePath

    console.log(`[UpdateService] 开始下载更新包: ${url}`)
    console.log(`[UpdateService] 本地存储路径: ${localFilePath}`)

    this.doDownload(mainWindow, url, localFilePath, latestVersion, 0)
  }

  private handleDownloadError(mainWindow: BrowserWindow, err: Error): void {
    this.isDownloading = false
    console.error('[UpdateService] 静默下载更新包出错:', err.message)
    const errorPayload = {
      status: 'error',
      message: `下载更新包失败: ${err.message}`
    }
    mainWindow.webContents.send('update-download-status', errorPayload)
    SseManager.getInstance().broadcast('update-download-status', errorPayload)
  }

  /**
   * 重启并执行覆盖安装
   */
  public restartAndInstall(): { success: boolean; message: string } {
    console.log(`[UpdateService] restartAndInstall 调用，downloadedFilePath="${this.downloadedFilePath}"`)

    if (!this.downloadedFilePath) {
      const msg = '未找到已下载的安装包路径，请重新检查更新'
      console.error(`[UpdateService] ${msg}`)
      return { success: false, message: msg }
    }

    if (!fs.existsSync(this.downloadedFilePath)) {
      const msg = `安装包文件不存在: ${this.downloadedFilePath}`
      console.error(`[UpdateService] ${msg}`)
      return { success: false, message: msg + '，请重新检查更新' }
    }

    const fileSize = fs.statSync(this.downloadedFilePath).size
    if (fileSize === 0) {
      const msg = `安装包文件大小为 0 字节，下载可能已损坏: ${this.downloadedFilePath}`
      console.error(`[UpdateService] ${msg}`)
      return { success: false, message: msg + '，请重新检查更新' }
    }

    const filePath = this.downloadedFilePath
    console.log(`[UpdateService] 准备重启并执行覆盖安装: ${filePath} (${fileSize} 字节)`)

    const platform = process.platform

    // 强制设置 isQuiting 标志，绕过 win.on('close') 的后台隐藏拦截器，确保 app.quit() 能彻底退出
    ;(app as any).isQuiting = true

    if (platform === 'win32') {
      // Windows: 启动 NSIS 安装包（detached 保证安装进程在主进程退出后继续运行）
      const child = spawn(filePath, [], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      setTimeout(() => app.quit(), 300)
    } else if (platform === 'darwin') {
      exec(`open "${filePath}"`, (err) => {
        if (err) {
          console.error('[UpdateService] 唤起 dmg 安装界面失败:', err.message)
        }
      })
      setTimeout(() => app.quit(), 500)
    } else if (platform === 'linux') {
      shell.openPath(join(filePath, '..')).catch((err) => {
        console.error('[UpdateService] 打开 Linux 安装包目录失败:', err.message)
      })
      setTimeout(() => app.quit(), 500)
    } else {
      return { success: false, message: `不支持的系统平台: ${platform}` }
    }

    return { success: true, message: '正在退出并运行安装包...' }
  }

  /**
   * 获取远程 update.json（支持对301/302重定向的深度自适应递归跟随）
   */
  private fetchUpdateConfig(targetUrl: string = this.updateUrl, redirectsCount: number = 0): Promise<UpdateConfig> {
    if (redirectsCount > 5) {
      return Promise.reject(new Error('获取更新配置重定向次数过多，已自动熔断'))
    }
    return new Promise((resolve, reject) => {
      https
        .get(targetUrl, (res) => {
          // 🚀 核心重构：自适应深度跟随 301 与 302 临时/永久重定向，彻底根治 Gitee / CDN 强力分发时的重定向报错
          if (res.statusCode === 301 || res.statusCode === 302) {
            const redirectUrl = res.headers.location
            if (redirectUrl) {
              resolve(this.fetchUpdateConfig(redirectUrl, redirectsCount + 1))
              return
            }
          }

          if (res.statusCode !== 200) {
            reject(new Error(`获取更新配置失败，状态码: ${res.statusCode}`))
            return
          }

          let data = ''
          res.on('data', (chunk) => {
            data += chunk
          })

          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as UpdateConfig
              resolve(parsed)
            } catch (e) {
              reject(new Error('解析更新配置文件 JSON 格式错误'))
            }
          })
        })
        .on('error', (err) => {
          reject(err)
        })
    })
  }

  /**
   * 判断远程版本是否高于当前版本
   */
  private isNewerVersion(current: string, latest: string): boolean {
    const currParts = current.replace(/^v/, '').split('.').map(Number)
    const lateParts = latest.replace(/^v/, '').split('.').map(Number)

    for (let i = 0; i < 3; i++) {
      const curr = currParts[i] || 0
      const late = lateParts[i] || 0
      if (late > curr) return true
      if (late < curr) return false
    }
    return false
  }

  /**
   * 获取当前系统适用的安装包 URL
   */
  private getDownloadUrl(config: UpdateConfig): string | null {
    const platform = process.platform
    const arch = process.arch

    if (platform === 'win32') {
      return config.platforms.win32?.url || null
    }

    if (platform === 'darwin') {
      // 优先 M 系列芯片的 arm64 安装包，无则寻找通用 x64
      if (arch === 'arm64') {
        return config.platforms.darwin_arm64?.url || config.platforms.darwin_x64?.url || null
      }
      return config.platforms.darwin_x64?.url || null
    }

    if (platform === 'linux') {
      return config.platforms.linux?.url || null
    }

    return null
  }
}

export function getRealAppVersion(): string {
  let version = app.getVersion()
  if (version === '0.0' || !version) {
    try {
      const pathsToTry = [
        join(app.getAppPath(), 'package.json'),
        join(process.cwd(), 'package.json'),
        join(app.getAppPath(), '..', '..', 'package.json')
      ]
      for (const p of pathsToTry) {
        if (fs.existsSync(p)) {
          const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'))
          if (pkg && pkg.version) {
            version = pkg.version
            break
          }
        }
      }
    } catch (err) {
      console.warn('[VersionService] 读取 package.json 版本号失败:', err)
    }
  }
  return version || '1.0.8'
}
