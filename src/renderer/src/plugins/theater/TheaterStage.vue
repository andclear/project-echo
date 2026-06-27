<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick, onUnmounted } from 'vue';
import { usePluginSync } from '../../composables/usePluginSync';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Settings2Icon,
  SendIcon,
  PlusIcon,
  Trash2Icon,
  SmileIcon,
  Loader2Icon,
  AlertCircleIcon,
  CheckIcon,
  Edit3Icon,
  UserIcon,
  SparklesIcon,
  SaveIcon,
  UsersIcon,
  XIcon
} from 'lucide-vue-next';

const props = defineProps<{
  sessionId: string;
  isMobile: boolean;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'restart'): void;
}>();

// -------------------------------------------------------------
// 状态定义
// -------------------------------------------------------------
const themeId = ref('');
const playerCharName = ref('');
const timeSpace = ref('');
const summary = ref('');
const characterStates = ref<any[]>([]);
const messages = ref<any[]>([]);
const nextOptions = ref<any[]>([]);

const mergedMessages = computed(() => {
  try {
    const result: any[] = [];
    if (!Array.isArray(messages.value)) return result;
    for (const msg of messages.value) {
      if (!msg) continue;
      if (msg.type === 'image') {
        const last = result[result.length - 1];
        if (last && last.type === 'image-group') {
          result[result.length - 1] = {
            ...last,
            images: [
              ...(last.images || []),
              {
                id: msg.id,
                imagePath: msg.imagePath,
                actors: msg.actors
              }
            ]
          };
        } else {
          result.push({
            id: msg.id,
            role: 'system',
            type: 'image-group',
            createdAt: msg.createdAt,
            images: [{
              id: msg.id,
              imagePath: msg.imagePath,
              actors: msg.actors
            }]
          });
        }
      } else {
        result.push(msg);
      }
    }
    return result;
  } catch (e: any) {
    console.error('[TheaterStage] mergedMessages 计算属性崩溃，详细堆栈:', e);
    return messages.value || [];
  }
});
const prompts = ref<any>({});

// 正在生成/排队状态
const isGenerating = ref(false);
const currentNpcGenerating = ref('');

// 行动与对话输入框
const actionInput = ref('');
const dialogueInput = ref('');

// 选中的辅助角色详情（当前右侧选中的角色）
const selectedCharName = ref('');

// 右侧信息面板的激活 Tab: 'soul' | 'status' | 'relation' | 'backpack'
const activeRightTab = ref<'soul' | 'status' | 'relation' | 'backpack'>('status');

// 正在编辑设定的状态
const isEditingSoul = ref(false);
const editingSoulText = ref('');

// 添加状态栏表单状态
const isAddingStatusBar = ref(false);
const newBarName = ref('');
const newBarType = ref<'number' | 'text'>('number');
const newBarInitial = ref('100');
const newBarMin = ref(0);
const newBarMax = ref(100);
const newBarDesc = ref('');
const newBarRule = ref('');

function openAddStatusBarForm() {
  newBarName.value = '';
  newBarType.value = 'number';
  newBarInitial.value = '100';
  newBarMin.value = 0;
  newBarMax.value = 100;
  newBarDesc.value = '';
  newBarRule.value = '';
  isAddingStatusBar.value = true;
}

watch(newBarType, (newType) => {
  if (newType === 'number') {
    newBarInitial.value = '100';
  } else {
    newBarInitial.value = '良好';
  }
});

async function submitNewStatusBar() {
  if (!newBarName.value || !newBarName.value.trim()) {
    showToast('请填写属性名称！');
    return;
  }
  if (!newBarDesc.value || !newBarDesc.value.trim()) {
    showToast('请填写属性描述说明！');
    return;
  }
  if (!newBarRule.value || !newBarRule.value.trim()) {
    showToast('请填写大模型变动规则！');
    return;
  }

  try {
    const payload = {
      sessionId: props.sessionId,
      statusBar: {
        name: newBarName.value.trim(),
        type: newBarType.value,
        min: newBarType.value === 'number' ? Number(newBarMin.value) : undefined,
        max: newBarType.value === 'number' ? Number(newBarMax.value) : undefined,
        initialValue: newBarType.value === 'number' ? Number(newBarInitial.value) : newBarInitial.value,
        description: newBarDesc.value.trim(),
        aiRule: newBarRule.value.trim()
      }
    };

    const res = await (window.electron && window.electron.ipcRenderer
      ? window.electron.ipcRenderer.invoke('theater-add-session-status-bar', payload)
      : window.api.invoke('theater-add-session-status-bar', payload));
    if (res.success) {
      characterStates.value = res.characterStates;
      isAddingStatusBar.value = false;
      showToast(`已成功为所有角色追加属性 [${newBarName.value}]！`);
    } else {
      showToast(res.error || '添加属性失败');
    }
  } catch (err: any) {
    showToast('添加异常: ' + err.message);
  }
}

// 右上角 Agent 配置弹窗状态
const isConfigOpen = ref(false);
const selectedAgentKey = ref<string>('narrator');
const configPrompts = ref<any>({});
const enableImageGen = ref(false);
const enableOptionsGen = ref(true);
const isResettingRuntime = ref(false);

const agentPromptEntries = [
  { id: 'narrator', label: '1. 开场旁白 Agent' },
  { id: 'directorIntent', label: '2. 时空导演意图 Agent' },
  { id: 'timeSpace', label: '3. 时间与空间 Agent' },
  { id: 'mainPlot', label: '4. 剧情收束推进 Agent' },
  { id: 'character', label: '5. NPC 角色演绎 Agent' },
  { id: 'plotState', label: '6. 主线状态维护 Agent' },
  { id: 'characterMind', label: '7. 角色心理连续性 Agent' },
  { id: 'consistencyRepair', label: '8. 事实一致性修正 Agent' },
  { id: 'status', label: '9. 属性状态维护 Agent' },
  { id: 'relation', label: '10. 社会关系维护 Agent' },
  { id: 'summary', label: '11. 剧情归档总结 Agent' },
  { id: 'options', label: '12. 剧情推进选项 Agent' },
  { id: 'imageGen', label: '13. 剧情生图插画 Agent' }
];

// 格式化移动端 Agent 标签，去除序号与 " Agent" 后缀，节省横向空间
function formatMobileAgentLabel(label: string): string {
  return label.replace(/^\d+\.\s*/, '').replace(/\s*Agent$/, '');
}

const showVariablesHelp = ref(false);
const availableVariables = [
  { name: 'world_settings', label: '基础世界观', desc: '题材中配置的剧本世界观与规则设定，提供给大模型了解故事的大框架。' },
  { name: 'scenario', label: '开局剧情背景', desc: '题材中配置的开局背景、基本大纲与主线走向剧情。' },
  { name: 'opening_direction', label: '本局开场方向', desc: '玩家在准备大厅输入的本局开场落点、氛围或切入事件，仅用于首轮初始化，不覆盖原始世界观。' },
  { name: 'time_space', label: '当前时间空间', desc: '大剧院中最新的时空物理定位描述（如夜晚 21:00，在阴暗书房里）。' },
  { name: 'player_character', label: '玩家扮演角色', desc: '当前用户在本场大剧院中扮演的角色姓名，用于约束选项和防止替 NPC 行动。' },
  { name: 'character_list', label: '参演角色列表', desc: '当前参与本轮演绎或可被调度的角色姓名列表。' },
  { name: 'history', label: '清洁过的历史', desc: '本场游戏最近多轮的对话和动作轨迹，会自动脱水清洗思维链以节省 Token。' },
  { name: 'summary', label: '剧情纪事大纲', desc: '阶段性剧本纪事（summary.md）的内容，每过 10 轮会自动进行提炼合并。' },
  { name: 'current_summary', label: '当前剧情总结', desc: '当前已落盘的剧情纪事总结，主要用于剧情归档总结 Agent 继续合并。' },
  { name: 'character_settings', label: '参演角色详情', desc: '包含本剧本中当前所有参演角色的性别、年龄及人设概述。' },
  { name: 'character_name', label: '扮演角色姓名', desc: '当前具体需要被扮演/处理的 NPC 的名字，仅在特定演绎和结算 Agent 下生效。' },
  { name: 'character_soul', label: '角色设定(Soul)', desc: '当前被扮演的 NPC 专属的灵魂深度设定卡大纲内容。' },
  { name: 'character_states', label: '全员属性状态', desc: '包含大剧院中所有角色实时的状态栏数值、题材配置规则、背包与余额。' },
  { name: 'current_character_states', label: '当前全员状态', desc: '与全员属性状态等价的兼容变量，供旧提示词或自定义提示词继续使用。' },
  { name: 'self_states', label: '专属扮演状态', desc: '当前具体被扮演的 NPC 专属的数值、题材配置规则、背包与余额（仅在角色演绎下生效）。' },
  { name: 'relations', label: '角色间关系网', desc: '当前被分析的角色与其他角色之间，已落盘的单向长线社会关系与情感基调连线。' },
  { name: 'current_relations', label: '当前关系网', desc: '与角色间关系网等价的兼容变量，供关系维护和自定义提示词使用。' },
  { name: 'status_bars_definition', label: '状态栏定义', desc: '题材配置中的状态栏规则、说明、取值范围和 AI 结算规则。' },
  { name: 'latest_input', label: '最新动作输入', desc: '玩家/用户最新输入的原始文本动作描述（不带角色名称前缀）。' },
  { name: 'latest_user_input', label: '最新玩家行动', desc: '玩家最新输入的行动，带角色名称前缀，如：*行动*: 观察四周。' },
  { name: 'latest_round_content', label: '本轮真实内容', desc: '本轮玩家、NPC 与旁白已经真实发生的互动文本，用于结算、心理、主线和修正。' },
  { name: 'last_10_rounds_history', label: '近十轮历史', desc: '最近十轮历史内容，主要用于剧情归档总结 Agent。' },
  { name: 'round_context', label: '本轮时空事实', desc: '本轮锁定的唯一时空事实、在场角色、导演意图和禁止矛盾项。' },
  { name: 'director_intent', label: '本轮导演意图', desc: '时空导演意图 Agent 给出的本轮戏剧目标，用于约束 NPC、旁白和选项。' },
  { name: 'plot_state', label: '长期主线状态', desc: '当前主线目标、核心冲突、未解问题、已知线索、未解决威胁和下一轮压力点。' },
  { name: 'character_minds', label: '角色心理状态', desc: '角色即时情绪、当前目标、隐藏意图、对玩家态度、压力来源和下一步倾向。' }
];

function copyVariableText(varName: string) {
  const text = `{${varName}}`;
  navigator.clipboard.writeText(text).then(() => {
    showToast(`变量 ${text} 已成功复制到剪贴板，可直接粘贴！`);
  }).catch(err => {
    showToast('复制失败: ' + err);
  });
}

// 删除剧情插画二次确认弹窗状态
const showDeleteModal = ref(false);
const imageToDelete = ref<any>(null);
const groupMsgToDelete = ref<any>(null);
const imageToDeleteBase64 = ref('');
const isDeletingImage = ref(false);

// 全局 Toast 提示
const toastVisible = ref(false);
const toastMessage = ref('');
let toastTimer: any = null;
function showToast(msg: string) {
  if (toastTimer) clearTimeout(toastTimer);
  toastMessage.value = msg;
  toastVisible.value = true;
  toastTimer = setTimeout(() => {
    toastVisible.value = false;
  }, 2500);
}

// 消息滚动容器
const messageListRef = ref<HTMLElement | null>(null);
function scrollToBottom() {
  nextTick(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight;
    }
  });
  // 移动端双保险延迟滚动：在 60ms 之后，等 DOM 树在浏览器排版引擎里彻底计算完成后，再次滚动对齐，防滑偏
  setTimeout(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTop = messageListRef.value.scrollHeight;
    }
  }, 60);
}

// -------------------------------------------------------------
// 数据加载
// -------------------------------------------------------------
async function loadSessionState() {
  try {
    const res = await window.api.invoke('theater-get-stage-state', { sessionId: props.sessionId });
    if (res.success && res.state) {
      const s = res.state;
      themeId.value = s.themeId;
      playerCharName.value = s.playerCharName;
      timeSpace.value = s.timeSpace;
      summary.value = s.summary;
      characterStates.value = s.characterStates || [];
      messages.value = s.messages || [];
      // 自动静默预加载历史插图 Base64，保障瞬开体验
      messages.value.forEach(msg => {
        if (msg && msg.type === 'image' && msg.imagePath) {
          ensureImageLoaded(msg.id, msg.imagePath);
        }
      });
      prompts.value = s.prompts || {};
      enableImageGen.value = !!s.prompts.enableImageGen;
      enableOptionsGen.value = s.prompts.enableOptionsGen !== false;
      
      // 默认选中玩家当前扮演的角色
      if (!selectedCharName.value) {
        selectedCharName.value = playerCharName.value;
      }
      
      // 获取当前可用的下一步选项（如没有，可以取默认选项或空）
      nextOptions.value = s.nextOptions || [];
      scrollToBottom();

      // 🚀 智能自愈判定：如果在等待演绎（Loading 状态），而拉取回来的最新消息已经包含了新产出的内容，则重置消退 Loading
      if (isGenerating.value && !currentNpcGenerating.value) {
        const lastMsg = messages.value[messages.value.length - 1];
        if (lastMsg && lastMsg.role !== 'user') {
          isGenerating.value = false;
          currentNpcGenerating.value = '';
          console.log('[TheaterStage] 状态自愈：自愈拉取检测到最新演绎完成，消退 Loading 态。');
        }
      }
    } else {
      showToast(res.error || '获取会话状态失败');
    }
  } catch (err: any) {
    console.error('[TheaterStage] loadSessionState 崩溃，堆栈:', err);
    showToast('加载会话异常: ' + err.message);
  }
}

// -------------------------------------------------------------
// NPC 流式渲染处理 (监听 IPC)
// -------------------------------------------------------------
function handleNpcChunk(
  payload: {
    role: string;
    content: string;
    type?: string;
    imagePath?: string;
    actors?: string;
    id?: string;
    createdAt?: number;
    characterStates?: any[];
    sessionId?: string;
  }
) {
  // preload 的 on() 已将 _event 剥离，第一个参数直接就是 payload
  if (!payload) return;

  if (payload.type === 'stage-status') {
    if (!payload.sessionId || payload.sessionId === props.sessionId) {
      currentNpcGenerating.value = payload.role || payload.content || '';
    }
    return;
  }

  if (payload.type === 'next-options-cleared') {
    if (!payload.sessionId || payload.sessionId === props.sessionId) {
      nextOptions.value = [];
    }
    return;
  }

  if (payload.type === 'stage-state-updated') {
    if (!payload.sessionId || payload.sessionId === props.sessionId) {
      loadSessionState();
    }
    return;
  }

  // 1. 拦截角色状态更新消息
  if (payload.type === 'character-states-update') {
    if (payload.characterStates) {
      characterStates.value = payload.characterStates;
    }
    return;
  }

  // 2. 异步生图消息
  if (payload.type === 'image') {
    // 异步生图消息直接压入消息列表，不参与文本合并，且不激活 isGenerating 等待态
    messages.value.push({
      id: payload.id || `image_${Date.now()}`,
      role: payload.role || 'system',
      content: payload.content || '[插画渲染]',
      type: 'image',
      imagePath: payload.imagePath || '',
      actors: payload.actors || '',
      createdAt: Date.now()
    });
    // 强制初始化为折叠状态
    if (payload.id) {
      expandedImages.value[payload.id] = false;
      if (payload.imagePath) {
        ensureImageLoaded(payload.id, payload.imagePath);
      }
    }
    messages.value = [...messages.value];
    scrollToBottom();
    return;
  }

  // 3. 拦截状态/关系变动看板系统消息 (防止被误合并或当作普通流式气泡)
  if (payload.role === 'system' && isSystemDashboard(payload.content)) {
    const exists = payload.id ? messages.value.find(m => m.id === payload.id) : null;
    if (exists) {
      exists.content = payload.content;
    } else {
      messages.value.push({
        id: payload.id || `dashboard_${Date.now()}`,
        role: 'system',
        content: payload.content,
        createdAt: Date.now()
      });
      if (payload.id) {
        expandedDashboards.value[payload.id] = false;
      }
    }
    messages.value = [...messages.value];
    scrollToBottom();
    return;
  }

  // 🚀 2. 拦截异步完成/错误事件
  if (payload.type === 'theater-step-completed') {
    isGenerating.value = false;
    currentNpcGenerating.value = '';
    // 收到轻量完成信号，主动从标准 HTTP 接口拉取最新全量状态，自愈防丢
    loadSessionState();
    return;
  }

  if (payload.type === 'theater-step-failed') {
    isGenerating.value = false;
    currentNpcGenerating.value = '';
    showToast(payload.error || '执行回合错误');
    return;
  }

  currentNpcGenerating.value = payload.role || '';
  
  // 内容为空说明是 Agent "正在思考"信号，仅更新状态栏，不对消息列表做任何操作
  if (!payload.content) {
    return;
  }

  // 查找或更新在前端消息列表中的对应 NPC 的发言
  // 这里做一个智能追加，方便流式感官
  const existing = payload.id
    ? messages.value.find(m => m && m.id === payload.id)
    : messages.value.find(m => m && m.role === payload.role && (Date.now() - m.createdAt < 20000));
  if (existing) {
    existing.content = payload.content;
  } else {
    messages.value.push({
      id: payload.id || `npc_chunk_${Date.now()}`,
      role: payload.role || '',
      content: payload.content,
      createdAt: payload.createdAt || Date.now()
    });
  }
  messages.value = [...messages.value];
  scrollToBottom();
}

const isMobile = computed(() => props.isMobile);
const isMobileRightPanelOpen = ref(false);

watch(isMobile, (newVal) => {
  if (!newVal) {
    isMobileRightPanelOpen.value = false;
  }
});

let sseUnsubscribe: (() => void) | null = null;

usePluginSync({
  pluginName: 'theater',
  eventName: 'next-options-cleared',
  fetchFn: async () => {
    nextOptions.value = [];
    await loadSessionState();
  }
});

usePluginSync({
  pluginName: 'theater',
  eventName: 'stage-state-updated',
  fetchFn: async () => {
    await loadSessionState();
  }
});

onMounted(() => {
  loadSessionState();
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.on('theater-npc-action-chunk', handleNpcChunk);
  } else if (window.api && window.api.receive) {
    sseUnsubscribe = window.api.receive('theater-npc-action-chunk', handleNpcChunk);
  }
});

onUnmounted(() => {
  if (window.electron && window.electron.ipcRenderer) {
    window.electron.ipcRenderer.removeListener('theater-npc-action-chunk', handleNpcChunk);
  }
  if (sseUnsubscribe) {
    sseUnsubscribe();
    sseUnsubscribe = null;
  }
});

// -------------------------------------------------------------
// 双输入框提交与发送
// -------------------------------------------------------------
async function handleSend() {
  const action = actionInput.value.trim();
  const dialogue = dialogueInput.value.trim();
  
  if (!action && !dialogue) {
    showToast('行动或对话输入不能为空');
    return;
  }
  
  // 组合成标准演绎格式 *行动* "对话"
  let combined = '';
  if (action && dialogue) {
    combined = `*${action}* “${dialogue}”`;
  } else if (action) {
    combined = `*${action}*`;
  } else {
    combined = `“${dialogue}”`;
  }
  
  // 立即清空输入框、清空上一轮选项并显示加载
  actionInput.value = '';
  dialogueInput.value = '';
  nextOptions.value = [];
  isGenerating.value = true;
  currentNpcGenerating.value = '系统分析中...';
  
  // 用户输入的气泡先手动压入消息队列，提升交互即时响应
  messages.value.push({
    id: `temp_user_${Date.now()}`,
    role: 'user',
    content: combined,
    createdAt: Date.now()
  });
  scrollToBottom();

  try {
    const res = await window.api.invoke('theater-execute-stage-step', {
      sessionId: props.sessionId,
      userText: combined
    });
    
    if (!res.success) {
      showToast(res.error || '执行回合错误');
      isGenerating.value = false;
      currentNpcGenerating.value = '';
    }
  } catch (err: any) {
    showToast('提交执行异常: ' + err.message);
    isGenerating.value = false;
    currentNpcGenerating.value = '';
  }
}

// -------------------------------------------------------------
// 剧情推进选项回填
// -------------------------------------------------------------
function selectOption(opt: { action: string; dialogue: string }) {
  actionInput.value = opt.action || '';
  dialogueInput.value = opt.dialogue || '';
}

// -------------------------------------------------------------
// 右侧角色信息切换与详情操作
// -------------------------------------------------------------
// 排序计算属性：确保当前玩家扮演的角色在第一位
const sortedCharacters = computed(() => {
  const list = [...characterStates.value];
  list.sort((a, b) => {
    // 1. 主角永远排在第一位
    const isAPlayer = a.name === playerCharName.value;
    const isBPlayer = b.name === playerCharName.value;
    if (isAPlayer && !isBPlayer) return -1;
    if (!isAPlayer && isBPlayer) return 1;

    // 2. 参演状态排序：在场的排在退场的前面
    const aParticipating = a.isParticipating !== false;
    const bParticipating = b.isParticipating !== false;
    if (aParticipating && !bParticipating) return -1;
    if (!aParticipating && bParticipating) return 1;

    return 0;
  });
  return list;
});

const selectedCharState = computed(() => {
  return characterStates.value.find(s => s.name === selectedCharName.value);
});

const selectedCharStatic = computed(() => {
  // 找到静态设定
  const theme = characterStates.value; // 本地缓存有头像和性别等
  // 这里在 listThemes() 拿到的角色带有头像，所以我们在加载角色时读取
  // 我们可以通过获取 static 配置或后端同步读取
  return selectedCharState.value;
});

async function toggleSessionCharacterParticipating(charName: string) {
  const target = characterStates.value.find(s => s.name === charName);
  if (!target) return;

  const currentStatus = target.isParticipating !== false;
  const newStatus = !currentStatus;

  // 1. 获取最新所有被激活的角色名称（包括主角）
  const activeNames = characterStates.value
    .filter(s => s.name === playerCharName.value || (s.name === charName ? newStatus : s.isParticipating !== false))
    .map(s => s.name);

  try {
    const res = await window.api.invoke('theater-update-session-participating-characters', {
      sessionId: props.sessionId,
      activeNames
    });

    if (res.success) {
      target.isParticipating = newStatus;
      showToast(`角色 [${charName}] 已成功${newStatus ? '切入登场状态' : '切为后备退场状态'}`);
    } else {
      showToast(res.error || '更新登场状态失败');
    }
  } catch (err: any) {
    showToast('更新异常: ' + err.message);
  }
}

// 计算渐变色进度条 Hash 起止色
function getProgressBarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 40) % 360;
  return {
    background: `linear-gradient(90deg, hsl(${h1}, 75%, 55%), hsl(${h2}, 85%, 65%))`,
    shadow: `0 2px 8px -1px hsl(${h1}, 70%, 50%, 0.35)`
  };
}

// 🚀 属性状态栏排序算法：1. 好感度内置属性必须永远置顶；2. 数值类属性排在文本类属性之前
const sortedStatusBars = computed(() => {
  if (!selectedCharState.value || !selectedCharState.value.status_bars) return [];
  
  const entries = Object.entries(selectedCharState.value.status_bars).map(([name, val]) => {
    const isNum = val !== null && val !== undefined && val !== '' && !isNaN(Number(val));
    return { name, val, isNum };
  });

  return entries.sort((a, b) => {
    // 1. 好感度永远置顶
    if (a.name === '好感度') return -1;
    if (b.name === '好感度') return 1;

    // 2. 数值类型排在文本类型之前
    if (a.isNum && !b.isNum) return -1;
    if (!a.isNum && b.isNum) return 1;

    return 0;
  });
});

const isEditingRelation = ref(false);
const editingRelationItem = ref<{ id: number; from: string; to: string; relation: string; isNew?: boolean } | null>(null);

// 可供新建关系选择的目标角色列表（排除当前角色自己）
const availableTargetCharacters = computed(() => {
  if (!selectedCharState.value) return [];
  const currentName = selectedCharState.value.name;
  return characterStates.value
    .map(c => c.name)
    .filter(name => name !== currentName);
});

const parsedRelations = computed(() => {
  if (!selectedCharState.value || !selectedCharState.value.relations) return [];
  const text = selectedCharState.value.relations;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  return lines.map((line, idx) => {
    const match = line.match(/^(.+?)\s*(?:→|->)\s*(.+?)\s*(?::|：)\s*(.+)$/);
    if (match) {
      return {
        id: idx,
        from: match[1].trim(),
        to: match[2].trim(),
        relation: match[3].trim(),
        raw: line,
        isInvalid: false
      };
    }
    return {
      id: idx,
      from: '',
      to: '',
      relation: '',
      raw: line,
      isInvalid: true
    };
  });
});

function startEditRelation(item: any) {
  if (selectedCharState.value?.isParticipating === false) {
    showToast('该角色已退场，无法修改其社交关系。');
    return;
  }
  editingRelationItem.value = {
    id: item.id,
    from: item.from || item.raw,
    to: item.to || '',
    relation: item.relation || '',
    isNew: false
  };
  isEditingRelation.value = true;
}

function startAddRelation() {
  if (selectedCharState.value?.isParticipating === false) {
    showToast('该角色已退场，无法新增其社交关系。');
    return;
  }
  editingRelationItem.value = {
    id: -1,
    from: selectedCharState.value?.name || '',
    to: '',
    relation: '',
    isNew: true
  };
  isEditingRelation.value = true;
}

async function saveEditedRelation() {
  if (!editingRelationItem.value || !selectedCharState.value) return;
  const item = editingRelationItem.value;
  
  if (!item.from.trim() || !item.to.trim() || !item.relation.trim()) {
    showToast('来源、目标和关系内容均不能为空');
    return;
  }
  
  let newLines: string[] = [];
  const oldText = selectedCharState.value.relations || '';
  const oldLines = oldText.split('\n').map(l => l.trim()).filter(Boolean);
  const formattedLine = `${item.from.trim()} → ${item.to.trim()} ：${item.relation.trim()}`;
  
  if (item.isNew) {
    newLines = [...oldLines, formattedLine];
  } else {
    newLines = parsedRelations.value.map(p => {
      if (p.id === item.id) return formattedLine;
      return p.raw;
    });
  }
  
  isEditingRelation.value = false;
  editingRelationItem.value = null;
  await saveRelationsText(newLines.join('\n'));
}

async function deleteRelation(itemId: number) {
  if (!selectedCharState.value) return;
  if (selectedCharState.value.isParticipating === false) {
    showToast('该角色已退场，无法删除其社交关系。');
    return;
  }
  
  const newLines = parsedRelations.value
    .filter(p => p.id !== itemId)
    .map(p => p.raw);
    
  await saveRelationsText(newLines.join('\n'));
}

// 手动调整状态栏属性值 (Slider 即时更新)
async function changeStatusBarVal(attrName: string, val: number | string) {
  if (!selectedCharState.value) return;
  if (selectedCharState.value.isParticipating === false) {
    showToast(`角色 [${selectedCharState.value.name}] 处于退场状态，不允许修改状态栏`);
    return;
  }
  const targetState = selectedCharState.value;
  const updatedBars = { ...targetState.status_bars, [attrName]: val };
  
  targetState.status_bars = updatedBars; // 先前端即时同步
  
  try {
    await window.api.invoke('theater-update-character-state', {
      sessionId: props.sessionId,
      charName: targetState.name,
      statePayload: {
        status_bars: updatedBars
      }
    });
  } catch (err: any) {
    showToast('更新属性失败: ' + err.message);
  }
}

// 鼠标按下进度条轨道时，根据点击位置直接计算并更新数值，解决滑块遮挡附近的点击盲区问题
function handleRangeMouseDown(e: MouseEvent, attrName: string) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const percentage = Math.max(0, Math.min(100, Math.round((clickX / rect.width) * 100)));
  
  // 强行把原生 input 值修改，确保后续拖拽能够在该位置连续平滑接管
  const inputEl = e.currentTarget as HTMLInputElement;
  if (inputEl) {
    inputEl.value = String(percentage);
  }
  changeStatusBarVal(attrName, percentage);
}

// 手动修改社会关系文本描述
async function saveRelationsText(newRelations: string) {
  if (!selectedCharState.value) return;
  const targetState = selectedCharState.value;
  targetState.relations = newRelations;
  
  try {
    await window.api.invoke('theater-update-character-state', {
      sessionId: props.sessionId,
      charName: targetState.name,
      statePayload: {
        relations: newRelations
      }
    });
    showToast('关系描述已保存');
  } catch (err: any) {
    showToast('更新关系失败: ' + err.message);
  }
}

// 手动加减背包物品数量
async function updateBackpackQty(itemName: string, diff: number) {
  if (!selectedCharState.value) return;
  const targetState = selectedCharState.value;
  const item = targetState.backpack.find((i: any) => i.name === itemName);
  if (!item) return;
  
  item.quantity += diff;
  if (item.quantity <= 0) {
    targetState.backpack = targetState.backpack.filter((i: any) => i.name !== itemName);
  }
  
  try {
    await window.api.invoke('theater-update-character-state', {
      sessionId: props.sessionId,
      charName: targetState.name,
      statePayload: {
        backpack: targetState.backpack
      }
    });
  } catch (err: any) {
    showToast('背包更新失败: ' + err.message);
  }
}

// 新增背包物品
const isAddingItem = ref(false);
const newItemName = ref('');
const newItemQty = ref(1);

async function addBackpackItem() {
  const name = newItemName.value.trim();
  if (!name) return;
  if (!selectedCharState.value) return;
  
  const targetState = selectedCharState.value;
  const existing = targetState.backpack.find((i: any) => i.name === name);
  if (existing) {
    existing.quantity += newItemQty.value;
  } else {
    targetState.backpack.push({ name, quantity: newItemQty.value });
  }
  
  newItemName.value = '';
  newItemQty.value = 1;
  isAddingItem.value = false;
  
  try {
    await window.api.invoke('theater-update-character-state', {
      sessionId: props.sessionId,
      charName: targetState.name,
      statePayload: {
        backpack: targetState.backpack
      }
    });
    showToast('成功添加物品');
  } catch (err: any) {
    showToast('添加物品失败: ' + err.message);
  }
}

// 修改余额
async function changeBalance(newBalance: number) {
  if (!selectedCharState.value) return;
  const targetState = selectedCharState.value;
  targetState.balance = Math.max(0, newBalance);
  
  try {
    await window.api.invoke('theater-update-character-state', {
      sessionId: props.sessionId,
      charName: targetState.name,
      statePayload: {
        balance: targetState.balance
      }
    });
  } catch (err: any) {
    showToast('余额更新失败: ' + err.message);
  }
}

// 编辑角色设定 Soul.md 物理写入
function openEditSoul() {
  if (!selectedCharState.value) return;
  // 假定前端也持有了静态的 soul 性格数据
  // 我们在 characterStates 里保存了实时状态和设定
  // 为了从物理磁盘重载设定，我们在这里提供修改
  const dbChar = characterStates.value.find(s => s.name === selectedCharName.value);
  editingSoulText.value = dbChar?.soul || '';
  isEditingSoul.value = true;
}

async function saveSoulEdits() {
  if (!selectedCharName.value) return;
  isEditingSoul.value = false;
  
  try {
    const res = await window.api.invoke('theater-edit-character-soul', {
      themeId: themeId.value,
      charName: selectedCharName.value,
      newSoul: editingSoulText.value
    });
    if (res.success) {
      showToast('设定文件已物理更新');
      const dbChar = characterStates.value.find(s => s.name === selectedCharName.value);
      if (dbChar) dbChar.soul = editingSoulText.value;
    } else {
      showToast(res.error || '保存设定失败');
    }
  } catch (err: any) {
    showToast('设定保存异常: ' + err.message);
  }
}

// -------------------------------------------------------------
// 右上角 Agent 提示词配置
// -------------------------------------------------------------
function openAgentConfig() {
  configPrompts.value = JSON.parse(JSON.stringify(prompts.value));
  enableOptionsGen.value = configPrompts.value.enableOptionsGen !== false;
  isConfigOpen.value = true;
}

async function saveAgentConfig() {
  isConfigOpen.value = false;
  configPrompts.value.enableImageGen = enableImageGen.value; // 同步开关
  configPrompts.value.enableOptionsGen = enableOptionsGen.value;
  
  try {
    const res = await window.api.invoke('theater-update-agent-prompts', {
      sessionId: props.sessionId,
      prompts: JSON.parse(JSON.stringify(configPrompts.value))
    });
    if (res.success) {
      prompts.value = { ...configPrompts.value };
      showToast('Agent 配置保存成功');
    } else {
      showToast(res.error || '保存配置失败');
    }
  } catch (err: any) {
    showToast('配置保存异常: ' + err.message);
  }
}

async function resetThemeRuntime() {
  if (isGenerating.value || isResettingRuntime.value) {
    showToast('当前正在演绎中，请等待本轮结束后再清空。');
    return;
  }

  const confirmed = window.confirm('确定要清空当前剧本下的所有游玩记录、消息、状态、关系图和插图缓存吗？剧本配置和角色设定会保留，清空后将回到剧本准备大厅重新开始。');
  if (!confirmed) return;

  isResettingRuntime.value = true;
  try {
    const res = await window.api.invoke('theater-reset-theme-runtime', {
      sessionId: props.sessionId
    });
    if (res.success) {
      emit('restart');
    } else {
      showToast(res.error || '清空剧本运行数据失败');
    }
  } catch (err: any) {
    showToast('清空剧本运行数据异常: ' + err.message);
  } finally {
    isResettingRuntime.value = false;
  }
}

// -------------------------------------------------------------
// 插画折叠展开与轮播交互
// -------------------------------------------------------------
const expandedImages = ref<Record<string, boolean>>({});
const loadedImages = ref<Record<string, string>>({});
const currentImageIndex = ref<Record<string, number>>({});

async function ensureImageLoaded(msgId: string, imagePath: string) {
  if (loadedImages.value[msgId]) return;
  try {
    const res = await window.api.invoke('theater-read-image', imagePath);
    if (res.success && res.base64) {
      loadedImages.value[msgId] = res.base64;
    } else {
      showToast('插画文件读取失败: ' + (res.error || '未知错误'));
    }
  } catch (err: any) {
    showToast('读取插画文件异常: ' + err.message);
  }
}

function getCurrentImage(msg: any) {
  if (!msg || !Array.isArray(msg.images) || msg.images.length === 0) {
    return null;
  }
  const idx = currentImageIndex.value[msg.id] || 0;
  if (idx < 0 || idx >= msg.images.length) {
    return msg.images[0] || null;
  }
  return msg.images[idx] || null;
}

function switchImage(msgId: string, step: number, msg: any) {
  if (!msg || !Array.isArray(msg.images) || msg.images.length === 0) return;
  const currentIdx = currentImageIndex.value[msgId] || 0;
  const newIdx = (currentIdx + step + msg.images.length) % msg.images.length;
  currentImageIndex.value[msgId] = newIdx;
  
  const currentImg = msg.images[newIdx];
  if (currentImg && currentImg.imagePath) {
    ensureImageLoaded(currentImg.id, currentImg.imagePath);
  }
}

function toggleImage(msgId: string) {
  expandedImages.value[msgId] = !expandedImages.value[msgId];
  if (expandedImages.value[msgId]) {
    const msg = mergedMessages.value.find(m => m.id === msgId);
    const currentImg = getCurrentImage(msg);
    if (currentImg && currentImg.imagePath) {
      ensureImageLoaded(currentImg.id, currentImg.imagePath);
    }
  }
}

function confirmDeleteImage(msg: any) {
  const currentImg = getCurrentImage(msg);
  if (!currentImg) return;

  imageToDelete.value = currentImg;
  groupMsgToDelete.value = msg;
  imageToDeleteBase64.value = loadedImages.value[currentImg.id] || '';
  showDeleteModal.value = true;
}

function cancelDelete() {
  showDeleteModal.value = false;
  imageToDelete.value = null;
  groupMsgToDelete.value = null;
  imageToDeleteBase64.value = '';
}

async function executeDelete() {
  if (!imageToDelete.value || !groupMsgToDelete.value || isDeletingImage.value) return;

  isDeletingImage.value = true;
  try {
    const messageId = imageToDelete.value.id;
    const msg = groupMsgToDelete.value;

    const res = await window.api.invoke('theater-delete-message', {
      sessionId: props.sessionId,
      messageId: messageId
    });

    if (res && res.success) {
      // 1. 从前端的 messages 中移除该消息
      const idx = messages.value.findIndex(m => m.id === messageId);
      if (idx !== -1) {
        messages.value.splice(idx, 1);
        messages.value = [...messages.value]; // 触发计算属性 mergedMessages 重新计算
      }

      // 2. 清除该图片的加载缓存
      delete loadedImages.value[messageId];

      // 3. 调整当前轮播的 index
      const groupMsg = mergedMessages.value.find(m => m.id === msg.id);
      if (groupMsg && Array.isArray(groupMsg.images)) {
        const remainingCount = groupMsg.images.length;
        const currentIdx = currentImageIndex.value[msg.id] || 0;
        if (remainingCount === 0) {
          // 整组都没有图片了
          delete currentImageIndex.value[msg.id];
          delete expandedImages.value[msg.id];
        } else if (currentIdx >= remainingCount) {
          currentImageIndex.value[msg.id] = remainingCount - 1;
          // 加载新的当前图片
          const nextImg = groupMsg.images[remainingCount - 1];
          if (nextImg && nextImg.imagePath) {
            ensureImageLoaded(nextImg.id, nextImg.imagePath);
          }
        } else {
          // 索引虽然没变，但图片变了，所以要重新加载当前索引指向的图片
          const nextImg = groupMsg.images[currentIdx];
          if (nextImg && nextImg.imagePath) {
            ensureImageLoaded(nextImg.id, nextImg.imagePath);
          }
        }
      }
      
      // 成功后关闭弹窗
      cancelDelete();
    } else {
      alert('删除失败: ' + (res?.error || '未知错误'));
    }
  } catch (err: any) {
    console.error('删除插图失败:', err);
    alert('删除插图失败: ' + err.message);
  } finally {
    isDeletingImage.value = false;
  }
}



const expandedDashboards = ref<Record<string, boolean>>({});
function toggleDashboard(msgId: string) {
  expandedDashboards.value[msgId] = !expandedDashboards.value[msgId];
}

// 整理出场角色的头像，若无则使用首字母
function getCharAvatar(name: string) {
  const targetName = name === 'user' ? playerCharName.value : name;
  const c = characterStates.value.find(char => char.name === targetName);
  return c?.avatar || '';
}

// 格式化文本：高亮 *行动* 部分，并在动作和台词之间插入空行
function formatMessageContent(content: string) {
  if (!content) return '';
  
  // 在动作描述与台词之间插入空行（支持正向与反向相邻情况）
  const formattedText = content
    .replace(/(\*[\s\S]*?\*)\s*(“[\s\S]*?”)/g, '$1\n\n$2')
    .replace(/(“[\s\S]*?”)\s*(\*[\s\S]*?\*)/g, '$1\n\n$2');

  let formatted = formattedText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 支持 Mustache {{user}} 绕过编译
  // 我们直接渲染
  formatted = formatted.replace(/\*([\s\S]*?)\*/g, '<span class="action-desc">*$1*</span>');
  formatted = formatted.replace(/“([\s\S]*?)”/g, '<span class="dialogue-text">“$1”</span>');
  
  return formatted.replace(/\n/g, '<br/>');
}

// 判断是不是特殊气泡看板（变化看板）
function isSystemDashboard(content: string) {
  return content && content.startsWith('### 📋 本轮状态与关系变动看板');
}

function formatDashboard(content: string) {
  // 检查是否是老看板数据格式（即没有包含新标记）
  const hasStatus = content.includes('[STATUS_START]');
  const hasRelation = content.includes('[RELATION_START]');

  let statusItems: string[] = [];
  let relationItems: string[] = [];

  if (!hasStatus && !hasRelation) {
    // 兼容老看板数据格式，按行解析
    const lines = content
      .replace('### 📋 本轮状态与关系变动看板', '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('•') || l.startsWith('-'))
      .map(l => l.replace(/^[•-]\s*/, ''));

    // 老格式中根据内容区分状态与关系
    for (const line of lines) {
      if (line.includes('属性') && line.includes('变动为')) {
        statusItems.push(line);
      } else if (line.includes('→') || line.includes('->')) {
        relationItems.push(line);
      } else {
        statusItems.push(line);
      }
    }
  } else {
    // 新格式解析
    const statusMatch = content.match(/\[STATUS_START\]([\s\S]*?)\[STATUS_END\]/);
    if (statusMatch) {
      statusItems = statusMatch[1].trim().split('\n').map(s => s.trim().replace(/^-\s*/, '')).filter(Boolean);
    }
    const relationMatch = content.match(/\[RELATION_START\]([\s\S]*?)\[RELATION_END\]/);
    if (relationMatch) {
      relationItems = relationMatch[1].trim().split('\n').map(s => s.trim().replace(/^-\s*/, '')).filter(Boolean);
    }
  }

  let html = '';

  // 1. 状态变更渲染 (优雅网格卡片)
  if (statusItems.length > 0) {
    html += `
      <div class="dashboard-group mb-5">
        <div class="dashboard-group-title flex items-center gap-1.5 text-xs font-bold text-primary mb-3">
          <span class="w-1.5 h-3.5 rounded bg-primary"></span>
          状态与资产变更
        </div>
        <div class="dashboard-card-grid grid grid-cols-1 gap-2.5">
          ${statusItems.map(item => renderStatusCard(item)).join('')}
        </div>
      </div>
    `;
  }

  // 2. 关系变更渲染 (心智连线流)
  if (relationItems.length > 0) {
    html += `
      <div class="dashboard-group">
        <div class="dashboard-group-title flex items-center gap-1.5 text-xs font-bold text-success mb-3">
          <span class="w-1.5 h-3.5 rounded bg-emerald-500"></span>
          社会关系变更
        </div>
        <div class="dashboard-card-grid grid grid-cols-1 gap-2.5">
          ${relationItems.map(item => renderRelationCard(item)).join('')}
        </div>
      </div>
    `;
  }

  if (html === '') {
    return '<div class="text-xs text-on-surface-variant/60 italic text-center py-2">无任何变动记录</div>';
  }

  return html;
}

function renderStatusCard(item: string): string {
  const regex = /^([^\s：:]+)[\s：:]+属性\s*\[([^\]]+)\]\s*变动为\s*([\s\S]*?)\s*→\s*([\s\S]*)$/;
  const match = item.match(regex);

  if (!match) {
    return `
      <div class="px-3 py-2 rounded bg-surface-low border border-outline-variant/15 text-xs text-on-surface-variant leading-relaxed">
        ${formatDashboardLine(item)}
      </div>
    `;
  }

  const charName = match[1].trim();
  const attrName = match[2].trim();
  const oldVal = match[3].trim();
  const newVal = match[4].trim();

  const isDiffValue = newVal.startsWith('+') || newVal.startsWith('-');
  const isNumeric = !isNaN(Number(oldVal)) && (!isNaN(Number(newVal)) || isDiffValue);

  let valHtml = '';
  if (isNumeric) {
    const isUp = isDiffValue ? newVal.startsWith('+') : Number(newVal) > Number(oldVal);
    const badgeBg = isUp ? 'bg-green-500/10 text-green-500 border-green-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20';
    const arrow = isUp ? '↑' : '↓';
    valHtml = `
      <div class="flex items-center gap-1.5 font-mono text-xs font-bold">
        <span class="text-on-surface-variant/50">${oldVal}</span>
        <span class="text-on-surface-variant/30">→</span>
        <span class="px-1.5 py-0.5 rounded border text-[10px] ${badgeBg}">${arrow} ${newVal}</span>
      </div>
    `;
  } else {
    valHtml = `
      <div class="flex flex-col gap-1 mt-1 text-[11px] leading-relaxed">
        <div class="text-on-surface-variant/40 line-through truncate max-w-full">
          原: ${oldVal}
        </div>
        <div class="text-on-surface font-medium bg-primary/5 border border-primary/10 rounded px-2 py-1">
          新: ${newVal}
        </div>
      </div>
    `;
  }

  return `
    <div class="p-3 rounded-lg bg-surface-low border border-outline-variant/20 hover:border-outline-variant/40 transition-colors flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
            ${charName}
          </span>
          <span class="text-xs font-bold text-on-surface">
            ${attrName}
          </span>
        </div>
        ${isNumeric ? valHtml : ''}
      </div>
      ${!isNumeric ? valHtml : ''}
    </div>
  `;
}

function renderRelationCard(item: string): string {
  const regex = /^([^\s→\-]+)\s*(?:→|-\s*>)\s*([^\s：:]+)\s*[：:]\s*([\s\S]*)$/;
  const match = item.match(regex);

  if (!match) {
    return `
      <div class="px-3 py-2 rounded bg-surface-low border border-outline-variant/15 text-xs text-on-surface-variant leading-relaxed">
        ${formatDashboardLine(item)}
      </div>
    `;
  }

  const fromChar = match[1].trim();
  const toChar = match[2].trim();
  const description = match[3].trim();

  return `
    <div class="p-3 rounded-lg bg-surface-low border border-outline-variant/20 hover:border-emerald-500/30 transition-colors flex flex-col gap-2.5">
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
          ${fromChar}
        </span>
        <span class="text-on-surface-variant/40 font-mono">→</span>
        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
          ${toChar}
        </span>
      </div>
      <div class="text-xs text-on-surface leading-relaxed pl-1.5 border-l border-emerald-500/30">
        ${description}
      </div>
    </div>
  `;
}

function formatDashboardLine(line: string) {
  return line
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.*?)`/g, '<code class="diff-code">$1</code>');
}

// -------------------------------------------------------------
// 右侧侧边栏宽度拖动调整与销毁处理
// -------------------------------------------------------------
const rightPanelWidth = ref(340);
const isDraggingSidebar = ref(false);
let startX = 0;
let startWidth = 0;

function startResize(e: MouseEvent) {
  isDraggingSidebar.value = true;
  startX = e.clientX;
  startWidth = rightPanelWidth.value;
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function handleResize(e: MouseEvent) {
  if (!isDraggingSidebar.value) return;
  const deltaX = e.clientX - startX;
  // 鼠标向左拖动（deltaX为负）时右侧面板宽度增加，向右拖动时宽度减小
  let newWidth = startWidth - deltaX;
  if (newWidth < 280) newWidth = 280;
  if (newWidth > 600) newWidth = 600;
  rightPanelWidth.value = newWidth;
}

function stopResize() {
  isDraggingSidebar.value = false;
  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onUnmounted(() => {
  stopResize();
});
</script>

<template>
  <div class="theater-stage flex-1 flex min-h-0 bg-background text-on-surface overflow-hidden">
    <!-- ==========================================
         左栏：主聊天演绎面板
         ========================================== -->
    <div class="left-panel flex-1 min-w-0 flex flex-col min-h-0">
      <!-- 顶部状态信息 -->
      <header class="stage-header h-14 px-6 border-b border-outline-variant/30 bg-surface flex items-center justify-between flex-shrink-0">
        <div class="flex items-center space-x-3">
          <button @click="$emit('back')" class="p-1.5 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer" title="返回题材大堂">
            <ChevronLeftIcon class="w-4 h-4" />
          </button>
          <div class="min-w-0">
            <h2 class="text-sm font-bold text-on-surface truncate">舞台演绎中心</h2>
          </div>
        </div>


        <div class="flex items-center space-x-2">
          <button @click="openAgentConfig" class="p-2 rounded-full hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-all active:scale-90 cursor-pointer" title="配置 Agent 提示词">
            <Settings2Icon class="w-4 h-4" />
          </button>
          <button
            @click="resetThemeRuntime"
            :disabled="isGenerating || isResettingRuntime"
            class="p-2 rounded-full hover:bg-red-50 dark:hover:bg-red-500/10 text-on-surface-variant hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-90 cursor-pointer"
            title="清空当前剧本游玩数据并重新开始"
          >
            <Loader2Icon v-if="isResettingRuntime" class="w-4 h-4 animate-spin" />
            <Trash2Icon v-else class="w-4 h-4" />
          </button>
          <button v-if="isMobile" @click="isMobileRightPanelOpen = true" class="p-2 rounded-full hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-all active:scale-90 cursor-pointer" title="查看参演角色与状态">
            <UsersIcon class="w-4 h-4" />
          </button>
        </div>
      </header>

      <!-- 消息演绎流 -->
      <div ref="messageListRef" class="message-list flex-1 overflow-y-auto p-6 space-y-6">
        <div v-for="msg in mergedMessages" :key="msg.id" class="message-item animate-fade-in">
          
          <!-- 时空气泡渲染 -->
          <div v-if="msg.role === 'system' && msg.content?.startsWith('🎬')" class="timespace-wrapper mx-auto max-w-lg my-4 text-center">
            <div class="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary/5 border border-primary/15 text-[10px] font-extrabold text-primary shadow-xs">
              <SparklesIcon class="w-3.5 h-3.5 animate-pulse" />
              <span>{{ msg.content?.substring(1) }}</span>
            </div>
          </div>

          <!-- 看板渲染 -->
          <div v-else-if="isSystemDashboard(msg.content)" class="dashboard-wrapper mx-auto max-w-lg rounded-lg border border-outline-variant/30 bg-surface shadow-xs overflow-hidden my-4">
            <div @click="toggleDashboard(msg.id)" class="dashboard-header p-3 flex items-center justify-between bg-surface-low cursor-pointer hover:bg-surface-high transition-all select-none">
              <span class="text-xs font-bold text-primary flex items-center gap-1.5">
                📋 本轮状态与关系变动
              </span>
              <span class="text-[10px] text-on-surface-variant/60">
                {{ expandedDashboards[msg.id] ? '点击折叠' : '点击展开' }}
              </span>
            </div>
            <div v-if="expandedDashboards[msg.id]" class="dashboard-body p-4 border-t border-outline-variant/20 bg-surface animate-slide-down">
              <div v-html="formatDashboard(msg.content)" class="dashboard-content"></div>
            </div>
          </div>

          <!-- 插画气泡渲染 (支持多张图片合并轮播，且原比例展示) -->
          <div v-else-if="msg.type === 'image-group'" class="image-wrapper mx-auto max-w-sm rounded-lg border border-outline-variant/30 bg-surface shadow-sm overflow-hidden my-4">
            <div @click="toggleImage(msg.id)" class="image-header p-3 flex items-center justify-between bg-surface-low cursor-pointer hover:bg-surface-high transition-colors select-none">
              <span class="text-xs font-bold text-primary flex items-center gap-1.5">
                🎨 剧情生成插画
              </span>
              <span class="text-[10px] text-on-surface-variant/60">
                {{ expandedImages[msg.id] ? '点击折叠' : '点击展开' }}
              </span>
            </div>
            <div v-if="expandedImages[msg.id]" class="image-body animate-slide-down relative">
              <template v-if="msg.images && msg.images.length > 0">
                <div class="image-carousel-container relative bg-surface-high">
                  
                  <!-- 悬浮删除按钮 -->
                  <button @click.stop="confirmDeleteImage(msg)" 
                          class="absolute left-3 top-3 z-20 p-1.5 rounded-full bg-black/60 hover:bg-red-600 text-white transition-all active:scale-90 cursor-pointer shadow-xs select-none backdrop-blur-xs flex items-center justify-center" 
                          title="删除当前插图">
                    <Trash2Icon class="w-3.5 h-3.5" />
                  </button>

                  <!-- N / M 悬浮页码角标 -->
                  <div v-if="msg.images.length > 1" class="absolute right-3 top-3 z-10 px-2.5 py-0.5 rounded-full bg-black/60 text-white text-[9px] font-bold select-none tracking-wider backdrop-blur-xs">
                    {{ (currentImageIndex[msg.id] || 0) + 1 }} / {{ msg.images.length }}
                  </div>
                  
                  <!-- 左右悬浮切换按钮 -->
                  <template v-if="msg.images.length > 1">
                    <button @click.stop="switchImage(msg.id, -1, msg)" class="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center bg-black/40 hover:bg-black/60 text-white transition-all active:scale-90 cursor-pointer shadow-xs select-none">
                      <ChevronLeftIcon class="w-4 h-4" />
                    </button>
                    <button @click.stop="switchImage(msg.id, 1, msg)" class="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 rounded-full flex items-center justify-center bg-black/40 hover:bg-black/60 text-white transition-all active:scale-90 cursor-pointer shadow-xs select-none">
                      <ChevronRightIcon class="w-4 h-4" />
                    </button>
                  </template>

                  <!-- 渲染加载中或原比例大图 -->
                  <div v-if="!getCurrentImage(msg) || !loadedImages[getCurrentImage(msg)?.id]" class="flex flex-col items-center justify-center p-12 text-on-surface-variant/60">
                    <Loader2Icon class="w-6 h-6 animate-spin text-primary mb-2" />
                    <span class="text-[10px]">正在加载插图...</span>
                  </div>
                  <img v-else :src="loadedImages[getCurrentImage(msg)?.id]" class="w-full h-auto object-contain max-h-[500px] block mx-auto animate-fade-in" />
                  
                  <!-- 页脚展示涉及角色 -->
                  <div class="image-footer p-2 text-center bg-surface-high border-t border-outline-variant/20">
                    <span class="text-[10px] text-on-surface-variant/80 font-bold">涉及角色：{{ getCurrentImage(msg)?.actors || '环境' }}</span>
                  </div>

                </div>
              </template>
            </div>
          </div>

          <!-- 旁白叙事渲染 -->
          <div v-else-if="msg.role === 'narrator'" class="narrator-bubble text-center mx-auto max-w-xl p-4 rounded bg-primary/5 border-l-2 border-primary/40 my-3">
            <p v-html="formatMessageContent(msg.content)" class="text-xs text-on-surface-variant italic leading-relaxed"></p>
          </div>

          <!-- 系统提示渲染 -->
          <div v-else-if="msg.role === 'system'" class="system-bubble text-center text-[10px] text-on-surface-variant/60 my-2">
            <span>{{ msg.content }}</span>
          </div>

          <!-- 正常对话渲染 -->
          <div v-else class="flex gap-3" :class="{ 'flex-row-reverse': msg.role === 'user' }">
            <!-- 头像 -->
            <div class="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-outline-variant/30 shadow-sm flex items-center justify-center bg-surface-high text-xs font-bold text-on-surface-variant">
              <img v-if="getCharAvatar(msg.role)" :src="getCharAvatar(msg.role)" class="w-full h-full object-cover" />
              <span v-else>{{ msg.role === 'user' ? '我' : msg.role.substring(0, 1) }}</span>
            </div>
            
            <!-- 对话框 -->
            <div :class="isMobile ? 'max-w-[85%]' : 'max-w-[70%]'" class="space-y-1">
              <div class="text-[10px] text-on-surface-variant/75 px-1" :class="{ 'text-right': msg.role === 'user' }">
                {{ msg.role === 'user' ? playerCharName : msg.role }}
              </div>
              <div class="bubble px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed shadow-sm"
                   :class="msg.role === 'user' ? 'bg-primary text-on-primary dark:bg-[#1c3024] dark:text-[#86efac] rounded-tr-none' : 'bg-surface-high text-on-surface rounded-tl-none border border-outline-variant/20'">
                <p v-html="formatMessageContent(msg.content)"></p>
              </div>
            </div>
          </div>

        </div>
        
        <!-- 排队生成 Loading：仅显示当前正在思考的角色名与小加载点，不阻挡已生成气泡的视野 -->
        <div v-if="isGenerating" class="flex items-center gap-2 pl-1 py-1 animate-fade-in">
          <Loader2Icon class="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />
          <span class="text-[10px] text-on-surface-variant/60">{{ currentNpcGenerating || '...' }}</span>
          <span class="flex gap-0.5 items-center">
            <span class="w-1 h-1 rounded-full bg-primary/60 animate-bounce" style="animation-delay:0ms"></span>
            <span class="w-1 h-1 rounded-full bg-primary/60 animate-bounce" style="animation-delay:150ms"></span>
            <span class="w-1 h-1 rounded-full bg-primary/60 animate-bounce" style="animation-delay:300ms"></span>
          </span>
        </div>
      </div>

      <!-- 推进选项与底部输入框 -->
      <footer class="stage-footer p-5 border-t border-outline-variant/20 bg-surface flex flex-col space-y-3">
        <!-- 剧情推进选项区 (横向极简胶囊条) -->
        <div v-if="nextOptions.length > 0" class="options-capsule-row flex items-center gap-2 px-1 select-none flex-shrink-0 animate-fade-in">
          <span class="text-[10px] font-extrabold text-primary flex items-center gap-1 flex-shrink-0">
            <SparklesIcon class="w-3 h-3 text-primary animate-pulse" />
            <span>推进建议:</span>
          </span>
          <div class="flex-1 flex gap-2 overflow-x-auto scrollbar-none py-1 mask-right">
            <button v-for="(opt, idx) in nextOptions" :key="idx" 
                    @click="selectOption(opt)" 
                    :title="`${opt.action ? '行动: *' + opt.action + '* ' : ''}${opt.dialogue ? '对白: “' + opt.dialogue + '”' : ''}`"
                    class="inline-flex items-center gap-1.5 rounded-full bg-surface-high/60 dark:bg-surface-high/30 hover:bg-primary/10 border border-outline-variant/30 hover:border-primary/40 text-[10px] font-bold px-3 py-1 cursor-pointer text-on-surface-variant/80 hover:text-primary transition-all active:scale-95 shadow-xs flex-shrink-0">
              <span class="w-1 h-1 rounded-full bg-primary/50"></span>
              {{ opt.title }}
            </button>
          </div>
        </div>

        <!-- 双输入框集成控制面板 -->
        <div class="console-box flex gap-4 items-center bg-surface/50 dark:bg-surface-high/15 backdrop-blur-md border border-outline-variant/30 focus-within:border-primary/50 focus-within:ring-4 focus-within:ring-primary/5 p-3 rounded-2xl shadow-xs transition-all">
          <div class="flex-1 flex flex-col divide-y divide-outline-variant/10">
            <!-- 行动输入轨 -->
            <!-- 行动输入轨 -->
            <div class="flex items-start py-1.5 min-h-[48px]">
              <span class="text-[9px] font-extrabold text-primary bg-primary/5 dark:bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 mr-3 flex-shrink-0 select-none uppercase tracking-wider mt-1.5">🎬 行动</span>
              <textarea v-model="actionInput" rows="2" placeholder="描述你这一步的动作、环境变更等（例：三个小时后，我推开大门...）" 
                        @keydown.enter.prevent="handleSend" class="flex-1 bg-transparent border-none text-xs text-on-surface focus:outline-none placeholder-on-surface-variant/30 p-0 resize-none overflow-y-auto leading-relaxed" />
            </div>
            
            <!-- 对话输入轨 -->
            <div class="flex items-start py-1.5 min-h-[48px]">
              <span class="text-[9px] font-extrabold text-primary bg-primary/5 dark:bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 mr-3 flex-shrink-0 select-none uppercase tracking-wider mt-1.5">💬 对话</span>
              <textarea v-model="dialogueInput" rows="2" placeholder="输入你要说的话（例：你果然在这里，昨天晚上去见谁了？）" 
                        @keydown.enter.prevent="handleSend" class="flex-1 bg-transparent border-none text-xs text-on-surface focus:outline-none placeholder-on-surface-variant/30 p-0 resize-none overflow-y-auto leading-relaxed" />
            </div>
          </div>
          
          <!-- 圆形精致发送按钮 -->
          <button @click="handleSend" class="w-10 h-10 rounded-full bg-primary hover:bg-primary-container text-on-primary flex items-center justify-center transition-all hover:scale-105 active:scale-90 cursor-pointer shadow-sm flex-shrink-0" title="发送 (发送后自动排队演绎)">
            <SendIcon class="w-4 h-4" />
          </button>
        </div>
      </footer>
    </div>

    <!-- 拖拽调节侧边栏宽度手柄 -->
    <div v-if="!isMobile" class="resize-handle w-[3px] hover:w-[5px] active:w-[5px] h-full cursor-col-resize hover:bg-primary/40 active:bg-primary transition-all flex-shrink-0 bg-outline-variant/20 z-10"
         @mousedown="startResize"></div>

    <!-- 移动端背景遮罩层 -->
    <div v-if="isMobile && isMobileRightPanelOpen" @click="isMobileRightPanelOpen = false" class="fixed inset-0 bg-black/40 z-30 transition-opacity duration-300"></div>

    <!-- ==========================================
         右栏：辅助信息面板
         ========================================== -->
    <div class="right-panel flex flex-col min-h-0 bg-surface-low flex-shrink-0"
         :class="[
           isMobile ? 'fixed top-0 right-0 h-full z-40 shadow-2xl transition-transform duration-300 border-l border-outline-variant/30' : 'border-l border-outline-variant/20'
         ]"
         :style="isMobile ? { transform: isMobileRightPanelOpen ? 'translateX(0)' : 'translateX(100%)', width: '80vw' } : { width: rightPanelWidth + 'px' }">
      <!-- 角色头像横向滚动头部 -->
      <div class="cast-header border-b border-outline-variant/20 bg-surface flex-shrink-0 px-4 pt-4 pb-1">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-bold text-on-surface">参演阵容卡</h3>
          <button v-if="isMobile" @click="isMobileRightPanelOpen = false" class="p-1 rounded-full hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer" title="收起面板">
            <XIcon class="w-3.5 h-3.5" />
          </button>
        </div>
        <div class="cast-scroll grid grid-cols-[repeat(auto-fit,minmax(52px,1fr))] gap-x-4 gap-y-3 p-1 pb-1.5 overflow-y-auto max-h-[140px] scrollbar-thin">
          <!-- 排序：选中的/玩家当前角色在第一位 -->
          <div v-for="char in sortedCharacters" :key="char.name" 
               @click="selectedCharName = char.name"
               class="cast-avatar-card flex flex-col items-center gap-1.5 flex-shrink-0 cursor-pointer select-none relative group">
            
            <div class="avatar-ring w-12 h-12 rounded-full p-0.5 border-2 transition-all relative flex items-center justify-center bg-surface-high"
                 :class="[
                   selectedCharName === char.name ? 'border-primary scale-105 shadow-sm' : 'border-transparent group-hover:border-outline-variant/60',
                   char.isParticipating === false ? 'grayscale opacity-45' : ''
                 ]">
              <div class="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center text-xs font-bold bg-surface-high text-on-surface-variant">
                <img v-if="char.avatar" :src="char.avatar" class="w-full h-full object-cover" />
                <span v-else>{{ char.name.substring(0, 1) }}</span>
              </div>
              
              <!-- 扮演标识 Badge -->
              <span v-if="char.name === playerCharName" class="player-badge absolute -top-1 -right-1 bg-red-600 text-white font-bold text-[8px] px-1 py-0.5 rounded leading-none shadow">
                主
              </span>
            </div>
            <span class="text-[10px] font-medium transition-colors truncate max-w-[56px] text-center" :class="[
              selectedCharName === char.name ? 'text-primary font-bold' : 'text-on-surface-variant/70',
              char.isParticipating === false ? 'text-on-surface-variant/35 font-light' : ''
            ]">
              {{ char.name }}
            </span>
          </div>
        </div>
      </div>

      <!-- 选中角色详情区域 -->
      <div v-if="selectedCharState" class="char-detail-box flex-1 min-h-0 flex flex-col">
        <!-- 角色登场管理区 (主角无此操作) -->
        <div v-if="selectedCharName !== playerCharName" class="p-3 bg-surface-high/35 border-b border-outline-variant/15 flex items-center justify-between flex-shrink-0">
          <span class="text-[10px] text-on-surface-variant flex items-center gap-1.5 font-bold">
            <span :class="selectedCharState.isParticipating !== false ? 'text-primary' : 'text-on-surface-variant/40'">●</span>
            登场状态：{{ selectedCharState.isParticipating !== false ? '已在场参演' : '未登场/后备背景' }}
          </span>
          <button
            @click="toggleSessionCharacterParticipating(selectedCharName)"
            class="px-2.5 py-1 rounded text-[9px] font-bold transition-all active:scale-95 cursor-pointer border"
            :class="selectedCharState.isParticipating !== false 
              ? 'bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white border-red-500/30' 
              : 'bg-primary/10 text-primary hover:bg-primary hover:text-on-primary border-primary/30'"
          >
            {{ selectedCharState.isParticipating !== false ? '暂时退场' : '立刻登场' }}
          </button>
        </div>

        <!-- 属性 Tabs 头 -->
        <div class="detail-tabs h-11 border-b border-outline-variant/25 bg-surface flex items-center justify-between px-5 flex-shrink-0 select-none">
          <button v-for="tab in [
            { id: 'status', label: '状态栏' },
            { id: 'soul', label: '设定' },
            { id: 'relation', label: '关系' },
            { id: 'backpack', label: '背包' }
          ] as { id: typeof activeRightTab.value; label: string }[]" :key="tab.id"
                  @click="activeRightTab = tab.id"
                  class="flex-1 py-2 text-[11px] font-bold text-center border-b-2 transition-all cursor-pointer"
                  :class="activeRightTab === tab.id ? 'border-primary text-primary font-extrabold' : 'border-transparent text-on-surface-variant/60 hover:text-on-surface-variant'">
            {{ tab.label }}
          </button>
        </div>

        <!-- 具体的 Tab 详情容器 -->
        <div class="tab-content flex-1 min-h-0 overflow-y-auto space-y-4"
             :style="{ '--tab-content-pb': isMobile ? '80px' : '20px' }">
          
          <!-- A. 设定 Tab -->
          <div v-if="activeRightTab === 'soul'" class="space-y-4 animate-fade-in">
            <div class="flex items-center justify-between">
              <h4 class="text-[11px] font-extrabold tracking-wider text-on-surface-variant flex items-center gap-1.5 uppercase opacity-90">
                🧬 角色设定档案 / Character Soul
              </h4>
              <button v-if="!isEditingSoul" @click="openEditSoul" class="text-[10px] text-primary hover:text-on-primary transition-all flex items-center gap-1 cursor-pointer font-bold bg-primary/5 hover:bg-primary px-2.5 py-1 rounded-md border border-primary/20 hover:border-transparent active:scale-95 shadow-xs">
                <Edit3Icon class="w-3 h-3" />
                <span>编辑设定</span>
              </button>
            </div>
            
            <div v-if="!isEditingSoul" class="soul-viewer p-4 rounded-xl bg-surface/50 dark:bg-surface-high/20 border border-outline-variant/15 text-[11px] text-on-surface-variant/90 whitespace-pre-wrap leading-relaxed max-h-[360px] overflow-y-auto scrollbar-thin shadow-xs hover:border-outline-variant/30 transition-colors">
              {{ selectedCharState.soul || '暂无设定数据。' }}
            </div>
            
            <div v-else class="soul-editor space-y-3">
              <textarea v-model="editingSoulText" rows="14" class="w-full p-4 text-[11px] rounded-xl placeholder-on-surface-variant/30 resize-none leading-relaxed" placeholder="在此编辑角色性格设定与背景故事..."></textarea>
              <div class="flex justify-end gap-2">
                <button @click="isEditingSoul = false" class="px-3.5 py-1.5 rounded-md bg-surface-high hover:bg-surface dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-outline-variant/20 text-[10px] text-on-surface transition-colors cursor-pointer active:scale-95">取消</button>
                <button @click="saveSoulEdits" class="px-3.5 py-1.5 rounded-md bg-primary hover:bg-primary-container text-on-primary text-[10px] font-bold transition-all active:scale-95 cursor-pointer shadow-xs">保存修改</button>
              </div>
            </div>
          </div>

          <!-- B. 状态栏 Tab -->
          <div v-if="activeRightTab === 'status'" class="space-y-4 animate-fade-in flex flex-col min-h-0">
            <!-- 头部标题 -->
            <div class="flex-shrink-0">
              <h4 class="text-[11px] font-extrabold tracking-wider text-on-surface-variant flex items-center gap-1.5 uppercase opacity-90">
                📊 状态指标监视器 / Status Indicators
              </h4>
            </div>

            <!-- 卡片列表与新增按钮/表单共享同一个滚动容器，确保超出时可向下滚动，且按钮始终跟在状态卡片最下方 -->
            <div class="flex-1 overflow-y-auto scrollbar-thin space-y-4 pr-1"
                 :style="{ paddingBottom: isMobile ? '72px' : '0px' }">
              <div v-if="Object.keys(selectedCharState.status_bars).length === 0" class="text-center py-10 text-[10px] text-on-surface-variant/40 bg-surface/20 dark:bg-surface-high/10 rounded-xl border border-dashed border-outline-variant/20">
                暂未配置状态栏属性
              </div>
              
              <div v-else class="space-y-3">
                <div v-for="item in sortedStatusBars" :key="item.name" 
                     class="status-bar-card p-3.5 rounded-xl border border-outline-variant/15 bg-surface/40 dark:bg-surface-high/15 hover:border-primary/25 transition-all shadow-xs group">
                  
                  <!-- 数字型属性渲染渐变 Slider -->
                  <div v-if="item.isNum" class="space-y-2.5">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-on-surface tracking-wide">
                        {{ item.name }}
                      </span>
                      <span class="text-xs font-mono font-bold text-primary">{{ Number(item.val) }}%</span>
                    </div>
                    <div class="progress-container relative h-3 w-full rounded-full bg-surface dark:bg-zinc-800 overflow-hidden border border-outline-variant/10">
                      <div class="progress-bar h-full rounded-full transition-all duration-300 relative bg-gradient-to-r from-primary to-primary-container"
                           :style="{ width: `${Number(item.val)}%` }">
                      </div>
                      <!-- 拖动改变数值 input -->
                      <input type="range" min="0" max="100" :value="Number(item.val)" 
                             :disabled="selectedCharState.isParticipating === false"
                             @input="(e: any) => changeStatusBarVal(item.name, Number(e.target.value))"
                             @mousedown="(e: any) => handleRangeMouseDown(e, item.name)"
                             class="absolute inset-0 opacity-0 w-full h-full tech-range-input z-10"
                             :class="selectedCharState.isParticipating === false ? 'cursor-not-allowed' : 'cursor-pointer'" />
                    </div>
                  </div>
                  
                  <!-- 文本型属性直接修改 -->
                  <div v-else class="space-y-2">
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-bold text-on-surface tracking-wide">
                        {{ item.name }}
                      </span>
                    </div>
                    <textarea :value="item.val" 
                              :disabled="selectedCharState.isParticipating === false"
                              @blur="(e: any) => changeStatusBarVal(item.name, e.target.value)"
                              @keydown.enter="(e: any) => { e.target.blur(); }"
                              rows="2"
                              placeholder="输入状态描述..."
                              class="w-full px-3 py-2 text-[11px] rounded-lg placeholder-on-surface-variant/30 resize-none leading-relaxed"
                              :class="selectedCharState.isParticipating === false ? 'opacity-55 cursor-not-allowed bg-surface-low' : ''" />
                  </div>

                </div>
              </div>

              <!-- 新增状态属性按钮及表单 (放置于当前显示的所有状态栏的最下方) -->
              <div class="mt-4 border-t border-outline-variant/15 pt-3">
                <button v-if="!isAddingStatusBar" 
                        :disabled="selectedCharState.isParticipating === false"
                        @click="openAddStatusBarForm" 
                        class="w-full text-[10px] text-primary hover:text-on-primary transition-all flex items-center justify-center gap-1.5 cursor-pointer font-bold bg-primary/5 hover:bg-primary py-2 rounded-xl border border-primary/20 hover:border-transparent active:scale-98 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary/5 disabled:hover:text-primary">
                  <PlusIcon class="w-3.5 h-3.5" />
                  <span>添加状态栏指标</span>
                </button>

                <div v-else class="add-status-bar-form p-3.5 border border-outline-variant/20 bg-surface/50 dark:bg-surface-high/20 rounded-xl space-y-3 animate-slide-down shadow-xs">
                  <div class="text-[10px] font-bold text-primary flex items-center gap-1">
                    <span>新增全局状态栏指标</span>
                  </div>
                  
                  <input v-model="newBarName" type="text" placeholder="属性名称（如：San值、疯狂度）" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 focus:ring-4 focus:ring-primary/5" />
                  
                  <div class="grid grid-cols-2 gap-2">
                    <div class="space-y-1">
                      <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">类别</label>
                      <select v-model="newBarType" class="w-full px-2.5 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60">
                        <option value="number">数字型</option>
                        <option value="text">文本型</option>
                      </select>
                    </div>
                    <div class="space-y-1">
                      <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">初始值</label>
                      <input v-model="newBarInitial" type="text" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60" />
                    </div>
                  </div>

                  <div v-if="newBarType === 'number'" class="grid grid-cols-2 gap-2">
                    <div class="space-y-1">
                      <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">最小值</label>
                      <input v-model="newBarMin" type="number" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60" />
                    </div>
                    <div class="space-y-1">
                      <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">最大值</label>
                      <input v-model="newBarMax" type="number" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60" />
                    </div>
                  </div>

                  <input v-model="newBarDesc" type="text" placeholder="说明（如：用来衡量精神的稳定程度）" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60" />
                  <textarea v-model="newBarRule" placeholder="AI变动规则（如：在受到恐怖打击时扣减；归零时角色会彻底发狂）" rows="2" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 resize-none leading-relaxed" />

                  <div class="flex gap-2 justify-end">
                    <button @click="isAddingStatusBar = false" class="px-2.5 py-1 text-[10px] bg-surface-high hover:bg-surface dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-outline-variant/20 rounded-md cursor-pointer transition-colors active:scale-95">取消</button>
                    <button @click="submitNewStatusBar" class="px-3 py-1 text-[10px] bg-primary hover:bg-primary-container text-on-primary rounded-md font-bold transition-all active:scale-95 cursor-pointer shadow-xs">确认添加</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- C. 关系 Tab -->
          <div v-if="activeRightTab === 'relation'" class="space-y-4 animate-fade-in flex flex-col min-h-0">
            <div class="flex-shrink-0 space-y-3">
              <h4 class="text-[11px] font-extrabold tracking-wider text-on-surface-variant flex items-center gap-1.5 uppercase opacity-90">
                🤝 社会关系图谱 / Social Connections
              </h4>
              
              <div class="p-3 rounded-lg border-l-2 border-primary bg-primary/5 dark:bg-primary/10 text-[10px] text-on-surface-variant/80 leading-relaxed flex gap-2">
                <AlertCircleIcon class="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                <span>列出与其他角色的独立关系。修改文本将实时微调后续剧情演绎的走向。</span>
              </div>
              
              <div class="flex items-center justify-between pt-1">
                <span class="text-[10px] text-on-surface-variant/60 font-bold uppercase tracking-wider">关系卡片列表</span>
                <button @click="startAddRelation" 
                        :disabled="selectedCharState.isParticipating === false"
                        class="text-[9px] text-primary hover:text-on-primary bg-primary/5 hover:bg-primary px-2 py-0.5 rounded-md border border-primary/20 hover:border-transparent active:scale-95 transition-all flex items-center gap-0.5 cursor-pointer font-bold shadow-xs disabled:cursor-not-allowed disabled:opacity-50">
                  <PlusIcon class="w-2.5 h-2.5" />
                  <span>添加关系</span>
                </button>
              </div>
            </div>

            <!-- 卡片列表滚动容器 -->
            <div class="flex-1 overflow-y-auto scrollbar-thin space-y-3 pr-1">
              <!-- 1. 新增关系时，在列表顶端原地展现卡片表单 -->
              <div v-if="isEditingRelation && editingRelationItem && editingRelationItem.isNew" 
                   class="add-relation-form p-3.5 border border-primary/20 bg-surface/50 dark:bg-surface-high/20 rounded-xl space-y-3 animate-slide-down shadow-xs">
                <div class="text-[10px] font-bold text-primary flex items-center justify-between">
                  <span>✨ 新建社会关系</span>
                  <span class="text-[9px] text-on-surface-variant/70">当前角色：{{ editingRelationItem.from }}</span>
                </div>
                
                <div class="space-y-1.5">
                  <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">指向目标角色</label>
                  <select v-model="editingRelationItem.to" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-zinc-800 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 cursor-pointer">
                    <option value="" disabled>选择要关联的目标角色...</option>
                    <option v-for="name in availableTargetCharacters" :key="name" :value="name">{{ name }}</option>
                  </select>
                </div>
                
                <div class="space-y-1.5">
                  <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">具体关系/情感描述</label>
                  <textarea v-model="editingRelationItem.relation" placeholder="如：十分信任对方，愿意为彼此付出一切..." rows="2" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-zinc-800 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 resize-none leading-relaxed" />
                </div>
                
                <div class="flex gap-1.5 justify-end">
                  <button @click="isEditingRelation = false; editingRelationItem = null" class="px-2 py-0.5 text-[9px] bg-surface-high border border-outline-variant/20 rounded cursor-pointer hover:bg-surface active:scale-95 transition-all">取消</button>
                  <button @click="saveEditedRelation" class="px-2.5 py-0.5 text-[9px] bg-primary text-on-primary rounded font-bold cursor-pointer hover:bg-primary-container active:scale-95 transition-all">保存</button>
                </div>
              </div>

              <div v-if="parsedRelations.length === 0 && (!isEditingRelation || !editingRelationItem || !editingRelationItem.isNew)" 
                   class="text-center py-10 text-[10px] text-on-surface-variant/40 bg-surface/20 dark:bg-surface-high/10 rounded-xl border border-dashed border-outline-variant/20">
                暂无任何社交关系连线，可点击右上角添加。
              </div>
              
              <div v-else v-for="item in parsedRelations" :key="item.id" 
                   class="group p-3.5 rounded-xl border border-outline-variant/15 bg-surface/40 dark:bg-surface-high/15 hover:border-primary/25 transition-all flex flex-col gap-2 relative shadow-xs">
                
                <!-- 情况一：原地编辑表单 -->
                <div v-if="editingRelationItem && editingRelationItem.id === item.id" class="space-y-3">
                  <div class="text-[10px] font-bold text-primary flex items-center justify-between">
                    <span>📝 修改社会关系</span>
                    <span class="px-2 py-0.5 rounded bg-primary/10 text-primary text-[8px] tracking-wide font-bold">
                      {{ editingRelationItem.from }} → {{ editingRelationItem.to }}
                    </span>
                  </div>
                  
                  <div class="space-y-1.5">
                    <label class="block text-[8px] text-on-surface-variant/80 font-bold uppercase">具体关系/情感描述</label>
                    <textarea v-model="editingRelationItem.relation" rows="2" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-zinc-800 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 resize-none leading-relaxed" />
                  </div>
                  <div class="flex gap-1.5 justify-end">
                    <button @click="isEditingRelation = false; editingRelationItem = null" class="px-2 py-0.5 text-[9px] bg-surface-high border border-outline-variant/20 rounded cursor-pointer hover:bg-surface active:scale-95 transition-all">取消</button>
                    <button @click="saveEditedRelation" class="px-2.5 py-0.5 text-[9px] bg-primary text-on-primary rounded font-bold cursor-pointer hover:bg-primary-container active:scale-95 transition-all">保存</button>
                  </div>
                </div>

                <!-- 情况二：正常展示 -->
                <div v-else class="space-y-2">
                  <div v-if="!item.isInvalid" class="flex items-center justify-between text-xs">
                    <div class="flex items-center gap-1 font-bold text-on-surface">
                      <span class="px-2 py-0.5 rounded bg-primary/10 text-primary text-[9px] tracking-wide">{{ item.from }}</span>
                      <span class="text-on-surface-variant/40 text-[9px] font-normal">→</span>
                      <span class="px-2 py-0.5 rounded bg-primary/10 text-primary text-[9px] tracking-wide">{{ item.to }}</span>
                    </div>
                    <div class="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button @click="startEditRelation(item)" 
                              :disabled="selectedCharState.isParticipating === false"
                              class="p-1 rounded hover:bg-surface-high dark:hover:bg-zinc-800 text-on-surface-variant hover:text-primary transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50" 
                              title="编辑关系">
                        <Edit3Icon class="w-3.5 h-3.5" />
                      </button>
                      <button @click="deleteRelation(item.id)" 
                              :disabled="selectedCharState.isParticipating === false"
                              class="p-1 rounded hover:bg-red-500/10 text-on-surface-variant hover:text-red-500 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50" 
                              title="删除关系">
                        <Trash2Icon class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  
                  <div v-if="!item.isInvalid" class="text-[11px] text-on-surface/90 font-semibold leading-relaxed pl-1">
                    {{ item.relation }}
                  </div>
                  
                  <!-- 兼容不合规的老数据行 -->
                  <div v-else class="flex items-center justify-between text-[11px] text-on-surface-variant/80 italic leading-relaxed pl-1">
                    <span>{{ item.raw }}</span>
                    <button @click="deleteRelation(item.id)" 
                            :disabled="selectedCharState.isParticipating === false"
                            class="p-1 rounded hover:bg-red-500/10 text-on-surface-variant hover:text-red-500 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50" 
                            title="删除非标准行">
                      <Trash2Icon class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- D. 背包 Tab -->
          <div v-if="activeRightTab === 'backpack'" class="space-y-4 animate-fade-in">
            <!-- 钱包经济系统 -->
            <div class="balance-card p-4 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-zinc-900 dark:to-zinc-950 border border-outline-variant/30 flex items-center justify-between shadow-xs">
              <div class="flex items-center gap-2">
                <span class="text-base text-primary/80">🪙</span>
                <div class="flex flex-col">
                  <span class="text-[9px] text-on-surface-variant/60 font-bold uppercase tracking-wider">余额</span>
                </div>
              </div>
              <div class="flex items-center gap-1 bg-surface/60 dark:bg-zinc-800/60 border border-outline-variant/30 rounded-lg px-2.5 py-0.5 focus-within:border-primary/60 focus-within:ring-4 focus-within:ring-primary/5 transition-all">
                <span class="text-xs font-bold text-on-surface-variant">￥</span>
                <input type="number" :value="selectedCharState.balance" 
                       @blur="(e: any) => changeBalance(Number(e.target.value))"
                       @keydown.enter="(e: any) => changeBalance(Number(e.target.value))"
                       class="w-20 bg-transparent border-none text-right text-xs font-bold text-on-surface focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
              </div>
            </div>

            <!-- 背包物品 -->
            <div class="backpack-header flex items-center justify-between border-b border-outline-variant/15 pb-2 mt-4">
              <h4 class="text-[11px] font-extrabold tracking-wider text-on-surface-variant flex items-center gap-1.5 uppercase opacity-90">
                🎒 物品列表
              </h4>
              <button @click="isAddingItem = !isAddingItem" class="text-[10px] text-primary hover:text-on-primary transition-all flex items-center gap-0.5 cursor-pointer font-bold bg-primary/5 hover:bg-primary px-2 py-0.5 rounded-md border border-primary/20 hover:border-transparent active:scale-95 shadow-xs">
                <PlusIcon class="w-3 h-3" />
                <span>放入新物品</span>
              </button>
            </div>

            <!-- 新增物品框 -->
            <div v-if="isAddingItem" class="add-item-form p-3.5 border border-outline-variant/20 bg-surface/50 dark:bg-surface-high/20 rounded-xl space-y-3 animate-slide-down shadow-xs">
              <input v-model="newItemName" type="text" placeholder="输入物品名称" class="w-full px-3 py-1.5 text-[11px] rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 focus:ring-4 focus:ring-primary/5" />
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-1.5 text-xs text-on-surface-variant">
                  <span>数量:</span>
                  <input v-model="newItemQty" type="number" min="1" class="w-16 px-2 py-0.5 text-center rounded-lg bg-surface dark:bg-surface-high/30 border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary/60 focus:ring-4 focus:ring-primary/5" />
                </div>
                <div class="flex gap-2">
                  <button @click="isAddingItem = false" class="px-2.5 py-1 text-[10px] bg-surface-high hover:bg-surface dark:bg-zinc-800 dark:hover:bg-zinc-700 border border-outline-variant/20 rounded-md cursor-pointer transition-colors active:scale-95">取消</button>
                  <button @click="addBackpackItem" class="px-3 py-1 text-[10px] bg-primary hover:bg-primary-container text-on-primary rounded-md font-bold transition-all active:scale-95 cursor-pointer shadow-xs">添加</button>
                </div>
              </div>
            </div>

            <!-- 背包列表 -->
            <div v-if="selectedCharState.backpack.length === 0" class="text-center py-10 text-[10px] text-on-surface-variant/40 bg-surface/20 dark:bg-surface-high/10 rounded-xl border border-dashed border-outline-variant/15">
              暂无物品
            </div>
            <div v-else class="space-y-2 max-h-[220px] overflow-y-auto scrollbar-thin">
              <div v-for="item in selectedCharState.backpack" :key="item.name" 
                   class="item-row p-3 rounded-xl bg-surface/30 dark:bg-surface-high/10 border border-outline-variant/15 flex items-center justify-between hover:border-primary/20 dark:hover:border-primary/30 transition-all shadow-xs">
                <span class="text-xs text-on-surface font-medium flex items-center gap-2">
                  <span class="w-1.5 h-1.5 rounded-full bg-primary/60"></span>
                  {{ item.name }}
                </span>
                <div class="flex items-center space-x-1.5 bg-surface-high/60 dark:bg-zinc-800/60 border border-outline-variant/30 rounded-lg p-0.5">
                  <button @click="updateBackpackQty(item.name, -1)" class="w-5 h-5 rounded-md hover:bg-surface dark:hover:bg-zinc-700 text-[10px] font-extrabold text-on-surface-variant flex items-center justify-center cursor-pointer transition-colors">-</button>
                  <span class="text-xs font-mono font-bold w-6 text-center text-primary">{{ item.quantity }}</span>
                  <button @click="updateBackpackQty(item.name, 1)" class="w-5 h-5 rounded-md hover:bg-surface dark:hover:bg-zinc-700 text-[10px] font-extrabold text-on-surface-variant flex items-center justify-center cursor-pointer transition-colors">+</button>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- ==========================================
         右上角：Agent 提示词配置大弹窗
         ========================================== -->
    <div v-if="isConfigOpen" class="agent-config-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="modal-box w-[94vw] md:w-[760px] h-[85vh] md:h-[580px] bg-surface rounded-2xl md:rounded-xl shadow-2xl border border-outline-variant/40 flex flex-col overflow-hidden animate-slide-up">
        <!-- 弹窗头 -->
        <header class="p-4 border-b border-outline-variant/20 bg-surface-low flex items-center justify-between flex-shrink-0">
          <h3 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
            <span>🎭 {{ isMobile ? '提示词配置' : '十三大演绎 Agent 提示词配置' }}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">高级配置</span>
          </h3>
          <button @click="isConfigOpen = false" class="p-1 rounded-full hover:bg-surface-high text-on-surface-variant hover:text-on-surface cursor-pointer">
            <span class="text-xs font-bold px-1.5">✕</span>
          </button>
        </header>

        <!-- 弹窗 Body -->
        <div class="flex-1 flex min-h-0 bg-surface">
          <!-- 左边 Agent 切换列表 -->
          <div class="border-r border-outline-variant/20 bg-surface-low overflow-y-auto flex-shrink-0 select-none"
               :class="isMobile ? 'w-24' : 'w-48'">
            <button v-for="a in agentPromptEntries" :key="a.id"
                    @click="selectedAgentKey = a.id"
                    class="w-full py-3 text-xs font-bold text-left border-l-4 transition-all cursor-pointer hover:bg-surface-high"
                    :class="[
                      selectedAgentKey === a.id ? 'border-primary bg-surface text-primary' : 'border-transparent text-on-surface-variant/70',
                      isMobile ? 'px-2 text-center border-l-2' : 'px-4 text-left border-l-4'
                    ]">
              {{ isMobile ? formatMobileAgentLabel(a.label) : a.label }}
            </button>
          </div>

          <!-- 右边 Prompt 修改区域 -->
          <div class="flex-1 min-h-0 flex flex-col p-5 space-y-4">
            <!-- 勾选生图开关 (特殊处理：在生图 Agent 面板顶部展示) -->
            <div v-if="selectedAgentKey === 'imageGen'" class="p-3 bg-primary/5 rounded border border-primary/20 flex items-center justify-between">
              <div class="space-y-0.5">
                <div class="text-xs font-bold text-primary">启用大剧院 AI 剧情生图</div>
                <div class="text-[9px] text-on-surface-variant/70">本功能需要您在常规设置中已开启 NovelAI 绘图功能且生图 API 密钥有效。</div>
              </div>
              <input type="checkbox" v-model="enableImageGen" class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/50 cursor-pointer" />
            </div>
            <div v-if="selectedAgentKey === 'options'" class="p-3 bg-primary/5 rounded border border-primary/20 flex items-center justify-between">
              <div class="space-y-0.5">
                <div class="text-xs font-bold text-primary">启用大剧院剧情推进选项</div>
                <div class="text-[9px] text-on-surface-variant/70">关闭后每轮结束不会调用推进选项 Agent，底部引导选项保持为空。</div>
              </div>
              <input type="checkbox" v-model="enableOptionsGen" class="w-4 h-4 rounded text-primary focus:ring-primary border-outline-variant/50 cursor-pointer" />
            </div>
            
            <div class="flex-1 flex flex-col min-h-0">
              <label class="text-[10px] font-bold text-on-surface-variant mb-1.5">系统内置/当前配置提示词（支持自由微调编辑）：</label>
              <textarea v-model="configPrompts[selectedAgentKey]" class="flex-1 w-full p-3 text-[11px] rounded bg-surface-high border border-outline-variant/40 text-on-surface focus:outline-none focus:border-primary resize-none leading-relaxed font-mono"></textarea>
            </div>

            <!-- 可用变量速查手册 (全局一致) -->
            <div class="bg-surface-low rounded border border-outline-variant/15 flex flex-col flex-shrink-0">
              <div @click="showVariablesHelp = !showVariablesHelp" 
                   class="p-2.5 flex items-center justify-between cursor-pointer hover:bg-surface-high transition-colors select-none text-[10px] font-bold text-primary">
                <span class="flex items-center gap-1.5 min-w-0 flex-1">
                  <svg class="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                  <span class="truncate">{{ isMobile ? '💡 可用注入变量速查' : '💡 可用注入变量速查手册 (点击变量名或右侧按钮直接复制，支持任意 Agent 组合编写)' }}</span>
                </span>
                <span class="text-on-surface-variant/50 font-normal flex-shrink-0 ml-2">
                  {{ showVariablesHelp ? (isMobile ? '折叠' : '点击折叠') : (isMobile ? '展开' : '点击展开查看全部可用变量') }}
                </span>
              </div>
              
              <div v-if="showVariablesHelp" class="border-t border-outline-variant/15 p-3 max-h-[140px] overflow-y-auto scrollbar-thin animate-slide-down">
                <div class="grid grid-cols-1 gap-2">
                  <div v-for="v in availableVariables" :key="v.name" 
                       class="flex flex-col sm:flex-row sm:items-center justify-between p-2 rounded bg-surface border border-outline-variant/20 hover:border-outline-variant/40 transition-colors group gap-2.5 sm:gap-4">
                    <div class="space-y-1 sm:space-y-0.5 flex-1 min-w-0 pr-0 sm:pr-4">
                      <div class="flex items-center gap-2">
                        <code @click="copyVariableText(v.name)" class="diff-code text-[10px] font-mono text-primary font-bold cursor-pointer hover:bg-primary/5 active:scale-95 transition-all flex-shrink-0">{{ '{' + v.name + '}' }}</code>
                        <span class="text-[8px] px-1.5 py-0.5 rounded bg-surface-high text-on-surface-variant/80 border border-outline-variant/20 scale-90 origin-left whitespace-nowrap flex-shrink-0">
                          {{ v.label }}
                        </span>
                      </div>
                      <p class="text-[9px] text-on-surface-variant/70 leading-normal">{{ v.desc }}</p>
                    </div>
                    <button 
                      @click="copyVariableText(v.name)"
                      class="px-2 py-1 rounded text-[8px] font-bold bg-primary/10 text-primary border border-primary/20 hover:bg-primary hover:text-on-primary transition-all active:scale-95 cursor-pointer flex items-center justify-center gap-1 flex-shrink-0 self-end sm:self-auto"
                    >
                      <svg class="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2"></path></svg>
                      <span>复制</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 弹窗底部操作 -->
        <footer class="p-4 border-t border-outline-variant/20 bg-surface-low flex justify-end gap-3 flex-shrink-0">
          <button @click="isConfigOpen = false" class="px-4 py-2 rounded bg-surface-high border border-outline-variant/40 text-xs text-on-surface cursor-pointer">取消</button>
          <button @click="saveAgentConfig" class="px-5 py-2 rounded bg-primary text-on-primary text-xs font-bold flex items-center space-x-1.5 cursor-pointer shadow-sm">
            <SaveIcon class="w-4 h-4" />
            <span>保存全部配置</span>
          </button>
        </footer>
      </div>
    </div>

    <!-- 全局 Toast 浮窗 -->
    <transition name="fade">
      <div v-if="toastVisible" class="toast-overlay fixed bottom-10 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-lg bg-surface border border-outline-variant/40 shadow-xl flex items-center gap-2">
        <AlertCircleIcon class="w-4 h-4 text-primary" />
        <span class="text-xs font-bold text-on-surface">{{ toastMessage }}</span>
      </div>
    </transition>

    <!-- 删除确认自定义弹窗 -->
    <transition name="fade">
      <div v-if="showDeleteModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-xs select-none">
        <div class="w-80 bg-surface rounded-xl border border-outline-variant/40 shadow-2xl p-5 overflow-hidden animate-slide-up flex flex-col space-y-4">
          
          <!-- 弹窗头部 -->
          <div class="flex items-start gap-3">
            <div class="p-2 rounded-full bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 flex-shrink-0 animate-pulse">
              <AlertCircleIcon class="w-5 h-5" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-on-surface">删除剧情插画</h3>
              <p class="text-xs text-on-surface-variant/80 mt-1 leading-relaxed">确定要删除这张自动生成的剧情插图吗？删除后，数据库记录及本地物理文件都将被永久硬删除且不可恢复。</p>
            </div>
          </div>

          <!-- 确认预览小图 -->
          <div v-if="imageToDeleteBase64" class="w-full h-28 rounded-lg overflow-hidden border border-outline-variant/20 bg-surface-low relative">
            <img :src="imageToDeleteBase64" class="w-full h-full object-cover" />
          </div>

          <!-- 弹窗底部操作按钮 -->
          <div class="flex gap-2 justify-end text-xs">
            <button @click="cancelDelete" class="px-4 py-2 rounded-lg border border-outline-variant hover:bg-surface-high text-on-surface-variant transition-colors cursor-pointer">
              取消
            </button>
            <button @click="executeDelete" class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-all font-bold cursor-pointer shadow-xs active:scale-95 flex items-center gap-1">
              <Trash2Icon v-if="!isDeletingImage" class="w-3.5 h-3.5" />
              <Loader2Icon v-else class="w-3.5 h-3.5 animate-spin" />
              {{ isDeletingImage ? '正在删除...' : '确定删除' }}
            </button>
          </div>

        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.cast-header {
  padding: 16px 20px 12px 20px;
}
.tab-content {
  padding: 20px;
  padding-bottom: var(--tab-content-pb, 20px);
}

/* 科技感 textarea 明暗模式样式自适应 */
.char-detail-box textarea {
  background-color: var(--surface-low, #f1f3ff);
  color: var(--on-surface, #141b2b);
  border: 1px solid var(--outline-variant, #c7c4d7);
  transition: all 0.2s ease;
}

.char-detail-box textarea:focus {
  background-color: var(--surface, #ffffff);
  border-color: var(--primary, #4648d4);
  outline: none;
  box-shadow: 0 0 0 4px rgba(70, 72, 212, 0.08);
}

.dark .char-detail-box textarea {
  background-color: #1a1a1a;
  color: #e5e2e1;
  border-color: #262626;
}

.dark .char-detail-box textarea:focus {
  background-color: #1e1e1e;
  border-color: #4edea3;
  box-shadow: 0 0 0 4px rgba(78, 222, 163, 0.12);
}
.theater-stage {
  font-family: 'Outfit', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* 消息流气泡定制 */
.bubble {
  word-break: break-word;
  white-space: pre-wrap;
}

:deep(.action-desc) {
  font-style: italic;
  font-weight: 400;
  color: #7c3aed; /* 优雅的亮色紫 */
}

.dark :deep(.action-desc) {
  color: #c084fc; /* 柔和的暗色紫 */
}

.bg-primary :deep(.action-desc) {
  color: rgba(255, 255, 255, 0.78) !important; /* 强制覆盖为半透明白，保证主色背景高可读性 */
  font-style: italic;
}

.dark .bg-primary :deep(.action-desc) {
  color: rgba(134, 239, 172, 0.8) !important; /* 暗色模式下，用户的行动描述显示为淡嫩绿，保证柔和性 */
}

:deep(.dialogue-text) {
  font-weight: 700;
  color: #111827; /* 醒目深灰/黑 */
}

.dark :deep(.dialogue-text) {
  color: #f9fafb; /* 醒目浅灰/白 */
}

.dark .bg-primary :deep(.dialogue-text) {
  color: #a7f3d0 !important; /* 用户对话文字采用嫩绿色，避免纯白刺眼 */
}

.bg-primary :deep(.dialogue-text) {
  color: #ffffff !important; /* 强制高亮纯白 */
}

.dashboard-list {
  list-style-type: disc !important;
}

.dashboard-group:first-child .dashboard-item::marker {
  color: var(--md-sys-color-primary, #6366f1);
}

.dashboard-group:last-child .dashboard-item::marker {
  color: #10b981; /* 翠绿色 */
}

.diff-code {
  font-family: monospace;
  background-color: rgba(255, 255, 255, 0.05);
  padding: 1px 4px;
  border-radius: 3px;
  color: #f43f5e;
}

/* 进度条的动画特效 */
.progress-bar::after {
  content: '';
  position: absolute;
  top: 0; left: 0; bottom: 0; right: 0;
  background-image: linear-gradient(
    -45deg,
    rgba(255, 255, 255, 0.15) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255, 255, 255, 0.15) 50%,
    rgba(255, 255, 255, 0.15) 75%,
    transparent 75%,
    transparent
  );
  z-index: 1;
  background-size: 30px 30px;
  animation: move-stripes 2.5s linear infinite;
  border-radius: 9999px;
}

@keyframes move-stripes {
  0% { background-position: 0 0; }
  100% { background-position: 30px 0; }
}

/* UI 渐变动画 */
.animate-fade-in {
  animation: fadeIn 0.3s ease-out forwards;
}

.animate-slide-down {
  animation: slideDown 0.25s ease-out forwards;
}

.animate-slide-up {
  animation: slideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}

.scrollbar-thin::-webkit-scrollbar {
  height: 4px;
  width: 4px;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 99px;
}

/* 隐藏滚动条 */
.scrollbar-none::-webkit-scrollbar {
  display: none;
}
.scrollbar-none {
  -ms-overflow-style: none;  /* IE and Edge */
  scrollbar-width: none;  /* Firefox */
}

/* 渐变遮罩，使选项右侧截断平滑过渡 */
.mask-right {
  mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
}

.tech-range-input {
  z-index: 10;
}

/* 自定义滑动调节控件的 Thumb 样式 */
.tech-range-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  border: 2px solid var(--md-sys-color-primary, #4648d4);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.status-bar-card:hover .tech-range-input::-webkit-slider-thumb {
  opacity: 1;
}

.tech-range-input::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  border: 2px solid var(--md-sys-color-primary, #4648d4);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.status-bar-card:hover .tech-range-input::-moz-range-thumb {
  opacity: 1;
}
</style>

<!-- 全局样式：强制纠正暗色模式下被 Scoped 机制阻碍的文本高亮颜色 -->
<style>
.dark .dialogue-text {
  color: #f9fafb !important;
}
.dark .action-desc {
  color: #c084fc !important;
}
</style>
