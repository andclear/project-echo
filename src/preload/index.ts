import { contextBridge, ipcRenderer } from 'electron'

// 完美模拟 electronAPI，提供基础 IPC 方法，完全摆脱对外部 @electron-toolkit/preload 包的引入依赖
const electronAPI = {
  ipcRenderer: {
    send(channel: string, ...args: any[]): void {
      ipcRenderer.send(channel, ...args)
    },
    sendSync(channel: string, ...args: any[]): any {
      return ipcRenderer.sendSync(channel, ...args)
    },
    sendTo(webContentsId: number, channel: string, ...args: any[]): void {
      (ipcRenderer as any).sendTo(webContentsId, channel, ...args)
    },
    sendToHost(channel: string, ...args: any[]): void {
      ipcRenderer.sendToHost(channel, ...args)
    },
    // 支持接收事件与卸载监听的高级实现
    on(channel: string, listener: (...args: any[]) => void): () => void {
      const subscription = (_event: any, ...args: any[]) => listener(...args)
      ipcRenderer.on(channel, subscription)
      return () => {
        ipcRenderer.removeListener(channel, subscription)
      }
    },
    once(channel: string, listener: (...args: any[]) => void): () => void {
      const subscription = (_event: any, ...args: any[]) => listener(...args)
      ipcRenderer.once(channel, subscription)
      return () => {
        ipcRenderer.removeListener(channel, subscription)
      }
    },
    removeListener(channel: string, listener: (...args: any[]) => void): void {
      ipcRenderer.removeListener(channel, listener)
    },
    removeAllListeners(channel: string): void {
      ipcRenderer.removeAllListeners(channel)
    },
    invoke(channel: string, ...args: any[]): Promise<any> {
      return ipcRenderer.invoke(channel, ...args)
    }
  }
}

// 供渲染进程使用的安全 API 自定义扩展
const api = {
  send: (channel: string, data: any) => {
    ipcRenderer.send(channel, data)
  },
  receive: (channel: string, func: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => func(...args))
  },
  invoke: (channel: string, ...args: any[]) => {
    return ipcRenderer.invoke(channel, ...args)
  }
}

// 使用 contextBridge 安全地暴露至渲染进程上下文
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[Preload] ContextBridge 暴露接口失败:', error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
