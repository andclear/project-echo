import { onMounted, onUnmounted } from 'vue';

interface PluginSyncOptions {
  pluginName: string;
  eventName: string;
  fetchFn: () => Promise<void>;
}

/**
 * 🚀 插件推拉数据同步 Hook
 * 
 * 作用：
 * 1. 自动在 Web/移动端监听 sse-connected 长连接恢复事件，一旦连上，立即拉取数据自愈。
 * 2. 自动监听主进程广播的 plugin:${pluginName}:${eventName} 消息，收到数据时执行同步拉取。
 * 3. 完美兼容 Electron 和 Web/移动端两种运行环境。
 */
export function usePluginSync(options: PluginSyncOptions) {
  const { pluginName, eventName, fetchFn } = options;
  const channelName = `plugin:${pluginName}:${eventName}`;

  let sseUnsubscribe: (() => void) | null = null;
  let sseConnectedUnsubscribe: (() => void) | null = null;

  // 触发拉取的包装，带上错误防护
  const triggerSync = async () => {
    try {
      await fetchFn();
    } catch (err) {
      console.error(`[PluginSync] [${pluginName}] 同步拉取执行异常:`, err);
    }
  };

  onMounted(() => {
    if (window.electron && window.electron.ipcRenderer) {
      // 桌面端 (Electron IPC) 环境：监听 IPC 通道
      window.electron.ipcRenderer.on(channelName, triggerSync);
    } else if (window.api && window.api.receive) {
      // 浏览器/Web (SSE/API Bridge) 环境：监听 SSE 分发通道
      const unsub = window.api.receive(channelName, triggerSync);
      if (typeof unsub === 'function') {
        sseUnsubscribe = unsub;
      }
      
      // 监听连接自愈恢复信号：一旦长连接重连成功，立即发起一轮状态拉取自愈，防止因断线丢失更新
      const unsubConnected = window.api.receive('sse-connected', () => {
        console.log(`[PluginSync] [${pluginName}] 检测到 SSE 长连接重连恢复，执行状态同步拉取自愈...`);
        triggerSync();
      });
      if (typeof unsubConnected === 'function') {
        sseConnectedUnsubscribe = unsubConnected;
      }
    }
  });

  onUnmounted(() => {
    if (window.electron && window.electron.ipcRenderer) {
      window.electron.ipcRenderer.removeListener(channelName, triggerSync);
    }
    if (sseUnsubscribe) {
      sseUnsubscribe();
      sseUnsubscribe = null;
    }
    if (sseConnectedUnsubscribe) {
      sseConnectedUnsubscribe();
      sseConnectedUnsubscribe = null;
    }
  });

  return {
    doSync: triggerSync
  };
}
