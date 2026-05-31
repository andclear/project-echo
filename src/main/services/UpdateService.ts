import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import fs from 'fs'
import https from 'https'
import { spawn, exec } from 'child_process'
import { DatabaseService } from '../db/database'

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

      const currentVersion = app.getVersion()
      const hasNewVersion = this.isNewerVersion(currentVersion, config.version)

      console.log(`[UpdateService] 当前版本: v${currentVersion}, 最新版本: v${config.version}, 是否有更新: ${hasNewVersion}`)

      if (!hasNewVersion) {
        this.isChecking = false
        if (manual) {
          mainWindow.webContents.send('update-check-status', {
            status: 'latest',
            currentVersion
          })
        }
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
      
      mainWindow.webContents.send('update-check-status', {
        status: 'update-found',
        version: config.version,
        changelog: config.changelog,
        isDocker: isDockerMode
      })

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
  private downloadUpdate(mainWindow: BrowserWindow, url: string, latestVersion: string): void {
    if (this.isDownloading) {
      console.log('[UpdateService] 正在后台下载更新包，请勿重复下载...')
      return
    }

    this.isDownloading = true
    mainWindow.webContents.send('update-download-progress', { progress: 0 })

    // 获取系统临时文件夹路径并在其下创建专属升级目录
    const tempDir = join(app.getPath('temp'), 'echo-updates')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // 提取文件名
    const urlParts = url.split('/')
    const originalFileName = urlParts[urlParts.length - 1] || `Echo-Setup-${latestVersion}`
    const localFilePath = join(tempDir, originalFileName)
    this.downloadedFilePath = localFilePath

    console.log(`[UpdateService] 开始静默下载更新包: ${url} -> ${localFilePath}`)

    const fileStream = fs.createWriteStream(localFilePath)

    const request = https.get(url, (response) => {
      // 兼容重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          console.log(`[UpdateService] 正在跟随重定向至: ${redirectUrl}`)
          fileStream.close()
          fs.unlinkSync(localFilePath) // 删掉空文件
          this.isDownloading = false
          this.downloadUpdate(mainWindow, redirectUrl, latestVersion)
          return
        }
      }

      if (response.statusCode !== 200) {
        this.handleDownloadError(mainWindow, new Error(`HTTP 状态码异常: ${response.statusCode}`))
        return
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
      let downloadedBytes = 0

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0) {
          const percent = Math.round((downloadedBytes / totalBytes) * 100)
          // 节流推送进度
          mainWindow.webContents.send('update-download-progress', { progress: percent })
        }
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        fileStream.close()
        this.isDownloading = false
        console.log('[UpdateService] 更新包静默下载顺利完成！')
        
        // 广播下载完成事件给渲染进程，唤起毛玻璃安装确认对话框
        mainWindow.webContents.send('update-download-status', {
          status: 'downloaded',
          version: latestVersion,
          changelog: this.latestVersionInfo?.changelog || ''
        })
      })
    })

    request.on('error', (err) => {
      fileStream.close()
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath)
      }
      this.handleDownloadError(mainWindow, err)
    })
  }

  private handleDownloadError(mainWindow: BrowserWindow, err: Error): void {
    this.isDownloading = false
    console.error('[UpdateService] 静默下载更新包出错:', err.message)
    mainWindow.webContents.send('update-download-status', {
      status: 'error',
      message: `下载更新包失败: ${err.message}`
    })
  }

  /**
   * 重启并执行覆盖安装
   */
  public restartAndInstall(): { success: boolean; message: string } {
    if (!this.downloadedFilePath || !fs.existsSync(this.downloadedFilePath)) {
      return { success: false, message: '未找到已下载的安装包，请重新检查更新' }
    }

    const filePath = this.downloadedFilePath
    console.log(`[UpdateService] 准备重启并执行覆盖安装: ${filePath}`)

    const platform = process.platform

    if (platform === 'win32') {
      // Windows: 静默或者唤起 NSIS 安装包，并退出主程序防占位
      const child = spawn(filePath, [], {
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      app.quit()
    } else if (platform === 'darwin') {
      // macOS: 打开 DMG 挂载并提示用户拖拽
      exec(`open "${filePath}"`, (err) => {
        if (err) {
          console.error('[UpdateService] 唤起 dmg 安装界面失败:', err.message)
        }
      })
      app.quit()
    } else if (platform === 'linux') {
      // Linux: 提示用户文件路径，并打开它
      shell.openPath(join(filePath, '..')).catch((err) => {
        console.error('[UpdateService] 打开 Linux 安装包目录失败:', err.message)
      })
      app.quit()
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
