import { ipcMain } from 'electron'

/**
 * 统一插件生命周期与挂载规范接口
 */
export interface IPlugin {
  name: string;
  init?(): void;
  registerIpcHandlers?(): void;
  views?: string[];
}

/**
 * 宿主主进程插件动态注册与生命周期管理器
 */
export class PluginManager {
  private static plugins: IPlugin[] = [];

  /**
   * 注册并装载插件，依次触发其生命周期方法
   */
  public static register(plugin: IPlugin): void {
    console.log(`[PluginManager] 🚀 正在注册插件: ${plugin.name}`);
    try {
      if (plugin.init) {
        plugin.init();
      }
      if (plugin.registerIpcHandlers) {
        plugin.registerIpcHandlers();
      }
      this.plugins.push(plugin);
      console.log(`[PluginManager] ✔ 插件 ${plugin.name} 注册并挂载完成！`);
    } catch (err: any) {
      console.error(`[PluginManager] ✘ 插件 ${plugin.name} 注册失败:`, err.message || err);
    }
  }

  /**
   * 获取所有已注册的插件列表
   */
  public static getPlugins(): IPlugin[] {
    return this.plugins;
  }
}

// 自动在主进程注册获取所有插件自定义视图的 IPC 通道
if (typeof ipcMain !== 'undefined' && ipcMain.handle) {
  ipcMain.handle('plugin-get-custom-views', () => {
    const viewsSet = new Set<string>()
    for (const plugin of PluginManager.getPlugins()) {
      if (plugin.views && Array.isArray(plugin.views)) {
        for (const view of plugin.views) {
          viewsSet.add(view)
        }
      }
    }
    return Array.from(viewsSet)
  })
}
