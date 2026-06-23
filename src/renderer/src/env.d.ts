interface Window {
  api: {
    platform: string
    send(channel: string, data?: any): void
    receive(channel: string, func: (...args: any[]) => void): (() => void) | void
    invoke(channel: string, ...args: any[]): Promise<any>
  }
  electron: {
    ipcRenderer: {
      send(channel: string, ...args: any[]): void
      sendSync(channel: string, ...args: any[]): any
      sendTo(webContentsId: number, channel: string, ...args: any[]): void
      sendToHost(channel: string, ...args: any[]): void
      on(channel: string, listener: (...args: any[]) => void): () => void
      once(channel: string, listener: (...args: any[]) => void): () => void
      removeListener(channel: string, listener: (...args: any[]) => void): void
      removeAllListeners(channel: string): void
      invoke(channel: string, ...args: any[]): Promise<any>
    }
  }
}

declare module '*.png' {
  const value: string
  export default value
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
