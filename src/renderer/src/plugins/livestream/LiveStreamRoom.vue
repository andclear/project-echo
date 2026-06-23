<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed, watch } from 'vue';
import {
  XIcon,
  SendIcon,
  GiftIcon,
  CoinsIcon,
  MessageCircleIcon,
  TvIcon,
  UsersIcon,
  SparklesIcon,
  Loader2Icon,
  ApertureIcon,
  TrophyIcon,
  CheckCircle2Icon,
  PlayIcon,
  PauseIcon,
  DownloadIcon
} from 'lucide-vue-next';
import { Downloader, Parser, Player } from 'svga.lite';

const props = defineProps<{
  sessionId: string;
  host: any;
  theme: string;
  direction: string;
  vipCharacters: any[];
  hasMet: boolean;
  isMobile: boolean;
  userNickname: string;
  userAvatar: string;
  initialMessages?: any[];
}>();

const emit = defineEmits<{
  (e: 'exit'): void;
}>();

// 统一处理属性命名，防止 props.host.folderName 为 undefined 导致生图/图库加载报错
const hostFolderName = computed(() => props.host?.folder_name || props.host?.folderName || '');

// 直播间状态
const isLiveActive = ref(true);
const isPaused = ref(false);

// 主播详情及画师图集模态窗状态
const isHostDetailModalOpen = ref(false);
const totalGiftAmount = ref(0);
const expectedGifts = ref(5000);
const chatCount = ref(0);

// AI 生图控制变量
const isGeneratingImage = ref(false);
const tempBase64 = ref('');
const tempFilename = ref('');
const tempActiveArtist = ref('');
const isStyleConfirmed = ref(false);
const lockedArtist = ref('');
const tempActiveArtistName = ref('');
const lockedArtistName = ref('');

// AI 定制提示词及背景轮换变量
const showCustomPromptInput = ref(false);
const customPromptText = ref('');
const enableBackgroundRotation = ref(false);
let backgroundRotationIntervalId: any = null;

// 背景图和图集列表
const currentBackgroundFilename = ref('');
const currentBackgroundBase64 = ref('');
const galleryImages = ref<any[]>([]);
const isLoadingGallery = ref(false);

// 亮暗色模式检测与实时监听
const isDarkTheme = ref(false);
let themeObserver: MutationObserver | null = null;

function togglePauseState() {
  isPaused.value = !isPaused.value;
  if (isPaused.value) {
    addSystemMessage('直播已暂停（AI 调用已停止）');
  } else {
    addSystemMessage('直播已恢复');
    startHostSpeechLoop();
  }
}

const localVipCharacters = ref<any[]>([...props.vipCharacters]);
const viewerCount = computed(() => localVipCharacters.value.length + 1);
const chatMessages = ref<any[]>([]);
const inputMessage = ref('');
const chatTextarea = ref<HTMLTextAreaElement | null>(null);

function adjustTextareaHeight() {
  if (chatTextarea.value) {
    chatTextarea.value.style.height = 'auto';
    chatTextarea.value.style.height = `${chatTextarea.value.scrollHeight}px`;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (isMentionMenuOpen.value && mentionCandidates.value.length > 0) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionMenuIndex.value = (mentionMenuIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length;
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionMenuIndex.value = (mentionMenuIndex.value + 1) % mentionCandidates.value.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selectMentionCandidate(mentionCandidates.value[mentionMenuIndex.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      isMentionMenuOpen.value = false;
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

const isMentionMenuOpen = ref(false);
const mentionSearchQuery = ref('');
const mentionMenuIndex = ref(0);

const mentionCandidates = computed(() => {
  const list = [props.host.name, ...localVipCharacters.value.map(v => v.name)];
  // 排除重复或未定义的空名字
  const filtered = list.filter((name, idx) => name && list.indexOf(name) === idx);
  if (!mentionSearchQuery.value) return filtered;
  return filtered.filter(name => name.toLowerCase().includes(mentionSearchQuery.value.toLowerCase()));
});

function selectMentionCandidate(name: string) {
  if (!chatTextarea.value) return;
  const textarea = chatTextarea.value;
  const val = textarea.value;
  const cursor = textarea.selectionStart;
  
  const textBeforeCursor = val.slice(0, cursor);
  const lastAtIdx = textBeforeCursor.lastIndexOf('@');
  
  if (lastAtIdx !== -1) {
    const beforeAt = val.slice(0, lastAtIdx);
    const afterCursor = val.slice(cursor);
    
    inputMessage.value = `${beforeAt}@${name} ${afterCursor}`;
    isMentionMenuOpen.value = false;
    
    nextTick(() => {
      const newCursorPos = lastAtIdx + name.length + 2; // +1 for @, +1 for space
      textarea.focus();
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      adjustTextareaHeight();
    });
  }
}

function handleInput(e: Event) {
  adjustTextareaHeight();
  
  const textarea = e.target as HTMLTextAreaElement;
  const val = textarea.value;
  const cursor = textarea.selectionStart;
  
  const textBeforeCursor = val.slice(0, cursor);
  const lastAtIdx = textBeforeCursor.lastIndexOf('@');
  
  if (lastAtIdx !== -1) {
    const searchRange = textBeforeCursor.slice(lastAtIdx + 1);
    // 限制 @ 检索，当遇到空格或字数较长时，不弹起菜单
    if (!searchRange.includes(' ') && searchRange.length <= 10) {
      isMentionMenuOpen.value = true;
      mentionSearchQuery.value = searchRange;
      mentionMenuIndex.value = Math.min(mentionMenuIndex.value, Math.max(0, mentionCandidates.value.length - 1));
      return;
    }
  }
  isMentionMenuOpen.value = false;
}

const isGiftDrawerOpen = ref(false);
const userWalletBalance = ref(1000);
const chatScrollContainer = ref<HTMLElement | null>(null);

// 用户资料与观众管理弹窗状态
const userAvatar = computed(() => props.userAvatar);
const isAudienceModalOpen = ref(false);
const isCustomizingAudience = ref(false);
const addressBookCharacters = ref<any[]>([]);
const selectedAudienceIds = ref<string[]>([]);

// 全局观众等级缓存 Map (所有直播间通用)
const characterLevels = ref<Record<string, number>>({});

// 排行榜前三名缓存 (用以绑定勋章)
const leaderboardTop3 = ref<string[]>([]);

// 礼物价格配表
const giftList = ref<Array<{ name: string; price: number; icon: string }>>([]);
const GIFT_ANIMATIONS: Record<string, 'gif' | 'svga'> = {
  '666': 'svga',
  '包包': 'svga',
  '天马': 'svga',
  '情书': 'gif',
  '比心': 'gif',
  '小花花': 'gif',
  '心动卡': 'gif',
  '摩天轮': 'gif',
  '告白花束': 'gif',
  '幸福马车': 'svga',
  '捏捏小脸': 'gif',
  '月桂皇冠': 'gif',
  '爱心气球': 'svga',
  '爱心直升机': 'svga',
  '爱的乐章': 'gif',
  '爱的漂流瓶': 'svga',
  '牛哇牛哇': 'gif',
  '紫色城堡': 'svga',
  '紫色玫瑰': 'svga',
  '红色跑车': 'svga',
  '超级火箭': 'svga'
};

// 动画播放器状态
let svgaDownloader: Downloader | null = null;
let svgaParser: Parser | null = null;
let svgaPlayer: Player | null = null;
const isSvgaPlaying = ref(false);
const svgaCanvasRef = ref<HTMLCanvasElement | null>(null);

// GIF 局部特效气泡队列
const gifQueue = ref<Array<{ id: string; sender: string; giftName: string; gifUrl: string }>>([]);

// 氛围弹幕缓存与生成锁
let hostSpeechIntervalId: any = null;

// 自定义弹窗控制 (拒绝原生 Alert/Confirm)
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

// 奔现/特权弹窗
const isMeetModalOpen = ref(false);
const meetModalType = ref<'meet' | 'date'>('meet');
const currentMeetEvent = ref<{ targetName: string; type: 'meet' | 'date'; confirmed: boolean } | null>(null);

// 结算弹窗
const isSummaryModalOpen = ref(false);
const summaryData = ref<any>(null);

// 下播确认弹窗
const isConfirmCloseOpen = ref(false);

// 阻止约会确认弹窗
const isConfirmBlockOpen = ref(false);
const blockPartnerTempName = ref('');

// 贡献排行榜弹窗
const isLeaderboardModalOpen = ref(false);
const leaderboard = ref<any[]>([]);

// ── 直播间背景图及画师风格锁定逻辑 ──
const artistOptions = ref<any[]>([]);

// 加载画师串预设选项
async function loadArtistOptions() {
  try {
    console.log('[LiveStreamRoom] 正在从后端拉取可用画师风格别名列表...');
    const res = await window.api.invoke('livestream:get-artists');
    console.log('[LiveStreamRoom] 拉取画师列表返回结果:', res);
    if (res.success && res.list) {
      artistOptions.value = res.list;
    }
  } catch (e) {
    console.error('获取画师列表失败:', e);
  }
}

// 当画师选择框改变时，自动保存
async function onArtistChange() {
  const matched = artistOptions.value.find((item) => item.value === lockedArtist.value);
  lockedArtistName.value = matched ? matched.name : '';
  if (lockedArtist.value) {
    isStyleConfirmed.value = true;
  } else {
    isStyleConfirmed.value = false;
  }
  await saveSessionConfig();
  showToast(lockedArtist.value ? `已成功选择并锁定画风为：${lockedArtistName.value} 🎨` : '已清除锁定画风。');
}

// 保存直播间配置状态到数据库
async function saveSessionConfig() {
  try {
    await window.api.invoke('livestream:update-session-config', {
      sessionId: props.sessionId,
      lockedArtist: lockedArtist.value,
      lockedArtistName: lockedArtistName.value,
      enableBackgroundRotation: enableBackgroundRotation.value
    });
  } catch (e) {
    console.error('更新直播间配置状态失败:', e);
  }
}

// 初始化背景图与配置
async function initBackground() {
  // 加载画师列表
  loadArtistOptions();

  try {
    const configRes = await window.api.invoke('livestream:get-session-config', { sessionId: props.sessionId });
    if (configRes.success) {
      lockedArtist.value = configRes.lockedArtist || '';
      lockedArtistName.value = configRes.lockedArtistName || '';
      enableBackgroundRotation.value = !!configRes.enableBackgroundRotation;
      if (lockedArtist.value) {
        isStyleConfirmed.value = true;
      }
    }
  } catch (err) {
    console.error('初始化直播间配置失败:', err);
  }

  try {
    const res = await window.api.invoke('get-gallery-images', { 
      folderName: hostFolderName.value,
      sessionId: props.sessionId
    });
    if (res.success && res.images && res.images.length > 0) {
      // 默认将最新生成的一张图设为背景
      const latestImg = res.images[0];
      currentBackgroundFilename.value = latestImg.filename;
      
      const readRes = await window.api.invoke('read-image-media', {
        folderName: hostFolderName.value,
        mediaPath: latestImg.relativePath,
        sessionId: props.sessionId
      });
      if (readRes.success) {
        currentBackgroundBase64.value = readRes.base64;
      }
    }
  } catch (e) {
    console.error('初始化直播间背景图失败:', e);
  }
}

// 打开主播面板详情与图库弹窗
async function openHostDetailModal() {
  isHostDetailModalOpen.value = true;
  try {
    const res = await window.api.invoke('livestream:get-total-gifts', { sessionId: props.sessionId });
    if (res.success) {
      totalGiftAmount.value = res.total || 0;
    }
  } catch (e) {
    console.error('获取累计打赏金额失败:', e);
  }
  loadHostGallery();
}

// 加载历史专属图集
async function loadHostGallery() {
  isLoadingGallery.value = true;
  galleryImages.value = [];
  try {
    const res = await window.api.invoke('get-gallery-images', { 
      folderName: hostFolderName.value,
      sessionId: props.sessionId
    });
    if (res.success && res.images) {
      const list = res.images.map((img: any) => ({
        ...img,
        base64: ''
      }));
      galleryImages.value = list;
      
      // 异步载入图片的 base64
      list.forEach(async (img: any, idx: number) => {
        try {
          const readRes = await window.api.invoke('read-image-media', {
            folderName: hostFolderName.value,
            mediaPath: img.relativePath,
            sessionId: props.sessionId
          });
          if (readRes.success) {
            galleryImages.value[idx].base64 = readRes.base64;
          }
        } catch (err) {
          console.error(`加载图片 ${img.filename} 失败:`, err);
        }
      });
    }
  } catch (e) {
    console.error('载入主播历史图集失败:', e);
  } finally {
    isLoadingGallery.value = false;
  }
}

// 调用 AI 生图
async function generateBackground() {
  if (isGeneratingImage.value) return;
  
  // 清理上一轮的手动生图状态
  tempFilename.value = '';
  tempBase64.value = '';
  tempActiveArtist.value = '';
  tempActiveArtistName.value = '';
  
  isGeneratingImage.value = true;
  
  try {
    // 初始提示词拼装，男主播用 1boy，女主播用 1girl
    const genderPrompt = props.host.gender === '男' ? '1boy' : '1girl';
    const initialPrompt = `${genderPrompt}, streaming in live room, ${props.theme || 'sweet girl, smiling'}`;
    
    const res = await window.api.invoke('generate-novelai-image', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      prompt: initialPrompt,
      dimensions: { width: 832, height: 1216 },
      prefixType: 'drawing',
      sessionId: props.sessionId,
      isTemp: true, // 开启临时预览模式，防垃圾落盘
      excludeArtist: tempActiveArtist.value || undefined // 排除当前所用画风
    });
    
    if (res.success) {
      tempBase64.value = res.base64;
      tempActiveArtist.value = res.activeArtist || '';
      tempActiveArtistName.value = res.activeArtistName || '';
      
      const parts = res.relativePath.split('/');
      tempFilename.value = parts[parts.length - 1];
      
      showToast('临时画风背景生成成功！不满意可重新生成，满意请确定画风。🎨');
    } else {
      showToast(`AI生图失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`AI生图异常: ${e.message || String(e)}`);
  } finally {
    isGeneratingImage.value = false;
  }
}

// 确认画风，将当前临时图设为正式背景并锁定画师串
async function confirmStyle() {
  if (!tempBase64.value || !tempFilename.value) return;
  
  try {
    const res = await window.api.invoke('confirm-novelai-image', {
      folderName: hostFolderName.value,
      sessionId: props.sessionId,
      tempFilename: tempFilename.value
    });

    if (res.success) {
      // 锁定当前画师串，确保该直播间后续自动生图的画风完全统一
      lockedArtist.value = tempActiveArtist.value;
      lockedArtistName.value = tempActiveArtistName.value;
      
      currentBackgroundFilename.value = res.filename;
      currentBackgroundBase64.value = tempBase64.value; // 正式应用为当前直播间背景
      isStyleConfirmed.value = true;
      
      // 保存到数据库
      saveSessionConfig();

      // 清除临时标记
      tempFilename.value = '';
      tempBase64.value = '';
      tempActiveArtist.value = '';
      tempActiveArtistName.value = '';
      
      showToast('已锁定此画风风格，成功设为最新直播背景！🎨');
      loadHostGallery();
    } else {
      showToast(`锁定画风失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`确定画风异常: ${e.message || String(e)}`);
  }
}

// 在历史图集里点击切换背景图
async function selectBackgroundFromGallery(img: any) {
  currentBackgroundFilename.value = img.filename;
  if (img.base64) {
    currentBackgroundBase64.value = img.base64;
  } else {
    try {
      const readRes = await window.api.invoke('read-image-media', {
        folderName: hostFolderName.value,
        mediaPath: img.relativePath,
        sessionId: props.sessionId
      });
      if (readRes.success) {
        currentBackgroundBase64.value = readRes.base64;
      }
    } catch (e) {
      console.error('切换背景读取失败:', e);
    }
  }
  showToast('直播间背景图已成功切换！🎨');
}

// 下载/保存背景图片到本地
async function downloadBackgroundImg(img: any) {
  if (window.api && typeof window.api.invoke === 'function') {
    try {
      const res = await window.api.invoke('download-gallery-image', {
        folderName: hostFolderName.value,
        filename: img.filename,
        sessionId: props.sessionId
      });
      if (res.success) {
        showToast(`图片成功保存至：${res.savePath}`);
      } else if (res.error !== 'canceled') {
        showToast(`下载失败: ${res.error}`);
      }
    } catch (e) {
      console.error('Electron下载出错，尝试浏览器降级下载', e);
      webDownloadFallback(img);
    }
  } else {
    webDownloadFallback(img);
  }
}

function webDownloadFallback(img: any) {
  try {
    const base64Data = img.base64;
    if (!base64Data) {
      showToast('图片尚未加载完成，请稍后重试');
      return;
    }
    const a = document.createElement('a');
    a.href = base64Data;
    a.download = img.filename || 'download.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('下载已开始');
  } catch (e) {
    showToast('网页端下载失败');
    console.error(e);
  }
}

// 删除背景图片
async function deleteBackgroundImg(img: any) {
  try {
    const confirmDel = confirm('确定要物理删除这张背景图片吗？这会从您的电脑磁盘彻底删除！');
    if (!confirmDel) return;
    
    const res = await window.api.invoke('delete-gallery-image', {
      folderName: hostFolderName.value,
      filename: img.filename,
      sessionId: props.sessionId
    });
    
    if (res.success) {
      showToast('物理删除成功');
      
      const idx = galleryImages.value.findIndex(item => item.filename === img.filename);
      if (idx !== -1) {
        galleryImages.value.splice(idx, 1);
      }
      
      // 如果被删除的图恰好是当前正在渲染的背景，进行智能退回
      if (currentBackgroundFilename.value === img.filename) {
        if (galleryImages.value.length > 0) {
          const nextActiveIdx = Math.min(idx, galleryImages.value.length - 1);
          const nextActiveImg = galleryImages.value[nextActiveIdx];
          
          currentBackgroundFilename.value = nextActiveImg.filename;
          
          if (nextActiveImg.base64) {
            currentBackgroundBase64.value = nextActiveImg.base64;
          } else {
            const readRes = await window.api.invoke('read-image-media', {
              folderName: hostFolderName.value,
              mediaPath: nextActiveImg.relativePath,
              sessionId: props.sessionId
            });
            if (readRes.success) {
              currentBackgroundBase64.value = readRes.base64;
            }
          }
        } else {
          // 清空了，退回默认暗色背景
          currentBackgroundFilename.value = '';
          currentBackgroundBase64.value = '';
        }
      }
    } else {
      showToast(`删除失败: ${res.error}`);
    }
  } catch (e) {
    console.error('物理删除背景图异常:', e);
  }
}

// 每 20 条弹幕自动在后台静默触发一次场景绘图并更新背景
async function triggerSilentBackgroundDrawing() {
  try {
    const configRes = await window.api.invoke('get-novelai-config');
    if (!configRes.success || !configRes.config || !configRes.config.apiKey) {
      console.log('[LiveStream] 未检测到合法的 NovelAI 绘图配置（无 API Key），已跳过静默背景生图');
      return;
    }

    console.log('[LiveStream] 每20条弹幕触发后台静默场景绘图，正在提取上下文...');
    // 提取最近20条消息上下文并深拷贝去除 Vue Proxy 代理，防止 Electron IPC 结构化克隆报错
    const recent = JSON.parse(JSON.stringify(chatMessages.value.slice(-20)));
    
    const promptRes = await window.api.invoke('analyze-chat-image-prompt', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      recentMessages: recent
    });
    
    if (!promptRes.success || !promptRes.prompt) {
      console.warn('[LiveStream] 提取生图提示词失败:', promptRes.error);
      return;
    }
    
    console.log('[LiveStream] 提取生图提示词成功:', promptRes.prompt);
    
    // 调用生图接口，尺寸强制为 { width: 832, height: 1216 }
    // 使用刚才确定的画师串拼接或直接作为 overrideArtist 传递
    const drawRes = await window.api.invoke('generate-novelai-image', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      prompt: promptRes.prompt,
      dimensions: { width: 832, height: 1216 },
      prefixType: 'drawing',
      overrideArtist: lockedArtist.value || undefined,
      sessionId: props.sessionId
    });
    
    if (drawRes.success) {
      console.log('[LiveStream] 静默场景绘图成功！图片路径:', drawRes.relativePath);
      currentBackgroundFilename.value = drawRes.relativePath.split('/').pop() || '';
      currentBackgroundBase64.value = drawRes.base64;
      
      // 静默刷新一下图集列表
      loadHostGallery();
    } else {
      console.error('[LiveStream] 静默场景绘图生图失败:', drawRes.error);
    }
  } catch (e) {
    console.error('[LiveStream] 静默场景生图过程发生异常:', e);
  }
}

const isManualGeneratingImage = ref(false);
async function handleManualDrawing() {
  if (isManualGeneratingImage.value) return;
  isManualGeneratingImage.value = true;
  showToast('AI 正在分析直播间上下文并生成插画，请稍候... 🎨');
  try {
    // 提取最近20条消息上下文并深拷贝去除 Vue Proxy 代理，防止 Electron IPC 结构化克隆报错
    const recent = JSON.parse(JSON.stringify(chatMessages.value.slice(-20)));
    const promptRes = await window.api.invoke('analyze-chat-image-prompt', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      recentMessages: recent
    });
    
    if (!promptRes.success || !promptRes.prompt) {
      showToast(`提取生图提示词失败: ${promptRes.error || '大模型分析超时'}`);
      return;
    }
    
    showToast('提示词构思成功，AI 正在为您绘制插画... 🖌️');
    
    const drawRes = await window.api.invoke('generate-novelai-image', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      prompt: promptRes.prompt,
      dimensions: { width: 832, height: 1216 },
      prefixType: 'drawing',
      overrideArtist: lockedArtist.value || undefined,
      sessionId: props.sessionId
    });
    
    if (drawRes.success) {
      const filename = drawRes.relativePath.split('/').pop() || '';
      currentBackgroundFilename.value = filename;
      currentBackgroundBase64.value = drawRes.base64;
      showToast('场景插画生成成功，已应用为直播间背景！✨');
      loadHostGallery();
    } else {
      showToast(`生图服务返回失败: ${drawRes.error}`);
    }
  } catch (e: any) {
    showToast(`手动生图发生异常: ${e.message || String(e)}`);
  } finally {
    isManualGeneratingImage.value = false;
  }
}

async function openLeaderboard() {
  isLeaderboardModalOpen.value = true;
  try {
    const res = await window.api.invoke('livestream:get-leaderboard', { sessionId: props.sessionId });
    if (res.success) {
      leaderboard.value = res.leaderboard;
    }
  } catch (e) {
    console.error('加载排行榜失败:', e);
  }
}

// 观众管理弹窗控制方法
function openAudienceModal() {
  isAudienceModalOpen.value = true;
  isCustomizingAudience.value = false;
  selectedAudienceIds.value = localVipCharacters.value.map(c => c.id);
}

async function startCustomizeAudience() {
  isCustomizingAudience.value = true;
  try {
    const res = await window.api.invoke('get-characters');
    if (res.success && res.characters) {
      // 过滤掉当前主播本人
      const filtered = res.characters.filter((c: any) => c.id !== props.host.id);
      const enriched = [];
      for (const char of filtered) {
        let avatarUrl = '';
        try {
          avatarUrl = await window.api.invoke('get-character-avatar', char.folder_name);
        } catch (_) {}
        enriched.push({
          ...char,
          avatarUrl
        });
      }
      addressBookCharacters.value = enriched;
    }
  } catch (e) {
    console.error('加载通讯录角色失败:', e);
  }
}

function toggleAudienceSelection(charId: string) {
  const idx = selectedAudienceIds.value.indexOf(charId);
  if (idx >= 0) {
    selectedAudienceIds.value.splice(idx, 1);
  } else {
    if (selectedAudienceIds.value.length >= 3) {
      showToast('最多只能选择 3 个观众角色参与直播');
      return;
    }
    selectedAudienceIds.value.push(charId);
  }
}

async function confirmCustomAudience() {
  try {
    const newVips = [];
    for (const id of selectedAudienceIds.value) {
      const char = addressBookCharacters.value.find(c => c.id === id);
      if (char) {
        newVips.push({
          id: char.id,
          name: char.name,
          folderName: char.folder_name,
          avatar: char.avatarUrl,
          gender: char.gender || '未知'
        });
      } else {
        const oldVip = localVipCharacters.value.find(c => c.id === id);
        if (oldVip) {
          newVips.push({ ...oldVip });
        }
      }
    }
    
    const res = await window.api.invoke('livestream:update-session-vips', {
      sessionId: props.sessionId,
      hostFolderName: hostFolderName.value,
      vips: newVips
    });
    
    if (res.success) {
      localVipCharacters.value = res.vips || newVips;
      isAudienceModalOpen.value = false;
      showToast('成功更新直播间观众名单！');
      loadRankings();
    } else {
      showToast(`更新观众失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`保存异常: ${e.message || e}`);
  }
}

async function changeVipGender(vipId: string, newGender: string) {
  try {
    const updatedVips = localVipCharacters.value.map(v => {
      if (v.id === vipId) {
        return { ...v, gender: newGender };
      }
      return v;
    });
    
    const res = await window.api.invoke('livestream:update-session-vips', {
      sessionId: props.sessionId,
      hostFolderName: hostFolderName.value,
      vips: JSON.parse(JSON.stringify(updatedVips))
    });
    
    if (res.success) {
      localVipCharacters.value = updatedVips;
      showToast(`成功更新观众性别为 [${newGender}]！`);
    } else {
      showToast(`保存性别失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`修改性别异常: ${e.message || e}`);
  }
}

onMounted(() => {
  // 检测并监听亮暗色主题模式
  isDarkTheme.value = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
  themeObserver = new MutationObserver(() => {
    isDarkTheme.value = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  svgaDownloader = new Downloader();
  svgaParser = new Parser();
  
  // 启动静默并发预下载与反序列化解析任务，防播放延迟（移动端禁用，防止大内存占用导致浏览器 OOM 崩溃重启刷新）
  if (!props.isMobile) {
    preloadSvgaEffects();
  }
  
  loadGifts();
  loadMeetStatus();
  loadUserProfile();
  loadRankings();
  initBackground();

  if (props.initialMessages && props.initialMessages.length > 0) {
    chatMessages.value = [...props.initialMessages];
    scrollToBottom();
    // 仅开启主播主动发言轮询定时器，不需要再次欢迎和触发开场白
    startHostSpeechLoop();
  } else {
    // 添加首条系统欢迎弹幕
    addSystemMessage(`欢迎来到 ${props.host.name} 的直播间！这里主打温馨互动，请文明发言～`);
    
    // 开启主播主动发言轮询定时器
    startHostSpeechLoop();

    // 欢迎弹幕添加后，延迟 1.5 秒自动触发主播的连线开场白发言
    setTimeout(() => {
      if (isLiveActive.value) {
        makeNpcChatAction(props.host.id, true);
      }
    }, 1500);
  }
});

onBeforeUnmount(async () => {
  isLiveActive.value = false;
  if (hostSpeechIntervalId) clearInterval(hostSpeechIntervalId);
  if (backgroundRotationIntervalId) {
    clearInterval(backgroundRotationIntervalId);
    backgroundRotationIntervalId = null;
  }
  if (svgaPlayer) {
    try { svgaPlayer.destroy(); } catch (_) {}
  }
  // 清理主题监听器
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
  // 异步通知后端离开直播间，清空当前活跃会话状态，防止残留的异步调用被处理
  try {
    await window.api.invoke('livestream:leave-session', { sessionId: props.sessionId });
  } catch (err) {
    console.error('通知后端离开直播间失败:', err);
  }
});

// ── 背景图随机轮播及定时器管理 ──
function startBackgroundRotationTimer() {
  if (backgroundRotationIntervalId) {
    clearInterval(backgroundRotationIntervalId);
  }
  backgroundRotationIntervalId = setInterval(async () => {
    if (!isLiveActive.value || isPaused.value || !enableBackgroundRotation.value) return;
    await rotateBackground();
  }, 3 * 60 * 1000); // 每 3 分钟轮换一次
  console.log('[LiveStream] 已开启背景图每3分钟轮换定时器。');
}

function stopBackgroundRotationTimer() {
  if (backgroundRotationIntervalId) {
    clearInterval(backgroundRotationIntervalId);
    backgroundRotationIntervalId = null;
    console.log('[LiveStream] 已停止背景图轮换定时器。');
  }
}

async function rotateBackground() {
  if (galleryImages.value.length <= 1) return;
  
  // 随机挑选非当前背景图
  const otherImages = galleryImages.value.filter(
    (img) => img.filename !== currentBackgroundFilename.value
  );
  if (otherImages.length === 0) return;
  
  const randomIndex = Math.floor(Math.random() * otherImages.length);
  const nextImg = otherImages[randomIndex];
  
  await selectBackgroundFromGallery(nextImg);
  console.log(`[LiveStream] 背景图定时轮换，切换至: ${nextImg.filename}`);
}

watch(enableBackgroundRotation, (newVal) => {
  if (newVal) {
    startBackgroundRotationTimer();
  } else {
    stopBackgroundRotationTimer();
  }
  saveSessionConfig();
});

// ── 自然语言定制生图 ──
async function startCustomPromptDrawing() {
  if (!customPromptText.value.trim()) return;
  if (isGeneratingImage.value) return;

  isGeneratingImage.value = true;

  try {
    showToast('AI 正在构思和扩展绘图提示词，请稍候... 🧠');
    const promptRes = await window.api.invoke('generate-custom-image-prompt', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      userInput: customPromptText.value.trim()
    });

    if (!promptRes.success || !promptRes.prompt) {
      showToast(`提示词构思失败: ${promptRes.error || '未知错误'}`);
      return;
    }

    console.log('[LiveStream] AI 定制背景提示词扩展成功:', promptRes.prompt);

    const res = await window.api.invoke('generate-novelai-image', {
      characterId: props.host.id,
      folderName: hostFolderName.value,
      prompt: promptRes.prompt,
      dimensions: { width: 832, height: 1216 },
      prefixType: 'drawing',
      sessionId: props.sessionId,
      overrideArtist: lockedArtist.value || undefined
    });

    if (res.success) {
      const parts = res.relativePath.split('/');
      const filename = parts[parts.length - 1];

      // 直接应用为当前背景
      currentBackgroundFilename.value = filename;
      currentBackgroundBase64.value = res.base64;

      showToast('AI 定制背景图生成成功，已应用为直播背景！🎨');
      showCustomPromptInput.value = false;
      customPromptText.value = '';
      
      // 刷新图集
      loadHostGallery();
    } else {
      showToast(`AI生图失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`定制生图异常: ${e.message || String(e)}`);
  } finally {
    isGeneratingImage.value = false;
  }
}

function startHostSpeechLoop() {
  if (hostSpeechIntervalId) clearInterval(hostSpeechIntervalId);
  hostSpeechIntervalId = setInterval(async () => {
    if (!isLiveActive.value || isPaused.value) return;
    
    // 自嗨拦截：如果最后一条发言已经是主播自己，则不需要在无弹幕冷场时反复絮叨
    const lastMsg = chatMessages.value[chatMessages.value.length - 1];
    if (lastMsg && lastMsg.senderName === props.host.name) {
      return;
    }
    
    await makeNpcChatAction(props.host.id, true);
  }, 60000);
}

function loadGifts() {
  // 将礼物以升序价值排列
  const fallbackList = Object.entries({
    '比心': 9, '心动卡': 9, '小花花': 19, '月桂皇冠': 25, '捏捏小脸': 29, 
    '告白花束': 52, '牛哇牛哇': 66, '情书': 99, '摩天轮': 99, '爱的漂流瓶': 199,
    '爱心直升机': 1999, '天马': 999, '包包': 2999, '幸福马车': 1314, '爱心气球': 1314,
    '爱的乐章': 520, '紫色玫瑰': 520, '紫色城堡': 5200, '红色跑车': 8888, '超级火箭': 19999,
    '666': 666
  }).map(([name, price]) => {
    // 获取 png 静态图标 URL
    const icon = `./gifts/${name}.png`;
    return { name, price, icon };
  }).sort((a, b) => a.price - b.price);

  giftList.value = fallbackList;
}

async function loadUserProfile() {
  try {
    const bal = await window.api.invoke('get-user-profile');
    if (bal && bal.success && bal.profile) {
      if (typeof bal.profile.walletBalance === 'number') {
        userWalletBalance.value = bal.profile.walletBalance;
      }
    }
  } catch (e) {
    console.error('加载用户资料失败:', e);
  }
}

async function loadRankings() {
  try {
    const res = await window.api.invoke('livestream:get-leaderboard', { sessionId: props.sessionId });
    if (res.success && res.leaderboard.length >= 3) {
      leaderboardTop3.value = res.leaderboard.slice(0, 3).map((l: any) => l.name);
    }
    // 打赏排行更新时，自动同步拉取所有角色的最新通用等级
    await loadUserLevels();
  } catch (e) {
    console.error('加载前三名及等级失败:', e);
  }
}

async function loadUserLevels() {
  try {
    const res = await window.api.invoke('livestream:get-all-user-levels', { hostName: props.host.name });
    if (res.success && res.levels) {
      const map: Record<string, number> = {};
      for (const item of res.levels) {
        map[item.name] = item.level;
      }
      characterLevels.value = map;
      console.log('[LiveStream] 前端已同步等级映射 Map:', JSON.stringify(map));
    }
  } catch (e) {
    console.error('加载全局用户等级失败:', e);
  }
}

function getMemberLevel(msg: { role: string; senderName: string }): number {
  if (msg.role === 'assistant') {
    return 0;
  }
  if (msg.role === 'user') {
    const currentNameVal = characterLevels.value[msg.senderName];
    const propNameVal = characterLevels.value[props.userNickname];
    const defaultUserVal = characterLevels.value['用户'];
    const defaultUserEng = characterLevels.value['user'];
    return currentNameVal || propNameVal || defaultUserVal || defaultUserEng || 1;
  }
  return characterLevels.value[msg.senderName] || 1;
}

const latestHostSpeech = computed(() => {
  const hostMsgs = chatMessages.value.filter(m => m.role === 'assistant');
  if (hostMsgs.length > 0) {
    return hostMsgs[hostMsgs.length - 1].content;
  }
  return '';
});

function addSystemMessage(text: string) {
  chatMessages.value.push({
    id: `sys_${Date.now()}`,
    senderName: '系统',
    role: 'system',
    content: text,
    timestamp: Date.now()
  });
  scrollToBottom();
}

async function addChatMessage(msg: { senderName: string; role: 'user' | 'assistant' | 'vip' | 'system'; content: string; innerThought?: string; giftName?: string; giftValue?: number }) {
  try {
    let finalSender = msg.senderName;
    if (!finalSender || !finalSender.trim()) {
      if (msg.role === 'assistant') {
        finalSender = props.host.name;
      } else if (msg.role === 'user') {
        finalSender = props.userNickname || '用户';
      } else if (msg.role === 'system') {
        finalSender = '系统';
      } else {
        finalSender = '嘉宾';
      }
    }

    const res = await window.api.invoke('livestream:send-message', {
      sessionId: props.sessionId,
      characterId: props.host.id,
      role: msg.role,
      senderName: finalSender,
      content: msg.content,
      innerThought: msg.innerThought,
      giftName: msg.giftName,
      giftValue: msg.giftValue
    });

    if (res.success) {
      chatMessages.value.push(res.message);
      scrollToBottom();
      
      if (msg.role !== 'system' && msg.senderName !== '系统') {
        chatCount.value++;
        // 自动生图门槛：累计非系统消息达到 20 条时，触发自动场景生图
        if (chatCount.value > 0 && chatCount.value % 20 === 0) {
          console.log(`[LiveStream] 触发自动场景绘图。原因: 累计发言达到 ${chatCount.value} 条`);
          triggerSilentBackgroundDrawing();
        }
      }
    }
  } catch (e) {
    console.error('发送弹幕存盘失败:', e);
  }
}

function insertMention(name: string) {
  if (name === props.userNickname || name === '系统' || name === '系统消息') return;
  inputMessage.value = `${inputMessage.value}@${name} `.trimStart();
  nextTick(() => {
    if (chatTextarea.value) {
      chatTextarea.value.focus();
      adjustTextareaHeight();
    }
  });
}

async function sendMessage() {
  if (!inputMessage.value.trim()) return;
  if (isPaused.value) {
    showToast('当前直播已暂停，请先恢复播放');
    return;
  }
  const userText = inputMessage.value;
  inputMessage.value = '';
  
  if (chatTextarea.value) {
    chatTextarea.value.style.height = 'auto';
  }

  // 1. 发送用户发言入列
  await addChatMessage({
    senderName: props.userNickname,
    role: 'user',
    content: userText
  });

  // 重置自动说话定时器
  startHostSpeechLoop();

  // 2. 主播及 3 位 VIP 观众作出智能回应
  triggerNpcReactions();
}

async function triggerNpcReactions() {
  // 获取当前最新弹幕（即刚才用户或其他人发送的那条）
  const lastUserMsg = chatMessages.value[chatMessages.value.length - 1];
  const lastContent = lastUserMsg ? lastUserMsg.content || '' : '';

  // 检查是否包含 @ 符号且真的有在场角色被 @ 了
  const hasAtSymbol = lastContent.includes('@');
  let isAnyRoleMentioned = false;

  if (hasAtSymbol) {
    const isHostMentioned = lastContent.includes(`@${props.host.name}`);
    const mentionedVips = localVipCharacters.value.filter(vip => lastContent.includes(`@${vip.name}`));

    if (isHostMentioned || mentionedVips.length > 0) {
      isAnyRoleMentioned = true;

      // 1. 如果主播被 @，触发且仅触发主播回应
      if (isHostMentioned) {
        await makeNpcChatAction(props.host.id, true);
      }

      // 2. 如果 VIP 观众被 @，触发且仅触发被 @ 的 VIP 观众回应
      for (const vip of mentionedVips) {
        setTimeout(async () => {
          if (!isLiveActive.value) return;
          await makeNpcChatAction(vip.id, false);
        }, Math.floor(1000 + Math.random() * 2000));
      }
    }
  }

  // 没有 @ 或者没有 @ 对中任何在场角色，则保持现状（触发主播回应，VIP有30%概率旁听搭话）
  if (!isAnyRoleMentioned) {
    // 1. 触发主播回应
    await makeNpcChatAction(props.host.id, true);

    // 2. 触发 VIP 观众旁听搭话
    for (const vip of localVipCharacters.value) {
      if (Math.random() < 0.3) {
        setTimeout(async () => {
          if (!isLiveActive.value) return;
          await makeNpcChatAction(vip.id, false);
        }, Math.floor(1000 + Math.random() * 2000)); // 延迟 1-3 秒
      }
    }
  }
}

// 用于保证所有 NPC（包括主播和所有 VIP）的 AI 发言与送礼调用均为串行排队执行的 Promise 链锁
let npcChatPromiseChain = Promise.resolve();

async function makeNpcChatAction(characterId: string, isHost: boolean) {
  return new Promise<void>((resolve) => {
    npcChatPromiseChain = npcChatPromiseChain.then(async () => {
      if (!isLiveActive.value) {
        resolve();
        return;
      }
      if (isPaused.value) {
        console.log('[LiveStream] 直播间当前已暂停，AI 调用已被拦截');
        resolve();
        return;
      }
      try {
        const charName = isHost ? props.host.name : localVipCharacters.value.find(v => v.id === characterId)?.name || '嘉宾';
        
        // 找出当前上下文的最后弹幕说话人作为互动目标（排除系统消息及发言角色自己）
        const nonSys = chatMessages.value.filter(m => m.senderName !== '系统' && m.senderName !== '系统消息' && m.senderName !== charName);
        const lastSpeaker = nonSys.length > 0 ? nonSys[nonSys.length - 1].senderName : (props.userNickname || '用户');

        const res = await window.api.invoke('livestream:chat-action', {
          sessionId: props.sessionId,
          characterId,
          isHost,
          senderName: lastSpeaker
        });

        if (!isLiveActive.value) {
          resolve();
          return;
        }

        if (res.success && res.data) {
          if (isHost) {
            startHostSpeechLoop();
          }
          const roleType = isHost ? 'assistant' : 'vip';

          await addChatMessage({
            senderName: charName,
            role: roleType,
            content: res.data.content,
            innerThought: res.data.innerThought
          });

          // 如果 VIP 角色有冲动送礼意图
          if (!isHost && res.data.giftName) {
            // 将 1.2s 后的延迟送礼动作一同放在锁内等待执行完毕，确保打赏消息能被后续 AI 正常读取
            await new Promise<void>((giftResolve) => {
              setTimeout(async () => {
                if (isLiveActive.value) {
                  await sendNpcGift(charName, res.data.giftName);
                }
                giftResolve();
              }, 1200);
            });
          }
        }
      } catch (e) {
        console.error('NPC发言生成失败:', e);
      } finally {
        resolve();
      }
    });
  });
}

async function sendNpcGift(npcName: string, giftName: string) {
  if (!isLiveActive.value) return;
  try {
    const res = await window.api.invoke('livestream:send-gift', {
      sessionId: props.sessionId,
      senderName: npcName,
      giftName,
      receiverName: props.host.name
    });

    if (!isLiveActive.value) return;

    if (res.success) {
      // 成功在前端模拟飘屏
      await addChatMessage({
        senderName: npcName,
        role: 'vip',
        content: `送出了【${giftName}】`,
        giftName,
        giftValue: res.giftValue
      });
      // 播放打赏特效
      playGiftEffect(npcName, giftName);
      loadRankings(); // 重计打赏榜
      await loadMeetStatus();

      // 根据礼物价值决定是代码直回还是唤醒 AI 感谢
      if (res.giftValue < 100) {
        const hostThankTexts = [
          `谢谢${npcName}送的${giftName}，破费啦～`,
          `哇，收到${npcName}的${giftName}了，感谢支持！`,
          `谢谢${npcName}的${giftName}，比心心～`,
          `收到${npcName}的礼物${giftName}啦，老板大气！`
        ];
        const thankText = hostThankTexts[Math.floor(Math.random() * hostThankTexts.length)];
        setTimeout(async () => {
          if (!isLiveActive.value) return;
          await addChatMessage({
            senderName: props.host.name,
            role: 'assistant',
            content: thankText
          });
        }, 800);
      } else {
        setTimeout(() => {
          if (isLiveActive.value) {
            triggerNpcReactions();
          }
        }, 1000);
      }
    }
  } catch (e) {
    console.error('NPC送礼失败:', e);
  }
}

async function sendUserGift(gift: any) {
  if (userWalletBalance.value < gift.price) {
    showToast('充值余额不足，打赏失败！');
    return;
  }

  isGiftDrawerOpen.value = false;
  
  try {
    const res = await window.api.invoke('livestream:send-gift', {
      sessionId: props.sessionId,
      senderName: props.userNickname,
      giftName: gift.name,
      receiverName: props.host.name
    });

    if (res.success) {
      userWalletBalance.value -= gift.price;
      
      await addChatMessage({
        senderName: props.userNickname,
        role: 'user',
        content: `送出了【${gift.name}】`,
        giftName: gift.name,
        giftValue: gift.price
      });

      playGiftEffect(props.userNickname, gift.name);
      loadRankings();
      await loadMeetStatus();

      // 检查是否触发了奔现或特权邀约弹窗
      if (res.triggerMeetEvent) {
        meetModalType.value = 'meet';
        isMeetModalOpen.value = true;
      } else if (res.triggerDateEvent) {
        meetModalType.value = 'date';
        isMeetModalOpen.value = true;
      }

      // 送完豪礼后触发主播感谢
      setTimeout(() => {
        if (isLiveActive.value) {
          triggerNpcReactions();
        }
      }, 1000);
    } else {
      showToast(`打赏失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`送礼异常: ${e.message || e}`);
  }
}

function playGiftEffect(sender: string, giftName: string) {
  const type = GIFT_ANIMATIONS[giftName] || 'gif';
  
  if (type === 'gif') {
    // 播放左侧 GIF 弹框
    const gifUrl = `./gifts/${giftName}.gif`;
    const effectId = `gif_${Date.now()}_${Math.random()}`;
    gifQueue.value.push({
      id: effectId,
      sender,
      giftName,
      gifUrl
    });
    // 3秒后移除
    setTimeout(() => {
      gifQueue.value = gifQueue.value.filter(g => g.id !== effectId);
    }, 4000);
  } else if (type === 'svga') {
    // 播放全屏 SVGA 大特效
    const svgaUrl = `./gifts/${giftName}.svga`;
    enqueueSvga(svgaUrl);
  }
}

// SVGA 预加载缓存和静默预载函数
const svgaCache = new Map<string, any>();

async function preloadSvgaEffects() {
  console.log('[SVGA Debug] 开始执行全局 SVGA 静默预加载任务...');
  const svgaGifts = Object.keys(GIFT_ANIMATIONS).filter(name => GIFT_ANIMATIONS[name] === 'svga');
  for (const name of svgaGifts) {
    const svgaUrl = `./gifts/${name}.svga`;
    console.log(`[SVGA Debug] 准备下载预载资源: ${name}, 计算 URL: ${svgaUrl}`);
    (async () => {
      try {
        if (svgaDownloader && svgaParser) {
          const fileData = await svgaDownloader.get(svgaUrl);
          console.log(`[SVGA Debug] 成功下载二进制文件: ${name}, 大小: ${fileData ? fileData.byteLength || fileData.size : '未知'}`);
          const svgaData = await svgaParser.do(fileData);
          svgaCache.set(svgaUrl, svgaData);
          console.log(`[SVGA Debug] 成功预载解析特效 [${name}] | FPS: ${svgaData.FPS} | 帧数: ${svgaData.frames}`);
        } else {
          console.warn('[SVGA Debug] 预载器或解析器尚未就绪');
        }
      } catch (err: any) {
        console.error(`[SVGA Debug] 预载解析礼物 [${name}] 发生异常:`, err);
      }
    })();
  }
}

// 物理播放队列处理 SVGA
const svgaQueue = ref<string[]>([]);
function enqueueSvga(url: string) {
  console.log('[SVGA Debug] 礼物压入播放队列，地址:', url);
  svgaQueue.value.push(url);
  if (!isSvgaPlaying.value) {
    playNextSvga();
  }
}

async function playNextSvga() {
  console.log('[SVGA Debug] playNextSvga 触发，当前队列长度:', svgaQueue.value.length);
  if (svgaQueue.value.length === 0 || !svgaCanvasRef.value) {
    console.log('[SVGA Debug] 播放队列为空，或 Canvas 元素未挂载，结束播放流程');
    isSvgaPlaying.value = false;
    return;
  }

  isSvgaPlaying.value = true;
  const currentUrl = svgaQueue.value.shift()!;
  console.log('[SVGA Debug] 取出队列最前 SVGA 任务 URL:', currentUrl);
  
  try {
    // 1. 优先获取或下载 svgaData，以便利用其原始设计尺寸计算无畸变缩放比例
    let svgaData = svgaCache.get(currentUrl);
    if (svgaData) {
      console.log('[SVGA Debug] 预载缓存命中，直接使用解析好的数据');
    } else {
      console.log('[SVGA Debug] 预载缓存未命中，开始网络请求下载:', currentUrl);
      if (!svgaDownloader || !svgaParser) {
        throw new Error('网络下载器/解析器未初始化完毕');
      }
      const fileData = await svgaDownloader.get(currentUrl);
      console.log('[SVGA Debug] 实时网络下载成功，文件字节数:', fileData ? fileData.byteLength || fileData.size : '未知');
      svgaData = await svgaParser.do(fileData);
      console.log('[SVGA Debug] 实时数据解析成功，存入缓存');
      svgaCache.set(currentUrl, svgaData);
    }

    if (!svgaData) {
      throw new Error('SVGA 数据解析为空，无法播放');
    }

    // 2. 动态计算 Canvas 宽高，使其保持 SVGA 原始设计比例以防拉伸，并在全屏容器中绝对居中
    const canvas = svgaCanvasRef.value;
    if (canvas) {
      const containerWidth = canvas.parentElement?.clientWidth || window.innerWidth;
      const containerHeight = canvas.parentElement?.clientHeight || window.innerHeight;
      
      let canvasWidth = containerWidth;
      let canvasHeight = containerHeight;
      
      if (svgaData.videoSize && svgaData.videoSize.width && svgaData.videoSize.height) {
        const videoWidth = svgaData.videoSize.width;
        const videoHeight = svgaData.videoSize.height;
        const containerRatio = containerWidth / containerHeight;
        const videoRatio = videoWidth / videoHeight;
        
        console.log(`[SVGA Debug] 原始设计尺寸: width=${videoWidth}, height=${videoHeight}, 比例=${videoRatio}`);
        console.log(`[SVGA Debug] 容器可用尺寸: width=${containerWidth}, height=${containerHeight}, 比例=${containerRatio}`);
        
        if (containerRatio > videoRatio) {
          // 容器偏宽，以高度为基准缩放宽度
          canvasHeight = containerHeight;
          canvasWidth = containerHeight * videoRatio;
        } else {
          // 容器偏高，以宽度为基准缩放高度
          canvasWidth = containerWidth;
          canvasHeight = containerWidth / videoRatio;
        }
      }
      
      // 同步画布像素分辨率
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      
      // 同步 CSS 属性使其实际显示不拉伸，并绝对居中
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = '50%';
      canvas.style.top = '50%';
      canvas.style.transform = 'translate(-50%, -50%)';
      
      console.log(`[SVGA Debug] 已动态设为无拉伸视口: width=${canvas.style.width}, height=${canvas.style.height}`);
    } else {
      console.warn('[SVGA Debug] 警告：没有找到 Canvas DOM 实例！');
    }

    // 3. 销毁旧播放器以重置 WebGL 上下文，匹配新画布尺寸
    if (svgaPlayer) {
      console.log('[SVGA Debug] 发现旧播放器实例，正在销毁释放 WebGL 资源...');
      try {
        svgaPlayer.destroy();
      } catch (e) {
        console.error('[SVGA Debug] 销毁旧播放器失败:', e);
      }
      svgaPlayer = null;
    }

    // 4. 创建新播放器并指定 options.loop 限制，双重保险防无限循环
    if (canvas) {
      console.log('[SVGA Debug] 正在实例化新的 svga.lite Player...');
      svgaPlayer = new Player(canvas, undefined, { loop: 1, cacheFrames: false, intersectionObserverRender: false });
      console.log('[SVGA Debug] Player 实例化成功:', svgaPlayer);
    }

    if (!svgaPlayer) {
      throw new Error('SVGA 播放器实例化失败');
    }
    
    console.log('[SVGA Debug] 正在将数据 mount 进播放器中...');
    await svgaPlayer.mount(svgaData);
    console.log('[SVGA Debug] 数据 mount 完成');
    
    // 设置循环播放1遍（双重绑定确保非无限循环）
    svgaPlayer.loop = 1;
    svgaPlayer.set({ loop: 1 });
    
    if (svgaData.FPS && typeof svgaData.FPS === 'number' && svgaData.FPS > 0) {
      svgaPlayer.fps = svgaData.FPS;
      console.log('[SVGA Debug] 设定播放帧率为:', svgaPlayer.fps);
    } else {
      console.log('[SVGA Debug] 采用默认帧率播放');
    }

    console.log('[SVGA Debug] 正在启动播放 (start)...');
    svgaPlayer.start();
    console.log('[SVGA Debug] 播放已启动，等待渲染和 on("end") 事件...');
    
    const currentPlayer = svgaPlayer;
    currentPlayer.$on('end', () => {
      console.log('[SVGA Debug] 接收到播放结束事件 (end)');
      // 延迟 50 毫秒在下一个 Event Tick 销毁，避免在事件广播周期内自我销毁（Self-destruction）导致未捕获的渲染异常而重刷
      setTimeout(() => {
        try {
          currentPlayer.destroy();
          console.log('[SVGA Debug] 已成功在下一个事件周期销毁当前播放器并释放显存');
        } catch (e) {
          console.error('[SVGA Debug] 销毁当前播放器失败:', e);
        }
        if (svgaPlayer === currentPlayer) {
          svgaPlayer = null;
        }
      }, 50);
      
      setTimeout(() => {
        playNextSvga();
      }, 500);
    });
  } catch (err: any) {
    const errMsg = err.message || String(err);
    console.error('[SVGA Debug] 播放过程捕获致命异常:', err);
    // 直接弹窗给用户，清晰地看到报错原因
    showToast(`[SVGA 播放错误提示]: ${errMsg}`);
    
    isSvgaPlaying.value = false;
    if (svgaPlayer) {
      try {
        svgaPlayer.destroy();
      } catch (_) {}
      svgaPlayer = null;
    }
    playNextSvga();
  }
}

async function loadMeetStatus() {
  try {
    const res = await window.api.invoke('livestream:get-session-meet', { sessionId: props.sessionId });
    if (res.success) {
      currentMeetEvent.value = res.meetEvent;
      // 状态自愈：如果当前有针对主角（自己）且未确认的约会状态，且模态框未打开，则自动拉起确认模态框
      if (
        currentMeetEvent.value &&
        (currentMeetEvent.value.targetName === '用户' ||
         currentMeetEvent.value.targetName === 'Admin' ||
         currentMeetEvent.value.targetName === props.userNickname) &&
        currentMeetEvent.value.confirmed === false &&
        !isMeetModalOpen.value
      ) {
        meetModalType.value = currentMeetEvent.value.type;
        isMeetModalOpen.value = true;
      }
    }
  } catch (err) {
    console.error('[LiveStreamRoom] 获取约会状态失败:', err);
  }
}

async function confirmMeet(type: 'meet' | 'date') {
  isMeetModalOpen.value = false;
  try {
    const res = await window.api.invoke('livestream:confirm-meet-event', {
      sessionId: props.sessionId,
      type,
      confirmed: true
    });
    if (res.success) {
      showToast(type === 'meet' ? '奔现邀约达成！已写入约会记录' : '特权约会已解锁！');
      await loadMeetStatus();
    }
  } catch (e: any) {
    showToast(`确认失败: ${e.message || e}`);
  }
}

async function declineMeet(type: 'meet' | 'date') {
  isMeetModalOpen.value = false;
  try {
    const res = await window.api.invoke('livestream:confirm-meet-event', {
      sessionId: props.sessionId,
      type,
      confirmed: false
    });
    if (res.success) {
      showToast('已婉拒此次奔现邀约。');
      await loadMeetStatus();
    }
  } catch (e: any) {
    showToast(`拒绝失败: ${e.message || e}`);
  }
}

function blockMeetEvent() {
  if (!currentMeetEvent.value) return;
  blockPartnerTempName.value = currentMeetEvent.value.targetName;
  isConfirmBlockOpen.value = true;
}

async function confirmBlockMeetEvent() {
  isConfirmBlockOpen.value = false;
  try {
    const res = await window.api.invoke('livestream:block-meet-event', {
      sessionId: props.sessionId
    });
    if (res.success) {
      showToast('已阻止该奔现约会，他们已无法在此场直播中继续。');
      await loadMeetStatus();
    }
  } catch (e: any) {
    showToast(`阻止失败: ${e.message || e}`);
  }
}

function leaveSessionWithoutClose() {
  emit('exit');
}

function closeSessionRequest() {
  isConfirmCloseOpen.value = true;
}

async function confirmCloseSession() {
  isConfirmCloseOpen.value = false;
  isLoadingClose.value = true;
  
  try {
    const res = await window.api.invoke('livestream:close-session', {
      sessionId: props.sessionId
    });

    if (res.success) {
      isLiveActive.value = false;
      summaryData.value = {
        receivedAmount: res.receivedAmount,
        theme: props.theme
      };
      
      // 等待后端静默总结完毕的广播或直接在这里等待
      isSummaryModalOpen.value = true;
    } else {
      showToast(`下播失败: ${res.error}`);
    }
  } catch (e: any) {
    showToast(`下播异常: ${e.message || e}`);
  } finally {
    isLoadingClose.value = false;
  }
}

const isLoadingClose = ref(false);

function scrollToBottom() {
  nextTick(() => {
    if (chatScrollContainer.value) {
      chatScrollContainer.value.scrollTop = chatScrollContainer.value.scrollHeight;
    }
  });
  setTimeout(() => {
    if (chatScrollContainer.value) {
      chatScrollContainer.value.scrollTop = chatScrollContainer.value.scrollHeight;
    }
  }, 100);
}
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0 bg-[#0e0e0e] text-white overflow-hidden relative">
    
    <!-- 直播间背景图容器 -->
    <div class="absolute inset-0 z-0 pointer-events-none overflow-hidden bg-[#0e0e0e] flex justify-center">
      <img
        v-if="currentBackgroundBase64"
        :src="currentBackgroundBase64"
        class="h-full object-contain select-none"
      />
    </div>
    
    <!-- ── 1. 顶部直播间状态栏 ── -->
    <header 
      class="absolute top-0 left-0 right-0 z-30 bg-gradient-to-b from-black/80 to-transparent flex items-center justify-between pointer-events-auto animate-fade-in"
      :class="isMobile ? 'p-2' : 'p-4'"
    >
      <div
        @click="openHostDetailModal"
        class="flex items-center bg-black/40 backdrop-blur-md rounded-full border border-white/10 hover:bg-black/60 hover:border-white/20 transition-all cursor-pointer select-none"
        :class="isMobile ? 'px-2 py-1 space-x-1.5' : 'px-3 py-1.5 space-x-3'"
        title="点击查看主播详情与专属历史图库"
      >
        <div 
          class="rounded-full overflow-hidden border border-primary-fixed/30 flex-shrink-0"
          :class="isMobile ? 'w-6 h-6' : 'w-8 h-8'"
        >
          <img
            v-if="host.avatarUrl"
            :src="host.avatarUrl"
            class="w-full h-full object-cover"
          />
          <div v-else class="w-full h-full bg-primary/20 flex items-center justify-center font-bold text-xs">
            {{ host.name[0] }}
          </div>
        </div>
        <div class="flex flex-col min-w-0 pr-1">
          <span 
            class="font-black truncate leading-tight text-white"
            :class="isMobile ? 'text-[10px]' : 'text-xs'"
          >{{ host.name }}</span>
          <span 
            class="mt-0.5 leading-none font-bold"
            :class="isMobile ? 'text-[8px] text-[#4edea3]/90' : 'text-[9px] text-[#4edea3]'"
          >在线：{{ viewerCount }}人</span>
        </div>
        
        <!-- 播放/暂停控制按钮 -->
        <button
          @click.stop="togglePauseState"
          class="rounded-full text-white/70 hover:text-white hover:bg-white/15 transition-all cursor-pointer flex items-center justify-center flex-shrink-0"
          :class="isMobile ? 'w-5 h-5' : 'w-6 h-6'"
          :title="isPaused ? '恢复播放' : '暂停直播'"
        >
          <PlayIcon v-if="isPaused" class="fill-current text-[#4edea3]" :class="isMobile ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'" />
          <PauseIcon v-else class="text-white/80" :class="isMobile ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'" />
        </button>
      </div>

      <!-- VIP 观众列表 -->
      <div 
        class="flex items-center"
        :class="isMobile ? 'space-x-1.5' : 'space-x-3'"
      >
        <!-- 贡献榜单小气泡图标 -->
        <button
          @click="openLeaderboard"
          class="rounded-full bg-black/40 hover:bg-black/60 text-yellow-500 border border-white/10 hover:border-yellow-500/30 transition-all cursor-pointer flex items-center justify-center"
          :class="isMobile ? 'p-1' : 'p-1.5'"
          title="查看打赏贡献榜"
        >
          <TrophyIcon class="fill-current" :class="isMobile ? 'w-3.5 h-3.5' : 'w-3.5 h-3.5'" />
        </button>

        <div
          class="flex overflow-hidden cursor-pointer"
          :class="isMobile ? '-space-x-[14px]' : '-space-x-2.5'"
          @click="openAudienceModal"
          title="点击查看并自定义直播间观众角色"
        >
          <!-- VIP 观众头像组 -->
          <div
            v-for="vip in localVipCharacters"
            :key="vip.id"
            class="rounded-full overflow-hidden border border-white/20 bg-surface-container-high relative flex-shrink-0"
            :class="isMobile ? 'w-[22px] h-[22px]' : 'w-7 h-7'"
            :title="vip.name"
          >
            <img
              v-if="vip.avatar"
              :src="vip.avatar.startsWith('data:') ? vip.avatar : `data:image/png;base64,${vip.avatar}`"
              class="w-full h-full object-cover"
            />
            <div v-else class="w-full h-full flex items-center justify-center text-[9px] font-bold">
              {{ vip.name[0] }}
            </div>
          </div>

          <!-- 用户自己的人设头像 -->
          <div
            class="rounded-full overflow-hidden border border-white/20 bg-surface-container-high relative z-10 flex-shrink-0"
            :class="isMobile ? 'w-[22px] h-[22px]' : 'w-7 h-7'"
            :title="props.userNickname"
          >
            <img
              v-if="userAvatar"
              :src="userAvatar"
              class="w-full h-full object-cover"
            />
            <div v-else class="w-full h-full flex items-center justify-center text-[9px] font-bold">
              我
            </div>
          </div>
        </div>

        <button
          @click="leaveSessionWithoutClose"
          class="rounded-full bg-white/10 hover:bg-white/20 text-white/90 font-black tracking-wider transition-colors shadow-lg cursor-pointer"
          :class="isMobile ? 'px-2 py-1.5 text-[9px] mr-0.5' : 'mr-2 px-3.5 py-1.5 text-[11px]'"
        >
          离开
        </button>
        <button
          @click="closeSessionRequest"
          class="rounded-full bg-[#ba1a1a] hover:bg-[#ba1a1a]/80 text-white font-black tracking-wider transition-colors shadow-lg shadow-red-900/10 cursor-pointer"
          :class="isMobile ? 'px-2 py-1.5 text-[9px]' : 'px-3.5 py-1.5 text-[11px]'"
        >
          下播
        </button>
      </div>
    </header>

    <!-- ── 2. 直播主体视窗 ── -->
    <div
      class="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden transition-all duration-500"
      :class="currentBackgroundBase64 ? (isDarkTheme ? 'bg-black/30 backdrop-blur-[1px]' : '') : 'bg-gradient-to-b from-[#131313] to-[#050505]'"
    >
      <!-- 直播间精美氛围背景 -->
      <div v-if="!currentBackgroundBase64" class="absolute inset-0 opacity-15 pointer-events-none select-none">
        <div class="absolute inset-0 bg-radial-gradient from-[#4edea3]/25 via-transparent to-transparent"></div>
        <div class="w-full h-full flex items-center justify-center">
          <TvIcon class="w-48 h-48 text-[#4edea3] stroke-[0.3]" />
        </div>
      </div>



      <!-- SVGA 局域全屏大特效播放 Canvas -->
      <canvas
        v-show="isSvgaPlaying"
        ref="svgaCanvasRef"
        class="absolute z-[9999] pointer-events-none"
      ></canvas>

      <!-- GIF 局部特效展示区 (左侧悬浮飘窗) -->
      <div class="absolute left-4 bottom-[calc(35%+4rem)] z-30 pointer-events-none flex flex-col space-y-3 w-64 max-h-[40%] overflow-hidden">
        <TransitionGroup name="list">
          <div
            v-for="gif in gifQueue"
            :key="gif.id"
            class="flex items-center space-x-3 bg-black/60 backdrop-blur-sm border border-white/10 p-2.5 rounded-xl animate-slide-in pointer-events-auto"
          >
            <div class="flex-1 min-w-0">
              <span class="text-[10px] text-white/50 block font-medium">酷炫打赏</span>
              <p class="text-xs font-black truncate text-[#e5e2e1]">
                <span class="text-[#4edea3]">{{ gif.sender }}</span> 送出了礼物
              </p>
            </div>
            <div class="w-12 h-12 rounded-lg bg-black/20 flex-shrink-0 flex items-center justify-center overflow-hidden">
              <img :src="gif.gifUrl" class="w-10 h-10 object-contain" />
            </div>
          </div>
        </TransitionGroup>
      </div>

      <!-- 约会与奔现悬浮提示条 -->
      <div
        v-if="currentMeetEvent"
        class="absolute left-4 bottom-[calc(35%+1rem)] z-30 flex items-center space-x-2 bg-[#003824]/90 backdrop-blur-md border border-[#4edea3]/30 px-3 py-1.5 rounded-full text-xs text-white shadow-lg animate-fade-in pointer-events-auto select-none"
      >
        <span class="relative flex h-2 w-2">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#4edea3] opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-[#4edea3]"></span>
        </span>
        <span class="font-medium text-white/90">
          {{ host.name }} - {{ currentMeetEvent.targetName }}：计划{{ currentMeetEvent.type === 'meet' ? '线下奔现约会' : '亲密约会' }}
        </span>
        <button
          v-if="currentMeetEvent.targetName !== '用户' && currentMeetEvent.targetName !== props.userNickname"
          @click="blockMeetEvent"
          class="ml-2 hover:text-[#ffb3af] text-white/60 transition-colors p-0.5 rounded-full hover:bg-white/10 cursor-pointer"
          title="阻止此约会"
        >
          <XIcon class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- ── 3. 底部滚动弹幕列表 ── -->
      <div class="absolute inset-x-0 bottom-0 z-20 p-4 bg-gradient-to-t from-black/90 via-black/40 to-transparent flex flex-col justify-end max-h-[35%] pointer-events-auto">
        <div
          ref="chatScrollContainer"
          class="overflow-y-auto space-y-2 pr-1 min-h-0 max-h-full scrollbar-none"
        >
          <div
            v-for="msg in chatMessages"
            :key="msg.id"
            class="flex flex-col items-start"
          >
            <!-- 弹幕行 -->
            <div class="bg-black/35 backdrop-blur-sm border border-white/5 px-3 py-1.5 rounded-xl max-w-[85%] text-xs leading-relaxed break-all select-text">
              <!-- Rank Medal (前三名) -->
              <span
                v-if="msg.role !== 'system' && leaderboardTop3.includes(msg.senderName)"
                :class="[
                  'inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold text-white mr-1.5 align-middle scale-90 origin-left select-none',
                  leaderboardTop3[0] === msg.senderName ? 'bg-yellow-600' : leaderboardTop3[1] === msg.senderName ? 'bg-slate-400' : 'bg-amber-700'
                ]"
              >
                {{ leaderboardTop3[0] === msg.senderName ? '👑 榜一' : leaderboardTop3[1] === msg.senderName ? '🥈 榜二' : '🥉 榜三' }}
              </span>

              <!-- Level Badge -->
              <span
                v-if="msg.role !== 'system' && msg.senderName !== '系统' && msg.role !== 'assistant'"
                class="inline-flex items-center px-1 py-0.5 rounded bg-[#4edea3]/20 text-[#4edea3] text-[9px] font-black mr-1.5 align-middle scale-90 origin-left select-none"
              >
                Lv.{{ getMemberLevel(msg) }}
              </span>

              <!-- Sender Name -->
              <span
                :class="[
                  'font-black mr-2 cursor-pointer hover:underline align-middle',
                  msg.role === 'user' ? 'text-[#4edea3]' : msg.role === 'assistant' ? 'text-[#ffb3af]' : 'text-slate-300'
                ]"
                @click="insertMention(msg.senderName || (msg.role === 'assistant' ? props.host.name : msg.role === 'user' ? props.userNickname : '嘉宾'))"
              >
                {{ msg.senderName || (msg.role === 'assistant' ? props.host.name : msg.role === 'user' ? props.userNickname : '嘉宾') }}
              </span>
              
              <!-- Content -->
              <span class="font-medium text-white/90 align-middle">{{ msg.content }}</span>
            </div>
            

          </div>
        </div>
      </div>
    </div>

    <!-- ── 4. 底部输入 & 礼物控制栏 ── -->
    <footer class="relative min-h-16 py-2 px-4 bg-[#0a0a0a] border-t border-white/10 flex items-center justify-between z-30 flex-shrink-0">
      <!-- @ 提及候选人悬浮窗 -->
      <div
        v-if="isMentionMenuOpen && mentionCandidates.length > 0"
        class="absolute bottom-[90%] left-4 w-48 bg-[#181818]/95 backdrop-blur-md border border-white/10 rounded-xl shadow-2xl p-1.5 z-50 flex flex-col space-y-0.5 animate-fade-in max-h-48 overflow-y-auto scrollbar-none"
      >
        <div class="px-2 py-1 text-[10px] text-white/40 font-bold border-b border-white/5 mb-1">
          选择要提及的观众
        </div>
        <div
          v-for="(candidate, index) in mentionCandidates"
          :key="candidate"
          @click="selectMentionCandidate(candidate)"
          @mouseenter="mentionMenuIndex = index"
          :class="[
            'px-2 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all flex items-center justify-between',
            mentionMenuIndex === index 
              ? 'bg-[#4edea3]/20 text-[#4edea3]' 
              : 'text-white/80 hover:bg-white/5 hover:text-white'
          ]"
        >
          <span>@{{ candidate }}</span>
          <span v-if="candidate === props.host.name" class="text-[9px] px-1 py-0.5 rounded bg-rose-500/20 text-[#ffb3af] scale-90">主播</span>
          <span v-else class="text-[9px] px-1 py-0.5 rounded bg-[#4edea3]/15 text-[#4edea3] scale-90">VIP</span>
        </div>
      </div>

      <div class="flex-1 flex items-center bg-[#1c1b1b] rounded-xl px-3 py-2 border border-white/10 min-h-[38px]">
        <textarea
          ref="chatTextarea"
          v-model="inputMessage"
          class="flex-1 bg-transparent text-sm text-white focus:outline-none placeholder-white/30 resize-none max-h-24 min-h-[20px] h-5 py-0 scrollbar-none"
          placeholder="说点什么支持主播..."
          rows="1"
          @input="handleInput"
          @keydown="handleKeydown"
        ></textarea>
        <button
          @click="sendMessage"
          class="p-1 rounded-lg text-[#4edea3] hover:text-[#6ffbbe] transition-colors cursor-pointer flex items-center justify-center"
        >
          <SendIcon class="w-4 h-4" />
        </button>
      </div>

      <!-- 手动生图按钮 -->
      <button
        @click="handleManualDrawing"
        :disabled="isManualGeneratingImage"
        class="ml-3 w-[38px] h-[38px] p-0 rounded-xl bg-transparent hover:bg-white/5 text-[#4edea3] hover:text-[#6ffbbe] disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer flex-shrink-0 flex items-center justify-center"
        title="手动生成场景图"
      >
        <Loader2Icon v-if="isManualGeneratingImage" class="w-5 h-5 animate-spin" />
        <ApertureIcon v-else class="w-5 h-5" />
      </button>

      <button
        @click="isGiftDrawerOpen = true"
        class="ml-3 w-[38px] h-[38px] p-0 rounded-xl bg-transparent hover:bg-white/5 text-[#ff4d6d] hover:text-[#ff758f] transition-all cursor-pointer flex-shrink-0 flex items-center justify-center"
        title="打赏礼物"
      >
        <GiftIcon class="w-5 h-5" />
      </button>
    </footer>

    <!-- ── 5. 礼物滑出抽屉栏 ── -->
    <div
      v-if="isGiftDrawerOpen"
      class="fixed inset-0 z-50 flex flex-col justify-end bg-black/50"
      @click="isGiftDrawerOpen = false"
    >
      <div
        class="w-full bg-[#1c1b1b] border-t border-white/10 rounded-t-2xl max-h-[50%] p-5 flex flex-col select-none slide-up"
        @click.stop
      >
        <header class="flex items-center justify-between mb-4 flex-shrink-0">
          <span class="text-xs font-black text-on-surface-variant/60 flex items-center space-x-1.5">
            <CoinsIcon class="w-4 h-4 text-yellow-500" />
            <span>打赏礼物</span>
          </span>
          <button
            @click="isGiftDrawerOpen = false"
            class="p-1.5 rounded-lg text-white/50 hover:bg-white/10 transition-colors"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <!-- 礼物网格 (按价格升序排序) -->
        <div class="flex-1 overflow-y-auto grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-4 pr-1 mb-4 min-h-0">
          <div
            v-for="gift in giftList"
            :key="gift.name"
            @click="sendUserGift(gift)"
            class="relative flex flex-col items-center p-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/5 hover:border-[#4edea3]/40 transition-all duration-200 cursor-pointer text-center group"
          >
            <!-- SVGA 专属 "炫" 徽章 -->
            <span
              v-if="GIFT_ANIMATIONS[gift.name] === 'svga'"
              class="absolute -top-1 -right-1 z-10 px-1.5 py-0.5 rounded-tr-lg rounded-bl-lg bg-[#ff4d6d] text-[8px] font-black text-white leading-none scale-90 shadow-sm border border-white/10 animate-pulse"
            >
              炫
            </span>

            <div class="w-12 h-12 rounded-xl bg-[#fff0f3] border border-[#ffccd5]/40 flex items-center justify-center overflow-hidden mb-2 group-hover:scale-105 transition-transform duration-300">
              <img :src="gift.icon" class="w-10 h-10 object-contain" />
            </div>
            <span class="text-[11px] font-bold text-white truncate w-full mb-1">{{ gift.name }}</span>
            <div class="text-[10px] text-yellow-500 flex items-center justify-center space-x-0.5 font-bold">
              <span>{{ gift.price }}</span>
              <span>币</span>
            </div>
          </div>
        </div>

        <div class="border-t border-white/5 pt-4 flex items-center justify-between flex-shrink-0">
          <div class="text-xs flex items-center space-x-2">
            <span class="text-white/50">我的余额：</span>
            <span class="font-black text-[#4edea3] flex items-center space-x-1">
              <CoinsIcon class="w-3.5 h-3.5" />
              <span>{{ userWalletBalance }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 6. 奔现邀约与亲密特权弹窗 (自定义，非原生) ── -->
    <div
      v-if="isMeetModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
    >
      <div class="w-full max-w-sm rounded-2xl bg-[#1c1b1b] border border-white/10 p-6 text-center shadow-2xl scale-in">
        <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4 text-[#4edea3]">
          <SparklesIcon class="w-8 h-8 animate-pulse" />
        </div>
        
        <h3 class="text-base font-black mb-3">
          {{ meetModalType === 'meet' ? '线下奔现达成！' : '解锁亲密约会！' }}
        </h3>
        
        <p class="text-xs text-white/70 leading-relaxed mb-6">
          {{ meetModalType === 'meet' 
             ? `主播 ${host.name} 被你的慷慨打赏深深打动了，他向你发起了现实中见面的请求：“谢谢你一直以来的支持！我们找个机会在三次元见一面吧！”` 
             : `你已成功解锁了与 ${host.name} 的“现实更亲密特权约会”！他将会在以后的生活中，在现实中送你信物，邀请你开启更亲密的线上线下陪伴！`
          }}
        </p>

        <div class="flex space-x-3 justify-center">
          <button
            v-if="meetModalType === 'meet'"
            @click="declineMeet(meetModalType)"
            class="px-4 py-2 text-xs font-bold rounded-xl border border-white/10 hover:bg-white/5 transition-all cursor-pointer"
          >
            暂不考虑
          </button>
          <button
            @click="confirmMeet(meetModalType)"
            class="px-6 py-2 text-xs font-black text-[#003824] bg-[#4edea3] hover:bg-[#6ffbbe] rounded-xl transition-all shadow-sm cursor-pointer"
          >
            {{ meetModalType === 'meet' ? '欣然接受' : '好的' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── 主播详情及画师图集模态窗 ── -->
    <div
      v-if="isHostDetailModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm animate-fade-in select-none"
    >
      <div class="w-full max-w-2xl rounded-2xl bg-[#121212] border border-white/10 p-6 shadow-2xl overflow-hidden relative flex flex-col max-h-[85vh] text-white">
        <!-- 关闭按钮 -->
        <button
          @click="isHostDetailModalOpen = false"
          class="absolute top-4 right-4 text-white/50 hover:text-white transition-colors cursor-pointer"
        >
          <XIcon class="w-5 h-5" />
        </button>

        <!-- 顶部：名字、直播类型、打赏金额、期待礼物数额 -->
        <div class="flex items-start space-x-4 pb-4 border-b border-white/10">
          <div class="w-16 h-16 rounded-full overflow-hidden border-2 border-[#4edea3] flex-shrink-0">
            <img v-if="host.avatarUrl" :src="host.avatarUrl" class="w-full h-full object-cover" />
            <div v-else class="w-full h-full bg-primary/20 flex items-center justify-center font-bold text-xl">
              {{ host.name[0] }}
            </div>
          </div>
          <div class="flex-1 min-w-0 space-y-1">
            <div class="flex items-center space-x-2">
              <h2 class="text-lg font-black text-white truncate">{{ host.name }}</h2>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-[#4edea3]/20 text-[#4edea3] font-bold">主播</span>
            </div>
            <p class="text-xs text-white/60">直播类型：{{ direction || '情感' }}</p>
            <div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 sm:space-x-4 mt-2">
              <div class="text-xs text-white/80 flex flex-wrap items-center">
                <span class="text-white/40">已收打赏：</span>
                <span class="font-bold text-[#fc7c78]">{{ totalGiftAmount }} 回音币</span>
              </div>
              <div class="text-xs text-white/80 flex flex-wrap items-center">
                <span class="text-white/40">期待礼物：</span>
                <span class="font-bold text-[#4edea3]">{{ totalGiftAmount }} / {{ expectedGifts }} 回音币</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 下方主要内容：AI 生图及图库 -->
        <div class="flex-1 flex flex-col min-h-0 mt-4 overflow-y-auto pr-1">
          <!-- 画师风格选择区 -->
          <div class="mb-6 p-4 rounded-xl bg-white/5 border border-white/5 space-y-3 text-white">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-xs font-bold text-white flex items-center space-x-1.5">
                  <SparklesIcon class="w-3.5 h-3.5 text-[#4edea3]" />
                  <span>画师风格锁定配置</span>
                </h3>
                <p class="text-[10px] text-white/40 mt-0.5">
                  选择预设风格，后续场景生图将自动统一使用该风格画风。
                </p>
              </div>
            </div>
            
            <!-- 选择下拉框 -->
            <div class="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mt-1">
              <select 
                v-model="lockedArtist"
                @change="onArtistChange"
                class="bg-black/50 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#4edea3] w-full sm:max-w-sm cursor-pointer"
              >
                <option value="">-- 不指定锁定风格（默认随机轮换画师串） --</option>
                <option v-for="item in artistOptions" :key="item.value" :value="item.value">
                  {{ item.name }}
                </option>
              </select>
              <div v-if="lockedArtist" class="text-[10px] text-[#4edea3]/80 bg-[#4edea3]/10 px-2.5 py-1.5 rounded-lg flex items-center space-x-1 self-start sm:self-auto flex-shrink-0">
                <CheckCircle2Icon class="w-3.5 h-3.5 text-[#4edea3]" />
                <span>当前风格已锁定</span>
              </div>
            </div>
          </div>

          <!-- 专属历史图集 -->
          <div class="flex-1 flex flex-col min-h-0">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-xs font-bold text-white flex items-center space-x-1.5">
                <TvIcon class="w-3.5 h-3.5 text-white/60" />
                <span>专属历史图集</span>
              </h3>
              
              <div class="flex items-center space-x-3">
                <!-- 轮播背景勾选 -->
                <label class="flex items-center space-x-1 text-[11px] text-white/70 cursor-pointer select-none">
                  <input 
                    type="checkbox" 
                    v-model="enableBackgroundRotation" 
                    class="rounded border-white/20 bg-black/40 text-[#4edea3] focus:ring-0 focus:ring-offset-0 w-3 h-3 cursor-pointer"
                  />
                  <span>3分钟随机轮换</span>
                </label>
                
                <!-- 生图按钮 -->
                <button 
                  @click="showCustomPromptInput = !showCustomPromptInput" 
                  class="px-2 py-1 text-[10px] font-medium text-white bg-[#4edea3]/20 border border-[#4edea3]/40 hover:bg-[#4edea3] hover:text-black rounded transition-all flex items-center space-x-1 cursor-pointer"
                >
                  <SparklesIcon class="w-3 h-3" />
                  <span>AI定制背景</span>
                </button>
              </div>
            </div>

            <!-- 定制生图输入折叠面板 -->
            <div v-if="showCustomPromptInput" class="mb-4 p-3 bg-white/5 border border-white/10 rounded-xl space-y-3">
              <div class="text-[11px] text-white/80">
                请输入画面构想（支持中文，大模型会自动翻译为英文生图 Tag，不确定画风不会保存）：
              </div>
              <textarea 
                v-model="customPromptText"
                rows="2"
                class="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-[#4edea3] resize-none"
                placeholder="例如：穿着围裙在厨房里做美味的草莓蛋糕，脸上沾了点面粉，阳光照在发梢上..."
              ></textarea>
              <div class="flex justify-end space-x-2">
                <button 
                  @click="showCustomPromptInput = false"
                  class="px-2.5 py-1 text-[10px] text-white/60 hover:text-white bg-white/5 hover:bg-white/10 rounded transition-all cursor-pointer"
                >
                  取消
                </button>
                <button 
                  @click="startCustomPromptDrawing"
                  :disabled="isGeneratingImage || !customPromptText.trim()"
                  class="px-3 py-1 text-[10px] text-black bg-[#4edea3] hover:bg-[#6ffbbe] disabled:bg-white/10 disabled:text-white/40 rounded transition-all font-bold flex items-center space-x-1 cursor-pointer"
                >
                  <div v-if="isGeneratingImage" class="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
                  <span>开始定制生图</span>
                </button>
              </div>
            </div>
            
            <div v-if="isLoadingGallery" class="flex-1 py-10 flex flex-col items-center justify-center space-y-2">
              <div class="w-6 h-6 rounded-full border-2 border-white/30 border-t-white animate-spin"></div>
              <span class="text-[11px] text-white/40">加载图集列表中...</span>
            </div>
            <div v-else-if="galleryImages.length === 0" class="flex-1 py-10 text-center text-[11px] text-white/40 border border-dashed border-white/10 rounded-xl flex items-center justify-center">
              暂无已存背景，点击上方按钮开始生图吧
            </div>
            <div v-else class="grid grid-cols-3 gap-3 pr-1 pb-4">
              <div
                v-for="img in galleryImages"
                :key="img.filename"
                class="group relative aspect-[832/1216] rounded-lg overflow-hidden border border-white/10 bg-white/5 cursor-pointer hover:border-[#4edea3]/50 transition-all"
                @click="selectBackgroundFromGallery(img)"
              >
                <!-- 加载中的图片或者 base64 -->
                <img v-if="img.base64" :src="img.base64" class="w-full h-full object-cover" />
                <div v-else class="w-full h-full flex items-center justify-center bg-black/40">
                  <div class="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin"></div>
                </div>

                <!-- 选定标识 -->
                <div v-if="currentBackgroundFilename === img.filename" class="absolute inset-0 bg-[#4edea3]/10 border-2 border-[#4edea3] flex items-center justify-center">
                  <div class="bg-[#4edea3] text-[#003824] px-1.5 py-0.5 rounded text-[8px] font-black uppercase">
                    当前背景
                  </div>
                </div>

                <!-- 操作按钮组 -->
                <div class="absolute top-1.5 right-1.5 flex items-center space-x-1 z-10">
                  <!-- 下载按钮 -->
                  <button
                    @click.stop="downloadBackgroundImg(img)"
                    class="p-1 rounded bg-black/60 hover:bg-[#4edea3] hover:text-black text-white transition-all duration-200"
                    title="下载到本地"
                  >
                    <DownloadIcon class="w-3 h-3" />
                  </button>
                  <!-- 删除按钮 -->
                  <button
                    @click.stop="deleteBackgroundImg(img)"
                    class="p-1 rounded bg-black/60 hover:bg-rose-600 text-white transition-all duration-200"
                    title="删除背景图"
                  >
                    <XIcon class="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 7. 下播结算总结模态框 (结算全流程，自定义) ── -->
    <div
      v-if="isSummaryModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
    >
      <div class="w-full max-w-md rounded-2xl bg-[#1c1b1b] border border-white/10 p-6 shadow-2xl scale-in overflow-hidden relative">
        <div class="absolute inset-0 bg-gradient-to-br from-[#4edea3]/5 to-transparent pointer-events-none"></div>

        <div class="text-center mb-6">
          <div class="w-12 h-12 rounded-full bg-[#4edea3]/10 flex items-center justify-center mx-auto mb-3 text-[#4edea3]">
            <CheckCircle2Icon class="w-6 h-6" />
          </div>
          <h2 class="text-lg font-black">下播结算单</h2>
          <span class="text-[10px] text-white/40 block mt-1">直播会话已顺利结束并同步睡眠反思</span>
        </div>

        <div class="space-y-4 mb-6">
          <div class="p-4 rounded-xl bg-white/5 border border-white/5 space-y-3 text-xs">
            <div class="flex justify-between">
              <span class="text-white/60">直播主题</span>
              <span class="font-bold truncate max-w-[200px]">{{ summaryData?.theme }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-white/60">本次提现收益</span>
              <span class="font-black text-[#fc7c78]">{{ summaryData?.receivedAmount }} 回音币</span>
            </div>
            <div class="flex justify-between">
              <span class="text-white/60">财务扣减分成</span>
              <span class="text-white/40">已自动完成 50% 主播与平台钱包扣减</span>
            </div>
          </div>
        </div>

        <button
          @click="emit('exit')"
          class="w-full py-2.5 rounded-xl bg-[#4edea3] hover:bg-[#6ffbbe] text-[#003824] text-xs font-black text-center transition-all cursor-pointer"
        >
          返回直播大厅
        </button>
      </div>
    </div>

    <!-- ── 8. 下播确认弹窗 ── -->
    <div
      v-if="isConfirmCloseOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    >
      <div class="w-full max-w-xs rounded-2xl bg-[#1c1b1b] border border-white/10 p-5 text-center shadow-2xl scale-in">
        <h3 class="text-sm font-black mb-3">确定要结束直播吗？</h3>
        <p class="text-xs text-white/50 leading-relaxed mb-5">
          下播后，系统将自动发起本场直播的静默总结与睡眠反思日记，并执行钱包划扣。
        </p>
        
        <div class="flex space-x-3 justify-center">
          <button
            @click="isConfirmCloseOpen = false"
            class="px-4 py-2 text-xs font-bold rounded-xl border border-white/10 hover:bg-white/5 transition-all cursor-pointer"
          >
            继续播
          </button>
          <button
            @click="confirmCloseSession"
            class="px-5 py-2 text-xs font-black text-white bg-[#ba1a1a] hover:bg-[#ba1a1a]/80 rounded-xl transition-all shadow-sm cursor-pointer flex items-center space-x-1"
          >
            <Loader2Icon v-if="isLoadingClose" class="w-3.5 h-3.5 animate-spin" />
            <span>确认下播</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ── 9. 阻止约会确认弹窗 ── -->
    <div
      v-if="isConfirmBlockOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    >
      <div class="w-full max-w-xs rounded-2xl bg-[#1c1b1b] border border-white/10 p-5 text-center shadow-2xl scale-in">
        <div class="w-12 h-12 rounded-full bg-[#ba1a1a]/10 text-[#ffb4ab] flex items-center justify-center mx-auto mb-4 border border-[#ba1a1a]/20">
          <XIcon class="w-6 h-6" />
        </div>
        <h3 class="text-sm font-black mb-3">确定要阻止这次线下奔现吗？</h3>
        <p class="text-xs text-white/50 leading-relaxed mb-5">
          您真的要阻止 <strong class="text-white font-bold">{{ props.host?.name || '主播' }}</strong> 与 <strong class="text-[#ffb3af] font-bold">{{ blockPartnerTempName }}</strong> 的线下奔现亲密约会吗？
        </p>
        
        <div class="flex space-x-3 justify-center">
          <button
            @click="isConfirmBlockOpen = false"
            class="px-4 py-2 text-xs font-bold rounded-xl border border-white/10 hover:bg-white/5 transition-all cursor-pointer text-white/80 hover:text-white"
          >
            暂不阻止
          </button>
          <button
            @click="confirmBlockMeetEvent"
            class="px-5 py-2 text-xs font-black text-white bg-[#ba1a1a] hover:bg-[#ba1a1a]/80 rounded-xl transition-all shadow-sm cursor-pointer"
          >
            确认阻止
          </button>
        </div>
      </div>
    </div>

    <!-- ── 8.5. 观众管理与自定义勾选弹窗 (自定义，非原生) ── -->
    <div
      v-if="isAudienceModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      @click="isAudienceModalOpen = false"
    >
      <div
        class="w-full max-w-md rounded-2xl bg-[#1c1b1b] border border-white/10 p-5 shadow-2xl scale-in overflow-hidden relative text-white animate-fade-in"
        @click.stop
      >
        <header class="flex items-center justify-between pb-3 border-b border-white/10 mb-4">
          <span class="text-sm font-black flex items-center space-x-2 text-[#4edea3]">
            <UsersIcon class="w-4 h-4 fill-current" />
            <span>{{ isCustomizingAudience ? '自定义观众角色 (最多3个)' : '直播间观众名单' }}</span>
          </span>
          <button
            @click="isAudienceModalOpen = false"
            class="p-1 rounded-lg text-white/50 hover:bg-white/10 transition-colors cursor-pointer"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <!-- 1. 当前直播间观众展示视图 -->
        <div v-if="!isCustomizingAudience" class="space-y-4">
          <div class="max-h-[300px] overflow-y-auto pr-1 space-y-3 scrollbar-none">
            <!-- 玩家自己 -->
            <div class="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5">
              <div class="flex items-center space-x-3">
                <div class="w-9 h-9 rounded-full overflow-hidden bg-white/5 border border-white/10 flex-shrink-0">
                  <img v-if="userAvatar" :src="userAvatar" class="w-full h-full object-cover" />
                  <div v-else class="w-full h-full flex items-center justify-center text-[#4edea3] font-bold text-xs">我</div>
                </div>
                <div>
                  <div class="text-xs font-bold flex items-center space-x-1.5">
                    <span>{{ props.userNickname }}</span>
                    <span class="px-1 py-0.5 rounded bg-primary/20 text-[#4edea3] text-[8px] font-black scale-90">用户自己</span>
                  </div>
                </div>
              </div>
              <span class="text-[10px] text-white/40">已进入直播间</span>
            </div>

            <!-- VIP 观众们 -->
            <div
              v-for="vip in localVipCharacters"
              :key="vip.id"
              class="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5"
            >
              <div class="flex items-center space-x-3">
                <div class="w-9 h-9 rounded-full overflow-hidden bg-white/5 border border-white/10 flex-shrink-0">
                  <img v-if="vip.avatar" :src="vip.avatar.startsWith('data:') ? vip.avatar : `data:image/png;base64,${vip.avatar}`" class="w-full h-full object-cover" />
                  <div v-else class="w-full h-full flex items-center justify-center text-xs font-bold">{{ vip.name[0] }}</div>
                </div>
                <div>
                  <div class="text-xs font-bold flex items-center space-x-1.5">
                    <span>{{ vip.name }}</span>
                    <span class="px-1 py-0.5 rounded bg-slate-700 text-slate-300 text-[8px] scale-90 font-black">VIP 观众</span>
                    <select
                      :value="vip.gender || '未知'"
                      @change="(e) => changeVipGender(vip.id, (e.target as HTMLSelectElement).value)"
                      class="bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-[10px] border border-white/10 rounded px-1 py-0.5 outline-none cursor-pointer transition-colors"
                    >
                      <option value="未知" class="bg-[#1c1b1b]">未知</option>
                      <option value="男" class="bg-[#1c1b1b]">男</option>
                      <option value="女" class="bg-[#1c1b1b]">女</option>
                    </select>
                  </div>
                </div>
              </div>
              <span class="text-[10px] text-white/40">连线中</span>
            </div>
          </div>

          <div class="border-t border-white/5 pt-4 flex space-x-3">
            <button
              @click="startCustomizeAudience"
              class="flex-1 py-2.5 rounded-xl bg-[#4edea3]/10 hover:bg-[#4edea3]/20 text-[#4edea3] border border-[#4edea3]/20 text-xs font-black text-center transition-all cursor-pointer shadow-md"
            >
              自定义观众角色
            </button>
          </div>
        </div>

        <!-- 2. 自定义观众勾选视图 -->
        <div v-else class="space-y-4 animate-fade-in">
          <div v-if="addressBookCharacters.length === 0" class="py-12 text-center text-white/40 text-xs">
            正在加载通讯录角色名单...
          </div>
          
          <div v-else class="grid grid-cols-1 gap-2.5 max-h-[300px] overflow-y-auto pr-1 scrollbar-none">
            <div
              v-for="char in addressBookCharacters"
              :key="char.id"
              @click="toggleAudienceSelection(char.id)"
              :class="[
                'flex items-center justify-between p-2.5 rounded-xl border transition-all cursor-pointer',
                selectedAudienceIds.includes(char.id) 
                  ? 'bg-[#4edea3]/10 border-[#4edea3]/40 shadow-inner' 
                  : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/10'
              ]"
            >
              <div class="flex items-center space-x-3">
                <div class="w-9 h-9 rounded-full overflow-hidden bg-white/5 border border-white/10 flex-shrink-0">
                  <img v-if="char.avatarUrl" :src="char.avatarUrl.startsWith('data:') ? char.avatarUrl : `data:image/png;base64,${char.avatarUrl}`" class="w-full h-full object-cover" />
                  <div v-else class="w-full h-full flex items-center justify-center text-xs font-bold">{{ char.name[0] }}</div>
                </div>
                <span class="text-xs font-bold">{{ char.name }}</span>
              </div>

              <!-- Checkbox -->
              <div
                :class="[
                  'w-5 h-5 rounded-md border flex items-center justify-center bg-black/25 transition-all',
                  selectedAudienceIds.includes(char.id) ? 'border-[#4edea3] bg-[#4edea3]/20' : 'border-white/20'
                ]"
              >
                <CheckCircle2Icon v-if="selectedAudienceIds.includes(char.id)" class="w-4 h-4 text-[#4edea3]" />
              </div>
            </div>
          </div>

          <div class="text-[10px] text-white/40 text-center font-medium">
            提示：当前已勾选 {{ selectedAudienceIds.length }} 个角色 (最多 3 个)
          </div>

          <div class="border-t border-white/5 pt-4 flex space-x-3">
            <button
              @click="isCustomizingAudience = false"
              class="px-4 py-2.5 text-xs font-bold rounded-xl border border-white/10 hover:bg-white/5 transition-all cursor-pointer"
            >
              返回名单
            </button>
            <button
              @click="confirmCustomAudience"
              class="flex-1 py-2.5 rounded-xl bg-[#4edea3] hover:bg-[#6ffbbe] text-[#003824] text-xs font-black text-center transition-all cursor-pointer shadow-lg shadow-green-950/15"
            >
              确认并更新观众
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 9. 打赏贡献排行榜弹窗 (自定义，非原生) ── -->
    <div
      v-if="isLeaderboardModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
      @click="isLeaderboardModalOpen = false"
    >
      <div
        class="w-full max-w-md rounded-2xl bg-[#1c1b1b] border border-white/10 p-5 shadow-2xl scale-in overflow-hidden relative text-white"
        @click.stop
      >
        <header class="flex items-center justify-between pb-3 border-b border-white/10 mb-4">
          <span class="text-sm font-black flex items-center space-x-2 text-yellow-500">
            <TrophyIcon class="w-4 h-4 fill-current" />
            <span>粉丝打赏总贡献榜</span>
          </span>
          <button
            @click="isLeaderboardModalOpen = false"
            class="p-1 rounded-lg text-white/50 hover:bg-white/10 transition-colors"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </header>

        <div v-if="leaderboard.length === 0" class="py-12 text-center text-white/40 text-xs">
          暂无打赏贡献记录，快去送礼占领榜单吧！
        </div>

        <div v-else class="divide-y divide-white/5 max-h-[300px] overflow-y-auto pr-1">
          <div
            v-for="(fan, idx) in leaderboard"
            :key="fan.name"
            class="flex items-center justify-between py-3"
          >
            <div class="flex items-center space-x-3">
              <!-- Rank Medal (前三名) -->
              <div class="w-6 text-center">
                <span
                  v-if="idx < 3"
                  :class="[
                    'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white shadow-sm',
                    idx === 0 ? 'bg-yellow-500' : idx === 1 ? 'bg-slate-400' : 'bg-amber-600'
                  ]"
                >
                  {{ idx + 1 }}
                </span>
                <span v-else class="text-xs font-bold text-white/40">
                  {{ idx + 1 }}
                </span>
              </div>

              <!-- Avatar -->
              <div class="w-9 h-9 rounded-lg overflow-hidden bg-white/5 border border-white/10 flex-shrink-0">
                <img
                  v-if="fan.avatar && (fan.avatar.startsWith('data:') || fan.avatar.length > 50)"
                  :src="fan.avatar.startsWith('data:') ? fan.avatar : `data:image/png;base64,${fan.avatar}`"
                  class="w-full h-full object-cover"
                />
                <div v-else class="w-full h-full flex items-center justify-center text-[#4edea3] font-black text-sm">
                  {{ fan.name[0] }}
                </div>
              </div>

              <div>
                <div class="text-xs font-bold flex items-center space-x-2">
                  <span>{{ fan.name }}</span>
                  <span class="text-[8px] px-1 py-0.5 rounded bg-primary/20 text-[#4edea3] scale-90 origin-left font-black">
                    Lv.{{ fan.level }}
                  </span>
                </div>
              </div>
            </div>

            <div class="text-right">
              <span class="text-xs font-black text-[#fc7c78]">{{ fan.totalDonated }} 币</span>
            </div>
          </div>
        </div>

        <button
          @click="isLeaderboardModalOpen = false"
          class="w-full mt-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-white text-xs font-black text-center transition-all cursor-pointer border border-white/10"
        >
          关闭
        </button>
      </div>
    </div>

    <!-- 全局 Toast 飘字组件 -->
    <div
      v-if="toastVisible"
      class="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-[#293040]/90 text-white text-xs font-semibold shadow-2xl flex items-center space-x-2 backdrop-blur-md border border-white/10 animate-fade-in"
    >
      <span>{{ toastMessage }}</span>
    </div>

  </div>
</template>

<style scoped>
.slide-up {
  animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes slideUp {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

.scale-in {
  animation: scaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}
.list-enter-from {
  opacity: 0;
  transform: translateX(-20px);
}
.list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

.scrollbar-none::-webkit-scrollbar {
  display: none;
}
.scrollbar-none {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
