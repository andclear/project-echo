<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import {
  ChevronLeftIcon,
  ChevronDownIcon,
  PlayIcon,
  PlusIcon,
  UsersIcon,
  SearchIcon,
  XIcon,
  Loader2Icon,
  Trash2Icon
} from 'lucide-vue-next';
import LiveStreamRoom from './LiveStreamRoom.vue';

defineProps<{
  isMobile: boolean;
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

// 视图控制
type ViewState = 'lobby' | 'room';
const viewState = ref<ViewState>('lobby');

// 大厅下的子视图：历史大厅 ('history') 或 开播配置表单 ('create')
const lobbySubView = ref<'history' | 'create'>('history');

// 数据
const allCharacters = ref<any[]>([]);
const isLoadingChars = ref(false);

// 历史直播场次
const historySessions = ref<any[]>([]);
const isLoadingHistory = ref(false);

// 持久化的自定义分类提示词缓存
const savedPrompts = ref<Record<string, string>>({});

// 恢复直播时保存的历史弹幕消息
const resumedHistoryMessages = ref<any[]>([]);

const selectedHost = ref<any>(null);
const liveTheme = ref('');
const liveDirection = ref('情感');

const presetDirections = ['颜值', '情感', '游戏', '闲聊', '二次元'];

const availableDirections = computed(() => {
  const customKeys = Object.keys(savedPrompts.value).filter(
    key => !presetDirections.includes(key) && key !== '自定义'
  );
  return [...presetDirections, ...customKeys, '自定义'];
});

const livePrompt = ref('');

const defaultPrompts: Record<string, string> = {
  '颜值': '此直播间主打主播的外貌与气质展示。主播连线发言时更注重形象表现，谈吐优雅，对心动观众的打赏给予极其甜美、羞涩而热情的感谢与宠溺反馈。',
  '情感': '此直播间主打主播与观众的深度心灵沟通。主播发言温和细腻，擅长倾听并疏导情绪，对送礼物的观众会给予充满安全感、信赖且亲密的专属回应。',
  '游戏': '此直播间主打主播、用户以及其他观众之间的游戏话题互动与闲聊。主播发言爽朗大方、对各类游戏了如指掌且带有一些俏皮吐槽，对打赏送礼的观众会给予极为热烈、如同并肩作战的游戏队友般的义气回应。',
  '闲聊': '此直播间为轻松日常的围炉闲聊。主播发言随意亲切，像老朋友般与观众插科打诨、分享日常，对高等级和送礼的观众会给予极为熟稔、幽默的打趣互动。',
  '二次元': '此直播间为动漫萌系与声控电台。主播发言中会融入经典的ACG角色语气与萌系用词（如“欧尼酱”、“萌萌哒”等），声音甜美有元气，对打赏观众会给予极其可爱、元气满满的谢礼回馈。',
  '自定义': ''
};

const customDirectionName = ref('');
const customDirectionPrompt = ref('');

watch(liveDirection, (newDir) => {
  if (newDir === '自定义') {
    livePrompt.value = '';
    customDirectionName.value = '';
    customDirectionPrompt.value = '';
  } else if (savedPrompts.value[newDir] !== undefined) {
    livePrompt.value = savedPrompts.value[newDir];
  } else if (defaultPrompts[newDir]) {
    livePrompt.value = defaultPrompts[newDir];
  } else {
    livePrompt.value = '';
  }
});

// 弹窗控制
const isSelectModalOpen = ref(false);
const searchKeyword = ref('');

// 当前直播 Session
const activeSessionId = ref('');
const activeVipCharacters = ref<any[]>([]);
const hasMetBefore = ref(false);
const activeUserNickname = ref('用户');
const activeUserAvatar = ref('');
const isStarting = ref(false);

// Toast
const toastVisible = ref(false);
const toastMessage = ref('');
let toastTimer: any = null;

function showToast(msg: string) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMessage.value = msg;
  toastVisible.value = true;
  toastTimer = setTimeout(() => {
    toastVisible.value = false;
  }, 3000);
}

onMounted(async () => {
  preloadCharacters();
  await loadSavedPrompts();
  await loadHistorySessions();
  if (historySessions.value.length === 0) {
    lobbySubView.value = 'create';
  } else {
    lobbySubView.value = 'history';
  }
});

// 加载历史直播场次
async function loadHistorySessions() {
  isLoadingHistory.value = true;
  try {
    const res = await window.api.invoke('livestream:get-all-sessions');
    if (res.success && res.list) {
      historySessions.value = res.list;
    }
  } catch (e) {
    console.error('加载历史直播场次失败:', e);
  } finally {
    isLoadingHistory.value = false;
  }
}

// 加载持久化的分类提示词
async function loadSavedPrompts() {
  try {
    const res = await window.api.invoke('livestream:get-direction-prompts');
    if (res.success && res.prompts) {
      savedPrompts.value = res.prompts;
    }
  } catch (e) {
    console.error('加载持久化分类提示词失败:', e);
  }
}

// 保存当前分类提示词
async function saveCurrentPrompt() {
  if (!liveDirection.value) return;
  const currentPrompt = livePrompt.value;
  savedPrompts.value[liveDirection.value] = currentPrompt;
  try {
    await window.api.invoke('livestream:save-direction-prompt', {
      direction: liveDirection.value,
      prompt: currentPrompt
    });
  } catch (e) {
    console.error('保存分类提示词失败:', e);
  }
}

async function saveAsNewCategory() {
  const name = customDirectionName.value.trim();
  const promptVal = customDirectionPrompt.value.trim();

  if (!name) {
    showToast('请输入类型名称！');
    return;
  }
  if (!promptVal) {
    showToast('请输入直播间介绍！');
    return;
  }
  if (presetDirections.includes(name) || name === '自定义') {
    showToast('类型名称与系统预设类别重名，请重新命名！');
    return;
  }

  try {
    const res = await window.api.invoke('livestream:save-direction-prompt', {
      direction: name,
      prompt: promptVal
    });
    if (res.success) {
      showToast(`保存新类别“${name}”成功！`);
      savedPrompts.value[name] = promptVal;
      liveDirection.value = name;
      livePrompt.value = promptVal;
      customDirectionName.value = '';
      customDirectionPrompt.value = '';
    } else {
      showToast(`保存失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`保存异常: ${e.message || e}`);
  }
}

// 删除会话相关状态
const isConfirmDeleteOpen = ref(false);
const deletingSessionId = ref('');
const deletingSessionTheme = ref('');
const isDeleting = ref(false);

function requestDeleteSession(session: any) {
  deletingSessionId.value = session.id;
  deletingSessionTheme.value = session.theme;
  isConfirmDeleteOpen.value = true;
}

async function executeDeleteSession() {
  if (!deletingSessionId.value) return;
  isDeleting.value = true;
  try {
    const res = await window.api.invoke('livestream:delete-session', {
      sessionId: deletingSessionId.value
    });
    if (res.success) {
      showToast('删除历史直播成功！');
      await loadHistorySessions();
      if (historySessions.value.length === 0) {
        lobbySubView.value = 'create';
      }
    } else {
      showToast(`删除失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`删除异常: ${e.message || e}`);
  } finally {
    isConfirmDeleteOpen.value = false;
    deletingSessionId.value = '';
    deletingSessionTheme.value = '';
    isDeleting.value = false;
  }
}

// 预加载系统通讯录的角色
async function preloadCharacters() {
  isLoadingChars.value = true;
  try {
    const res = await window.api.invoke('get-characters');
    if (res.success && res.characters) {
      const list = res.characters.map((char: any) => ({ ...char }));
      const enrichedList = [];
      for (const char of list) {
        let avatarUrl = '';
        try {
          const avatarData = await window.api.invoke('get-character-avatar', char.folder_name);
          avatarUrl = avatarData || '';
        } catch (_) {}
        
        enrichedList.push({
          ...char,
          avatarUrl
        });
      }
      allCharacters.value = enrichedList;
    } else {
      showToast(`加载通讯录列表失败: ${res.error || '未知错误'}`);
    }
  } catch (e: any) {
    showToast(`加载通讯录列表失败: ${e.message || e}`);
  } finally {
    isLoadingChars.value = false;
  }
}

// 弹出选择角色弹窗
function openSelectHostModal() {
  searchKeyword.value = '';
  isSelectModalOpen.value = true;
  preloadCharacters();
}

// 选定角色
function handleSelectHost(host: any) {
  selectedHost.value = host;
  liveTheme.value = `${host.name}的直播间`;
  liveDirection.value = '情感';
  livePrompt.value = savedPrompts.value['情感'] !== undefined ? savedPrompts.value['情感'] : defaultPrompts['情感'];
  isSelectModalOpen.value = false;
}

// 过滤后的角色列表
const filteredCharacters = computed(() => {
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return allCharacters.value;
  return allCharacters.value.filter(c => c.name.toLowerCase().includes(kw));
});

// 开播
async function startLive() {
  if (!selectedHost.value) {
    showToast('请先选择开播的主播角色！');
    return;
  }
  if (!liveTheme.value.trim()) {
    showToast('请输入直播主题！');
    return;
  }
  
  isStarting.value = true;
  try {
    // 乐观保存最新提示词
    await saveCurrentPrompt();

    const res = await window.api.invoke('livestream:start-session', {
      characterId: selectedHost.value.id,
      theme: liveTheme.value,
      direction: liveDirection.value,
      customPrompt: livePrompt.value
    });

    if (res.success) {
      activeSessionId.value = res.sessionId;
      activeVipCharacters.value = res.vipCharacters;
      hasMetBefore.value = res.hasMet;
      activeUserNickname.value = res.userNickname || '用户';
      activeUserAvatar.value = res.userAvatar || '';
      resumedHistoryMessages.value = []; // 新开播清空历史缓存
      viewState.value = 'room';
    } else {
      showToast(`开播失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`开播异常: ${e.message || e}`);
  } finally {
    isStarting.value = false;
  }
}

// 新建直播
function clickNewLive() {
  selectedHost.value = null;
  liveTheme.value = '';
  liveDirection.value = '情感';
  livePrompt.value = savedPrompts.value['情感'] !== undefined ? savedPrompts.value['情感'] : defaultPrompts['情感'];
  lobbySubView.value = 'create';
  openSelectHostModal();
}

// 恢复历史直播
async function resumeLive(sessionId: string) {
  isStarting.value = true;
  try {
    const res = await window.api.invoke('livestream:resume-session', { sessionId });
    if (res.success) {
      activeSessionId.value = res.sessionId;
      activeVipCharacters.value = res.vipCharacters;
      hasMetBefore.value = res.hasMet;
      activeUserNickname.value = res.userNickname || '用户';
      activeUserAvatar.value = res.userAvatar || '';
      resumedHistoryMessages.value = res.initialMessages || [];
      
      let host = allCharacters.value.find(c => c.id === res.characterId);
      if (!host) {
        host = {
          id: res.characterId,
          name: res.hostName,
          folder_name: res.hostFolderName,
          avatarUrl: res.hostAvatar
        };
      }
      selectedHost.value = host;
      liveTheme.value = res.theme;
      liveDirection.value = res.direction;
      livePrompt.value = res.prompt || '';
      
      viewState.value = 'room';
    } else {
      showToast(`恢复直播失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`恢复直播异常: ${e.message || e}`);
  } finally {
    isStarting.value = false;
  }
}

// 头部返回逻辑
function handleHeaderBack() {
  if (lobbySubView.value === 'create' && historySessions.value.length > 0) {
    lobbySubView.value = 'history';
  } else {
    emit('exit');
  }
}

function exitRoom() {
  viewState.value = 'lobby';
  selectedHost.value = null;
  liveTheme.value = '';
  preloadCharacters();
  loadHistorySessions(); // 退回时重载历史
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0 bg-background text-on-surface overflow-hidden select-none animate-fade-in">
    
    <!-- ── 1. 直播间模式 ── -->
    <div v-if="viewState === 'room'" class="flex-1 flex flex-col min-h-0">
      <LiveStreamRoom
        :sessionId="activeSessionId"
        :host="selectedHost"
        :theme="liveTheme"
        :direction="liveDirection"
        :vipCharacters="activeVipCharacters"
        :hasMet="hasMetBefore"
        :isMobile="isMobile"
        :userNickname="activeUserNickname"
        :userAvatar="activeUserAvatar"
        :initialMessages="resumedHistoryMessages"
        @exit="exitRoom"
      />
    </div>

    <!-- ── 2. 首界面 (与大剧院结构完全一致) ── -->
    <div v-else class="flex-1 flex flex-col min-h-0 overflow-hidden">
      <!-- 顶部 Header (大剧院同款高14 px-6 border-b bg-surface) -->
      <header
        class="h-14 px-6 border-b border-outline-variant/30 bg-surface flex items-center justify-between flex-shrink-0"
      >
        <div class="flex items-center space-x-3">
          <button
            @click="handleHeaderBack"
            class="p-1.5 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
            title="返回主面板"
          >
            <ChevronLeftIcon class="w-4 h-4" />
          </button>
          <div>
            <h1 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
              <span>回音直播</span>
            </h1>
          </div>
        </div>

        <!-- 右上角快捷操作 -->
        <div class="flex items-center space-x-2">
          <button
            v-if="lobbySubView === 'history'"
            @click="clickNewLive"
            class="px-3 py-1.5 rounded bg-primary hover:bg-primary/95 text-[11px] font-bold text-white shadow-sm transition-all active:scale-95 cursor-pointer flex items-center gap-1"
          >
            <PlusIcon class="w-3.5 h-3.5" />
            <span>新建直播</span>
          </button>
          <button
            v-else-if="lobbySubView === 'create' && historySessions.length > 0"
            @click="lobbySubView = 'history'"
            class="px-3 py-1.5 rounded bg-surface-high border border-outline-variant/30 text-[11px] font-bold text-on-surface-variant hover:text-on-surface transition-all active:scale-95 cursor-pointer flex items-center gap-1"
          >
            <span>返回列表</span>
          </button>
        </div>
      </header>

      <!-- 主内容区 -->
      <div class="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
        <!-- 子视图 A: 历史大厅 -->
        <div v-if="lobbySubView === 'history'" class="space-y-5">
          <div class="mb-6">
            <h2 class="text-lg font-bold text-on-surface">历史直播记录</h2>
            <p class="text-xs text-on-surface-variant/75 mt-0.5">
              随时进入之前已开启的直播间继续精彩对话，已保存的消息和互动状态将自动恢复。
            </p>
          </div>

          <div v-if="isLoadingHistory" class="flex flex-col items-center justify-center py-12 space-y-2">
            <Loader2Icon class="w-6 h-6 animate-spin text-primary" />
            <span class="text-xs text-on-surface-variant/50">正在加载历史直播...</span>
          </div>

          <div v-else-if="historySessions.length === 0" class="py-12 text-center text-on-surface-variant/40 text-xs">
            暂无历史直播记录，请点击右上角“新建直播”。
          </div>

          <div v-else class="space-y-4">
            <div
              v-for="session in historySessions"
              :key="session.id"
              class="rounded-2xl bg-surface-low border border-outline-variant/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-primary/30 transition-all"
            >
              <div class="flex items-start sm:items-center space-x-3 sm:space-x-4 min-w-0 flex-1">
                <!-- 主播头像 -->
                <img
                  v-if="session.avatar"
                  :src="session.avatar"
                  class="w-12 h-12 rounded-xl object-cover border border-outline-variant/15 flex-shrink-0"
                />
                <div v-else class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center font-bold text-lg text-primary flex-shrink-0">
                  {{ session.char_name[0] }}
                </div>

                <div class="min-w-0 flex-1 space-y-1">
                  <!-- 主题与分类 -->
                  <div class="flex items-center space-x-2">
                    <span class="text-sm font-bold text-on-surface truncate">{{ session.theme }}</span>
                    <span class="px-1.5 py-0.5 text-[10px] font-bold rounded bg-primary/10 text-primary border border-primary/20 flex-shrink-0">
                      {{ session.direction }}
                    </span>
                  </div>

                  <!-- 信息统计 -->
                  <div class="flex flex-wrap items-center gap-1.5 sm:gap-3 text-[11px] text-on-surface-variant/70">
                    <span>主播: <strong class="text-on-surface font-semibold">{{ session.char_name }}</strong></span>
                    <span class="hidden sm:inline text-on-surface-variant/30">•</span>
                    <span>在线: {{ session.viewer_count }}人</span>
                    <span class="hidden sm:inline text-on-surface-variant/30">•</span>
                    <span>累计收益: {{ session.total_earnings }} 回音币</span>
                  </div>

                  <!-- 创建时间 -->
                  <div class="text-[10px] text-on-surface-variant/40">
                    开播时间: {{ new Date(session.created_at).toLocaleString() }}
                  </div>
                </div>
              </div>

              <!-- 操作按钮 -->
              <div class="flex items-center space-x-2 flex-shrink-0 self-end sm:self-auto sm:ml-4">
                <!-- 删除历史记录 -->
                <button
                  @click.stop="requestDeleteSession(session)"
                  class="p-2 rounded-xl bg-surface-high hover:bg-surface-highest text-[#ba1a1a] border border-outline-variant/15 hover:border-[#ba1a1a]/30 transition-all cursor-pointer flex items-center justify-center"
                  title="删除此直播记录"
                >
                  <Trash2Icon class="w-4 h-4" />
                </button>
                <!-- 继续直播 -->
                <button
                  @click="resumeLive(session.id)"
                  class="px-4 py-2 rounded-xl bg-primary hover:bg-primary/95 text-[11px] font-bold text-white shadow-sm transition-all active:scale-95 cursor-pointer flex items-center gap-1.5"
                >
                  <PlayIcon class="w-3 h-3 fill-current" />
                  <span>继续</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 子视图 B: 配置直播表单 (原有界面) -->
        <div v-else-if="lobbySubView === 'create'" class="space-y-5">
          <!-- 二级标题与描述 (大剧院同款) -->
          <div class="mb-6">
            <h2 class="text-lg font-bold text-on-surface">配置直播间</h2>
            <p class="text-xs text-on-surface-variant/75 mt-0.5">
              从通讯录中挑选心动角色邀请开播，开启专属线上连线交互。
            </p>
          </div>

          <!-- 表单配置卡片 -->
          <div class="rounded-2xl bg-surface-low border border-outline-variant/30 p-6 space-y-5">
            <!-- 1. 主播角色选择 -->
            <div>
              <label class="text-xs font-bold text-on-surface-variant block mb-2">选择主播角色</label>
              
              <!-- 已选主播展示 -->
              <div
                v-if="selectedHost"
                class="flex items-center justify-between p-4 rounded-xl bg-surface-high border border-outline-variant/20 shadow-sm"
              >
                <div class="flex items-center space-x-3">
                  <img
                    v-if="selectedHost.avatarUrl"
                    :src="selectedHost.avatarUrl"
                    class="w-12 h-12 rounded-lg object-cover border border-outline-variant/15"
                  />
                  <div v-else class="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center font-bold text-lg text-primary">
                    {{ selectedHost.name[0] }}
                  </div>
                  <div>
                    <span class="text-xs text-primary font-bold block mb-0.5">当前选定</span>
                    <span class="text-sm font-bold text-on-surface">{{ selectedHost.name }}</span>
                  </div>
                </div>
                
                <button
                  @click="openSelectHostModal"
                  class="text-xs font-semibold text-primary hover:underline cursor-pointer"
                >
                  重新选择
                </button>
              </div>

              <!-- 未选主播展示 -->
              <div
                v-else
                @click="openSelectHostModal"
                class="flex flex-col items-center justify-center p-8 border-2 border-dashed border-outline-variant/30 hover:border-primary/50 rounded-xl cursor-pointer bg-surface/50 hover:bg-surface transition-all duration-300 group space-y-2 text-center"
              >
                <div class="p-2.5 rounded-full bg-primary/5 group-hover:bg-primary/10 text-on-surface-variant/70 group-hover:text-primary transition-colors">
                  <UsersIcon class="w-5 h-5" />
                </div>
                <div>
                  <p class="text-xs font-bold text-on-surface group-hover:text-primary transition-colors">点击选择主播角色</p>
                  <p class="text-[10px] text-on-surface-variant/50 mt-0.5">从系统通讯录列表中邀请一位角色</p>
                </div>
              </div>
            </div>

            <!-- 2. 直播主题 -->
            <div>
              <label class="text-xs font-bold text-on-surface-variant block mb-2">直播主题</label>
              <input
                v-model="liveTheme"
                type="text"
                class="w-full px-4 py-3 text-sm rounded-xl bg-surface border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface font-semibold placeholder:text-on-surface-variant/40"
                placeholder="请输入直播主题，如：情感大厅畅聊"
                :disabled="!selectedHost"
              />
            </div>

            <!-- 3. 直播分类 -->
            <div>
              <label class="text-xs font-bold text-on-surface-variant block mb-2">直播分类</label>
              <div class="relative">
                <select
                  v-model="liveDirection"
                  class="w-full pl-4 pr-10 py-3 text-sm rounded-xl bg-surface border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface font-semibold cursor-pointer appearance-none"
                  :disabled="!selectedHost"
                >
                  <option v-for="dir in availableDirections" :key="dir" :value="dir">{{ dir }}</option>
                </select>
                <div class="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none text-on-surface-variant/60">
                  <ChevronDownIcon class="w-4 h-4" />
                </div>
              </div>
            </div>

            <!-- 3.5 真实提示词 (对直播间内容的介绍，非自定义状态下显示) -->
            <div v-if="selectedHost && liveDirection !== '自定义'" class="space-y-2">
              <div class="flex items-center justify-between">
                <label class="text-xs font-bold text-on-surface-variant block">直播提示词 (对直播间内容的真实介绍)</label>
                <span class="text-[10px] text-on-surface-variant/50">用户可自由编辑修改以微调人设</span>
              </div>
              <textarea
                v-model="livePrompt"
                @blur="saveCurrentPrompt"
                @change="saveCurrentPrompt"
                rows="4"
                class="w-full px-4 py-3 text-xs rounded-xl bg-surface border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface/90 font-medium placeholder:text-on-surface-variant/40 resize-y leading-relaxed"
                placeholder="请输入对直播间内容的介绍或提示词..."
              ></textarea>
            </div>

            <!-- 3.6 自定义分类的录入字段 (自定义状态下显示) -->
            <div v-if="selectedHost && liveDirection === '自定义'" class="space-y-4 rounded-xl border border-dashed border-outline-variant/30 p-4 bg-surface/30">
              <div class="space-y-1.5">
                <label class="text-xs font-bold text-on-surface-variant block">类型名称</label>
                <input
                  v-model="customDirectionName"
                  type="text"
                  class="w-full px-4 py-2.5 text-xs rounded-xl bg-surface border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface font-semibold placeholder:text-on-surface-variant/40"
                  placeholder="请输入新的直播类型，如：脱口秀"
                />
              </div>
              <div class="space-y-1.5">
                <label class="text-xs font-bold text-on-surface-variant block">直播间介绍</label>
                <textarea
                  v-model="customDirectionPrompt"
                  rows="3"
                  class="w-full px-4 py-2.5 text-xs rounded-xl bg-surface border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface/90 font-medium placeholder:text-on-surface-variant/40 resize-y leading-relaxed"
                  placeholder="请输入该类型的提示词，如：此直播间由主播和粉丝连线讲述趣味段子..."
                ></textarea>
              </div>
              <div class="flex justify-end pt-1">
                <button
                  @click="saveAsNewCategory"
                  class="px-4 py-2 rounded-xl bg-primary hover:bg-primary/90 text-white text-xs font-bold shadow-md cursor-pointer transition-all duration-200"
                >
                  保存为新类别
                </button>
              </div>
            </div>

            <!-- 4. 开播按钮 -->
            <button
              @click="startLive"
              :disabled="!selectedHost || isStarting"
              class="w-full py-3.5 rounded-xl text-xs font-bold flex items-center justify-center space-x-2 transition-all cursor-pointer shadow-md hover:shadow-lg mt-6"
              :class="[
                selectedHost && !isStarting
                  ? 'bg-primary hover:bg-primary/95 text-white'
                  : 'bg-surface-high text-on-surface-variant/40 border border-outline-variant/20 cursor-not-allowed shadow-none'
              ]"
            >
              <Loader2Icon v-if="isStarting" class="w-4 h-4 animate-spin" />
              <PlayIcon v-else class="w-4 h-4 fill-current" />
              <span>创建直播间开启直播</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 3. 选择通讯录角色弹窗 (自定义，非原生) ── -->
    <div
      v-if="isSelectModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
      @click="isSelectModalOpen = false"
    >
      <div
        class="w-full max-w-md rounded-2xl bg-surface border border-outline-variant/30 p-5 shadow-2xl scale-in overflow-hidden relative flex flex-col max-h-[80vh]"
        @click.stop
      >
        <header class="flex items-center justify-between pb-3 border-b border-outline-variant/20 mb-4 flex-shrink-0">
          <span class="text-sm font-bold flex items-center space-x-2 text-on-surface">
            <UsersIcon class="w-4 h-4" />
            <span>选择主播角色</span>
          </span>
          <button
            @click="isSelectModalOpen = false"
            class="p-1 rounded-lg text-on-surface-variant/60 hover:bg-surface-high transition-colors cursor-pointer"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <!-- 搜索过滤 -->
        <div class="relative mb-4 flex-shrink-0">
          <input
            v-model="searchKeyword"
            type="text"
            placeholder="搜索通讯录角色名称..."
            class="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-surface-low border border-outline-variant/30 focus:border-primary focus:outline-none text-on-surface placeholder:text-on-surface-variant/40"
          />
          <SearchIcon class="w-3.5 h-3.5 absolute left-3 top-3 text-on-surface-variant/40" />
        </div>

        <!-- 角色列表 -->
        <div class="flex-1 overflow-y-auto pr-1 space-y-2 min-h-0">
          <div v-if="isLoadingChars" class="flex flex-col items-center justify-center py-12 space-y-2">
            <Loader2Icon class="w-6 h-6 animate-spin text-primary" />
            <span class="text-xs text-on-surface-variant/50">正在加载角色...</span>
          </div>

          <div v-else-if="filteredCharacters.length === 0" class="py-12 text-center text-on-surface-variant/40 text-xs">
            没有找到可邀请的角色。
          </div>

          <div
            v-else
            v-for="char in filteredCharacters"
            :key="char.id"
            @click="handleSelectHost(char)"
            class="flex items-center justify-between p-3 rounded-xl bg-surface-low border border-outline-variant/15 hover:border-primary/30 cursor-pointer hover:bg-surface-high transition-all"
          >
            <div class="flex items-center space-x-3">
              <img
                v-if="char.avatarUrl"
                :src="char.avatarUrl"
                class="w-10 h-10 rounded-lg object-cover border border-outline-variant/10"
              />
              <div v-else class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center font-bold text-xs text-primary">
                {{ char.name[0] }}
              </div>
              <div>
                <span class="text-xs font-bold text-on-surface block">{{ char.name }}</span>
                <span class="text-[10px] text-on-surface-variant/50 mt-0.5 block truncate max-w-[200px]">
                  {{ char.folder_name }}
                </span>
              </div>
            </div>
            
            <button
              class="px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-[10px] font-bold hover:bg-primary/20 transition-all cursor-pointer"
            >
              选择
            </button>
          </div>
        </div>

        <button
          @click="isSelectModalOpen = false"
          class="w-full mt-4 py-2.5 rounded-xl bg-surface-high hover:bg-surface-highest text-on-surface text-xs font-semibold text-center transition-all cursor-pointer border border-outline-variant/30 flex-shrink-0"
        >
          取消
        </button>
      </div>
    </div>

    <!-- ── 4. 删除二重确认弹窗 (自定义，非原生) ── -->
    <div
      v-if="isConfirmDeleteOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
      @click="isConfirmDeleteOpen = false"
    >
      <div
        class="w-full max-w-sm rounded-2xl bg-surface border border-outline-variant/30 p-5 shadow-2xl scale-in overflow-hidden relative flex flex-col space-y-4 text-center"
        @click.stop
      >
        <h3 class="text-sm font-bold text-on-surface">确定删除该历史直播？</h3>
        <p class="text-xs text-on-surface-variant/70 leading-relaxed">
          删除后将永久删除【{{ deletingSessionTheme }}】的弹幕聊天记录和所有生成的数据，此操作不可撤销。
        </p>
        <div class="flex items-center space-x-3">
          <button
            @click="isConfirmDeleteOpen = false"
            :disabled="isDeleting"
            class="flex-1 py-2.5 rounded-xl bg-surface-high hover:bg-surface-highest text-on-surface text-xs font-semibold border border-outline-variant/30 cursor-pointer transition-all"
          >
            取消
          </button>
          <button
            @click="executeDeleteSession"
            :disabled="isDeleting"
            class="flex-1 py-2.5 rounded-xl bg-[#ba1a1a] hover:bg-[#ba1a1a]/90 text-white text-xs font-bold cursor-pointer transition-all flex items-center justify-center gap-1.5"
          >
            <Loader2Icon v-if="isDeleting" class="w-3.5 h-3.5 animate-spin" />
            <span>确定删除</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div
      v-if="toastVisible"
      class="fixed bottom-10 left-1/2 transform -translate-x-1/2 z-50 px-5 py-3 rounded-xl bg-[#293040]/90 dark:bg-[#1f1f1f]/90 text-white text-xs font-semibold shadow-2xl flex items-center space-x-2 backdrop-blur-md border border-outline-variant/20 animate-fade-in"
    >
      <span>{{ toastMessage }}</span>
    </div>

  </div>
</template>
