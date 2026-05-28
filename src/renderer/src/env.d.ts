interface Window {
  api: {
    platform: string
    send(channel: string, data?: any): void
    receive(channel: string, func: (...args: any[]) => void): void
    invoke(channel: string, ...args: any[]): Promise<any>
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
