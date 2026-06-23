<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { 
  ArrowLeftIcon, 
  PlusIcon, 
  SendIcon, 
  Trash2Icon, 
  LockIcon, 
  ShieldCheckIcon, 
  SmileIcon, 
  Loader2Icon,
  LeafIcon,
  XIcon,
  MenuIcon,
  SparklesIcon
} from 'lucide-vue-next';
import MarkdownIt from 'markdown-it';
import { usePluginSync } from '../../composables/usePluginSync';
import defaultAvatarUrl from '../../assets/default-avatar.webp';

const props = defineProps<{
  isMobile: boolean;
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

// ── Markdown 渲染器 ──
const md = new MarkdownIt({
  html: false, // 设为 false 防止 XSS 注入，只解析纯 markdown
  linkify: true,
  breaks: true // 自动将 \n 换行符解析为 <br>
});

const renderMarkdown = (content: string) => {
  if (!content) return '';
  return md.render(content);
};

// ── 响应式状态 ──
const showSidebar = ref(false);
const isCheckingDisclaimer = ref(true);
const isDisclaimerAccepted = ref<boolean | null>(null);
const sessions = ref<any[]>([]);
const currentSessionId = ref<string | null>(null);
const messages = ref<any[]>([]);
const inputText = ref('');
const isThinking = ref(false);
const isGenerating = ref(false); // 正在生成开场白或流式回复中

// 头像缓存与用户个人头像
const avatarCache = ref<Record<string, string>>({});
const userAvatarUrl = ref('');

// 弹出新建会话相关
const showCreateModal = ref(false);
const allCharacters = ref<any[]>([]);
const selectedCharId = ref<string>('');
const newSessionTitle = ref('');

// 流式文字分块暂存
const streamingMessageId = ref<string | null>(null);

// ── 计算属性 ──
const currentSession = computed(() => {
  return sessions.value.find(s => s.id === currentSessionId.value) || null;
});

// 滚动到底部
const chatMessageContainer = ref<HTMLElement | null>(null);
const scrollToBottom = async () => {
  await nextTick();
  if (chatMessageContainer.value) {
    chatMessageContainer.value.scrollTop = chatMessageContainer.value.scrollHeight;
  }
};

// ── 核心数据加载 ──
const checkDisclaimer = async () => {
  if (!window.api || !window.api.invoke) {
    isDisclaimerAccepted.value = false;
    isCheckingDisclaimer.value = false;
    return;
  }
  try {
    const res = await window.api.invoke('therapy-is-disclaimer-accepted');
    if (res && res.success) {
      isDisclaimerAccepted.value = res.accepted;
    } else {
      isDisclaimerAccepted.value = false;
    }
  } catch (err) {
    console.error('检查免责声明失败:', err);
    isDisclaimerAccepted.value = false;
  } finally {
    isCheckingDisclaimer.value = false;
  }
};

const acceptDisclaimer = async () => {
  if (!window.api || !window.api.invoke) {
    isDisclaimerAccepted.value = true;
    return;
  }
  try {
    const res = await window.api.invoke('therapy-accept-disclaimer');
    if (res && res.success) {
      isDisclaimerAccepted.value = true;
      await loadSessions();
    }
  } catch (err) {
    console.error('签署免责声明失败:', err);
  }
};

const loadSessions = async () => {
  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('therapy-list-sessions');
    if (res && res.success) {
      sessions.value = res.list || [];
      // 异步加载会话中AI角色的头像并存入缓存
      if (res.list) {
        Promise.all(
          res.list.map(async (s: any) => {
            if (s.character_id && s.character_folder_name && !avatarCache.value[s.character_id]) {
              const base64 = await window.api.invoke('get-character-avatar', s.character_folder_name);
              if (base64) {
                avatarCache.value[s.character_id] = base64;
              }
            }
          })
        ).catch(err => console.error('预加载会话头像失败:', err));
      }
      // 默认选中第一个会话
      if (sessions.value.length > 0 && !currentSessionId.value) {
        selectSession(sessions.value[0].id);
      }
    }
  } catch (err) {
    console.error('加载会话列表失败:', err);
  }
};

const loadHistory = async (sessionId: string) => {
  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('therapy-get-session-history', { sessionId });
    if (res && res.success) {
      messages.value = res.history || [];
      // 仅当最后一条是角色回复或当前没有在等待思考响应时，重置思考状态
      const lastMsg = messages.value[messages.value.length - 1];
      if ((lastMsg && lastMsg.role === 'assistant') || !isThinking.value) {
        isThinking.value = false;
      }
      scrollToBottom();
    }
  } catch (err) {
    console.error('加载会话历史失败:', err);
  }
};

const selectSession = async (sessionId: string) => {
  currentSessionId.value = sessionId;
  messages.value = [];
  isThinking.value = false;
  inputText.value = '';
  isMultiSelectMode.value = false;
  selectedMessageIds.value = [];
  if (props.isMobile) {
    showSidebar.value = false;
  }
  await loadHistory(sessionId);
};

const openCreateModal = async () => {
  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('get-characters');
    if (res && res.success) {
      allCharacters.value = res.characters || [];
      // 异步加载可选AI角色的头像并存入缓存
      if (res.characters) {
        Promise.all(
          res.characters.map(async (char: any) => {
            if (char.id && char.folder_name && !avatarCache.value[char.id]) {
              const base64 = await window.api.invoke('get-character-avatar', char.folder_name);
              if (base64) {
                avatarCache.value[char.id] = base64;
              }
            }
          })
        ).catch(err => console.error('预加载角色列表头像失败:', err));
      }
      if (allCharacters.value.length > 0) {
        selectedCharId.value = allCharacters.value[0].id;
      }
      newSessionTitle.value = '';
      showCreateModal.value = true;
    }
  } catch (err) {
    console.error('获取角色列表失败:', err);
  }
};

// ── 自定义美观弹窗状态与触发器 ──
interface DialogConfig {
  show: boolean;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'danger';
  isConfirm: boolean;
  resolve?: (value: boolean) => void;
}

const dialogConfig = ref<DialogConfig>({
  show: false,
  title: '提示',
  message: '',
  type: 'info',
  isConfirm: false
});

const showCustomDialog = (options: {
  title?: string;
  message: string;
  type?: 'info' | 'warning' | 'danger';
  isConfirm?: boolean;
}): Promise<boolean> => {
  return new Promise((resolve) => {
    dialogConfig.value = {
      show: true,
      title: options.title || (options.isConfirm ? '确认操作' : '提示'),
      message: options.message,
      type: options.type || 'info',
      isConfirm: !!options.isConfirm,
      resolve
    };
  });
};

const handleDialogConfirm = () => {
  if (dialogConfig.value.resolve) dialogConfig.value.resolve(true);
  dialogConfig.value.show = false;
};

const handleDialogCancel = () => {
  if (dialogConfig.value.resolve) dialogConfig.value.resolve(false);
  dialogConfig.value.show = false;
};

const createSession = async () => {
  if (!selectedCharId.value) return;
  const char = allCharacters.value.find(c => c.id === selectedCharId.value);
  if (!char) return;

  const title = newSessionTitle.value.trim() || `与 ${char.name} 的倾听时光`;
  isGenerating.value = true;
  showCreateModal.value = false;

  if (!window.api || !window.api.invoke) {
    isGenerating.value = false;
    return;
  }
  try {
    const res = await window.api.invoke('therapy-create-session', { characterId: selectedCharId.value, title });
    if (res && res.success) {
      await loadSessions();
      await selectSession(res.sessionId);
    }
  } catch (err) {
    console.error('新建会话失败:', err);
  } finally {
    isGenerating.value = false;
  }
};

const deleteSession = async (sessionId: string) => {
  const confirmed = await showCustomDialog({
    title: '删除倾听时光',
    message: '确定要删除这段「倾听时光」吗？所有的倾诉记录将被物理销毁且无法找回。',
    type: 'danger',
    isConfirm: true
  });
  if (!confirmed) return;
  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('therapy-delete-session', { sessionId });
    if (res && res.success) {
      if (currentSessionId.value === sessionId) {
        currentSessionId.value = null;
        messages.value = [];
      }
      await loadSessions();
    }
  } catch (err) {
    console.error('删除会话失败:', err);
  }
};

// ── 发送消息 ──
const sendMessage = async () => {
  if (!currentSessionId.value || isThinking.value || isGenerating.value) return;
  const text = inputText.value.trim();
  if (!text) return;

  inputText.value = '';
  isThinking.value = true;
  
  // 插入临时本地用户消息展示
  messages.value.push({
    id: `temp_${Date.now()}`,
    session_id: currentSessionId.value,
    role: 'user',
    content: text,
    timestamp: Date.now()
  });
  scrollToBottom();

  if (!window.api || !window.api.invoke) {
    isThinking.value = false;
    return;
  }
  try {
    // 异步呼起主进程大模型
    const res = await window.api.invoke('therapy-send-message', {
      sessionId: currentSessionId.value,
      userText: text
    });
    if (!res || !res.success) {
      isThinking.value = false;
      await showCustomDialog({
        title: '发送失败',
        message: `发送失败: ${res?.error || '未知错误'}`,
        type: 'warning'
      });
    }
  } catch (err: any) {
    isThinking.value = false;
    console.error('发送消息异常:', err);
  }
};

// ── 处理流式消息块 ──
const handleMessageChunk = (data: any) => {
  if (!data || data.sessionId !== currentSessionId.value) return;

  isThinking.value = false; // 收到第一个字就关闭“认真倾听中”的呼吸提示，显示气泡

  // 检查是不是结尾帧
  if (data.completed) {
    isThinking.value = false;
    scrollToBottom();
    return;
  }

  const lastMsg = messages.value[messages.value.length - 1];
  const isLastAssistant = lastMsg && lastMsg.role === 'assistant' && !lastMsg.id.startsWith('temp_');

  if (data.done) {
    // 最终帧，替换为完整内容
    if (isLastAssistant) {
      lastMsg.content = data.content;
    } else {
      messages.value.push({
        id: `assistant_${Date.now()}`,
        session_id: data.sessionId,
        role: 'assistant',
        content: data.content,
        timestamp: Date.now()
      });
    }
    isThinking.value = false;
  } else {
    // 增量帧，累加内容
    if (isLastAssistant) {
      lastMsg.content = (lastMsg.content || '') + data.content;
    } else {
      messages.value.push({
        id: `assistant_${Date.now()}`,
        session_id: data.sessionId,
        role: 'assistant',
        content: data.content,
        timestamp: Date.now()
      });
    }
  }

  scrollToBottom();
};

// ── 获取用户应用头像 ──
const loadUserProfile = async () => {
  try {
    const res = await window.api.invoke('get-user-profile');
    if (res && res.success && res.profile) {
      userAvatarUrl.value = res.profile.appAvatarUrl || '';
    }
  } catch (err) {
    console.error('获取用户头像失败:', err);
  }
};

// ── 格式化日期 ──
const formatMessageTime = (ts: number): string => {
  const d = new Date(ts);
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `今天 ${hours}:${minutes}`;
};

// ── 挂载推拉同步 Hook ──
usePluginSync({
  pluginName: 'therapy',
  eventName: 'sessions-updated',
  fetchFn: async () => {
    await loadSessions();
    if (currentSessionId.value) {
      await loadHistory(currentSessionId.value);
    }
  }
});

onMounted(async () => {
  await loadUserProfile();
  await checkDisclaimer();
  if (isDisclaimerAccepted.value) {
    await loadSessions();
  }

  // 绑定主进程 IPC Stream Chunk 监听器
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.on('therapy-message-chunk', handleMessageChunk);
  }
  if (window.api && window.api.receive) {
    window.api.receive('plugin:therapy:message-chunk', handleMessageChunk);
  }
});

// ── 消息多选删除相关 ──
const isMultiSelectMode = ref(false);
const selectedMessageIds = ref<string[]>([]);

const toggleMultiSelectMode = () => {
  isMultiSelectMode.value = !isMultiSelectMode.value;
  selectedMessageIds.value = [];
};

const toggleSelectMessage = (msgId: string) => {
  if (!isMultiSelectMode.value) return;
  const idx = selectedMessageIds.value.indexOf(msgId);
  if (idx > -1) {
    selectedMessageIds.value.splice(idx, 1);
  } else {
    selectedMessageIds.value.push(msgId);
  }
};

const deleteSelectedMessages = async () => {
  if (selectedMessageIds.value.length === 0) return;
  const confirmed = await showCustomDialog({
    title: '删除对话',
    message: `确定要永久删除这 ${selectedMessageIds.value.length} 条对话吗？删除后此部分对话将不会再作为上下文记忆传给 AI。`,
    type: 'danger',
    isConfirm: true
  });
  if (!confirmed) return;

  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('therapy-delete-messages', {
      messageIds: selectedMessageIds.value,
      sessionId: currentSessionId.value
    });
    if (res && res.success) {
      isMultiSelectMode.value = false;
      selectedMessageIds.value = [];
      if (currentSessionId.value) {
        await loadHistory(currentSessionId.value);
      }
    } else {
      await showCustomDialog({
        title: '删除失败',
        message: `删除失败: ${res?.error || '未知错误'}`,
        type: 'danger'
      });
    }
  } catch (err) {
    console.error('删除消息失败:', err);
  }
};

onUnmounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.removeAllListeners('therapy-message-chunk');
  }
});
</script>

<template>
  <!-- 根节点应用 Serene Sanctuary 沉浸式暗色主题 -->
  <div class="serene-sanctuary w-full h-full flex flex-col overflow-hidden select-none bg-[#151311] text-[#e7e1de]">
    
    <!-- 0. 安全空间开启加载页 -->
    <div 
      v-if="isCheckingDisclaimer" 
      class="flex-1 flex flex-col items-center justify-center p-6 bg-[#151311] space-y-4"
    >
      <Loader2Icon class="w-8 h-8 text-[#f8bb73] animate-spin" />
      <div class="text-center">
        <p class="text-xs text-[#e7e1de] font-semibold">正在连结您的情绪避风港...</p>
        <p class="text-[10px] text-[#d5c4b4]/50 mt-1">正在初始化本地加密安全通道</p>
      </div>
    </div>

    <!-- 1. 免责声明页 -->
    <div 
      v-else-if="isDisclaimerAccepted === false" 
      class="flex-1 flex items-center justify-center p-6 bg-[#151311]"
    >
      <div class="w-full max-w-[28rem] p-8 rounded-2xl bg-[#1d1b19] border border-[#504539]/20 shadow-2xl flex flex-col items-center text-center">
        <!-- Leaf/Nature Icon -->
        <div class="w-16 h-16 mb-6 rounded-full bg-[#f8bb73]/10 flex items-center justify-center text-[#f8bb73]">
          <LeafIcon class="w-8 h-8 animate-pulse" />
        </div>
        
        <h2 class="text-2xl font-semibold mb-3 text-[#f8bb73]">开启您的心理按摩之旅</h2>
        <p class="text-sm text-[#d5c4b4] leading-relaxed mb-6">
          欢迎来到此处安静的避风港。这是一个专为您打造的情绪疏导空间，旨在通过倾听与陪伴，缓解您内心的疲惫。
        </p>

        <!-- Warning details card -->
        <div class="w-full p-4 mb-8 rounded-xl bg-[#211f1d] border border-[#504539]/10 text-left text-xs text-[#d5c4b4] leading-relaxed">
          <p class="mb-3 font-medium text-[#e7e1de]">
            在这里，您可以卸下防备，自由地表达。所有的对话都将处于严格的隐私隔离状态，不会被记录或用于任何其他用途。
          </p>
          <p>
            我们致力于提供温暖的倾听，但请知悉，此服务并非医疗诊断或专业心理治疗替代方案。如果您感到极度不适或情绪无法承受，请务必寻求专业的医疗帮助。
          </p>
        </div>

        <!-- Accept Button (Pill) -->
        <button 
          @click="acceptDisclaimer"
          class="w-full py-3.5 mb-4 rounded-full bg-gradient-to-r from-[#f8bb73] to-[#d9a05b] hover:from-[#d9a05b] hover:to-[#f8bb73] text-[#472a00] font-semibold text-sm transition-all duration-300 shadow-md hover:shadow-[#f8bb73]/20"
        >
          我已了解并开始倾听时光
        </button>

        <button 
          @click="emit('exit')"
          class="text-xs text-[#d5c4b4]/60 hover:text-[#d5c4b4] transition-colors underline underline-offset-4"
        >
          返回首页
        </button>
      </div>
    </div>

    <!-- 2. 主页面 (会话及对话展示) -->
    <div v-else-if="isDisclaimerAccepted === true" class="flex-1 flex min-h-0 overflow-hidden relative">
      
      <!-- 2.1 左侧：倾听时光列表 -->
      <aside 
        class="flex flex-col bg-[#1d1b19] min-h-0 transition-transform duration-300 ease-in-out"
        :class="[
          isMobile 
            ? 'fixed inset-y-0 left-0 z-30 w-64 shadow-2xl' 
            : 'relative w-64 flex-shrink-0 border-r border-[#504539]/20',
          isMobile && !showSidebar ? '-translate-x-full' : 'translate-x-0'
        ]"
      >
        <!-- 侧栏顶部 -->
        <div class="p-4 border-b border-[#504539]/20 flex flex-col space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-semibold text-[#d5c4b4]">倾听时光</h2>
            <button 
              @click="emit('exit')"
              class="p-1 rounded-lg hover:bg-[#2c2927] text-[#d5c4b4] transition-colors"
              title="退出心理按摩"
            >
              <ArrowLeftIcon class="w-4 h-4" />
            </button>
          </div>
          
          <!-- 新建会话按钮 -->
          <button 
            @click="openCreateModal"
            class="w-full py-2 px-3 border border-[#f8bb73]/30 hover:border-[#f8bb73] text-[#f8bb73] rounded-full text-xs font-medium flex items-center justify-center space-x-1.5 transition-all duration-300 hover:bg-[#f8bb73]/5"
          >
            <PlusIcon class="w-3.5 h-3.5" />
            <span>开启新的倾听时光</span>
          </button>
        </div>

        <!-- 列表内容 -->
        <div class="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
          <div v-if="sessions.length === 0" class="text-center py-8 text-xs text-[#d5c4b4]/40">
            暂无倾听时光，点击上方开启新篇章
          </div>
          
          <div 
            v-for="session in sessions" 
            :key="session.id"
            @click="selectSession(session.id)"
            class="group p-3 rounded-xl flex items-center justify-between cursor-pointer transition-all duration-300 relative overflow-hidden"
            :class="[
              session.id === currentSessionId 
                ? 'bg-[#2c2927] border border-[#504539]/40' 
                : 'hover:bg-[#211f1d] border border-transparent'
            ]"
          >
            <!-- 角色信息 -->
            <div class="flex items-center space-x-2.5 min-w-0 flex-1">
              <div class="w-8 h-8 rounded-full overflow-hidden bg-[#211f1d] flex-shrink-0 border border-[#504539]/20">
                <img 
                  v-if="avatarCache[session.character_id]" 
                  :src="avatarCache[session.character_id]" 
                  class="w-full h-full object-cover" 
                />
                <div v-else class="w-full h-full flex items-center justify-center text-xs bg-[#f8bb73]/10 text-[#f8bb73]">
                  {{ session.character_name?.[0] || '听' }}
                </div>
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold text-[#e7e1de] truncate">
                  {{ session.character_name }}
                </p>
                <p class="text-[10px] text-[#d5c4b4]/60 truncate mt-0.5">
                  {{ session.title }}
                </p>
              </div>
            </div>

            <!-- 删除按钮 -->
            <button 
              @click.stop="deleteSession(session.id)"
              class="p-1 hover:bg-[#151311] text-[#ffb4ab] rounded-lg transition-all duration-200"
              title="删除会话"
            >
              <Trash2Icon class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <!-- 移动端侧栏遮罩层 -->
      <div 
        v-if="isMobile && showSidebar" 
        class="fixed inset-0 z-20 bg-[#100e0c]/60 backdrop-blur-xs transition-opacity duration-300"
        @click="showSidebar = false"
      ></div>

      <!-- 2.2 右侧：对话主窗 -->
      <main class="flex-1 flex flex-col bg-[#151311] min-w-0 relative">
        <!-- 头部导航 -->
        <header class="h-14 px-4 sm:px-6 border-b border-[#504539]/20 flex items-center justify-between bg-[#151311] flex-shrink-0">
          <div class="flex items-center space-x-3 min-w-0">
            <!-- 移动端侧栏开关按钮 -->
            <button 
              v-if="isMobile"
              @click="showSidebar = !showSidebar"
              class="p-1.5 -ml-1.5 rounded-lg hover:bg-[#2c2927] text-[#d5c4b4] transition-colors flex-shrink-0"
              title="打开侧边栏"
            >
              <MenuIcon class="w-5 h-5" />
            </button>

            <div 
              v-if="currentSession" 
              class="w-8 h-8 rounded-full overflow-hidden bg-[#1d1b19] border border-[#504539]/20 flex-shrink-0"
            >
              <img 
                v-if="avatarCache[currentSession.character_id]" 
                :src="avatarCache[currentSession.character_id]" 
                class="w-full h-full object-cover" 
              />
              <div v-else class="w-full h-full flex items-center justify-center text-xs bg-[#f8bb73]/10 text-[#f8bb73]">
                {{ currentSession.character_name?.[0] }}
              </div>
            </div>
            <div class="min-w-0">
              <h1 class="text-xs font-bold text-[#e7e1de] truncate">
                {{ currentSession ? currentSession.character_name : '未选择会话' }}
              </h1>
              <p class="text-[10px] text-[#d5c4b4]/50 truncate mt-0.5 flex items-center space-x-1">
                <LockIcon class="w-2.5 h-2.5 text-[#d7c4ab]/60" />
                <span>专属隐私空间</span>
              </p>
            </div>
          </div>

          <!-- 右侧操作栏（包括多选管理按钮和退出按钮） -->
          <div class="flex items-center space-x-2">
            <!-- 管理/多选消息按钮 -->
            <button 
              v-if="currentSessionId && messages.length > 0"
              @click="toggleMultiSelectMode"
              class="px-2.5 py-1 text-[11px] font-semibold border rounded-full transition-all duration-300 flex-shrink-0"
              :class="[
                isMultiSelectMode 
                  ? 'border-[#ffb4ab] text-[#ffb4ab] bg-[#ffb4ab]/5 hover:bg-[#ffb4ab]/15' 
                  : 'border-[#504539] text-[#d5c4b4] hover:border-[#f8bb73] hover:text-[#f8bb73]'
              ]"
            >
              {{ isMultiSelectMode ? '取消管理' : '管理对话' }}
            </button>

            <!-- 移动端退出按钮 -->
            <button 
              v-if="isMobile"
              @click="emit('exit')"
              class="p-1.5 rounded-lg hover:bg-[#2c2927] text-[#d5c4b4] transition-colors"
              title="退出心理按摩"
            >
              <ArrowLeftIcon class="w-5 h-5" />
            </button>
          </div>
        </header>

        <!-- 对话框消息区域 -->
        <div 
          ref="chatMessageContainer"
          class="flex-1 overflow-y-auto px-4 sm:px-6 py-6 sm:py-8 min-h-0 flex flex-col space-y-6"
        >
          <div v-if="!currentSessionId" class="flex-1 flex flex-col items-center justify-center text-center">
            <LeafIcon class="w-12 h-12 text-[#f8bb73]/15 mb-3 animate-pulse" />
            <p class="text-sm text-[#d5c4b4]/40">在这片安静之地，选择左侧角色或新建倾听时光，开启您的心里按摩</p>
          </div>

          <div v-else class="w-full max-w-[50rem] mx-auto flex flex-col space-y-6">
            <template v-for="(msg, index) in messages" :key="msg.id">
              <!-- 时间注记 -->
              <div 
                v-if="index === 0 || msg.timestamp - messages[index - 1].timestamp > 5 * 60 * 1000"
                class="text-center"
              >
                <span class="text-[10px] px-2 py-0.5 rounded-full bg-[#1d1b19] text-[#d5c4b4]/40">
                  {{ formatMessageTime(msg.timestamp) }}
                </span>
              </div>

              <!-- 消息气泡 -->
              <div 
                class="flex w-full items-start space-x-3 group transition-all duration-200"
                :class="[
                  msg.role === 'user' ? 'justify-end' : 'justify-start',
                  isMultiSelectMode ? 'hover:bg-[#211f1d]/30 py-1.5 px-2.5 rounded-2xl cursor-pointer' : ''
                ]"
                @click="toggleSelectMessage(msg.id)"
              >
                <!-- 复选框 (用户消息时，贴着气泡左侧，渲染在最前面) -->
                <div 
                  v-if="isMultiSelectMode && msg.role === 'user'" 
                  class="flex-shrink-0 self-center mr-1.5 w-5 h-5 rounded-full border flex items-center justify-center transition-all duration-300"
                  :class="[
                    selectedMessageIds.includes(msg.id) 
                      ? 'border-[#f8bb73] bg-[#f8bb73] text-[#472a00]' 
                      : 'border-[#504539] hover:border-[#f8bb73]'
                  ]"
                >
                  <svg v-if="selectedMessageIds.includes(msg.id)" class="w-3.5 h-3.5 stroke-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <!-- AI 头像 (居左) -->
                <div 
                  v-if="msg.role !== 'user' && currentSession"
                  class="w-8 h-8 rounded-full overflow-hidden bg-[#1d1b19] border border-[#504539]/20 flex-shrink-0"
                >
                  <img 
                    v-if="avatarCache[currentSession.character_id]" 
                    :src="avatarCache[currentSession.character_id]" 
                    class="w-full h-full object-cover" 
                  />
                  <div v-else class="w-full h-full flex items-center justify-center text-xs bg-[#f8bb73]/10 text-[#f8bb73]">
                    {{ currentSession.character_name?.[0] || '听' }}
                  </div>
                </div>

                <!-- 气泡内容 -->
                <div 
                  class="max-w-[75%] rounded-2xl py-3 px-4 text-sm leading-relaxed"
                  :class="[
                    msg.role === 'user'
                      ? 'bg-[#2c2927] text-[#e7e1de] border border-[#504539]/20'
                      : 'bg-[#1d1b19] text-[#e7e1de] border border-[#504539]/10'
                  ]"
                >
                  <div 
                    class="select-text selection:bg-[#f8bb73]/30 selection:text-[#f8bb73] markdown-body"
                    v-html="renderMarkdown(msg.content)"
                  ></div>
                </div>

                <!-- 用户头像 (居右) -->
                <div 
                  v-if="msg.role === 'user'"
                  class="w-8 h-8 rounded-full overflow-hidden bg-[#1d1b19] border border-[#504539]/20 flex-shrink-0"
                >
                  <img 
                    :src="userAvatarUrl || defaultAvatarUrl" 
                    class="w-full h-full object-cover" 
                  />
                </div>

                <!-- 复选框 (角色消息时，贴着气泡右侧，渲染在最后面) -->
                <div 
                  v-if="isMultiSelectMode && msg.role !== 'user'" 
                  class="flex-shrink-0 self-center ml-1.5 w-5 h-5 rounded-full border flex items-center justify-center transition-all duration-300"
                  :class="[
                    selectedMessageIds.includes(msg.id) 
                      ? 'border-[#f8bb73] bg-[#f8bb73] text-[#472a00]' 
                      : 'border-[#504539] hover:border-[#f8bb73]'
                  ]"
                >
                  <svg v-if="selectedMessageIds.includes(msg.id)" class="w-3.5 h-3.5 stroke-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </template>

            <!-- 3. AI正在呼吸思考状态 -->
            <div v-if="isThinking" class="flex w-full justify-start items-start space-x-3">
              <!-- AI 头像 -->
              <div 
                v-if="currentSession"
                class="w-8 h-8 rounded-full overflow-hidden bg-[#1d1b19] border border-[#504539]/20 flex-shrink-0"
              >
                <img 
                  v-if="avatarCache[currentSession.character_id]" 
                  :src="avatarCache[currentSession.character_id]" 
                  class="w-full h-full object-cover" 
                />
                <div v-else class="w-full h-full flex items-center justify-center text-xs bg-[#f8bb73]/10 text-[#f8bb73]">
                  {{ currentSession.character_name?.[0] || '听' }}
                </div>
              </div>
              <div class="flex items-center h-8 space-x-2">
                <Loader2Icon class="w-3.5 h-3.5 animate-spin text-[#f8bb73]" />
                <span class="text-xs text-[#d5c4b4]/60 italic">正在认真聆听和思考你的诉说...</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部消息输入区域 / 多选管理工具条 -->
        <div v-if="currentSessionId" class="p-3 sm:p-4 bg-[#151311] border-t border-[#504539]/20 flex flex-col items-center">
          <!-- 1. 多选管理工具栏 -->
          <div 
            v-if="isMultiSelectMode" 
            class="w-full max-w-[50rem] flex items-center justify-between py-2.5 px-4 rounded-xl bg-[#1d1b19] border border-[#ffb4ab]/20 transition-all duration-300"
          >
            <span class="text-xs text-[#d5c4b4] font-medium">
              已选择 <strong class="text-[#f8bb73] font-bold mx-1">{{ selectedMessageIds.length }}</strong> 条对话
            </span>
            <div class="flex items-center space-x-3">
              <button 
                @click="toggleMultiSelectMode"
                class="px-4 py-2 rounded-full border border-[#504539] hover:border-[#d5c4b4] text-[#d5c4b4] text-xs font-semibold transition-colors"
              >
                取消
              </button>
              <button 
                @click="deleteSelectedMessages"
                :disabled="selectedMessageIds.length === 0"
                class="px-5 py-2 rounded-full bg-[#ffb4ab] hover:bg-[#ffb4ab]/80 text-[#561e18] text-xs font-bold transition-all duration-300 disabled:opacity-40 disabled:cursor-not-allowed shadow-md hover:shadow-[#ffb4ab]/10"
              >
                删除所选 ({{ selectedMessageIds.length }})
              </button>
            </div>
          </div>

          <!-- 2. 原版常规消息输入区域 -->
          <div v-else class="w-full max-w-[50rem] flex flex-col space-y-2">
            <div class="flex items-center space-x-2">
              <!-- 输入栏（Soft Well 暗色井设计） -->
              <div class="flex-1 relative flex items-center bg-[#1d1b19] border border-[#504539]/30 rounded-xl px-4 focus-within:border-[#bccbb1] transition-all duration-300">
                <input 
                  v-model="inputText"
                  @keydown.enter="sendMessage"
                  type="text" 
                  placeholder="把你的压力都倾诉在这里吧..."
                  class="w-full py-3.5 bg-transparent text-sm text-[#e7e1de] outline-none placeholder-[#d5c4b4]/40"
                  :disabled="isThinking"
                />
                
                <!-- 快捷发送按钮 -->
                <button 
                  @click="sendMessage"
                  class="p-1 rounded-lg text-[#f8bb73] hover:text-[#d9a05b] disabled:opacity-30 transition-colors"
                  :disabled="!inputText.trim() || isThinking"
                >
                  <SendIcon class="w-4 h-4" />
                </button>
              </div>
            </div>

            <!-- Reassuring Shield (Privacy Banner) -->
            <div class="flex items-center justify-center space-x-1.5 text-[10px] text-[#d7c4ab]/50 py-1">
              <ShieldCheckIcon class="w-3.5 h-3.5 text-[#bccbb1]" />
              <span>内容受平台最高安全及本地加密防线保护，绝不上传云端</span>
            </div>
          </div>
        </div>
      </main>
    </div>

    <!-- 3. 新开会话弹出 Modal -->
    <div 
      v-if="showCreateModal" 
      class="fixed inset-0 z-50 bg-[#100e0c]/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div class="w-full max-w-sm rounded-2xl bg-[#1d1b19] border border-[#504539]/30 shadow-2xl p-6 flex flex-col max-h-[85vh]">
        <!-- 头部 -->
        <div class="flex items-center justify-between mb-4 flex-shrink-0">
          <h3 class="text-sm font-semibold text-[#f8bb73]">选择倾心倾听的 AI 角色</h3>
          <button 
            @click="showCreateModal = false"
            class="p-1 rounded-lg hover:bg-[#2c2927] text-[#d5c4b4] transition-colors"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>

        <!-- 角色选择区 -->
        <div class="flex-1 overflow-y-auto space-y-2 pr-1 mb-6">
          <div v-if="allCharacters.length === 0" class="text-center py-6 text-xs text-[#d5c4b4]/40">
            通讯录里空空如也，请先去主页导入人设卡角色
          </div>
          
          <div 
            v-for="char in allCharacters" 
            :key="char.id"
            @click="selectedCharId = char.id"
            class="p-2.5 rounded-xl border cursor-pointer transition-all duration-300 flex items-center space-x-3"
            :class="[
              selectedCharId === char.id 
                ? 'bg-[#2c2927]/60 border-[#f8bb73]/60' 
                : 'bg-[#211f1d]/40 border-[#504539]/20 hover:bg-[#211f1d]'
            ]"
          >
            <div class="w-9 h-9 rounded-full overflow-hidden bg-[#1d1b19] border border-[#504539]/20 flex-shrink-0">
              <img 
                v-if="avatarCache[char.id]" 
                :src="avatarCache[char.id]" 
                class="w-full h-full object-cover" 
              />
              <div v-else class="w-full h-full flex items-center justify-center text-xs bg-[#f8bb73]/10 text-[#f8bb73]">
                {{ char.name?.[0] }}
              </div>
            </div>
            <div class="min-w-0">
              <p class="text-xs font-semibold text-[#e7e1de]">
                {{ char.name }}
              </p>
            </div>
          </div>
        </div>

        <!-- 会话命名 -->
        <div class="mb-6 flex-shrink-0">
          <label class="block text-[10px] text-[#d5c4b4]/60 mb-1.5 uppercase tracking-wider font-semibold">
            给这段时光命名（可选）
          </label>
          <input 
            v-model="newSessionTitle"
            type="text" 
            placeholder="例如：深夜解忧、工作吐槽..."
            class="w-full py-2.5 px-3.5 bg-[#211f1d] border border-[#504539]/30 focus:border-[#f8bb73] rounded-xl text-xs text-[#e7e1de] outline-none"
          />
        </div>

        <!-- 提交按钮 -->
        <button 
          @click="createSession"
          :disabled="!selectedCharId"
          class="w-full py-3 rounded-full bg-[#f8bb73] hover:bg-[#d9a05b] text-[#472a00] font-semibold text-xs transition-colors flex items-center justify-center space-x-2 shadow-md disabled:opacity-40"
        >
          <span>开启倾听时光</span>
        </button>
      </div>
    </div>

    <!-- 4. 全屏生成加载器（新建时光） -->
    <div 
      v-if="isGenerating" 
      class="fixed inset-0 z-50 bg-[#100e0c]/90 flex flex-col items-center justify-center text-center space-y-4"
    >
      <Loader2Icon class="w-8 h-8 text-[#f8bb73] animate-spin" />
      <div>
        <p class="text-xs text-[#e7e1de] font-semibold">正在连结 AI 倾听师...</p>
        <p class="text-[10px] text-[#d5c4b4]/50 mt-1">正在融合角色卡人设，动态生成专属开场白，请稍候</p>
      </div>
    </div>

    <!-- ── 全局自定义高颜值模态对话框 ── -->
    <div 
      v-if="dialogConfig.show" 
      class="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-background/60 backdrop-blur-md transition-all duration-300"
    >
      <div 
        class="w-[340px] max-w-full p-6 rounded-2xl border border-outline-variant/30 bg-surface shadow-2xl flex flex-col items-center text-center transform scale-100 transition-all duration-300"
      >
        <!-- 头部图标 (根据类型变化) -->
        <div 
          :class="[
            dialogConfig.type === 'danger' ? 'bg-error/10 text-error' :
            dialogConfig.type === 'warning' ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'
          ]"
          class="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 animate-bounce"
        >
          <SparklesIcon v-if="dialogConfig.type === 'info'" class="w-6 h-6" />
          <LockIcon v-else-if="dialogConfig.type === 'warning'" class="w-6 h-6" />
          <Trash2Icon v-else-if="dialogConfig.type === 'danger'" class="w-5 h-5" />
        </div>

        <h3 class="text-sm font-bold text-on-surface mt-4">{{ dialogConfig.title }}</h3>
        <p class="text-xs text-on-surface-variant/80 mt-2.5 leading-relaxed break-all whitespace-pre-wrap select-text">
          {{ dialogConfig.message }}
        </p>

        <!-- 底部按钮区 -->
        <div class="flex items-center w-full gap-3 mt-6">
          <button 
            v-if="dialogConfig.isConfirm"
            @click="handleDialogCancel"
            class="flex-1 py-2 px-3 rounded-xl border border-outline-variant/40 bg-surface hover:bg-surface-high text-xs font-bold text-on-surface-variant active:scale-95 transition-all cursor-pointer"
          >
            取消
          </button>
          <button 
            @click="handleDialogConfirm"
            :class="[
              dialogConfig.type === 'danger' ? 'bg-error !text-on-error hover:bg-error/90' :
              dialogConfig.type === 'warning' ? 'bg-warning !text-on-warning hover:bg-warning/90' : 'bg-primary !text-on-primary hover:bg-primary/90'
            ]"
            class="flex-1 py-2 px-3 rounded-xl text-xs font-bold active:scale-95 transition-all shadow-sm cursor-pointer"
          >
            {{ dialogConfig.isConfirm ? '确定' : '好的' }}
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 引入 Plus Jakarta Sans 字体 fallback 兼容 */
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');

.serene-sanctuary {
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  line-height: 1.6;
}

/* 隐藏滚动条但保留滚动能力 */
.overflow-y-auto {
  scrollbar-width: thin;
  scrollbar-color: #504539 rgba(0, 0, 0, 0.1);
}

.overflow-y-auto::-webkit-scrollbar {
  width: 5px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background-color: #504539;
  border-radius: 20px;
}

/* 自定义气泡内 Markdown 渲染样式，与避风港静谧暗色及暖金色风格融合 */
:deep(.markdown-body) {
  background: transparent !important;
  color: inherit !important;
  font-size: inherit !important;
  line-height: inherit !important;
}

:deep(.markdown-body p) {
  margin-bottom: 0.5rem;
}

:deep(.markdown-body p:last-child) {
  margin-bottom: 0;
}

:deep(.markdown-body ul) {
  list-style-type: disc !important;
  padding-left: 1.25rem !important;
  margin-bottom: 0.5rem !important;
}

:deep(.markdown-body ol) {
  list-style-type: decimal !important;
  padding-left: 1.25rem !important;
  margin-bottom: 0.5rem !important;
}

:deep(.markdown-body li) {
  margin-bottom: 0.25rem !important;
}

:deep(.markdown-body code) {
  background-color: rgba(248, 187, 115, 0.15) !important;
  color: #f8bb73 !important;
  padding: 0.125rem 0.25rem !important;
  border-radius: 0.25rem !important;
  font-family: monospace !important;
  font-size: 0.85em !important;
}

:deep(.markdown-body strong) {
  color: #f8bb73 !important;
  font-weight: 600 !important;
}
</style>
