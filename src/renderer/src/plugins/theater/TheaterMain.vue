<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import {
  ChevronLeftIcon,
  PlusIcon,
  Trash2Icon,
  RotateCcwIcon,
  ZoomInIcon,
  ZoomOutIcon,
  Loader2Icon,
  Settings2Icon,
  PlayIcon,
  UsersIcon,
  GlobeIcon,
  UploadIcon,
  SparklesIcon,
  SaveIcon,
  FileJsonIcon,
  SearchIcon,
  XIcon,
  SmileIcon,
  AlertCircleIcon,
  CheckIcon,
  Edit3Icon,
  DownloadIcon
} from 'lucide-vue-next';
import TheaterStage from './TheaterStage.vue';

defineProps<{
  isMobile: boolean;
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

// -------------------------------------------------------------
// 状态管理
// -------------------------------------------------------------
type ViewState = 'list' | 'lobby' | 'editor' | 'stage';
const viewState = ref<ViewState>('list');
const activeSessionId = ref('');

const themes = ref<any[]>([]);
const selectedTheme = ref<any>(null);
const hasDrawing = ref(false);
const isProcessing = ref(false);
const drawingIndices = ref<Set<number>>(new Set());
const processStep = ref('');
const processSteps = ref<string[]>([]);
const currentStepIndex = ref(0);

// AI智能生成或卡片导入时的灵感提示词
const aiPromptInput = ref('');

// 通讯录导入角色弹窗状态
const isAddressBookOpen = ref(false);
const addressBookChars = ref<any[]>([]);
const addressBookSearchQuery = ref('');
const selectedAddressBookCharIds = ref<string[]>([]);

// 导入用户人设弹窗状态
const isUserProfileOpen = ref(false);
const userProfiles = ref<any[]>([]);

// 导入已注册状态栏弹窗状态
const isImportPresetOpen = ref(false);
const presetList = ref<any[]>([]);
const selectedPresetIds = ref<string[]>([]);

// AI 生成背景灵感输入弹窗状态
const isCreativePromptOpen = ref(false);
const creativePromptText = ref('');
const creativePromptType = ref<'world' | 'scenario'>('world');

// 全局 Toast 提示状态
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
// 重写本地 alert 弹出框为全局 Toast，绕过 Electron 原生阻塞弹窗限制且提升视觉观感
function alert(msg: any) {
  showToast(String(msg));
}

// 全局 Confirm 确认框状态
const confirmVisible = ref(false);
const confirmMessage = ref('');
let confirmCallback: (() => void) | null = null;
function showConfirm(msg: string, callback: () => void) {
  confirmMessage.value = msg;
  confirmCallback = callback;
  confirmVisible.value = true;
}
function handleConfirmOk() {
  if (confirmCallback) confirmCallback();
  confirmVisible.value = false;
}

// 状态栏属性常用 Emoji 预置列表
const presetEmojis = [
  '❤️',
  '🧠',
  '⚡',
  '💪',
  '🛡️',
  '⚔️',
  '🔮',
  '💰',
  '🌟',
  '🍀',
  '🔥',
  '💧',
  '🍃',
  '😀',
  '😄',
  '😂',
  '😉',
  '😊',
  '😍',
  '😘',
  '😚',
  '😜',
  '😎',
  '😭',
  '😱',
  '😡',
  '👍',
  '👎',
  '👏',
  '🤝',
];
const activeEmojiPickerIndex = ref<number | null>(null);

// -------------------------------------------------------------
// 表单数据定义
// -------------------------------------------------------------
interface CharacterForm {
  name: string;
  gender: string;
  age: string;
  soul: string;
  appearance: string;
  avatar?: string;
  avatarBase64?: string;
}

interface RelationForm {
  from: string;
  to: string;
  type: string;
}

interface StatusBarForm {
  name: string;
  emoji: string;
  type: 'number' | 'text';
  min?: number;
  max?: number;
  initialValue: number | string;
  aiRule: string;
  description: string; // 属性说明
}

interface ThemeForm {
  id?: string;
  name: string;
  world_settings: string;
  scenario: string;
  status_bars: StatusBarForm[];
  relations: RelationForm[];
  characters: CharacterForm[];
  cover?: string;
  coverBase64?: string;
}

const form = ref<ThemeForm>({
  name: '',
  world_settings: '',
  scenario: '',
  status_bars: [],
  relations: [],
  characters: [],
  cover: '',
  coverBase64: '',
});

// 编辑器当前的 Tab 模式: 'manual' | 'ai' | 'card'
const editorTab = ref<'manual' | 'ai' | 'card'>('manual');
// 跟踪当前正在进行“用户人设替换”的角色索引，若为 null 则代表全局尾端追加导入
const replaceCharIndex = ref<number | null>(null);
// 控制“新剧本”下拉菜单的开启状态
const isCreateMenuOpen = ref(false);

// -------------------------------------------------------------
// 关系图谱 SVG 平移与缩放状态
// -------------------------------------------------------------
const zoom = ref(1.0);
const panX = ref(0);
const panY = ref(0);
const svgNodes = ref<{ name: string; x: number; y: number }[]>([]);
const draggedNodeIndex = ref<number | null>(null);

let lastMouseX = 0;
let lastMouseY = 0;
let isDraggingCanvas = false;

// -------------------------------------------------------------
// 大堂 Lobby 运行态选项
// -------------------------------------------------------------
const selectedPlayerChar = ref('');
const playMode = ref<'immersive' | 'tactical'>('immersive');
const readyNpcNames = ref<Set<string>>(new Set());

// -------------------------------------------------------------
// 辅助工具：莫兰迪低饱和度渐变色生成
// -------------------------------------------------------------
function getMorandiColors(name: string): [string, string] {
  if (!name) return ['#abb1b8', '#c6cbd2'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    ['#a8bca1', '#7e9377'], // 雅致灰绿
    ['#cbbfa8', '#a49881'], // 递进灰褐
    ['#a5b7cd', '#7c8fa8'], // 雾霾蓝灰
    ['#d2b4b4', '#ab8a8a'], // 莫兰迪粉
    ['#cbb4d2', '#9c82a5'], // 紫罗兰灰
    ['#b4c4c4', '#8a9c9c'], // 清新青灰
    ['#dacbb4', '#b3a088'], // 暖沙色
    ['#acbabc', '#809193'], // 浅松石灰
    ['#cdbfb4', '#a8988c'], // 大地暖灰
    ['#b5b5b5', '#8f8f8f'], // 经典灰
  ];
  const index = Math.abs(hash) % colors.length;
  return colors[index] as [string, string];
}

function getMorandiGradient(name: string) {
  const [c1, c2] = getMorandiColors(name);
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

function formatAge(age: string | number | undefined) {
  if (age === null || age === undefined || age === '') return '';
  const ageStr = String(age).trim();
  if (ageStr.endsWith('岁')) {
    return ageStr;
  }
  return ageStr + '岁';
}

const participatingChars = ref<string[]>([]);

function toggleParticipating(name: string) {
  const idx = participatingChars.value.indexOf(name);
  if (idx > -1) {
    participatingChars.value.splice(idx, 1);
  } else {
    participatingChars.value.push(name);
  }
}

watch(selectedPlayerChar, (newPlayer, oldPlayer) => {
  if (!selectedTheme.value || !selectedTheme.value.characters) return;

  // 1. 初始化就绪态 NPC 列表
  readyNpcNames.value = new Set(selectedTheme.value.characters.map((c: any) => c.name));
  if (newPlayer) {
    readyNpcNames.value.delete(newPlayer);
  }

  // 2. 更新参演角色勾选状态，若老主角存在且未勾选，自动切为参演；新主角强行排除
  participatingChars.value = participatingChars.value.filter(n => n !== newPlayer);
  if (oldPlayer && oldPlayer !== newPlayer && !participatingChars.value.includes(oldPlayer)) {
    participatingChars.value.push(oldPlayer);
  }
});

// -------------------------------------------------------------
// 生命周期与数据拉取
// -------------------------------------------------------------
onMounted(async () => {
  await loadThemes();
  await checkDrawingStatus();
});

async function loadThemes() {
  const res = await window.api.invoke('theater-list-themes');
  if (res.success) {
    themes.value = res.list || [];
  }
}

async function checkDrawingStatus() {
  const res = await window.api.invoke('theater-get-drawing-status');
  if (res.success) {
    hasDrawing.value = !!res.hasDrawing;
  }
}

// -------------------------------------------------------------
// 剧本列表操作
// -------------------------------------------------------------
async function enterLobby(theme: any) {
  selectedTheme.value = theme;

  // 优先检测该剧本是否已经存在会话记录
  try {
    const checkRes = await window.api.invoke('theater-find-active-session', { themeId: theme.id });
    if (checkRes.success && checkRes.sessionId) {
      // 存在历史会话，直接恢复进入演绎舞台
      activeSessionId.value = checkRes.sessionId;
      viewState.value = 'stage';
      return;
    }
  } catch (err) {
    console.error('检测已有大剧院会话失败:', err);
  }
  
  let userPersonaName = '';
  try {
    // 异步拉取个人中心人设列表进行名字比对
    const res = await window.api.invoke('list-user-profiles');
    if (res.success && res.list && res.list.length > 0) {
      const userProfileNames = res.list.map((p: any) => p.name).filter(Boolean);
      if (theme.characters && theme.characters.length > 0) {
        // 优先匹配名字在用户人设列表中的第一个角色
        const firstMatched = theme.characters.find((c: any) => userProfileNames.includes(c.name));
        if (firstMatched) {
          userPersonaName = firstMatched.name;
        }
      }
    }
  } catch (err) {
    console.error('获取用户人设列表进行比对失败:', err);
  }

  selectedPlayerChar.value = userPersonaName
    ? userPersonaName
    : (theme.characters && theme.characters.length > 0 ? theme.characters[0].name : '');

  readyNpcNames.value = new Set(theme.characters ? theme.characters.map((c: any) => c.name) : []);
  // 移除主角的就绪态，只针对群演NPC
  if (selectedPlayerChar.value) {
    readyNpcNames.value.delete(selectedPlayerChar.value);
  }

  // 初始化参演角色勾选状态，默认除主角外全选
  participatingChars.value = theme.characters 
    ? theme.characters.map((c: any) => c.name).filter((n: string) => n !== selectedPlayerChar.value)
    : [];

  viewState.value = 'lobby';
}

// 打开创建编辑器，支持指定初始模式（手动、AI 编织或角色卡导入）
function openCreateEditor(mode: 'manual' | 'ai' | 'card' = 'manual') {
  form.value = {
    name: '',
    world_settings: '',
    scenario: '',
    status_bars: [], // 依照最新指示：不预置任何内容
    relations: [],
    characters: [], // 依照最新指示：不预置任何内容
    cover: '',
    coverBase64: '',
  };
  svgNodes.value = [];
  editorTab.value = mode;
  aiPromptInput.value = '';
  viewState.value = 'editor';
}

function openEditEditor() {
  if (!selectedTheme.value) return;
  const theme = selectedTheme.value;

  // 检测是否存在占位符，用来在加载时对 {{user}} 主角进行标红提示与展开自愈
  const contentString = JSON.stringify(theme);
  const hasUserField = /\{\{user\}\}|<user>/i.test(contentString);

  form.value = {
    id: theme.id,
    name: theme.name,
    world_settings: theme.world_settings || '',
    scenario: theme.scenario || '',
    status_bars: theme.status_bars 
      ? JSON.parse(JSON.stringify(theme.status_bars)).map((bar: any) => ({ ...bar, isCollapsed: true })) 
      : [],
    relations: theme.relations ? JSON.parse(JSON.stringify(theme.relations)) : [],
    characters: theme.characters 
      ? JSON.parse(JSON.stringify(theme.characters)).map((c: any) => {
          const isPlaceholder = c.name === '{{user}}' || c.name === '<user>';
          return {
            ...c,
            isCollapsed: isPlaceholder ? false : true,
            isPlaceholderUser: isPlaceholder ? true : undefined,
          };
        })
      : [],
    cover: theme.cover || '',
  };

  // 初始化图谱节点
  initRelationshipNodes();
  editorTab.value = 'manual';
  viewState.value = 'editor';
}

async function handleDeleteTheme(themeId: string, event: MouseEvent) {
  event.stopPropagation();
  showConfirm('确认要物理删除该剧本包吗？此操作将同步清空数据库缓存且不可恢复。', async () => {
    const res = await window.api.invoke('theater-delete-theme', { themeId });
    if (res.success) {
      showToast('剧本包已物理删除 🗑️');
      await loadThemes();
      if (selectedTheme.value && selectedTheme.value.id === themeId) {
        selectedTheme.value = null;
        viewState.value = 'list';
      }
    } else {
      showToast('删除失败: ' + res.error);
    }
  });
}

async function handleExportTheme(themeId: string, event: MouseEvent) {
  event.stopPropagation();
  isProcessing.value = true;
  processStep.value = '正在导出剧本题材为 .echotheater 压缩包...';
  try {
    const res = await window.api.invoke('theater-export-theme', { themeId });
    if (res.success) {
      if (res.isDocker && res.base64) {
        // Docker/Web 模式下：将 Base64 还原为 Blob 并触发浏览器端标准 Web 下载
        const blob = await fetch(res.base64).then((r) => r.blob());
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = res.filename || 'ThemeExport.echotheater';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast('剧本包已在浏览器成功触发下载 💾');
      } else {
        showToast('剧本包已导出成功 💾');
      }
    } else if (res.canceled) {
      // 用户取消导出
    } else {
      showToast('导出失败: ' + res.error);
    }
  } catch (err: any) {
    alert('导出剧本包发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

async function handleTriggerImport() {
  isProcessing.value = true;
  processStep.value = '正在准备导入剧本...';
  try {
    const res = await window.api.invoke('theater-import-theme');
    if (res.success) {
      showToast('剧本包导入成功 🎉');
      await loadThemes();
    } else if (res.canceled) {
      // 用户取消导入，静默
    } else if (res.error && res.error.includes('Docker 模式下不支持')) {
      // 在 Docker/Web 浏览器环境下，降级触发前端的原生 file input 上传
      const fileInput = document.getElementById('theater-import-file-input');
      fileInput?.click();
    } else {
      alert('导入失败: ' + res.error);
    }
  } catch (err: any) {
    alert('导入发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

async function handleWebImportTheme(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];

  isProcessing.value = true;
  processStep.value = `正在读取剧本压缩包 [${file.name}]...`;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target?.result as string;
    processStep.value = '正在解码并解包还原剧本目录...';
    try {
      const res = await window.api.invoke('theater-import-theme', { base64 });
      if (res.success) {
        showToast(`剧本 [${file.name}] 上传导入成功 🎉`);
        await loadThemes();
      } else {
        alert('剧本上传导入失败: ' + res.error);
      }
    } catch (err: any) {
      alert('上传导入发生异常: ' + (err.message || err));
    } finally {
      isProcessing.value = false;
      target.value = ''; // 清空选择
    }
  };
  reader.onerror = () => {
    alert('读取文件失败！');
    isProcessing.value = false;
    target.value = '';
  };
  reader.readAsDataURL(file);
}

// -------------------------------------------------------------
// 编辑器 - 关系图谱节点定位与拖拽
// -------------------------------------------------------------
function initRelationshipNodes(preserveDragged = false) {
  const chars = form.value.characters;
  if (!chars || chars.length === 0) {
    svgNodes.value = [];
    return;
  }

  const width = 800;
  const height = 400;
  
  // 1. 构建邻接信息并计算度数 (权重)
  const degreeMap = new Map<string, number>();
  for (const c of chars) {
    degreeMap.set(c.name, 0);
  }
  
  if (form.value.relations) {
    for (const r of form.value.relations) {
      if (degreeMap.has(r.from)) {
        degreeMap.set(r.from, degreeMap.get(r.from)! + 1);
      }
      if (degreeMap.has(r.to)) {
        degreeMap.set(r.to, degreeMap.get(r.to)! + 1);
      }
    }
  }

  // 2. 划分连通分量 (BFS) 用于提取孤立网与主网
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const c of chars) {
    if (visited.has(c.name)) continue;
    
    const comp: string[] = [];
    const queue = [c.name];
    visited.add(c.name);
    
    while (queue.length > 0) {
      const curr = queue.shift()!;
      comp.push(curr);
      
      const neighbors = chars.filter(other => {
        return form.value.relations?.some(r => 
          (r.from === curr && r.to === other.name) || 
          (r.from === other.name && r.to === curr)
        );
      });
      
      for (const n of neighbors) {
        if (!visited.has(n.name)) {
          visited.add(n.name);
          queue.push(n.name);
        }
      }
    }
    components.push(comp);
  }

  // 按照节点数量降序排列，主网排在最前面
  components.sort((a, b) => b.length - a.length);

  const nodePositions = new Map<string, { x: number; y: number }>();

  // 3. 布局核心分量 (components[0])
  if (components.length > 0) {
    const mainComp = components[0];
    const hasAnyRelation = form.value.relations && form.value.relations.length > 0;
    
    if (!hasAnyRelation) {
      // 没有任何连线：所有角色按网格整齐排布
      const cols = Math.ceil(Math.sqrt(chars.length));
      const gapX = width / (cols + 1);
      const rows = Math.ceil(chars.length / cols);
      const gapY = height / (rows + 1);
      
      chars.forEach((c, idx) => {
        const r = Math.floor(idx / cols);
        const col = idx % cols;
        nodePositions.set(c.name, {
          x: gapX * (col + 1),
          y: gapY * (r + 1)
        });
      });
    } else {
      // 有连线，布局主连通分量 (采用轻量级力导向算法)
      const cx = width / 2 - 80; // 偏左放置，腾出右侧给孤立分量
      const cy = height / 2;
      
      if (mainComp.length === 1) {
        nodePositions.set(mainComp[0], { x: cx, y: cy });
      } else if (mainComp.length === 2) {
        nodePositions.set(mainComp[0], { x: cx - 70, y: cy });
        nodePositions.set(mainComp[1], { x: cx + 70, y: cy });
      } else {
        // 1. 初始化坐标：核心节点锚定在正中心，其余节点在小半径圆周上稍微错开
        const sortedMain = [...mainComp].sort((a, b) => {
          return (degreeMap.get(b) || 0) - (degreeMap.get(a) || 0);
        });
        const centerNode = sortedMain[0];

        const tempPositions = new Map<string, { x: number; y: number }>();
        mainComp.forEach((name, idx) => {
          if (name === centerNode) {
            tempPositions.set(name, { x: cx, y: cy });
          } else {
            // 环状均匀分布在微小的 30px 半径上，防止初始重合导致斥力计算为 0
            const angle = (idx * 2 * Math.PI) / mainComp.length;
            tempPositions.set(name, { x: cx + 30 * Math.cos(angle), y: cy + 30 * Math.sin(angle) });
          }
        });

        // 2. 物理力导向迭代 (进行 300 次经典力学收敛)
        const iterations = 300;
        const idealDist = 150;     // 理想边长提升至 150px
        const cRep = 45000;        // 斥力系数大幅增加至 45000，强力撑开节点
        const cAtt = 0.08;        // 引力系数微调至 0.08
        const cGrav = 0.001;      // 重力向心力大幅削弱至 0.001，避免向心挤压一团

        for (let iter = 0; iter < iterations; iter++) {
          const forces = new Map<string, { fx: number; fy: number }>();
          mainComp.forEach(name => forces.set(name, { fx: 0, fy: 0 }));

          // A. 两两节点间的斥力计算 (斥力与距离的平方成反比)
          for (let i = 0; i < mainComp.length; i++) {
            for (let j = i + 1; j < mainComp.length; j++) {
              const u = mainComp[i];
              const v = mainComp[j];
              const pu = tempPositions.get(u)!;
              const pv = tempPositions.get(v)!;

              let dx = pu.x - pv.x;
              let dy = pu.y - pv.y;
              if (dx === 0 && dy === 0) {
                dx = Math.random() * 0.1 - 0.05;
                dy = Math.random() * 0.1 - 0.05;
              }
              const dist = Math.sqrt(dx * dx + dy * dy) || 1;
              const forceMag = cRep / (dist * dist);
              const fx = (dx / dist) * forceMag;
              const fy = (dy / dist) * forceMag;

              forces.get(u)!.fx += fx;
              forces.get(u)!.fy += fy;
              forces.get(v)!.fx -= fx;
              forces.get(v)!.fy -= fy;
            }
          }

          // B. 有连线节点间的引力计算 (引力与偏离理想距离的长短成正比)
          if (form.value.relations) {
            for (const r of form.value.relations) {
              if (mainComp.includes(r.from) && mainComp.includes(r.to)) {
                const u = r.from;
                const v = r.to;
                const pu = tempPositions.get(u)!;
                const pv = tempPositions.get(v)!;

                const dx = pv.x - pu.x;
                const dy = pv.y - pu.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const forceMag = cAtt * (dist - idealDist);
                const fx = (dx / dist) * forceMag;
                const fy = (dy / dist) * forceMag;

                forces.get(u)!.fx += fx;
                forces.get(u)!.fy += fy;
                forces.get(v)!.fx -= fx;
                forces.get(v)!.fy -= fy;
              }
            }
          }

          // C. 向心重力计算 (轻微将各个节点拉向主网中心 cx, cy)
          mainComp.forEach(name => {
            const pu = tempPositions.get(name)!;
            const dx = cx - pu.x;
            const dy = cy - pu.y;
            forces.get(name)!.fx += dx * cGrav;
            forces.get(name)!.fy += dy * cGrav;
          });

          // D. 更新临时坐标 (核心锚点固定不移以维持布局重心，限制最大步长防振荡)
          mainComp.forEach(name => {
            if (name === centerNode) return; // 锚定主网最核心主角
            const pu = tempPositions.get(name)!;
            const force = forces.get(name)!;

            const maxStep = 10;
            const stepX = Math.max(-maxStep, Math.min(maxStep, force.fx));
            const stepY = Math.max(-maxStep, Math.min(maxStep, force.fy));

            pu.x += stepX;
            pu.y += stepY;

            // 物理防越界约束
            pu.x = Math.max(50, Math.min(width - 220, pu.x));
            pu.y = Math.max(50, Math.min(height - 50, pu.y));
          });
        }

        // 3. 将物理计算收敛后的坐标写入节点定位图
        mainComp.forEach(name => {
          const pos = tempPositions.get(name)!;
          nodePositions.set(name, { x: pos.x, y: pos.y });
        });
      }

      // 4. 布局其他连通分量 (双人小网与孤立角色，整齐摆放在右侧)
      let rightYOffset = 45;
      const rightX = width - 170; // 往左平移以腾出更宽横向空间
      const stepY = 65;

      for (let k = 1; k < components.length; k++) {
        const subComp = components[k];
        if (subComp.length === 1) {
          // 孤立角色，右侧单列摆放
          nodePositions.set(subComp[0], { x: rightX + 40, y: rightYOffset });
          rightYOffset += stepY;
        } else if (subComp.length === 2) {
          // 双人连线网，水平间距从 80px 增大到 140px，防止字框盖住头像
          nodePositions.set(subComp[0], { x: rightX, y: rightYOffset });
          nodePositions.set(subComp[1], { x: rightX + 140, y: rightYOffset });
          rightYOffset += stepY;
        } else {
          // 其他小网络环状排布
          const subCx = rightX + 40;
          const subCy = rightYOffset + 25;
          const subRadius = 25;
          subComp.forEach((name, i) => {
            const angle = (i * 2 * Math.PI) / subComp.length;
            nodePositions.set(name, {
              x: subCx + subRadius * Math.cos(angle),
              y: subCy + subRadius * Math.sin(angle)
            });
          });
          rightYOffset += stepY + 30;
        }
        
        // 防止溢出画布底部
        if (rightYOffset > height - 40) {
          rightYOffset = 45;
        }
      }
    }
  }

  // 映射回 svgNodes 响应式数组中
  const currentMap = new Map(svgNodes.value.map(n => [n.name, n]));
  svgNodes.value = chars.map(c => {
    if (preserveDragged && currentMap.has(c.name)) {
      return currentMap.get(c.name)!;
    }
    const pos = nodePositions.get(c.name) || { x: width / 2, y: height / 2 };
    return {
      name: c.name,
      x: pos.x,
      y: pos.y
    };
  });
}

let lastCharsCount = form.value.characters.length;

// 监听角色列表变化，随时同步图谱节点
watch(
  () => form.value.characters,
  newVal => {
    if (!newVal) return;
    const isCountChanged = newVal.length !== lastCharsCount;
    lastCharsCount = newVal.length;
    
    // 如果是角色增删，重绘布局；如果只是编辑内部字段，保留用户的拖动坐标
    initRelationshipNodes(!isCountChanged);
  },
  { deep: true },
);

// 判断当前关系连线是否为双向关系
function hasBiDirectionalRelation(rel: { from: string; to: string }) {
  if (!form.value.relations) return false;
  return form.value.relations.some(r => r.from === rel.to && r.to === rel.from);
}

// 获取关系连线 SVG 路径 (双向使用二次贝塞尔曲线错开，单向使用直线)
function getRelationPath(rel: { from: string; to: string }) {
  const fromNode = svgNodes.value.find(n => n.name === rel.from);
  const toNode = svgNodes.value.find(n => n.name === rel.to);
  if (!fromNode || !toNode) return '';

  const x1 = fromNode.x;
  const y1 = fromNode.y;
  const x2 = toNode.x;
  const y2 = toNode.y;

  if (hasBiDirectionalRelation(rel)) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    
    // 计算垂向偏移量，让双向线条产生 30px 的弯曲弧度
    const nx = -dy / len;
    const ny = dx / len;
    const offset = 30;
    const cx = mx + nx * offset;
    const cy = my + ny * offset;

    return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  }

  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

// 获取关系描述文字的中心定位点 (二次贝塞尔曲线的 t=0.5 处，或直线中点)
function getRelationTextPos(rel: { from: string; to: string }) {
  const fromNode = svgNodes.value.find(n => n.name === rel.from);
  const toNode = svgNodes.value.find(n => n.name === rel.to);
  if (!fromNode || !toNode) return { x: 0, y: 0 };

  const x1 = fromNode.x;
  const y1 = fromNode.y;
  const x2 = toNode.x;
  const y2 = toNode.y;

  if (hasBiDirectionalRelation(rel)) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const offset = 30;
    const cx = mx + nx * offset;
    const cy = my + ny * offset;

    // t = 0.5 时公式: P = 0.25*P1 + 0.5*C + 0.25*P2
    const tx = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
    const ty = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
    return { x: tx, y: ty };
  }

  return {
    x: (x1 + x2) / 2,
    y: (y1 + y2) / 2
  };
}

// 展示完整关系文字的 Toast 药丸
function showFullRelation(rel: any) {
  if (!rel.type) return;
  showToast(`${rel.from} ➔ ${rel.to}：${rel.type}`);
}

const activeRelationIndex = ref<number | null>(null);

function toggleRelationBubble(idx: number) {
  if (activeRelationIndex.value === idx) {
    activeRelationIndex.value = null;
  } else {
    activeRelationIndex.value = idx;
  }
}

// -------------------------------------------------------------
// SVG 图谱交互实现
// -------------------------------------------------------------
function startDragCanvas(e: MouseEvent) {
  // 点击或拖拽画布空白处，收起所有关系气泡
  activeRelationIndex.value = null;
  if (draggedNodeIndex.value !== null) return;
  isDraggingCanvas = true;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}

function handleSvgMouseMove(e: MouseEvent) {
  if (draggedNodeIndex.value !== null) {
    const dx = (e.clientX - lastMouseX) / zoom.value;
    const dy = (e.clientY - lastMouseY) / zoom.value;
    svgNodes.value[draggedNodeIndex.value].x += dx;
    svgNodes.value[draggedNodeIndex.value].y += dy;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  } else if (isDraggingCanvas) {
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    panX.value += dx;
    panY.value += dy;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }
}

function stopSvgDrag() {
  draggedNodeIndex.value = null;
  isDraggingCanvas = false;
}

function startDragNode(e: MouseEvent, index: number) {
  e.stopPropagation();
  draggedNodeIndex.value = index;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}

// -------------------------------------------------------------
// 缩放操作
// -------------------------------------------------------------
function zoomIn() {
  zoom.value = Math.min(3.0, zoom.value + 0.15);
}

function zoomOut() {
  zoom.value = Math.max(0.3, zoom.value - 0.15);
}

function resetZoom() {
  zoom.value = 1.0;
  panX.value = 0;
  panY.value = 0;
}

// -------------------------------------------------------------
// 表单数据操作
// -------------------------------------------------------------
function addCharacter() {
  if (form.value.characters.length >= 8) {
    alert('最多创建 8 个角色（包含玩家自己扮演的角色）！');
    return;
  }
  // 按照最新指示：不预填任何默认内容，外貌特征生图 Tag 留空，姓名、年龄、人设全部初始化留空
  form.value.characters.push({
    name: '',
    gender: '自定义',
    age: '',
    soul: '',
    appearance: '',
    isCollapsed: false,
  });
}

function removeCharacter(index: number) {
  const charName = form.value.characters[index].name;
  form.value.characters.splice(index, 1);
  // 清理涉及该角色的关系连线
  if (charName) {
    form.value.relations = form.value.relations.filter(r => r.from !== charName && r.to !== charName);
  }
  // 结构变动，重算拓扑布局
  initRelationshipNodes(false);
}

function addRelation() {
  const chars = form.value.characters.filter(c => c.name && c.name.trim());
  if (chars.length < 2) {
    alert('必须添加至少两名拥有姓名的角色，才能构建关系连线！');
    return;
  }
  form.value.relations.push({
    from: chars[0].name,
    to: chars[1].name,
    type: '',
  });
  // 结构变动，重算拓扑布局
  initRelationshipNodes(false);
}

function removeRelation(index: number) {
  form.value.relations.splice(index, 1);
  // 结构变动，重算拓扑布局
  initRelationshipNodes(false);
}

function addStatusBar() {
  // 按照最新指示：不预填任何默认内容，且补充了属性说明 description，留空待填
  form.value.status_bars.push({
    name: '',
    type: 'number',
    min: 0,
    max: 100,
    aiRule: '',
    description: '',
    isCollapsed: false,
  });
}

function removeStatusBar(index: number) {
  form.value.status_bars.splice(index, 1);
}

// -------------------------------------------------------------
// 剧本图片上传处理
// -------------------------------------------------------------
function triggerUploadCover() {
  const fileInput = document.getElementById('cover-file-input') as HTMLInputElement;
  fileInput?.click();
}

function onCoverFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (files && files.length > 0) {
    const file = files[0];
    const reader = new FileReader();
    reader.onload = event => {
      if (event.target?.result) {
        const base64 = event.target.result as string;
        form.value.cover = base64;
        form.value.coverBase64 = base64;
      }
    };
    reader.readAsDataURL(file);
  }
}

function triggerUploadAvatar(index: number) {
  const fileInput = document.getElementById(`avatar-file-input-${index}`) as HTMLInputElement;
  fileInput?.click();
}

function onAvatarFileChange(e: Event, index: number) {
  const files = (e.target as HTMLInputElement).files;
  if (files && files.length > 0) {
    const file = files[0];
    const reader = new FileReader();
    reader.onload = event => {
      if (event.target?.result) {
        const base64 = event.target.result as string;
        form.value.characters[index].avatar = base64;
        form.value.characters[index].avatarBase64 = base64;
      }
    };
    reader.readAsDataURL(file);
  }
}

// -------------------------------------------------------------
// 个人中心人设导入与替换逻辑
// -------------------------------------------------------------
async function openUserProfileReplace(idx: number) {
  replaceCharIndex.value = idx;
  await openUserProfileImport();
}

function closeUserProfileModal() {
  isUserProfileOpen.value = false;
  replaceCharIndex.value = null;
}

async function openUserProfileImport() {
  isProcessing.value = true;
  processStep.value = '正在拉取个人中心人设列表...';
  try {
    const res = await window.api.invoke('list-user-profiles');
    if (res.success && res.list) {
      if (res.list.length === 0) {
        replaceCharIndex.value = null;
        alert('您尚未在「设置 - 个人中心 - 用户人设」中创建任何个人人设！请先前往个人中心创建。');
        return;
      }
      userProfiles.value = res.list;
      if (res.list.length === 1) {
        // 只有一个人设，直接导入或替换
        importSingleUserProfile(res.list[0]);
      } else {
        // 多个，打开人设选择弹窗
        isUserProfileOpen.value = true;
      }
    } else {
      replaceCharIndex.value = null;
      alert('获取人设列表失败: ' + (res.error || '未知错误'));
    }
  } catch (err: any) {
    replaceCharIndex.value = null;
    alert('拉取用户设定发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

function importSingleUserProfile(profile: any) {
  const replaceIdx = replaceCharIndex.value;

  // 🚀 替换场景：如果是替换占位角色而非追加
  if (replaceIdx !== null && replaceIdx >= 0 && replaceIdx < form.value.characters.length) {
    const oldName = form.value.characters[replaceIdx].name || '';
    const newName = profile.name || '';

    form.value.characters[replaceIdx] = {
      name: newName,
      gender: profile.gender || '自定义',
      age: profile.age ? String(profile.age) : '',
      soul: profile.content || profile.description || '',
      appearance: '',
      avatar: profile.avatar || '',
      avatarBase64: profile.avatar || undefined,
      isCollapsed: false, // 替换后保持展开状态以方便用户核验
      isUserPersona: true,
      isPlaceholderUser: true, // ⚠️ 极为关键：必须带有占位标识，以便在保存剧本时进行一键全局替换
    };

    // 同步将剧本默认关系中的旧姓名及占位符映射至玩家真实姓名，防止关系卡片数值丢失及拓扑线折断
    if (oldName && oldName !== newName) {
      form.value.relations.forEach((r: any) => {
        if (r.from === oldName || r.from === '{{user}}' || r.from === '<user>') r.from = newName;
        if (r.to === oldName || r.to === '{{user}}' || r.to === '<user>') r.to = newName;
      });
    }

    // 重新拓扑并刷新 SVG 节点连线渲染
    initRelationshipNodes();

    replaceCharIndex.value = null; // 重置
    isUserProfileOpen.value = false;
    alert(`已成功将用户人设 [${profile.name}] 替换为占位主角！`);
    return;
  }

  // 🚀 追加场景
  if (form.value.characters.length >= 8) {
    alert('当前题材配置的角色数量已达 8 个上限，无法继续导入！');
    return;
  }

  // 查重
  if (form.value.characters.some(c => c.name === profile.name)) {
    alert(`人设 [${profile.name}] 已存在于当前角色列表中，请勿重复导入！`);
    return;
  }

  form.value.characters.push({
    name: profile.name || '',
    gender: profile.gender || '自定义',
    age: profile.age ? String(profile.age) : '',
    soul: profile.content || profile.description || '',
    appearance: '',
    avatar: profile.avatar || '',
    avatarBase64: profile.avatar || undefined,
    isCollapsed: true, // 默认折叠以保持卡片列表紧凑整洁
    isUserPersona: true, // 标记为用户人设，以便在大堂主角设置时优先选中它
  });

  isUserProfileOpen.value = false;
  alert(`已成功将用户人设 [${profile.name}] 导入登场角色列表！`);
}

// -------------------------------------------------------------
// 导入已注册状态栏预设属性逻辑
// -------------------------------------------------------------
async function openImportPresetModal() {
  isImportPresetOpen.value = true;
  selectedPresetIds.value = [];
  isProcessing.value = true;
  processStep.value = '正在拉取状态栏预设...';
  try {
    const res = await window.api.invoke('get-state-presets');
    if (res.success && res.presets) {
      presetList.value = res.presets;
    } else {
      alert('获取状态栏预设失败: ' + (res.error || '未知错误'));
    }
  } catch (err: any) {
    alert('拉取状态栏预设发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

function toggleSelectPreset(id: string) {
  const idx = selectedPresetIds.value.indexOf(id);
  if (idx > -1) {
    selectedPresetIds.value.splice(idx, 1);
  } else {
    selectedPresetIds.value.push(id);
  }
}

function handleConfirmImportPresets() {
  if (selectedPresetIds.value.length === 0) {
    isImportPresetOpen.value = false;
    return;
  }

  let importedCount = 0;
  for (const id of selectedPresetIds.value) {
    const preset = presetList.value.find(p => p.id === id);
    if (!preset) continue;

    // 查重：若题材内已有同名状态栏，跳过
    if (form.value.status_bars.some(bar => bar.name === preset.label)) {
      continue;
    }

    form.value.status_bars.push({
      name: preset.label || '',
      emoji: '❓', // 默认分配未分类 Emoji 问号
      type: preset.type || 'number',
      min: 0,
      max: 100,
      aiRule: preset.rule || '',
      description: preset.meaning || '',
      isCollapsed: false,
    });
    importedCount++;
  }

  isImportPresetOpen.value = false;
  alert(`已成功导入 ${importedCount} 个已注册状态栏属性！`);
}

// -------------------------------------------------------------
// 通讯录导入角色弹窗逻辑
// -------------------------------------------------------------
async function openAddressBook() {
  isAddressBookOpen.value = true;
  addressBookSearchQuery.value = '';
  selectedAddressBookCharIds.value = []; // 打开时清空已选
  isProcessing.value = true;
  processStep.value = '正在拉取宿主通讯录角色列表...';
  try {
    const res = await window.api.invoke('get-characters');
    if (res.success && res.characters) {
      // 🚀 进行浅拷贝，防止从 IPC 传回的原始对象被冻结 (frozen) 导致无法在渲染进程中直接赋值修改 avatar
      const list = res.characters.map((char: any) => ({ ...char }));
      // 🚀 核心优化：并行批量拉取每个角色的头像 base64，并赋给 char.avatar，彻底解决弹窗头像不显示问题
      await Promise.all(
        list.map(async (char: any) => {
          try {
            const avatarData = await window.api.invoke('get-character-avatar', char.folder_name);
            char.avatar = avatarData || '';
          } catch (_) {
            char.avatar = '';
          }
        })
      );
      addressBookChars.value = list;
    } else {
      alert('获取通讯录角色失败: ' + res.error);
    }
  } catch (err: any) {
    alert('拉取通讯录发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

const filteredAddressBookChars = computed(() => {
  const query = addressBookSearchQuery.value.trim().toLowerCase();
  if (!query) return addressBookChars.value;
  return addressBookChars.value.filter(c => c.name && c.name.toLowerCase().includes(query));
});

// 选择/反选角色，限制单次多选最多 7 人，且总人数不超过 8 人
function toggleSelectAddressBookChar(char: any) {
  const idx = selectedAddressBookCharIds.value.indexOf(char.id);
  if (idx > -1) {
    selectedAddressBookCharIds.value.splice(idx, 1);
  } else {
    // 限制单次最多选 7 个，强行留出至少 1 个手动创作空位
    if (selectedAddressBookCharIds.value.length >= 7) {
      alert('单次最多只能勾选 7 个角色导入，需保留至少 1 个席位供您手动添加人设！');
      return;
    }
    // 同时限制：剧本中已存在人数 + 当前勾选人数，总数不能超过 8
    const totalAfterImport = form.value.characters.length + selectedAddressBookCharIds.value.length;
    if (totalAfterImport >= 8) {
      alert(`当前剧本已配置了 ${form.value.characters.length} 个角色，本次最多只能再选择 ${8 - form.value.characters.length} 个导入！`);
      return;
    }
    selectedAddressBookCharIds.value.push(char.id);
  }
}

// 辅助：已导入角色的本地路径转 base64，防止前端 file 协议受阻
function convertImgToBase64(imgUrl: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
        return;
      }
      resolve('');
    };
    img.onerror = () => {
      resolve('');
    };
    img.src = imgUrl;
  });
}

// 批量从通讯录导入选中的角色
async function handleBatchImportFromAddressBook() {
  if (selectedAddressBookCharIds.value.length === 0) return;

  isProcessing.value = true;
  isAddressBookOpen.value = false; // 关掉弹窗
  
  let successCount = 0;
  try {
    for (const charId of selectedAddressBookCharIds.value) {
      const targetChar = addressBookChars.value.find(c => c.id === charId);
      if (!targetChar) continue;

      processStep.value = `正在从通讯录导入角色 [${targetChar.name}] 的设定...`;
      const folderName = targetChar.folder_name || targetChar.id;

      // 1. 读取 Soul.md
      const soulRes = await window.api.invoke('read-character-file', { folderName, fileName: 'Soul.md' });
      const soul = soulRes.success ? soulRes.content : '';

      // 2. 读取 Appearance.md 并提取 tags
      const appRes = await window.api.invoke('read-character-file', { folderName, fileName: 'Appearance.md' });
      let appearance = '';
      if (appRes.success && appRes.content) {
        const tagsMatch = appRes.content.match(/### Appearance Tags\s*([\s\S]*?)(?:### Appearance Description|$)/i);
        if (tagsMatch) {
          appearance = tagsMatch[1].trim();
        } else {
          appearance = appRes.content.trim();
        }
      }

      // 3. 读取 meta.json 获得性别、年龄
      const metaRes = await window.api.invoke('read-character-file', { folderName, fileName: 'meta.json' });
      let gender = '自定义';
      let age = '';
      if (metaRes.success && metaRes.content) {
        try {
          const meta = JSON.parse(metaRes.content);
          gender = meta.gender || '自定义';
          age = meta.age ? String(meta.age) : '';
        } catch (_) {}
      }

      // 4. 转换头像成 base64
      let avatarBase64 = '';
      let avatar = targetChar.avatar || '';
      if (avatar) {
        if (avatar.startsWith('data:image')) {
          avatarBase64 = avatar;
        } else {
          avatarBase64 = await convertImgToBase64(avatar);
        }
      }

      // 5. 注入表单角色列表，并默认折叠（isCollapsed = true）保持卡片墙精致
      form.value.characters.push({
        name: targetChar.name || '',
        gender,
        age,
        soul,
        appearance,
        avatar: avatarBase64 || avatar,
        avatarBase64: avatarBase64 || undefined,
        isCollapsed: true,
      });

      successCount++;
    }

    alert(`成功从通讯录批量导入了 ${successCount} 名核心角色！`);
  } catch (err: any) {
    alert('批量导入失败: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
    selectedAddressBookCharIds.value = [];
  }
}

// -------------------------------------------------------------
// AI 与卡片导入等高级生图/生成逻辑
// -------------------------------------------------------------
// 打开灵感输入弹窗，要求用户输入世界观的简单描述
function handleBackgroundAIGenerate(type: 'world' | 'scenario') {
  creativePromptType.value = type;
  creativePromptText.value = '';
  isCreativePromptOpen.value = true;
}

// 提交灵感并调用 AI 进行世界设定/开局剧本的生成
async function submitCreativePromptGenerate() {
  if (!creativePromptText.value || !creativePromptText.value.trim()) {
    alert('请输入一些剧本创意或世界观设定构想！');
    return;
  }

  const type = creativePromptType.value;
  const promptText = creativePromptText.value.trim();
  isCreativePromptOpen.value = false; // 关闭灵感输入弹窗

  isProcessing.value = true;
  processStep.value = `AI 正在根据灵感编织${type === 'world' ? '世界设定' : '剧情开局描述'}...`;
  try {
    const res = await window.api.invoke('theater-ai-generate-background', {
      prompt: promptText,
      type,
    });
    if (res.success) {
      if (type === 'world') {
        form.value.world_settings = res.content;
      } else {
        form.value.scenario = res.content;
      }
    } else {
      alert('AI 生成失败: ' + res.error);
    }
  } catch (err: any) {
    alert('AI 生成发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

async function handleGenerateCharactersAI() {
  if (!form.value.world_settings && !form.value.scenario) {
    alert('请先输入一些世界观设定或剧本故事，以便 AI 有背景素材发散生成角色！');
    return;
  }

  // 限制最大可以生成的角色数。最多生成 8 - 1 (保留1个给玩家手动扮演) - 当前已有角色数
  const maxAllowed = 8 - 1 - form.value.characters.length;
  if (maxAllowed <= 0) {
    alert('当前角色数量已达到限制 (7 个核心角色)，无法继续生成新的核心角色！需保留 1 个席位供您手动配置。');
    return;
  }

  isProcessing.value = true;
  processStep.value = `AI 正在根据剧本环境创造最多 ${maxAllowed} 个核心参演角色...`;
  try {
    const bg = `${form.value.world_settings}\n\n${form.value.scenario}`;
    const res = await window.api.invoke('theater-ai-generate-characters', { 
      backgroundText: bg,
      maxCount: maxAllowed 
    });
    if (res.success && res.list) {
      const newList = res.list.map((c: any) => ({
        name: c.name || '',
        gender: c.gender || '自定义',
        age: String(c.age || ''),
        soul: c.soul || '',
        appearance: c.appearance || '',
        isCollapsed: true, // 导入时默认折叠保持界面整洁
      }));
      // 追加到已有角色列表中
      form.value.characters.push(...newList);
      initRelationshipNodes();
      alert(`AI 成功为您生成并追加了 ${newList.length} 位极富戏剧冲突的角色！请上传头像或补充关系。`);
    } else {
      alert('AI 角色生成失败: ' + res.error);
    }
  } catch (err: any) {
    alert('AI 角色生成发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

async function handleDrawAvatarAI(index: number) {
  const char = form.value.characters[index];
  if (!char.appearance || !char.appearance.trim()) {
    alert('请先在「外貌特征生图 Tags」中输入英文生图 Tags，例如 "1girl, short hair, red dress"。');
    return;
  }

  // 局部生图加载，不阻断用户在编辑器内的其他操作
  drawingIndices.value.add(index);
  try {
    const res = await window.api.invoke('generate-novelai-image', {
      characterId: 'temp_avatar_' + index,
      folderName: 'temp_avatar_drawing',
      // 前置头像限定词，防止 NovelAI V3/V4 等模型将其画为多宫格或全身视图
      prompt: `solo, headshot, portrait, upper body, ${char.appearance}`,
      dimensions: { width: 640, height: 640 },
      prefixType: 'drawing',
    });
    if (res.success && res.base64) {
      char.avatar = res.base64;
      char.avatarBase64 = res.base64;
      alert(`角色 [${char.name || ''}] 头像绘制完成并成功回填！`);
    } else {
      alert('生图失败: ' + res.error);
    }
  } catch (err: any) {
    alert('AI 绘图发生异常: ' + (err.message || err));
  } finally {
    drawingIndices.value.delete(index);
  }
}

// 手动添加角色处：使用 AI 提炼外貌生图 Tag
async function handleExtractAppearanceAI(index: number) {
  const char = form.value.characters[index];
  if (!char.soul || !char.soul.trim()) {
    alert('请先输入该角色的「性格设定大纲 (Soul.md)」，以便 AI 从中精炼物理外貌特征！');
    return;
  }
  isProcessing.value = true;
  processStep.value = `AI 正在根据人设大纲解析 [${char.name || '新角色'}] 的固定物理外貌 Tags...`;
  try {
    const res = await window.api.invoke('theater-ai-extract-appearance', { soul: char.soul });
    if (res.success && res.tags) {
      char.appearance = res.tags;
      alert('外貌生图 Tags 提炼成功！已自动填充。');
    } else {
      alert('AI 提炼失败: ' + res.error);
    }
  } catch (err: any) {
    alert('AI 提炼外貌发生异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

// AI 智能一键编织模式
async function handleAIOtherweave() {
  if (!aiPromptInput.value || !aiPromptInput.value.trim()) {
    alert('请输入你的剧本创作一句话构想！');
    return;
  }

  processSteps.value = [
    '🔮 正在勾勒世界观宏大蓝图...',
    '🎬 正在铺设扣人心弦的开局剧本...',
    '👥 正在编织栩栩如生的群演人设...',
    '📈 正在适配初始剧本状态栏属性...',
  ];
  currentStepIndex.value = 0;
  isProcessing.value = true;

  try {
    // 步骤 1：生成背景世界观
    processStep.value = processSteps.value[0];
    const worldRes = await window.api.invoke('theater-ai-generate-background', {
      prompt: aiPromptInput.value,
      type: 'world',
    });
    if (!worldRes.success) throw new Error('生成世界设定失败: ' + worldRes.error);
    form.value.world_settings = worldRes.content;
    currentStepIndex.value = 1;

    // 步骤 2：生成开局背景
    processStep.value = processSteps.value[1];
    const scenRes = await window.api.invoke('theater-ai-generate-background', {
      prompt: aiPromptInput.value,
      type: 'scenario',
    });
    if (!scenRes.success) throw new Error('生成开局背景失败: ' + scenRes.error);
    form.value.scenario = scenRes.content;
    currentStepIndex.value = 2;

    // 步骤 3：生成角色列表
    processStep.value = processSteps.value[2];
    const charsRes = await window.api.invoke('theater-ai-generate-characters', {
      backgroundText: `${worldRes.content}\n\n${scenRes.content}`,
    });
    if (!charsRes.success || !charsRes.list) throw new Error('发散生成多角色失败: ' + charsRes.error);
    form.value.characters = charsRes.list.map((c: any) => ({
      name: c.name || '',
      gender: c.gender || '自定义',
      age: String(c.age || ''),
      soul: c.soul || '',
      appearance: c.appearance || '',
    }));
    initRelationshipNodes();
    currentStepIndex.value = 3;

    // 步骤 4：配置初始剧本状态栏属性
    form.value.status_bars = [];

    // 生成一些基本的关系连线
    if (form.value.characters.length >= 2) {
      form.value.relations = [
        { from: form.value.characters[0].name, to: form.value.characters[1].name, type: '初次相遇的盟友' },
      ];
    }

    isProcessing.value = false;
    editorTab.value = 'manual'; // 切回手动进行展示
    alert('AI 剧本智能编织大包数据获取成功！您现在可以做进一步微调和修饰。');
  } catch (err: any) {
    isProcessing.value = false;
    alert('智能编织失败: ' + (err.message || err));
  }
}

// 角色卡拖拽/点击上传解析 (重构，使用 FileReader 并转换为二进制 Array)
function triggerUploadCard() {
  const cardInput = document.getElementById('card-file-input') as HTMLInputElement;
  cardInput?.click();
}

async function onCardFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || files.length === 0) return;
  const file = files[0];

  processSteps.value = [
    '正在提炼世界框架（第一步提炼大纲）',
    '正在提炼角色设定信息（准备中）',
    '正在理清关系网络',
    '正在写入数据库'
  ];
  currentStepIndex.value = 0;
  isProcessing.value = true;
  processStep.value = processSteps.value[0];

  // 接收后端的真实进度推送并更新任务看板
  const handleImportProgress = (payload: { stage: string; message: string; charName?: string; characters?: string[] }) => {
    processStep.value = payload.message;
    if (payload.stage === 'outline') {
      currentStepIndex.value = 0;
    } else if (payload.stage === 'characters_list' && payload.characters) {
      const charSteps = payload.characters.map(name => `正在提炼角色 [${name}] 设定信息`);
      processSteps.value = [
        '正在提炼世界框架（第一步提炼大纲）',
        ...charSteps,
        '正在理清关系网络',
        '正在写入数据库'
      ];
      currentStepIndex.value = 1;
    } else if (payload.stage === 'character_start' && payload.charName) {
      const targetLabel = `正在提炼角色 [${payload.charName}] 设定信息`;
      const idx = processSteps.value.indexOf(targetLabel);
      if (idx !== -1) {
        currentStepIndex.value = idx;
      }
    } else if (payload.stage === 'relations') {
      const idx = processSteps.value.indexOf('正在理清关系网络');
      if (idx !== -1) {
        currentStepIndex.value = idx;
      }
    } else if (payload.stage === 'db') {
      const idx = processSteps.value.indexOf('正在写入数据库');
      if (idx !== -1) {
        currentStepIndex.value = idx;
      }
    }
  };

  let unsubscribeProgress = () => {};
  if (window.electron && window.electron.ipcRenderer) {
    unsubscribeProgress = window.electron.ipcRenderer.on('theater-import-progress', handleImportProgress);
  }

  try {
    const arrayReader = new FileReader();
    arrayReader.onload = async () => {
      try {
        const arrayBuffer = arrayReader.result as ArrayBuffer;
        const uint8ArrayData = Array.from(new Uint8Array(arrayBuffer));

        const res = await window.api.invoke('theater-parse-character-card', { uint8ArrayData });
        unsubscribeProgress();

        if (!res.success) {
          throw new Error(res.error || '解析卡片失败');
        }
        const data = res.data;

        const contentString = JSON.stringify(data);
        const hasUserField = /\{\{user\}\}|<user>/i.test(contentString);

        if (data.cover) {
          form.value.cover = data.cover;
          form.value.coverBase64 = data.cover;
        }
        form.value.world_settings = data.world || '';
        form.value.scenario = data.scenario || '';
        form.value.characters = (data.characters || []).map((c: any) => ({
          name: c.name || '',
          gender: c.gender || '自定义',
          age: String(c.age || ''),
          soul: c.soul || '',
          appearance: c.appearance || '',
          isCollapsed: true,
        }));

        form.value.relations = (data.relations || []).map((r: any) => ({
          from: r.from,
          to: r.to,
          type: r.type || '关联',
        }));

        // 检测占位主角并自愈插入或标记
        let userChar = form.value.characters.find((c: any) => c.name === '{{user}}' || c.name === '<user>');
        if (!userChar && hasUserField) {
          userChar = {
            name: '{{user}}',
            gender: '待填写',
            age: '待填写',
            soul: '请补全您的角色性格设定',
            appearance: '请补全您的角色外貌设定',
            isCollapsed: false,
            isPlaceholderUser: true,
            isUserPersona: true,
          };
          form.value.characters.unshift(userChar);
        } else if (userChar) {
          userChar.isPlaceholderUser = true;
          userChar.isUserPersona = true;
          userChar.isCollapsed = false;
        }

        initRelationshipNodes();
        isProcessing.value = false;
        editorTab.value = 'manual'; // 切回手动表单展示
        alert('酒馆角色卡解密提炼成功！已回填至表单。');
      } catch (err: any) {
        unsubscribeProgress();
        isProcessing.value = false;
        alert('解析角色卡数据提取失败: ' + (err.message || err));
      }
    };
    arrayReader.readAsArrayBuffer(file);
  } catch (err: any) {
    unsubscribeProgress();
    isProcessing.value = false;
    alert('读取角色卡文件失败: ' + (err.message || err));
  }
}

// -------------------------------------------------------------
// 保存剧本包
// -------------------------------------------------------------
async function handleSaveTheme() {
  // 1. 拦截未改名补全的主角占位符
  const hasPlaceholder = form.value.characters.some(c => c.name.trim() === '{{user}}' || c.name.trim() === '<user>');
  if (hasPlaceholder) {
    alert('检测到剧本中仍有 {{user}} 占位角色，请先点击该角色并补全您的姓名与设定！');
    return;
  }

  // 2. 查找是否有正在保存的 placeholder 主角，如果名字已经被补全，则在前端执行一键全局批量替换
  const userChar = form.value.characters.find(c => c.isPlaceholderUser);
  if (userChar && userChar.name && userChar.name.trim() !== '{{user}}' && userChar.name.trim() !== '<user>') {
    const realName = userChar.name.trim();

    // 辅助全局正则替换函数
    const replacePlaceholder = (text: string) => {
      if (!text) return '';
      return text.replace(/\{\{user\}\}/gi, realName).replace(/<user>/gi, realName);
    };

    // 替换题材的基本文本字段
    form.value.world_settings = replacePlaceholder(form.value.world_settings);
    form.value.scenario = replacePlaceholder(form.value.scenario);

    // 替换所有角色的人设及外貌
    form.value.characters.forEach(c => {
      c.soul = replacePlaceholder(c.soul);
      c.appearance = replacePlaceholder(c.appearance);
    });

    // 替换关系图谱
    form.value.relations.forEach(r => {
      if (r.from === '{{user}}' || r.from === '<user>') r.from = realName;
      if (r.to === '{{user}}' || r.to === '<user>') r.to = realName;
      r.type = replacePlaceholder(r.type);
    });

    // 替换状态栏描述与 AI 规则
    form.value.status_bars.forEach(bar => {
      bar.description = replacePlaceholder(bar.description);
      bar.aiRule = replacePlaceholder(bar.aiRule);
    });

    // 清除占位符号标记，以完成自愈更名闭环
    delete userChar.isPlaceholderUser;
  }

  if (!form.value.name || !form.value.name.trim()) {
    alert('请填写剧本名称！');
    return;
  }
  if (!form.value.world_settings || !form.value.world_settings.trim()) {
    alert('请填写世界观背景设定！');
    return;
  }
  if (form.value.characters.length > 8) {
    alert('最多创建 8 个角色（包含玩家自己扮演的角色）！');
    return;
  }

  // 检查必填项：角色和自定义属性
  for (const c of form.value.characters) {
    if (!c.name || !c.name.trim()) {
      alert('所有登场角色均必须填写角色姓名！');
      return;
    }
    if (!c.soul || !c.soul.trim()) {
      alert(`角色 [${c.name}] 必须填写独立的性格设定大纲！`);
      return;
    }
  }

  for (const bar of form.value.status_bars) {
    if (!bar.name || !bar.name.trim()) {
      alert('所有状态栏属性均必须填写属性名称！');
      return;
    }
    if (!bar.description || !bar.description.trim()) {
      alert(`状态栏属性 [${bar.name}] 必须填写属性描述说明！`);
      return;
    }
    if (!bar.aiRule || !bar.aiRule.trim()) {
      alert(`状态栏属性 [${bar.name}] 必须填写大模型变动规则！`);
      return;
    }
  }

  isProcessing.value = true;
  processStep.value = '正在将剧本物理文件、人设 Soul.md 及头像资源落盘...';
  try {
    // 深拷贝以剥离 Vue 的 Reactive Proxy 响应式代理，避免 Electron IPC 出现 Structured Clone 复制错误
    const savePayload = JSON.parse(
      JSON.stringify({
        id: form.value.id,
        name: form.value.name,
        world_settings: form.value.world_settings,
        scenario: form.value.scenario,
        status_bars: form.value.status_bars,
        relations: form.value.relations,
        characters: form.value.characters,
        coverBase64: form.value.coverBase64,
      }),
    );

    const res = await window.api.invoke('theater-save-theme', savePayload);

    if (res.success) {
      alert('剧本包物理保存成功！已刷新快速索引缓存。');
      await loadThemes();
      viewState.value = 'list';
    } else {
      alert('保存剧本失败: ' + res.error);
    }
  } catch (err: any) {
    alert('保存发生未知异常: ' + (err.message || err));
  } finally {
    isProcessing.value = false;
  }
}

// Lobby - 开始冒险跑团
async function startAdventure() {
  if (!selectedTheme.value || !selectedPlayerChar.value) {
    alert('请先选择一个扮演的角色！');
    return;
  }

  isProcessing.value = true;

  const loadingTexts = [
    '正在编织世界线的法则与因果关系...',
    '正在绘制大剧院的帷幕与舞台布景...',
    '正在呼唤沉睡的群星，准备登台演出...',
    '正在为演员们系紧命运的丝线...',
    '正在调制各角色的情绪色调与色彩板...',
    '正在推演无数种剧本分支与未来的可能性...',
    '正在聆听后台的私语，校准角色的灵魂...',
    '正在搭建时空的交错点，请耐心静候...',
    '正在雕琢命运的齿轮，赋予万物初始状态...',
    '正在铺设每一条隐秘的伏笔与宿命线...',
    '幕布缓缓拉开，灯光正在聚焦舞台中央...',
    '剧场的交响乐已然奏响，静待主视角踏入...'
  ];

  let textIndex = 0;
  processStep.value = loadingTexts[textIndex];

  const timer = setInterval(() => {
    textIndex = (textIndex + 1) % loadingTexts.length;
    processStep.value = loadingTexts[textIndex];
  }, 3000);

  try {
    const res = await window.api.invoke('theater-create-stage-session', {
      themeId: selectedTheme.value.id,
      playerCharName: selectedPlayerChar.value,
      activeCharNames: [selectedPlayerChar.value, ...participatingChars.value]
    });

    if (res.success) {
      activeSessionId.value = res.sessionId;
      viewState.value = 'stage';
    } else {
      alert('初始化游玩会话失败: ' + res.error);
    }
  } catch (err: any) {
    alert('初始化游玩会话发生异常: ' + (err.message || err));
  } finally {
    clearInterval(timer);
    isProcessing.value = false;
  }
}
</script>

<template>
  <TheaterStage v-if="viewState === 'stage'" :isMobile="isMobile" :sessionId="activeSessionId" @back="viewState = 'list'" />
  <div v-else class="flex-1 flex flex-col min-h-0 bg-background text-on-surface overflow-hidden select-none animate-fade-in">
    <!-- ==========================================
         顶部 Header
         ========================================== -->
    <header
      class="h-14 px-6 border-b border-outline-variant/30 bg-surface flex items-center justify-between flex-shrink-0"
    >
      <div class="flex items-center space-x-3">
        <button
          v-if="viewState !== 'list'"
          @click="viewState = 'list'"
          class="p-1.5 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
          title="返回剧本列表"
        >
          <ChevronLeftIcon class="w-4 h-4" />
        </button>
        <button
          v-else
          @click="$emit('exit')"
          class="p-1.5 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
          title="返回主面板"
        >
          <ChevronLeftIcon class="w-4 h-4" />
        </button>
        <div>
          <h1 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
            <span>大剧院</span>
            <span v-if="viewState === 'lobby'" class="text-xs font-normal text-on-surface-variant/80"
              >/ 剧本准备大厅</span
            >
            <span v-if="viewState === 'editor'" class="text-xs font-normal text-on-surface-variant/80"
              >/ 剧本设计中心</span
            >
          </h1>
        </div>
      </div>

      <div class="flex items-center space-x-2">
        <!-- 列表页：右上角操作 -->
        <template v-if="viewState === 'list'">
          <!-- 隐藏的文件选择框，用于 Docker/Web 模式导入 -->
          <input
            id="theater-import-file-input"
            type="file"
            accept=".echotheater"
            class="hidden"
            @change="handleWebImportTheme($event)"
          />
          <button
            @click="handleTriggerImport"
            class="px-3 py-1.5 rounded bg-surface-high hover:bg-surface-highest text-[11px] font-bold text-on-surface-variant border border-outline-variant/30 transition-all active:scale-95 cursor-pointer flex items-center gap-1"
            title="导入剧本包 (.echotheater)"
          >
            <UploadIcon class="w-3.5 h-3.5" />
            <span>导入剧本</span>
          </button>

          <div class="relative">
            <button
              @click="isCreateMenuOpen = !isCreateMenuOpen"
              class="px-3 py-1.5 rounded bg-primary hover:bg-primary-container text-[11px] font-bold text-on-primary shadow-sm transition-all active:scale-95 cursor-pointer flex items-center gap-1"
            >
              <PlusIcon class="w-3.5 h-3.5" />
              <span>新剧本</span>
            </button>

            <!-- 创建模式下拉浮窗 -->
            <div
              v-if="isCreateMenuOpen"
              class="absolute right-0 mt-1.5 w-40 rounded bg-surface border border-outline-variant/30 py-1.5 shadow-lg z-50 text-left"
            >
              <!-- 遮罩层以关闭下拉菜单 -->
              <div class="fixed inset-0 z-[-1]" @click="isCreateMenuOpen = false"></div>

              <button
                @click="
                  openCreateEditor('manual');
                  isCreateMenuOpen = false;
                "
                class="w-full text-left px-3 py-1.5 text-[10px] text-on-surface hover:bg-surface-high transition-colors flex items-center gap-1.5 font-bold cursor-pointer"
              >
                <PlusIcon class="w-3 h-3 text-primary" />
                <span>手动配置模式</span>
              </button>
              <button
                @click="
                  openCreateEditor('ai');
                  isCreateMenuOpen = false;
                "
                class="w-full text-left px-3 py-1.5 text-[10px] text-on-surface hover:bg-surface-high transition-colors flex items-center gap-1.5 font-bold cursor-pointer"
              >
                <SparklesIcon class="w-3 h-3 text-primary animate-pulse" />
                <span>AI 智能编织</span>
              </button>
              <button
                @click="
                  openCreateEditor('card');
                  isCreateMenuOpen = false;
                "
                class="w-full text-left px-3 py-1.5 text-[10px] text-on-surface hover:bg-surface-high transition-colors flex items-center gap-1.5 font-bold cursor-pointer"
              >
                <FileJsonIcon class="w-3 h-3 text-primary" />
                <span>角色卡导入</span>
              </button>
            </div>
          </div>
        </template>

        <!-- 编辑器页：右上角操作 -->
        <template v-if="viewState === 'editor'">
          <button
            @click="handleSaveTheme"
            class="px-3 py-1.5 rounded bg-primary hover:bg-primary-container text-[11px] font-bold text-on-primary shadow-sm transition-all active:scale-95 cursor-pointer flex items-center gap-1"
          >
            <SaveIcon class="w-3.5 h-3.5" />
            <span>保存剧本</span>
          </button>
        </template>

        <!-- Lobby页：右上角操作 -->
        <template v-if="viewState === 'lobby'">
          <button
            @click="openEditEditor"
            class="px-3 py-1.5 rounded bg-surface-high hover:bg-surface-highest text-[11px] font-bold text-on-surface-variant border border-outline-variant/30 transition-all active:scale-95 cursor-pointer flex items-center gap-1"
          >
            <Settings2Icon class="w-3.5 h-3.5" />
            <span>编辑配置</span>
          </button>
        </template>
      </div>
    </header>

    <!-- ==========================================
         内容主体区
         ========================================== -->
    <div class="flex-1 flex flex-col min-h-0 overflow-hidden relative">
      <!-- ==========================================
           视图 1：剧本列表视图
           ========================================== -->
      <main v-if="viewState === 'list'" class="flex-1 overflow-y-auto p-6">
        <!-- 列表标题与指引 -->
        <div class="mb-6">
          <h2 class="text-lg font-bold text-on-surface">选择剧本</h2>
          <p class="text-xs text-on-surface-variant/75 mt-0.5">
            选择一个剧本包或导入角色卡，开启您的大剧院之旅。（非常消耗Token，Token爆炸警告）
          </p>
        </div>

        <!-- 列表网格 -->
        <div v-if="themes.length > 0" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          <!-- 剧本卡片 (采用紧凑竖屏海报设计，底部信息以绝对定位渐变遮罩层叠呈现) -->
          <div
            v-for="item in themes"
            :key="item.id"
            @click="enterLobby(item)"
            class="border border-outline-variant/30 hover:border-primary/45 bg-surface rounded relative aspect-[2/3] overflow-hidden cursor-pointer transition-all hover:-translate-y-0.5 shadow-sm group"
          >
            <!-- 封面图 (缺省用 Morandi 渐变背景) -->
            <div
              v-if="!item.cover"
              class="absolute inset-0 flex items-center justify-center font-bold text-white text-3xl select-none"
              :style="{ background: getMorandiGradient(item.name) }"
            >
              {{ item.name[0] }}
            </div>
            <img
              v-else
              :src="item.cover"
              class="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />

            <!-- 精美深色渐变浮层 (确保底部文字高可读性) -->
            <div class="absolute inset-0 bg-gradient-to-t from-black/95 via-black/55 to-transparent transition-opacity group-hover:via-black/60"></div>

            <!-- 右上角悬浮操作栏 -->
            <div
              class="absolute top-2 right-2 flex items-center gap-1 px-1 py-0.5 rounded bg-black/40 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-all duration-200 z-10"
            >
              <button
                @click.stop="handleExportTheme(item.id, $event)"
                class="p-1 text-white/80 hover:text-primary transition-colors cursor-pointer"
                title="导出剧本包 (.echotheater)"
              >
                <DownloadIcon class="w-3.5 h-3.5" />
              </button>
              <button
                @click.stop="handleDeleteTheme(item.id, $event)"
                class="p-1 text-white/80 hover:text-error transition-colors cursor-pointer"
                title="物理删除剧本包"
              >
                <Trash2Icon class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- 底部文字遮罩展示区域 -->
            <div class="absolute bottom-0 left-0 right-0 p-3 flex flex-col justify-end text-white select-none pointer-events-none">
              <!-- 第一行：剧本拼音ID与角色数标签 -->
              <div class="flex items-center justify-between mb-1.5 opacity-90">
                <span
                  class="px-1 py-0.5 rounded bg-primary/80 backdrop-blur-sm text-[7px] font-bold uppercase tracking-wider scale-90 origin-left"
                >
                  {{ item.id }}
                </span>
                <span class="text-[8px] text-gray-300 font-mono tracking-tight">
                  {{ item.characters?.length || 0 }} Chars
                </span>
              </div>

              <!-- 第二行：剧本名称 -->
              <h3 class="text-[11px] font-bold text-white line-clamp-1 group-hover:text-primary transition-colors leading-tight">
                {{ item.name }}
              </h3>

              <!-- 第三行：剧本简介 (限制两行，使用微缩灰白字体) -->
              <p class="text-[8px] text-gray-300/80 mt-1 line-clamp-2 leading-relaxed font-light">
                {{ item.description || item.scenario || '暂无详细背景剧情描述。' }}
              </p>
            </div>
          </div>
        </div>

        <!-- 空状态展示 (支持角色卡或包文件导入) -->
        <div v-else class="flex-1 flex flex-col items-center justify-center py-20">
          <div class="p-4 rounded bg-primary/10 text-primary mb-4">
            <BookOpenIcon class="w-8 h-8" />
          </div>
          <p class="text-sm font-bold text-on-surface mb-1">剧本库空空如也</p>
          <p class="text-xs text-on-surface-variant/65 mb-6 max-w-sm text-center">
            尚未创建或加载任何剧本设定。您可以点击右上角“新剧本”自主选择模式搭建世界观或导入角色卡。
          </p>
        </div>
      </main>

      <!-- ==========================================
           视图 2：剧本准备大堂 (Lobby)
           ========================================== -->
      <main v-if="viewState === 'lobby' && selectedTheme" class="flex-1 overflow-y-auto p-6 flex flex-col">
        <!-- 大堂标题 -->
        <div class="mb-5 flex items-center justify-between">
          <div>
            <span class="text-[10px] text-primary font-bold uppercase tracking-widest">SESSION PREP PHASE</span>
            <h2 class="text-lg font-bold text-on-surface flex items-center gap-2">
              剧本准备阶段：{{ selectedTheme.name }}
            </h2>
          </div>
        </div>

        <!-- 准备面板：两栏设计 -->
        <div class="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0">
          <!-- 左栏：参演角色 -->
          <div class="glass-panel rounded p-5 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-4 pb-2 border-b border-outline-variant/15">
                <h3 class="text-xs font-bold text-on-surface flex items-center gap-1.5">
                  <PlayIcon class="w-3.5 h-3.5 text-primary" />
                  <span>参演角色（过程中可增加）</span>
                </h3>
                <span
                  class="px-1.5 py-0.5 rounded bg-surface-high text-[8px] font-bold font-mono text-on-surface-variant"
                >
                  {{ participatingChars.length }} 参演
                </span>
              </div>

              <!-- NPC 列表 -->
              <div class="space-y-3 max-h-[480px] overflow-y-auto pr-1">
                <template v-for="c in selectedTheme.characters">
                  <div
                    v-if="c.name !== selectedPlayerChar"
                    :key="c.name"
                    class="p-2.5 rounded bg-surface/40 border border-outline-variant/10 flex items-center justify-between hover:bg-surface/75 transition-colors"
                  >
                    <div class="flex items-center space-x-2.5">
                      <!-- 勾选参演 Checkbox -->
                      <input 
                        type="checkbox"
                        :checked="participatingChars.includes(c.name)"
                        @change="toggleParticipating(c.name)"
                        class="w-3.5 h-3.5 rounded border-outline-variant text-primary focus:ring-primary cursor-pointer mr-0.5"
                      />
                      <!-- 头像 -->
                      <div
                        class="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center border border-outline-variant/20 flex-shrink-0"
                      >
                        <div
                          v-if="!c.avatar"
                          class="w-full h-full flex items-center justify-center font-bold text-white text-[10px]"
                          :style="{ background: getMorandiGradient(c.name) }"
                        >
                          {{ c.name[0] }}
                        </div>
                        <img v-else :src="c.avatar" @error="c.avatar = ''" class="w-full h-full object-cover rounded-full" />
                      </div>
                      <div>
                        <h4 class="text-xs font-bold text-on-surface" :class="!participatingChars.includes(c.name) ? 'text-on-surface-variant/40 line-through' : ''">{{ c.name }}</h4>
                        <p class="text-[9px] mt-0.5" :class="!participatingChars.includes(c.name) ? 'text-on-surface-variant/30' : 'text-on-surface-variant/80'">
                          {{ c.gender }} · {{ formatAge(c.age || '20') }}
                        </p>
                      </div>
                    </div>
                  </div>
                </template>
                <div
                  v-if="selectedTheme.characters?.length <= 1"
                  class="text-center py-6 text-[10px] text-on-surface-variant/60"
                >
                  暂无其他 NPC。
                </div>
              </div>
            </div>

            <p class="text-[9px] text-on-surface-variant/60 leading-normal border-t border-outline-variant/10 pt-3">
              所有处于勾选就绪状态的参演角色，均会在与玩家的互动或者特定世界事件时自动登场。未勾选的角色也可以后期手动设置登场。
            </p>
          </div>

          <!-- 右栏：主角设置 -->
          <div class="glass-panel rounded p-5 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between mb-4 pb-2 border-b border-outline-variant/15">
                <h3 class="text-xs font-bold text-on-surface flex items-center gap-1.5">
                  <UsersIcon class="w-3.5 h-3.5 text-primary" />
                  <span>主角设置</span>
                </h3>
                <span class="text-[10px] text-on-surface-variant/60 font-mono">ID: 0x7F_Kestrel</span>
              </div>

              <!-- 绑定角色选择 -->
              <div class="mb-4">
                <label class="block text-[10px] text-on-surface-variant font-bold mb-1.5">选择你所扮演的角色：</label>
                <select
                  v-model="selectedPlayerChar"
                  class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface focus:outline-none focus:border-primary"
                >
                  <option v-for="c in selectedTheme.characters" :key="c.name" :value="c.name">
                    {{ c.name }} ({{ c.gender }} / {{ c.age || '未知' }})
                  </option>
                </select>
              </div>

              <!-- 角色信息预览 -->
              <div v-if="selectedPlayerChar" class="p-3.5 rounded bg-surface/50 border border-outline-variant/15 mb-4">
                <!-- 头部栏：头像、姓名、性别与年龄水平排布在一行 -->
                <div class="flex items-center space-x-3 pb-2.5 border-b border-outline-variant/10 mb-2.5">
                  <!-- 头像 -->
                  <div
                    class="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 border border-outline-variant/20 bg-surface shadow-inner"
                  >
                    <div
                      v-if="!selectedTheme.characters.find(c => c.name === selectedPlayerChar)?.avatar"
                      class="w-full h-full flex items-center justify-center font-bold text-white text-xs"
                      :style="{ background: getMorandiGradient(selectedPlayerChar) }"
                    >
                      {{ selectedPlayerChar[0] }}
                    </div>
                    <img
                      v-else
                      :src="selectedTheme.characters.find(c => c.name === selectedPlayerChar)?.avatar"
                      @error="() => {
                        const target = selectedTheme.characters.find(c => c.name === selectedPlayerChar);
                        if (target) target.avatar = '';
                      }"
                      class="w-full h-full object-cover rounded-full"
                    />
                  </div>
                  <!-- 姓名与年龄 -->
                  <div>
                    <h4 class="text-xs font-bold text-on-surface flex items-center gap-2">
                      <span>{{ selectedPlayerChar }}</span>
                      <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[8px] font-medium leading-none">
                        {{ selectedTheme.characters.find(c => c.name === selectedPlayerChar)?.gender || '自定义' }} · 
                        {{ formatAge(selectedTheme.characters.find(c => c.name === selectedPlayerChar)?.age || '?') }}
                      </span>
                    </h4>
                  </div>
                </div>

                <!-- 性格大纲描述：在下方独立铺开 -->
                <p class="text-[9px] text-on-surface-variant/75 line-clamp-4 leading-relaxed">
                  {{
                    selectedTheme.characters.find(c => c.name === selectedPlayerChar)?.soul || '暂无角色独立设定。'
                  }}
                </p>
              </div>
            </div>

            <!-- 底部操作区 -->
            <div class="space-y-3.5 mt-auto">
              <p class="text-[9px] text-on-surface-variant/60 leading-normal border-t border-outline-variant/10 pt-3">
                * 提示：所选角色的设定文件 `Soul.md` 将在游戏开始时被 AI 系统加载，并以此构建角色的行动风格。
              </p>
              <!-- 开始跑团按钮 -->
              <button
                @click="startAdventure"
                class="w-full py-2.5 rounded bg-primary hover:bg-primary-container text-xs font-bold text-on-primary shadow-sm hover:shadow transition-all active:scale-95 cursor-pointer flex items-center justify-center space-x-2"
              >
                <PlayIcon class="w-4 h-4 fill-on-primary stroke-none" />
                <span>踏入大剧院</span>
              </button>
            </div>
          </div>
        </div>
      </main>

      <!-- ==========================================
           视图 3：剧本编辑器视图 (Editor)
           ========================================== -->
      <main v-if="viewState === 'editor'" class="flex-1 overflow-hidden flex flex-col">
        <!-- 具体的子模式界面 -->
        <div class="flex-1 min-h-0 overflow-y-auto p-6">
          <!-- A. AI智能编织面板 -->
          <div v-if="editorTab === 'ai'" class="max-w-xl mx-auto py-12 text-center">
            <div
              class="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4 animate-pulse"
            >
              <SparklesIcon class="w-6 h-6" />
            </div>
            <h3 class="text-sm font-bold text-on-surface mb-2">一句话智能编织剧本世界</h3>
            <p class="text-xs text-on-surface-variant/70 mb-6 leading-relaxed">
              输入你脑海中的跑团剧情构想或世界法则（哪怕只有一句话），AI
              将为您智能衍生并自动构筑一整套完整的世界背景设定、多位个性独特的NPC群演、关系网拓扑和状态规则，完成后自动填充到表单中！
            </p>

            <div class="space-y-4">
              <textarea
                v-model="aiPromptInput"
                placeholder="例如：一个被财阀控制的反乌托邦霓虹朋克世界。玩家需要和AI抵抗组织一起揭露背后的真相..."
                rows="4"
                class="w-full px-3 py-2 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary resize-none leading-relaxed"
              ></textarea>

              <button
                @click="handleAIOtherweave"
                class="w-full py-2 rounded bg-primary hover:bg-primary-container text-xs font-bold text-on-primary shadow transition-all active:scale-95 cursor-pointer flex items-center justify-center space-x-2"
              >
                <SparklesIcon class="w-4 h-4 fill-on-primary stroke-none" />
                <span>开始大包编织</span>
              </button>
            </div>
          </div>

          <!-- B. 角色卡导入面板 -->
          <div v-if="editorTab === 'card'" class="max-w-xl mx-auto py-12 text-center">
            <div
              class="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-4"
            >
              <UploadIcon class="w-6 h-6" />
            </div>
            <h3 class="text-sm font-bold text-on-surface mb-2">从酒馆角色卡 (Character Card) 提取</h3>
            <p class="text-xs text-on-surface-variant/70 mb-6 leading-relaxed">
              点击下方按钮或直接将酒馆 `.png` 角色卡图片、`.json`
              配置文件拖拽至此。系统大模型将全自动解构文本设定，提炼嵌套角色（NPC）、初始关系连线以及其所处的宏观世界观与剧情，并自动回填！
            </p>

            <input type="file" id="card-file-input" accept=".png,.json" class="hidden" @change="onCardFileChange" />

            <div
              @click="triggerUploadCard"
              class="border-2 border-dashed border-outline-variant hover:border-primary/50 bg-surface/30 rounded p-8 flex flex-col items-center justify-center cursor-pointer transition-colors"
            >
              <FileJsonIcon class="w-8 h-8 text-on-surface-variant/70 mb-2" />
              <span class="text-xs font-bold text-on-surface">点击选择本地卡片文件</span>
              <span class="text-[10px] text-on-surface-variant/65 mt-1">支持 SillyTavern 标准 PNG 与 JSON 格式</span>
            </div>
          </div>

          <!-- C. 手动配置模式主表单 -->
          <div v-if="editorTab === 'manual'" class="space-y-8 max-w-6xl mx-auto">
            <!-- 剧本基本信息 -->
            <section class="p-5 rounded bg-surface/60 border border-outline-variant/15 space-y-4">
              <h3
                class="text-xs font-bold text-on-surface border-b border-outline-variant/10 pb-2 flex items-center gap-1.5"
              >
                <span>1. 剧本基础定义</span>
              </h3>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <!-- 剧本名 -->
                <div class="md:col-span-2 space-y-1">
                  <label class="block text-[10px] text-on-surface-variant font-bold">
                    <span class="text-error mr-0.5">*</span>剧本题材名称：
                  </label>
                  <input
                    v-model="form.name"
                    type="text"
                    placeholder="请输入剧本的名称（例如：山海密卷、霓虹阴影）..."
                    class="w-full px-3 py-2 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary"
                  />
                  <p class="text-[9px] text-on-surface-variant/60">保存时系统将自动转换为纯拼音作为底层物理目录名。</p>
                </div>

                <!-- 封面图 -->
                <div class="space-y-1">
                  <label class="block text-[10px] text-on-surface-variant font-bold">剧本封面图片：</label>
                  <input
                    type="file"
                    id="cover-file-input"
                    accept="image/*"
                    class="hidden"
                    @change="onCoverFileChange"
                  />

                  <div class="flex items-center space-x-3">
                    <div
                      class="w-16 h-24 rounded overflow-hidden bg-surface-low border border-outline-variant/30 flex items-center justify-center flex-shrink-0 cursor-pointer"
                      @click="triggerUploadCover"
                    >
                      <div
                        v-if="!form.cover"
                        class="w-full h-full flex flex-col items-center justify-center text-[9px] text-on-surface-variant/60"
                        :style="{ background: getMorandiGradient(form.name) }"
                      >
                        <span>无封面</span>
                      </div>
                      <img v-else :src="form.cover" class="w-full h-full object-cover" />
                    </div>
                    <button
                      type="button"
                      @click="triggerUploadCover"
                      class="px-2.5 py-1.5 rounded border border-outline-variant/40 text-[10px] text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors cursor-pointer"
                    >
                      更换封面
                    </button>
                  </div>
                </div>
              </div>

              <!-- 并排世界观与开局剧本设定 -->
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-3">
                <!-- 世界观 -->
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between">
                    <label class="block text-[10px] text-on-surface-variant font-bold">
                      <span class="text-error mr-0.5">*</span>① 世界观设定 (World Settings)：
                    </label>
                    <button
                      type="button"
                      @click="handleBackgroundAIGenerate('world')"
                      class="text-[9px] text-primary hover:text-primary-container font-bold flex items-center gap-0.5 cursor-pointer"
                    >
                      <SparklesIcon class="w-2.5 h-2.5" />
                      <span>AI 生成设定</span>
                    </button>
                  </div>
                  <textarea
                    v-model="form.world_settings"
                    rows="6"
                    placeholder="在此描述故事所处的物理法理环境（例如：魔法体系设定、社会组织等）..."
                    class="w-full px-3 py-2 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface placeholder-on-surface-variant/45 focus:outline-none focus:border-primary resize-none leading-relaxed"
                  ></textarea>
                </div>

                <!-- 开局剧本 -->
                <div class="space-y-1.5">
                  <div class="flex items-center justify-between">
                    <label class="block text-[10px] text-on-surface-variant font-bold"
                      >② 开局剧情剧本 (Opening Scene)：</label
                    >
                    <button
                      type="button"
                      @click="handleBackgroundAIGenerate('scenario')"
                      class="text-[9px] text-primary hover:text-primary-container font-bold flex items-center gap-0.5 cursor-pointer"
                    >
                      <SparklesIcon class="w-2.5 h-2.5" />
                      <span>AI 生成开局</span>
                    </button>
                  </div>
                  <textarea
                    v-model="form.scenario"
                    rows="6"
                    placeholder="在此描述故事开始时的紧急遭遇和具体任务（可留空由 AI 实时演绎）..."
                    class="w-full px-3 py-2 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface placeholder-on-surface-variant/45 focus:outline-none focus:border-primary resize-none leading-relaxed"
                  ></textarea>
                </div>
              </div>
            </section>

            <!-- 登场角色管理 -->
            <section class="p-5 rounded bg-surface/60 border border-outline-variant/15 space-y-4">
              <div class="flex items-center justify-between border-b border-outline-variant/10 pb-2">
                <h3 class="text-xs font-bold text-on-surface flex items-center gap-1">
                  <span>2. 登场角色与核心人设 (NPCs & Characters)</span>
                </h3>
                <div class="flex items-center space-x-2">
                  <!-- 导入用户人设 -->
                  <button
                    type="button"
                    @click="openUserProfileImport"
                    class="px-2.5 py-1 rounded bg-primary/10 border border-primary/25 text-[10px] font-bold text-primary hover:bg-primary/20 transition-all cursor-pointer"
                  >
                    导入用户人设
                  </button>
                  <!-- 从通讯录导入 -->
                  <button
                    type="button"
                    @click="openAddressBook"
                    class="px-2.5 py-1 rounded bg-primary/10 border border-primary/25 text-[10px] font-bold text-primary hover:bg-primary/20 transition-all cursor-pointer"
                  >
                    从通讯录导入
                  </button>
                  <!-- AI生成 -->
                  <button
                    type="button"
                    :disabled="form.characters.length >= 7"
                    @click="handleGenerateCharactersAI"
                    class="px-2.5 py-1 rounded border text-[10px] font-bold transition-all cursor-pointer"
                    :class="[
                      form.characters.length >= 7
                        ? 'bg-surface-low text-on-surface-variant/40 border-outline-variant/15 cursor-not-allowed'
                        : 'bg-primary/10 border-primary/25 text-primary hover:bg-primary/20'
                    ]"
                  >
                    AI生成角色
                  </button>
                  <!-- 添加角色 -->
                  <button
                    type="button"
                    @click="addCharacter"
                    class="px-2.5 py-1 rounded bg-primary text-[10px] font-bold text-on-primary hover:bg-primary-container transition-all flex items-center gap-1 cursor-pointer"
                  >
                    <PlusIcon class="w-3.5 h-3.5" />
                    <span>添加角色</span>
                  </button>
                </div>
              </div>

              <!-- 角色卡片列表 -->
              <div v-if="form.characters.length > 0" class="flex flex-wrap gap-2.5 items-start">
                <div
                  v-for="(char, idx) in form.characters"
                  :key="idx"
                  :class="[
                    'transition-all duration-200',
                    char.isCollapsed ? 'w-[170px] flex-shrink-0' : 'w-full'
                  ]"
                >
                  <!-- 1. 折叠状态：只显示头像、姓名、年龄的小卡片 -->
                  <div
                    v-if="char.isCollapsed"
                    @click="char.isCollapsed = false"
                    class="p-2.5 rounded border shadow-sm hover:shadow-md transition-all flex items-center justify-between cursor-pointer group h-[52px] min-w-0"
                    :class="char.name === '{{user}}' || char.name === '<user>'
                      ? 'bg-error/5 border-error/55 hover:border-error hover:bg-error/10'
                      : 'bg-surface/50 border-outline-variant/15 hover:border-primary/30 hover:bg-surface'"
                  >
                    <div class="flex items-center space-x-2.5 min-w-0 flex-1">
                      <!-- 圆形小头像 -->
                      <div class="w-8 h-8 rounded-full overflow-hidden border border-outline-variant/20 flex items-center justify-center flex-shrink-0 bg-surface-low shadow-inner">
                        <div
                          v-if="!char.avatar"
                          class="w-full h-full flex items-center justify-center font-bold text-white text-[9px] rounded-full"
                          :style="{ background: getMorandiGradient(char.name) }"
                        >
                          {{ char.name ? char.name[0] : '?' }}
                        </div>
                        <img v-else :src="char.avatar" class="w-full h-full object-cover rounded-full" />
                      </div>
                      
                      <!-- 基本属性信息 -->
                      <div class="flex flex-col min-w-0">
                        <span
                          class="text-xs font-bold truncate pr-1"
                          :class="char.name === '{{user}}' || char.name === '<user>' ? 'text-error animate-pulse' : 'text-on-surface'"
                        >
                          <template v-if="char.name === '{{user}}' || char.name === '<user>'">
                            <span v-pre>{{user}}</span> (待补全)
                          </template>
                          <template v-else>
                            {{ char.name || '未命名角色' }}
                          </template>
                        </span>
                        <span class="text-[8px] text-on-surface-variant/70 mt-0.5 truncate">
                          {{ char.gender || '未知' }} · {{ char.age || '未知岁' }}
                        </span>
                      </div>
                    </div>

                    <!-- 操作按钮组 -->
                    <div class="flex items-center space-x-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        type="button"
                        @click.stop="char.isCollapsed = false"
                        class="p-1 rounded hover:bg-primary/10 text-primary transition-all cursor-pointer flex items-center justify-center"
                        title="编辑角色"
                      >
                        <Edit3Icon class="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        @click.stop="removeCharacter(idx)"
                        class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-all cursor-pointer flex items-center justify-center"
                        title="移除角色"
                      >
                        <Trash2Icon class="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  <!-- 2. 展开编辑状态 -->
                  <div
                    v-else
                    class="p-5 rounded-lg bg-surface border-2 flex flex-col space-y-4 relative shadow-lg border-l-4"
                    :class="char.name === '{{user}}' || char.name === '<user>'
                      ? 'border-error/45 border-l-error'
                      : 'border-primary/30 border-l-primary'"
                  >
                    <!-- 右上角快捷操作栏 -->
                    <div class="absolute top-4 right-4 flex items-center space-x-2.5 z-10">
                      <button
                        type="button"
                        @click.stop="char.isCollapsed = true"
                        class="p-1.5 rounded bg-success/10 hover:bg-success/20 text-success transition-all cursor-pointer flex items-center justify-center"
                        title="确定并折叠卡片"
                      >
                        <CheckIcon class="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        @click.stop="removeCharacter(idx)"
                        class="p-1.5 rounded bg-error/10 hover:bg-error/20 text-error transition-all cursor-pointer flex items-center justify-center"
                        title="移除该角色"
                      >
                        <Trash2Icon class="w-4 h-4" />
                      </button>
                    </div>

                    <!-- {{user}} 占位符修改警告 Alert -->
                    <div
                      v-if="char.name === '{{user}}' || char.name === '<user>'"
                      class="p-3 rounded bg-error/5 border border-error/25 flex items-center justify-between text-[11px] text-error font-medium leading-normal animate-fade-in"
                    >
                      <div class="flex items-center space-x-2">
                        <AlertCircleIcon class="w-4 h-4 text-error flex-shrink-0 animate-bounce" />
                        <span v-pre>请在此补全您扮演角色的设定。您也可以一键导入现有的用户人设进行原地替换。</span>
                      </div>
                      <button
                        type="button"
                        @click="openUserProfileReplace(idx)"
                        class="px-2.5 py-1 rounded bg-error/10 hover:bg-error/20 border border-error/30 text-[10px] font-bold text-error transition-all cursor-pointer flex-shrink-0 active:scale-95 ml-3"
                      >
                        使用用户人设替换
                      </button>
                    </div>

                    <!-- 角色核心信息区（左右布局，左侧头像，右侧姓名性别年龄输入框） -->
                    <div class="flex flex-col md:flex-row gap-5 items-start">
                      <!-- 左侧：头像区域 -->
                      <div class="relative flex-shrink-0">
                        <input
                          type="file"
                          :id="`avatar-file-input-${idx}`"
                          accept="image/*"
                          class="hidden"
                          @change="onAvatarFileChange($event, idx)"
                        />
                        <!-- 圆形大头像 -->
                        <div
                          class="w-20 h-20 rounded-full overflow-hidden border-2 border-primary/20 flex items-center justify-center cursor-pointer bg-surface shadow-md hover:scale-102 hover:border-primary/50 transition-all group relative"
                          @click="triggerUploadAvatar(idx)"
                          title="点击上传本地头像"
                        >
                          <div
                            v-if="!char.avatar"
                            class="w-full h-full flex items-center justify-center font-bold text-white text-2xl rounded-full"
                            :style="{ background: getMorandiGradient(char.name) }"
                          >
                            {{ char.name ? char.name[0] : '?' }}
                          </div>
                          <img v-else :src="char.avatar" @error="char.avatar = ''" class="w-full h-full object-cover rounded-full" />
                          
                          <!-- Hover 更换头像蒙层 (生图时隐藏以避免干扰) -->
                          <div v-if="!drawingIndices.has(idx)" class="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center text-white transition-opacity duration-200">
                            <UploadIcon class="w-4 h-4 mb-0.5" />
                            <span class="text-[8px] font-medium leading-none scale-90">更换头像</span>
                          </div>

                          <!-- 局部生图中的 Loading 蒙层 -->
                          <div v-else class="absolute inset-0 bg-black/65 flex flex-col items-center justify-center text-white transition-opacity duration-200">
                            <svg class="animate-spin h-5 w-5 text-primary mb-1" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            <span class="text-[8px] font-bold text-primary scale-90 tracking-wider">绘制中...</span>
                          </div>
                        </div>

                        <!-- NovelAI 浮动头像绘制按钮 -->
                        <button
                          v-if="hasDrawing"
                          type="button"
                          :disabled="drawingIndices.has(idx)"
                          @click.stop="handleDrawAvatarAI(idx)"
                          class="w-7 h-7 rounded-full bg-primary text-on-primary hover:bg-primary-container hover:text-primary flex items-center justify-center shadow-md absolute bottom-0 right-0 transition-transform active:scale-95 cursor-pointer hover:scale-108 border-2 border-surface"
                          :class="{ 'opacity-50 cursor-not-allowed': drawingIndices.has(idx) }"
                          title="使用 AI 绘制专属头像"
                        >
                          <!-- 如果在绘制中，展示转圈动画 -->
                          <svg v-if="drawingIndices.has(idx)" class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          <SparklesIcon v-else class="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <!-- 右侧：姓名、性别、年龄表单输入区 -->
                      <div class="flex-1 w-full grid grid-cols-1 md:grid-cols-3 gap-4 pr-16">
                        <div class="space-y-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">
                            <span class="text-error mr-0.5">*</span>角色姓名：
                          </label>
                          <input
                            v-model="char.name"
                            type="text"
                            placeholder="请输入姓名..."
                            class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary placeholder-on-surface-variant/40"
                          />
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">性别：</label>
                          <select
                            v-model="char.gender"
                            class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary"
                          >
                            <option value="男">男</option>
                            <option value="女">女</option>
                            <option value="自定义">自定义</option>
                          </select>
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">年龄：</label>
                          <input
                            v-model="char.age"
                            type="text"
                            placeholder="留空或输入数字..."
                            class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary placeholder-on-surface-variant/40"
                          />
                        </div>
                      </div>
                    </div>

                    <!-- 角色设定：性格设定大纲与外貌特征 -->
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
                      <!-- 性格设定 Soul.md -->
                      <div class="lg:col-span-2 flex flex-col space-y-1">
                        <label class="block text-[9px] text-on-surface-variant font-bold">
                          <span class="text-error mr-0.5">*</span>独立的性格设定大纲 (Soul.md，不含世界观背景)：
                        </label>
                        <textarea
                          v-model="char.soul"
                          rows="4"
                          placeholder="请输入角色的身世背景、内在性格偏好与对话特征..."
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary resize-none leading-relaxed flex-1"
                        ></textarea>
                      </div>

                      <!-- 外貌特征 Tags -->
                      <div class="flex flex-col space-y-1">
                        <div class="flex items-center justify-between mb-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">
                            外貌特征生图 Tags (英文逗号分隔)：
                          </label>
                          <!-- AI 提炼按钮 -->
                          <button
                            type="button"
                            @click="handleExtractAppearanceAI(idx)"
                            class="text-[8px] text-primary hover:text-primary-container font-bold flex items-center gap-0.5 cursor-pointer ml-auto"
                            title="从左侧的性格设定大纲中提炼物理外貌特征"
                          >
                            <SparklesIcon class="w-2.5 h-2.5" />
                            <span>AI 提炼 Tag</span>
                          </button>
                        </div>
                        <textarea
                          v-model="char.appearance"
                          rows="4"
                          placeholder="例如: 1boy, short silver hair, green eyes 等"
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface placeholder-on-surface-variant/40 focus:outline-none focus:border-primary resize-none leading-relaxed font-mono flex-1"
                        ></textarea>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 无角色空提示 -->
              <div
                v-else
                class="text-center py-8 border border-dashed border-outline-variant/30 rounded text-xs text-on-surface-variant/60"
              >
                尚未添加登场角色。点击右上角“添加角色”、“从通讯录导入”或“AI发散生成”来构建世界群演。
              </div>
            </section>

            <!-- 关系拓扑配置与 SVG 图谱 -->
            <section class="p-5 rounded bg-surface/60 border border-outline-variant/15 space-y-4">
              <h3
                class="text-xs font-bold text-on-surface border-b border-outline-variant/10 pb-2 flex items-center justify-between"
              >
                <span>3. 登场角色社会关系网络拓扑 (Relations Map)</span>
                <button
                  type="button"
                  @click="addRelation"
                  class="px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-[9px] font-bold text-primary hover:bg-primary/20 transition-all flex items-center gap-0.5 cursor-pointer"
                >
                  <PlusIcon class="w-3 h-3" />
                  <span>添加关系连线</span>
                </button>
              </h3>

              <!-- 关系配对表单 (改为宽度平铺或自适应网格) -->
              <div
                v-if="form.relations.length > 0"
                class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-h-[220px] overflow-y-auto pr-1"
              >
                <div
                  v-for="(rel, index) in form.relations"
                  :key="index"
                  class="p-2.5 rounded bg-surface-low border border-outline-variant/20 flex flex-col justify-between space-y-2 relative"
                >
                  <!-- 第一行：两个下拉角色选择 -->
                  <div class="flex items-center space-x-1.5 w-full">
                    <select
                      v-model="rel.from"
                      class="flex-1 min-w-[60px] px-1.5 py-1 text-[10px] rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none"
                    >
                      <option v-for="c in form.characters" :key="c.name" :value="c.name">
                        {{ c.name || '未命名角色' }}
                      </option>
                    </select>

                    <span class="text-[9px] text-on-surface-variant font-bold shrink-0">与</span>

                    <select
                      v-model="rel.to"
                      class="flex-1 min-w-[60px] px-1.5 py-1 text-[10px] rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none"
                    >
                      <option v-for="c in form.characters" :key="c.name" :value="c.name">
                        {{ c.name || '未命名角色' }}
                      </option>
                    </select>
                  </div>

                  <!-- 第二行：关系描述输入框与删除按钮 -->
                  <div class="flex items-center space-x-2 w-full">
                    <input
                      v-model="rel.type"
                      type="text"
                      placeholder="关系描述"
                      class="flex-1 min-w-0 px-1.5 py-1 text-[10px] rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary"
                    />

                    <!-- 删除关系 -->
                    <button
                      type="button"
                      @click="removeRelation(index)"
                      class="p-1 rounded text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0"
                    >
                      <Trash2Icon class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div
                v-else
                class="text-center py-6 border border-dashed border-outline-variant/20 rounded text-[10px] text-on-surface-variant/60"
              >
                暂无社会关系描述。添加两个以上的角色，并点击右上角创建连线。
              </div>

              <!-- SVG 实体关系图谱 (满宽呈现) -->
              <div
                class="w-full border border-outline-variant/20 bg-surface-dim/35 rounded relative h-[450px] overflow-hidden flex flex-col justify-between"
              >
                <!-- 缩放控制工具栏 -->
                <div class="absolute top-3.5 right-3.5 z-10 flex space-x-1.5">
                  <button
                    type="button"
                    @click="zoomIn"
                    class="p-1.5 rounded bg-surface/85 backdrop-blur border border-outline-variant/45 text-on-surface-variant hover:text-on-surface hover:bg-surface transition-colors cursor-pointer"
                    title="放大"
                  >
                    <ZoomInIcon class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    @click="zoomOut"
                    class="p-1.5 rounded bg-surface/85 backdrop-blur border border-outline-variant/45 text-on-surface-variant hover:text-on-surface hover:bg-surface transition-colors cursor-pointer"
                    title="缩小"
                  >
                    <ZoomOutIcon class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    @click="resetZoom"
                    class="p-1.5 rounded bg-surface/85 backdrop-blur border border-outline-variant/45 text-on-surface-variant hover:text-on-surface hover:bg-surface transition-colors cursor-pointer"
                    title="重置"
                  >
                    <RotateCcwIcon class="w-3.5 h-3.5" />
                  </button>
                </div>

                <!-- 实时拓扑网络 -->
                <svg
                  class="w-full h-full flex-1 cursor-grab active:cursor-grabbing"
                  @mousedown="startDragCanvas"
                  @mousemove="handleSvgMouseMove"
                  @mouseup="stopSvgDrag"
                  @mouseleave="stopSvgDrag"
                >
                  <!-- 定义箭头与渐变 -->
                  <defs>
                    <marker
                      id="arrow"
                      viewBox="0 0 10 10"
                      refX="34"
                      refY="5"
                      markerWidth="5"
                      markerHeight="5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
                    </marker>

                    <!-- 动态莫兰迪渐变定义 -->
                    <linearGradient
                      v-for="(node, nidx) in svgNodes"
                      :key="'grad-' + nidx"
                      :id="'grad-' + nidx"
                      x1="0%"
                      y1="0%"
                      x2="100%"
                      y2="100%"
                    >
                      <stop offset="0%" :stop-color="getMorandiColors(node.name)[0]" />
                      <stop offset="100%" :stop-color="getMorandiColors(node.name)[1]" />
                    </linearGradient>
                  </defs>

                  <!-- 全局缩放平移层 -->
                  <g :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0' }">
                    <!-- 连线关系渲染 -->
                    <g v-for="(rel, idx) in form.relations" :key="idx">
                      <path
                        v-if="svgNodes.find(n => n.name === rel.from) && svgNodes.find(n => n.name === rel.to)"
                        :d="getRelationPath(rel)"
                        fill="none"
                        stroke="var(--primary)"
                        stroke-width="1.8"
                        stroke-dasharray="3, 3"
                        marker-end="url(#arrow)"
                      />

                      <!-- 线上描述文字 -->
                      <g v-if="svgNodes.find(n => n.name === rel.from) && svgNodes.find(n => n.name === rel.to) && rel.type">
                        <!-- 获取曲线 t=0.5 处的中心定位点并进行偏置居中 -->
                        <foreignObject
                          :x="getRelationTextPos(rel).x - 40"
                          :y="getRelationTextPos(rel).y - 11"
                          width="80"
                          height="22"
                          class="overflow-visible"
                        >
                          <div
                            @click.stop="toggleRelationBubble(idx)"
                            class="px-1.5 py-0.5 rounded bg-surface border border-outline-variant/25 text-[10px] font-bold text-center text-on-surface truncate select-none shadow-sm cursor-pointer hover:border-primary/50 transition-all"
                            :title="rel.type"
                          >
                            {{ rel.type }}
                          </div>
                        </foreignObject>

                      </g>
                    </g>

                    <!-- 节点圆形头像渲染 -->
                    <g
                      v-for="(node, index) in svgNodes"
                      :key="index"
                      :transform="`translate(${node.x}, ${node.y})`"
                      @mousedown="startDragNode($event, index)"
                      class="cursor-pointer group"
                    >
                      <!-- 外发光背景环 -->
                      <circle
                        r="22"
                        fill="var(--surface)"
                        stroke="var(--primary)"
                        stroke-width="2"
                        class="group-hover:stroke-primary-container transition-all"
                      />

                      <!-- 莫兰迪色圆形填充 -->
                      <circle
                        r="20"
                        :fill="form.characters[index]?.avatar ? 'transparent' : 'url(#grad-' + index + ')'"
                      />

                      <!-- 剪切圆头像 -->
                      <clipPath :id="`clip-circle-${index}`">
                        <circle r="20" />
                      </clipPath>
                      <image
                        v-if="form.characters[index]?.avatar"
                        :href="form.characters[index].avatar"
                        x="-20"
                        y="-20"
                        width="40"
                        height="40"
                        :clip-path="`url(#clip-circle-${index})`"
                        preserveAspectRatio="xMidYMid slice"
                      />

                      <!-- 无头像显示文字 -->
                      <text v-else text-anchor="middle" dy=".3em" fill="#ffffff" font-size="10px" font-weight="bold">
                        {{ node.name ? node.name[0] : '?' }}
                      </text>

                      <!-- 名字标注 -->
                      <text
                        y="32"
                        text-anchor="middle"
                        fill="var(--on-surface)"
                        font-size="9px"
                        font-weight="bold"
                        class="select-none pointer-events-none"
                      >
                        {{ node.name }}
                      </text>
                    </g>

                    <!-- 被点击后展开的就近关系详情气泡 (移至最图层最末梢，确保气泡置于最顶部，完全遮盖在所有人设头像和虚线之上) -->
                    <g v-if="activeRelationIndex !== null && form.relations[activeRelationIndex]">
                      <foreignObject
                        :x="getRelationTextPos(form.relations[activeRelationIndex]).x - 90"
                        :y="getRelationTextPos(form.relations[activeRelationIndex]).y - 82"
                        width="180"
                        height="70"
                        class="overflow-visible z-50 pointer-events-auto"
                      >
                        <div
                          @click.stop="activeRelationIndex = null"
                          class="p-2 rounded bg-surface border border-primary/35 text-[10px] text-on-surface shadow-md select-text relative flex flex-col justify-center cursor-pointer animate-fade-in"
                          style="min-height: 48px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.15));"
                        >
                          <div class="font-bold border-b border-outline-variant/15 pb-0.5 mb-1 text-[9px] text-primary">
                            {{ form.relations[activeRelationIndex].from }} ➔ {{ form.relations[activeRelationIndex].to }} 关系详情
                          </div>
                          <div class="leading-normal whitespace-normal break-all max-h-[38px] overflow-y-auto pr-0.5">
                            {{ form.relations[activeRelationIndex].type }}
                          </div>
                          
                          <!-- 指向下方字卡的小三角 -->
                          <div
                            class="absolute bottom-[-5px] left-1/2 -translate-x-1/2 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-t-[5px]"
                            style="border-t-color: var(--surface);"
                          ></div>
                        </div>
                      </foreignObject>
                    </g>
                  </g>
                </svg>
                <div class="p-2 border-t border-outline-variant/10 text-[8px] text-on-surface-variant/60 bg-surface/30">
                  提示：在图谱画布上滚轮或使用右侧按钮缩放，用鼠标可拖拽节点修改拓扑形态。
                </div>
              </div>
            </section>

            <!-- 数值/状态栏自定义 -->
            <section class="p-5 rounded bg-surface/60 border border-outline-variant/15 space-y-4">
              <h3
                class="text-xs font-bold text-on-surface border-b border-outline-variant/10 pb-2 flex items-center justify-between"
              >
                <span>4. 剧本状态栏</span>
                <div class="flex items-center space-x-2">
                  <!-- 导入已注册状态栏 -->
                  <button
                    type="button"
                    @click="openImportPresetModal"
                    class="px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-[9px] font-bold text-primary hover:bg-primary/20 transition-all flex items-center gap-0.5 cursor-pointer"
                  >
                    <DownloadIcon class="w-3 h-3" />
                    <span>导入已注册状态栏</span>
                  </button>
                  <!-- 添加属性 -->
                  <button
                    type="button"
                    @click="addStatusBar"
                    class="px-2 py-0.5 rounded bg-primary text-[9px] font-bold text-on-primary hover:bg-primary-container transition-all flex items-center gap-0.5 cursor-pointer"
                  >
                    <PlusIcon class="w-3 h-3" />
                    <span>添加属性</span>
                  </button>
                </div>
              </h3>

              <!-- 状态栏网格 -->
              <div v-if="form.status_bars.length > 0" class="flex flex-wrap gap-2.5 items-start">
                <div
                  v-for="(bar, sidx) in form.status_bars"
                  :key="sidx"
                  :class="[
                    'transition-all duration-200',
                    bar.isCollapsed ? 'w-[170px] flex-shrink-0' : 'w-full'
                  ]"
                >
                  <!-- 1. 折叠状态：只显示Emoji、属性名称、类别 -->
                  <div
                    v-if="bar.isCollapsed"
                    @click="bar.isCollapsed = false"
                    class="p-2.5 rounded bg-surface/50 border border-outline-variant/15 hover:border-primary/30 hover:bg-surface shadow-sm hover:shadow-md transition-all flex items-center justify-between cursor-pointer group h-[52px] min-w-0"
                  >
                    <div class="flex items-center space-x-2.5 min-w-0 flex-1">
                      <!-- 属性标识图标 -->
                      <div class="w-8 h-8 rounded bg-primary/10 border border-primary/15 flex items-center justify-center text-xs font-bold flex-shrink-0 shadow-inner text-primary">
                        #
                      </div>
                      
                      <!-- 属性信息 -->
                      <div class="flex flex-col min-w-0">
                        <span class="text-xs font-bold text-on-surface truncate pr-1">{{ bar.name || '未命名属性' }}</span>
                        <span class="text-[8px] text-on-surface-variant/70 mt-0.5 truncate">
                          {{ bar.type === 'number' ? '数字型属性' : '文本型属性' }}
                        </span>
                      </div>
                    </div>

                    <!-- 操作按钮组 -->
                    <div class="flex items-center space-x-1.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        type="button"
                        @click.stop="bar.isCollapsed = false"
                        class="p-1 rounded hover:bg-primary/10 text-primary transition-all cursor-pointer flex items-center justify-center"
                        title="编辑属性"
                      >
                        <Edit3Icon class="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        @click.stop="removeStatusBar(sidx)"
                        class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-all cursor-pointer flex items-center justify-center"
                        title="移除属性"
                      >
                        <Trash2Icon class="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  <!-- 2. 展开编辑状态 -->
                  <div
                    v-else
                    class="p-5 rounded-lg bg-surface border-2 border-primary/30 flex flex-col space-y-4 relative shadow-lg border-l-4 border-l-primary"
                  >
                    <!-- 右上角快捷操作栏 -->
                    <div class="absolute top-4 right-4 flex items-center space-x-2.5 z-10">
                      <button
                        type="button"
                        @click.stop="bar.isCollapsed = true"
                        class="p-1.5 rounded bg-success/10 hover:bg-success/20 text-success transition-all cursor-pointer flex items-center justify-center"
                        title="确定并折叠卡片"
                      >
                        <CheckIcon class="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        @click.stop="removeStatusBar(sidx)"
                        class="p-1.5 rounded bg-error/10 hover:bg-error/20 text-error transition-all cursor-pointer flex items-center justify-center"
                        title="移除该属性"
                      >
                        <Trash2Icon class="w-4 h-4" />
                      </button>
                    </div>

                    <!-- 属性主要参数网格 -->
                    <div class="grid grid-cols-1 md:grid-cols-6 gap-4 pr-16">
                      <!-- 指标名 -->
                      <div class="space-y-1 md:col-span-2">
                        <label class="block text-[9px] text-on-surface-variant font-bold">
                          <span class="text-error mr-0.5">*</span>属性名称：
                        </label>
                        <input
                          v-model="bar.name"
                          type="text"
                          placeholder="例如: 生命值、精神力"
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary placeholder-on-surface-variant/40"
                        />
                      </div>
                      


                      <!-- 类别 -->
                      <div class="space-y-1 md:col-span-1">
                        <label class="block text-[9px] text-on-surface-variant font-bold">属性类别：</label>
                        <select
                          v-model="bar.type"
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary"
                        >
                          <option value="number">数字型 (Number)</option>
                          <option value="text">文本型 (Text)</option>
                        </select>
                      </div>

                      <!-- 条件属性值 -->
                      <template v-if="bar.type === 'number'">
                        <div class="space-y-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">最小值：</label>
                          <input
                            v-model.number="bar.min"
                            type="number"
                            class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div class="space-y-1">
                          <label class="block text-[9px] text-on-surface-variant font-bold">最大值：</label>
                          <input
                            v-model.number="bar.max"
                            type="number"
                            class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary"
                          />
                        </div>
                      </template>
                    </div>

                    <!-- 属性说明与变动规则说明 -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div class="space-y-1">
                        <label class="block text-[9px] text-on-surface-variant font-bold">
                          <span class="text-error mr-0.5">*</span>属性描述说明（提供给 AI 了解）：
                        </label>
                        <input
                          v-model="bar.description"
                          type="text"
                          placeholder="说明该指标的含义以及不同指标下对角色的影响"
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary placeholder-on-surface-variant/40"
                        />
                      </div>

                      <div class="space-y-1">
                        <label class="block text-[9px] text-on-surface-variant font-bold">
                          <span class="text-error mr-0.5">*</span>大模型联动改变与增减规则说明：
                        </label>
                        <input
                          v-model="bar.aiRule"
                          type="text"
                          placeholder="指示 AI 指标变动的规则..."
                          class="w-full px-2.5 py-1.5 text-xs rounded bg-surface border border-outline-variant/30 text-on-surface focus:outline-none focus:border-primary placeholder-on-surface-variant/40"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div
                v-else
                class="text-center py-8 border border-dashed border-outline-variant/30 rounded text-xs text-on-surface-variant/60"
              >
                暂未设定任何附加数值属性。点击右上角“添加属性”建立卡片。
              </div>
            </section>
          </div>
        </div>
      </main>

      <!-- ==========================================
           通讯录导入角色 Modal 弹窗
           ========================================== -->
      <transition name="fade">
        <div
          v-if="isAddressBookOpen"
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        >
          <div
            class="bg-surface border border-outline-variant/35 rounded-lg max-w-xl w-full flex flex-col max-h-[80vh] shadow-2xl overflow-hidden animate-fade-in"
          >
            <!-- 头部 -->
            <div class="p-4 border-b border-outline-variant/20 bg-surface flex items-center justify-between">
              <h3 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
                <UsersIcon class="w-4 h-4 text-primary" />
                <span>从通讯录导入角色</span>
              </h3>
              <button
                @click="isAddressBookOpen = false"
                class="p-1 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <XIcon class="w-4 h-4" />
              </button>
            </div>

            <!-- 搜索框 -->
            <div class="p-3 bg-surface-low border-b border-outline-variant/15 flex items-center px-4">
              <SearchIcon class="w-4 h-4 text-on-surface-variant/60 mr-2" />
              <input
                v-model="addressBookSearchQuery"
                type="text"
                placeholder="输入姓名搜索通讯录角色..."
                class="bg-transparent border-none text-xs text-on-surface w-full focus:outline-none placeholder-on-surface-variant/45"
              />
            </div>

            <!-- 角色列表内容 (bg-surface-lowest 保证底色白皙清亮) -->
            <div class="flex-1 overflow-y-auto p-4 space-y-2.5 bg-surface-lowest">
              <div v-if="filteredAddressBookChars.length > 0" class="grid grid-cols-2 gap-3">
                <div
                  v-for="char in filteredAddressBookChars"
                  :key="char.id"
                  @click="toggleSelectAddressBookChar(char)"
                  class="p-3 rounded border flex items-center space-x-3 cursor-pointer transition-all active:scale-98 relative"
                  :class="[
                    selectedAddressBookCharIds.includes(char.id)
                      ? 'bg-primary/10 border-primary text-primary shadow-sm'
                      : 'bg-surface border-outline-variant/20 text-on-surface hover:border-primary/30 hover:bg-surface-low'
                  ]"
                >
                  <!-- 勾选标记小徽章 -->
                  <div
                    v-if="selectedAddressBookCharIds.includes(char.id)"
                    class="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center shadow-sm"
                  >
                    <CheckIcon class="w-2.5 h-2.5 text-on-primary" />
                  </div>

                  <!-- 圆形头像 -->
                  <div
                    class="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 border border-outline-variant/20 bg-surface shadow-inner"
                  >
                    <div
                      v-if="!char.avatar"
                      class="w-full h-full flex items-center justify-center font-bold text-white text-xs"
                      :style="{ background: getMorandiGradient(char.name) }"
                    >
                      {{ char.name ? char.name[0] : '?' }}
                    </div>
                    <img v-else :src="char.avatar" @error="char.avatar = ''" class="w-full h-full object-cover rounded-full" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <h4 class="text-xs font-bold truncate" :class="selectedAddressBookCharIds.includes(char.id) ? 'text-primary font-black' : 'text-on-surface'">
                      {{ char.name }}
                    </h4>
                    <p class="text-[9px] mt-0.5 truncate" :class="selectedAddressBookCharIds.includes(char.id) ? 'text-primary/75' : 'text-on-surface-variant/80'">
                      {{ char.folder_name }}
                    </p>
                  </div>
                </div>
              </div>

              <!-- 空搜索 -->
              <div v-else class="text-center py-12 text-xs text-on-surface-variant/65">
                未检索到任何符合搜索条件的角色档案。
              </div>
            </div>

            <!-- 底部确认导入操作栏 -->
            <div class="p-4 border-t border-outline-variant/20 bg-surface flex items-center justify-between">
              <span class="text-[10px] text-on-surface-variant font-bold">
                已选：<span class="text-primary text-xs">{{ selectedAddressBookCharIds.length }}</span> / 7 个角色
              </span>
              <div class="flex items-center space-x-2.5">
                <button
                  type="button"
                  @click="isAddressBookOpen = false"
                  class="px-3.5 py-1.5 rounded border border-outline-variant/40 text-[10px] font-bold text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  @click="handleBatchImportFromAddressBook"
                  :disabled="selectedAddressBookCharIds.length === 0"
                  class="px-4 py-1.5 rounded text-[10px] font-bold shadow-sm transition-all cursor-pointer flex items-center gap-1"
                  :class="[
                    selectedAddressBookCharIds.length > 0
                      ? 'bg-primary text-on-primary hover:bg-primary-container'
                      : 'bg-surface-low border border-outline-variant/20 text-on-surface-variant/40 cursor-not-allowed'
                  ]"
                >
                  <span>确认导入</span>
                  <span v-if="selectedAddressBookCharIds.length > 0">({{ selectedAddressBookCharIds.length }})</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- ==========================================
           AI 生成设定/开局灵感输入 Modal 弹窗
           ========================================== -->
      <transition name="fade">
        <div 
          v-if="isCreativePromptOpen" 
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        >
          <div class="bg-surface border border-outline-variant/35 rounded-lg max-w-md w-full flex flex-col shadow-2xl overflow-hidden">
            <!-- 头部 -->
            <div class="p-4 border-b border-outline-variant/20 bg-surface flex items-center justify-between">
              <h3 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
                <SparklesIcon class="w-4 h-4 text-primary animate-pulse" />
                <span>AI 生成{{ creativePromptType === 'world' ? '世界设定' : '开局剧本' }}</span>
              </h3>
              <button 
                @click="isCreativePromptOpen = false" 
                class="p-1 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <XIcon class="w-4 h-4" />
              </button>
            </div>

            <!-- 输入区域 -->
            <div class="p-5 space-y-4">
              <div class="space-y-1.5 text-left">
                <label class="block text-[10px] text-on-surface-variant font-bold">
                  请输入你的一句话创作灵感描述：
                </label>
                <textarea 
                  v-model="creativePromptText"
                  rows="4" 
                  :placeholder="creativePromptType === 'world' ? '例如：一个被财阀控制的反乌托邦霓虹朋克世界，充斥着高科技低生活和人工智能暗流...' : '例如：玩家和抵抗组织正在突袭财阀的数据库，警报突然响起，防卫机器人被激活并包围了玩家...'" 
                  class="w-full px-3 py-2 text-xs rounded bg-surface border border-outline-variant/40 text-on-surface placeholder-on-surface-variant/45 focus:outline-none focus:border-primary resize-none leading-relaxed"
                ></textarea>
              </div>

              <!-- 操作按钮 -->
              <div class="flex items-center justify-end space-x-3 pt-2">
                <button 
                  type="button"
                  @click="isCreativePromptOpen = false"
                  class="px-3.5 py-1.5 rounded border border-outline-variant/40 text-xs font-bold text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button 
                  type="button"
                  @click="submitCreativePromptGenerate"
                  class="px-4 py-1.5 rounded bg-primary hover:bg-primary-container text-xs font-bold text-on-primary shadow-sm hover:shadow transition-all cursor-pointer flex items-center gap-1"
                >
                  <SparklesIcon class="w-3.5 h-3.5" />
                  <span>开始生成</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- ==========================================
           毛玻璃玻璃摩砂 Loading 遮罩
           ========================================== -->
      <transition name="fade">
        <div
          v-if="isProcessing"
          class="absolute inset-0 bg-background/60 backdrop-blur-md flex flex-col items-center justify-center z-50 text-center px-6"
        >
          <!-- 磨砂玻璃状态板 -->
          <div
            class="glass-panel border border-outline-variant/35 rounded-lg p-8 max-w-sm w-full shadow-2xl relative overflow-hidden"
          >
            <!-- 加载转圈 -->
            <div class="relative w-12 h-12 mx-auto mb-4 flex items-center justify-center">
              <Loader2Icon class="w-10 h-10 text-primary animate-spin" />
            </div>

            <h4 class="text-xs font-bold text-on-surface mb-2">正在设计构筑剧院空间</h4>
            <p
              class="text-[10px] text-on-surface-variant leading-relaxed min-h-[40px] flex items-center justify-center px-2"
            >
              {{ processStep }}
            </p>

            <!-- 如果是智能编织/卡片导入的分步加载状态 -->
            <div
              v-if="processSteps.length > 0"
              class="mt-5 space-y-2 border-t border-outline-variant/15 pt-4 text-left"
            >
              <div
                v-for="(step, idx) in processSteps"
                :key="idx"
                class="flex items-center space-x-2 text-[9px] transition-colors"
                :class="
                  idx === currentStepIndex
                    ? 'text-primary font-bold'
                    : idx < currentStepIndex
                      ? 'text-on-surface-variant/50 line-through'
                      : 'text-on-surface-variant/35'
                "
              >
                <!-- 步骤点 -->
                <div
                  class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  :class="
                    idx === currentStepIndex
                      ? 'bg-primary animate-ping'
                      : idx < currentStepIndex
                        ? 'bg-on-surface-variant/50'
                        : 'bg-outline-variant'
                  "
                ></div>
                <span>{{ step }}</span>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- ==========================================
           精美全局 Toast 提示浮窗 (苹果极简毛玻璃药丸设计)
           ========================================== -->
      <transition name="fade">
        <div 
          v-if="toastVisible" 
          class="fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-2 rounded-full bg-surface/90 backdrop-blur-md border border-outline-variant/35 text-[10px] font-bold text-on-surface shadow-xl flex items-center gap-1.5 max-w-sm text-center leading-relaxed"
        >
          <span class="text-primary">✨</span>
          <span class="whitespace-pre-line">{{ toastMessage }}</span>
        </div>
      </transition>

      <!-- ==========================================
           操作确认 Confirm 弹窗 (大主页面同款磨砂玻璃设计)
           ========================================== -->
      <transition name="fade">
        <div 
          v-if="confirmVisible" 
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        >
          <div class="bg-surface border border-outline-variant/35 rounded-lg max-w-xs w-full flex flex-col shadow-2xl overflow-hidden p-5 space-y-4 text-center">
            <h3 class="text-xs font-bold text-on-surface flex items-center justify-center gap-1.5">
              <AlertCircleIcon class="w-4 h-4 text-error" />
              <span>操作确认</span>
            </h3>
            <p class="text-[10px] text-on-surface-variant leading-relaxed">
              {{ confirmMessage }}
            </p>
            <div class="flex items-center justify-center space-x-3 pt-2">
              <button 
                type="button"
                @click="confirmVisible = false"
                class="px-3.5 py-1.5 rounded border border-outline-variant/40 text-[10px] font-bold text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors cursor-pointer"
              >
                取消
              </button>
              <button 
                type="button"
                @click="handleConfirmOk"
                class="px-4 py-1.5 rounded bg-error text-white hover:bg-error/90 text-[10px] font-bold shadow-sm transition-all cursor-pointer"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      </transition>

      <!-- ==========================================
           用户人设导入 Modal 弹窗
           ========================================== -->
      <transition name="fade">
        <div
          v-if="isUserProfileOpen"
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        >
          <div
            class="bg-surface border border-outline-variant/35 rounded-lg max-w-sm w-full flex flex-col shadow-2xl overflow-hidden animate-fade-in"
          >
            <!-- 头部 -->
            <div class="p-4 border-b border-outline-variant/20 bg-surface flex items-center justify-between">
              <h3 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
                <UsersIcon class="w-4 h-4 text-primary" />
                <span>导入用户人设</span>
              </h3>
              <button
                @click="closeUserProfileModal"
                class="p-1 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <XIcon class="w-4 h-4" />
              </button>
            </div>

            <!-- 人设列表 -->
            <div class="flex-1 overflow-y-auto p-4 space-y-2 bg-surface-lowest max-h-[300px]">
              <div
                v-for="profile in userProfiles"
                :key="profile.profileId"
                @click="importSingleUserProfile(profile)"
                class="p-3 rounded border border-outline-variant/20 bg-surface hover:border-primary/40 hover:bg-surface-low flex items-center space-x-3 cursor-pointer transition-all"
              >
                <!-- 头像 -->
                <div class="w-9 h-9 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 bg-surface shadow-inner border border-outline-variant/20">
                  <div
                    v-if="!profile.avatar"
                    class="w-full h-full flex items-center justify-center font-bold text-white text-xs"
                    :style="{ background: getMorandiGradient(profile.name) }"
                  >
                    {{ profile.name ? profile.name[0] : '?' }}
                  </div>
                  <img v-else :src="profile.avatar" @error="profile.avatar = ''" class="w-full h-full object-cover rounded-full" />
                </div>
                <!-- 信息 -->
                <div class="flex-1 min-w-0">
                  <h4 class="text-xs font-bold text-on-surface truncate">{{ profile.name }}</h4>
                  <p class="text-[9px] text-on-surface-variant/80 mt-0.5 truncate">
                    {{ profile.gender }} · {{ formatAge(profile.age || '未知') }}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>

      <!-- ==========================================
           已注册状态栏预设导入 Modal 弹窗
           ========================================== -->
      <transition name="fade">
        <div
          v-if="isImportPresetOpen"
          class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        >
          <div
            class="bg-surface border border-outline-variant/35 rounded-lg max-w-sm w-full flex flex-col shadow-2xl overflow-hidden animate-fade-in"
          >
            <!-- 头部 -->
            <div class="p-4 border-b border-outline-variant/20 bg-surface flex items-center justify-between">
              <h3 class="text-sm font-bold text-on-surface flex items-center gap-1.5">
                <FileJsonIcon class="w-4 h-4 text-primary" />
                <span>导入已注册状态栏</span>
              </h3>
              <button
                @click="isImportPresetOpen = false"
                class="p-1 rounded hover:bg-surface-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                <XIcon class="w-4 h-4" />
              </button>
            </div>

            <!-- 预设列表 -->
            <div class="flex-1 overflow-y-auto p-4 space-y-2 bg-surface-lowest max-h-[300px]">
              <div
                v-for="preset in presetList"
                :key="preset.id"
                @click="toggleSelectPreset(preset.id)"
                class="p-3 rounded border bg-surface hover:bg-surface-low flex items-center justify-between cursor-pointer transition-all"
                :class="[
                  selectedPresetIds.includes(preset.id)
                    ? 'border-primary bg-primary/5 hover:bg-primary/10'
                    : 'border-outline-variant/20'
                ]"
              >
                <div class="flex-1 min-w-0 pr-4">
                  <h4 class="text-xs font-bold text-on-surface flex items-center gap-1.5">
                    <span class="px-1 py-0.5 rounded text-[8px] font-mono leading-none bg-surface-high border border-outline-variant/20">
                      {{ preset.type === 'number' ? '数字' : '文本' }}
                    </span>
                    <span class="truncate text-on-surface">{{ preset.label }}</span>
                  </h4>
                  <p class="text-[9px] text-on-surface-variant/80 mt-1 truncate">
                    {{ preset.meaning || '暂无描述信息' }}
                  </p>
                </div>
                
                <!-- 复选框 -->
                <div
                  class="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors"
                  :class="[
                    selectedPresetIds.includes(preset.id)
                      ? 'border-primary bg-primary text-on-primary'
                      : 'border-outline-variant/45'
                  ]"
                >
                  <CheckIcon v-if="selectedPresetIds.includes(preset.id)" class="w-3 h-3 stroke-[3]" />
                </div>
              </div>

              <div
                v-if="presetList.length === 0"
                class="text-center py-8 text-[10px] text-on-surface-variant/60"
              >
                未检测到任何注册指标。请先在「设置 - 状态栏设置」中添加。
              </div>
            </div>

            <!-- 底部确认栏 -->
            <div class="p-3 border-t border-outline-variant/20 bg-surface flex items-center justify-end space-x-2.5">
              <button
                type="button"
                @click="isImportPresetOpen = false"
                class="px-3 py-1.5 rounded border border-outline-variant/35 text-[10px] font-bold text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                :disabled="selectedPresetIds.length === 0"
                @click="handleConfirmImportPresets"
                class="px-3 py-1.5 rounded text-[10px] font-bold transition-all cursor-pointer flex items-center gap-1"
                :class="[
                  selectedPresetIds.length === 0
                    ? 'bg-surface-low text-on-surface-variant/40 border border-outline-variant/15 cursor-not-allowed'
                    : 'bg-primary text-on-primary hover:bg-primary-container'
                ]"
              >
                <span>确认导入 ({{ selectedPresetIds.length }})</span>
              </button>
            </div>
          </div>
        </div>
      </transition>

    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
