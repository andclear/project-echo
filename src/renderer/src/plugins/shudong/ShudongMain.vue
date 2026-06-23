<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue';
import { 
  ArrowLeftIcon, 
  PlusIcon, 
  Trash2Icon, 
  ImageIcon, 
  Loader2Icon,
  HeartIcon, 
  SendIcon, 
  XIcon, 
  LockIcon, 
  UnlockIcon,
  MessageSquareIcon,
  SparklesIcon,
  Edit3Icon
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

// ── API 基础地址与图片绝对路径解析 ──
const getApiBaseUrl = () => {
  const hostname = window.location.hostname || 'localhost';
  const currentPort = window.location.port;
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  
  let apiPort = '6868'; // 默认物理 Express 端点
  if (['5173', '5174', '5175'].includes(currentPort)) {
    // 处于开发调试端口，重定向至 Express 服务所在的 6868 媒体端口
    apiPort = '6868';
  } else if (currentPort) {
    // 生产局域网 Web 模式直接走同源端口
    apiPort = currentPort;
  }
  
  return `${protocol}//${hostname}:${apiPort}`;
};

const resolveImageUrl = (imageName: string) => {
  if (!imageName) return '';
  if (imageName.startsWith('http://') || imageName.startsWith('https://') || imageName.startsWith('data:')) {
    return imageName;
  }
  return `${getApiBaseUrl()}/api/shudong/image?name=${imageName}`;
};

// ── Markdown 渲染器 ──
const md = new MarkdownIt({
  html: false, // 设为 false 防止 XSS
  linkify: true,
  breaks: true // 自动将 \n 换行符解析为 <br>
});

const renderMarkdown = (content: string) => {
  if (!content) return '';
  // 将相对图片接口替换为包含宿主IP端口的绝对接口，彻底解决开发与桌面模式下图片裂开问题
  const baseUrl = getApiBaseUrl();
  const absoluteContent = content.replace(/\/api\/shudong\/image/g, `${baseUrl}/api/shudong/image`);
  
  let html = md.render(absoluteContent);

  // 1. 替换任务列表复选框 (支持 [ ] 和 [x] / [X])
  html = html.replace(/<li>\[ \] /g, '<li class="task-list-item"><input type="checkbox" disabled class="task-list-item-checkbox" /> ');
  html = html.replace(/<li>\[[xX]\] /g, '<li class="task-list-item"><input type="checkbox" checked disabled class="task-list-item-checkbox" /> ');

  // 2. 代码块一键复制按钮注入 (捕获 pre code 结构包裹 div 并插入复制按钮)
  html = html.replace(/<pre><code([\s\S]*?)>([\s\S]*?)<\/code><\/pre>/g, (match, codeClass, codeContent) => {
    return `<div class="code-block-wrapper relative group my-3">
      <button class="copy-code-btn absolute top-2 right-2 px-2 py-1 rounded bg-surface border border-outline-variant/30 text-[10px] text-on-surface-variant hover:bg-surface-high opacity-0 md:group-hover:opacity-100 transition-opacity duration-200 cursor-pointer active:scale-95" onclick="window.copyCodeToClipboard(this)">复制</button>
      <pre><code${codeClass}>${codeContent}</code></pre>
    </div>`;
  });

  // 3. 增强 GitHub Alert / Callout 语法渲染
  // 匹配形如 <blockquote> [!WARNING] ... </blockquote> 结构
  html = html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (match, innerHtml) => {
    const typeMatch = innerHtml.match(/^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s*<br\s*\/?>|\s+)?([\s\S]*)$/i);
    if (typeMatch) {
      const type = typeMatch[1].toUpperCase();
      const textContent = typeMatch[2];
      
      let borderClass = 'border-l-4 border-blue-500';
      let bgClass = 'bg-blue-50/50 dark:bg-blue-950/10';
      let titleColor = 'text-blue-600 dark:text-blue-400';
      let titleText = 'NOTE';
      let iconSvg = `<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
      
      if (type === 'TIP') {
        borderClass = 'border-l-4 border-emerald-500';
        bgClass = 'bg-emerald-50/50 dark:bg-emerald-950/10';
        titleColor = 'text-emerald-600 dark:text-emerald-400';
        titleText = 'TIP';
        iconSvg = `<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>`;
      } else if (type === 'IMPORTANT') {
        borderClass = 'border-l-4 border-purple-500';
        bgClass = 'bg-purple-50/50 dark:bg-purple-950/10';
        titleColor = 'text-purple-600 dark:text-purple-400';
        titleText = 'IMPORTANT';
        iconSvg = `<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>`;
      } else if (type === 'WARNING') {
        borderClass = 'border-l-4 border-amber-500';
        bgClass = 'bg-amber-50/50 dark:bg-amber-950/10';
        titleColor = 'text-amber-600 dark:text-amber-400';
        titleText = 'WARNING';
        iconSvg = `<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>`;
      } else if (type === 'CAUTION') {
        borderClass = 'border-l-4 border-rose-500';
        bgClass = 'bg-rose-50/50 dark:bg-rose-950/10';
        titleColor = 'text-rose-600 dark:text-rose-400';
        titleText = 'CAUTION';
        iconSvg = `<svg class="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>`;
      }
      
      return `<div class="my-4 p-4 rounded-r-xl border-l-4 ${borderClass} ${bgClass} select-text">
        <div class="flex items-center font-bold text-[11px] ${titleColor} mb-1.5 select-none uppercase tracking-wider">
          ${iconSvg}
          <span>${titleText}</span>
        </div>
        <div class="markdown-callout-content text-xs leading-relaxed text-on-surface-variant select-text">
          <p>${textContent}</p>
        </div>
      </div>`;
    }
    return match;
  });

  return html;
};

// ── Markdown 文本反向解析回编辑器 Block 块的算法 ──
const parseMarkdownToBlocks = (markdown: string): EditorBlock[] => {
  if (!markdown) {
    return [{ id: Math.random().toString(), type: 'text', value: '' }];
  }
  
  const result: EditorBlock[] = [];
  const imgRegex = /!\[.*?\]\(\/api\/shudong\/image\?name=([a-zA-Z0-9_\-\.]+)\)/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = imgRegex.exec(markdown)) !== null) {
    const textBefore = markdown.substring(lastIndex, match.index).trim();
    if (textBefore) {
      result.push({
        id: Math.random().toString(),
        type: 'text',
        value: textBefore
      });
    }
    
    const imageName = match[1];
    result.push({
      id: Math.random().toString(),
      type: 'image',
      value: imageName
    });
    
    lastIndex = imgRegex.lastIndex;
  }
  
  const remainingText = markdown.substring(lastIndex).trim();
  if (remainingText || result.length === 0) {
    result.push({
      id: Math.random().toString(),
      type: 'text',
      value: remainingText
    });
  }
  
  return result;
};

// ── 页面状态 ──
type ViewMode = 'list' | 'write' | 'detail';
const viewMode = ref<ViewMode>('list');
const editingCardId = ref<string | null>(null);
const cards = ref<any[]>([]);
const selectedCard = ref<any | null>(null);
const activeTab = ref<'all' | 'private' | 'disclosed'>('all');
const isLoading = ref(true);

// ── 头像缓存 ──
const avatarCache = ref<Record<string, string>>({});

// ── 编辑器模块化块数据结构 ──
interface EditorBlock {
  id: string;
  type: 'text' | 'image';
  value: string; // text为内容，image为图片文件名
}

const blocks = ref<EditorBlock[]>([
  { id: Math.random().toString(), type: 'text', value: '' }
]);
const currentFocusIndex = ref<number>(-1);
const isDisclosed = ref(false);
const isPublishing = ref(false);
const isUploadingImage = ref(false);

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

// ── 日期格式化 ──
const formatDate = (timestamp: number) => {
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
};

// ── 卡片极简日期格式化 (安全防报错版) ──
const formatCardDate = (timestamp: any) => {
  try {
    if (!timestamp) return '无时间';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '无效时间';
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${m}-${d} ${hh}:${mm}`;
  } catch (e) {
    console.error('[Shudong] formatCardDate error:', e);
    return '时间异常';
  }
};

// ── 过滤卡片列表 ──
const filteredCards = computed(() => {
  if (activeTab.value === 'private') {
    return cards.value.filter(c => !c.disclosed);
  }
  if (activeTab.value === 'disclosed') {
    return cards.value.filter(c => c.disclosed);
  }
  return cards.value;
});

// ── 轮流插值横向交错瀑布流分列计算属性 (高容错诊断版) ──
const columnsOfCards = computed(() => {
  try {
    const isMob = props ? props.isMobile : false;
    const colsCount = isMob ? 1 : 3;
    const result: any[][] = Array.from({ length: colsCount }, () => []);
    
    const list = filteredCards.value;
    if (list && Array.isArray(list)) {
      list.forEach((card, index) => {
        result[index % colsCount].push(card);
      });
    } else {
      console.warn('[Shudong] filteredCards.value is empty or not an array:', list);
    }
    return result;
  } catch (e) {
    console.error('[Shudong] columnsOfCards computed property throw error:', e);
    return [[], [], []];
  }
});

// ── 数据拉取 ──
const loadCards = async () => {
  if (!window.api || !window.api.invoke) return;
  try {
    const res = await window.api.invoke('shudong-list-cards');
    if (res && res.success) {
      cards.value = res.list || [];
      // 预加载所有评论角色的头像
      for (const card of cards.value) {
        if (card.comments) {
          for (const comment of card.comments) {
            if (comment.character_id && comment.folder_name && !avatarCache.value[comment.character_id]) {
              const base64 = await window.api.invoke('get-character-avatar', comment.folder_name);
              if (base64) {
                avatarCache.value[comment.character_id] = base64;
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('获取树洞卡片失败:', err);
  } finally {
    isLoading.value = false;
  }
};

// ── 挂载局域网广播与SSE拉取自愈同步 Hook ──
usePluginSync({
  pluginName: 'shudong',
  eventName: 'card-updated',
  fetchFn: async () => {
    await loadCards();
    // 如果当前处于详情页，自动更新当前显示的卡片（实现AI留言生成完毕后无感实时渲染）
    if (selectedCard.value) {
      const updatedCard = cards.value.find(c => c.id === selectedCard.value.id);
      if (updatedCard) {
        selectedCard.value = updatedCard;
      }
    }
  }
});

onMounted(async () => {
  await loadCards();

  // 挂载全局一键复制方法
  (window as any).copyCodeToClipboard = async (btn: HTMLButtonElement) => {
    const preEl = btn.nextElementSibling;
    const text = preEl ? preEl.textContent || '' : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      btn.innerText = '已复制';
      btn.classList.add('text-emerald-500');
      setTimeout(() => {
        btn.innerText = '复制';
        btn.classList.remove('text-emerald-500');
      }, 2000);
    } catch (e) {
      console.error('一键复制失败:', e);
      btn.innerText = '失败';
    }
  };
});

// ── 编辑器自适应高度 ──
const adjustHeight = (e: Event) => {
  const target = e.target as HTMLTextAreaElement;
  target.style.height = 'auto';
  target.style.height = target.scrollHeight + 'px';
};

// ── 编辑器图片插入 ──
const insertImage = async () => {
  if (isUploadingImage.value) return;
  try {
    isUploadingImage.value = true;
    let res;
    
    if (window.electron && window.electron.ipcRenderer) {
      // 桌面端环境使用 Electron 对话框选取本地图片
      res = await window.api.invoke('shudong-upload-image');
    } else {
      // Web / 移动浏览器端自适应创建 input[type=file] 读取 base64 传输
      res = await new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async (e: any) => {
          const file = e.target.files?.[0];
          if (!file) {
            resolve({ success: false });
            return;
          }
          const reader = new FileReader();
          reader.onload = async () => {
            const base64 = reader.result as string;
            const ext = file.name.substring(file.name.lastIndexOf('.'));
            try {
              const uploadRes = await window.api.invoke('shudong-upload-image', { base64, ext });
              resolve(uploadRes);
            } catch (err) {
              resolve({ success: false, error: err });
            }
          };
          reader.onerror = () => resolve({ success: false });
          reader.readAsDataURL(file);
        };
        input.click();
      });
    }

    if (res && res.success && res.imageName) {
      // 决定图片块插入的位置
      const activeIndex = currentFocusIndex.value >= 0 ? currentFocusIndex.value : blocks.value.length - 1;
      
      const newImageBlock: EditorBlock = {
        id: Math.random().toString(),
        type: 'image',
        value: res.imageName
      };
      
      const newTextBlock: EditorBlock = {
        id: Math.random().toString(),
        type: 'text',
        value: ''
      };
      
      blocks.value.splice(activeIndex + 1, 0, newImageBlock, newTextBlock);
      
      // 延迟自动聚焦到新生成的文本框
      nextTick(() => {
        const newTextarea = document.getElementById(`textarea-${newTextBlock.id}`);
        if (newTextarea) {
          newTextarea.focus();
        }
      });
    } else if (res && res.error) {
      await showCustomDialog({
        title: '上传失败',
        message: '图片上传失败: ' + res.error,
        type: 'warning'
      });
    }
  } catch (err) {
    console.error('插入图片失败:', err);
  } finally {
    isUploadingImage.value = false;
  }
};

// ── 移除块 ──
const removeBlock = (index: number) => {
  blocks.value.splice(index, 1);
  if (blocks.value.length === 0) {
    blocks.value.push({ id: Math.random().toString(), type: 'text', value: '' });
  }
};

// ── 编辑并填充编辑器 ──
const startEdit = (card: any) => {
  editingCardId.value = card.id;
  blocks.value = parseMarkdownToBlocks(card.content);
  isDisclosed.value = card.disclosed;
  viewMode.value = 'write';
  
  // 延迟自动撑开所有 textarea 高度
  nextTick(() => {
    const textareas = document.querySelectorAll('.block-editor-textarea') as NodeListOf<HTMLTextAreaElement>;
    textareas.forEach(textarea => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    });
  });
};

// ── 保存/发布秘密卡片 ──
const publishCard = async () => {
  if (isPublishing.value) return;

  // 拼接成完整的 markdown 字符串
  let markdown = '';
  for (const b of blocks.value) {
    if (b.type === 'text') {
      const val = b.value.trim();
      if (val) {
        markdown += val + '\n\n';
      }
    } else if (b.type === 'image') {
      markdown += `![img](/api/shudong/image?name=${b.value})\n\n`;
    }
  }

  const finalContent = markdown.trim();
  if (!finalContent) {
    await showCustomDialog({
      title: '内容为空',
      message: '心声内容不能为空哦。',
      type: 'warning'
    });
    return;
  }

  try {
    isPublishing.value = true;
    
    // 找出第一张图做主缩略图以兼容旧单图逻辑
    const firstImgBlock = blocks.value.find(b => b.type === 'image');
    const mainImageName = firstImgBlock ? firstImgBlock.value : null;

    let res;
    if (editingCardId.value) {
      // 1. 调用更新接口
      res = await window.api.invoke('shudong-update-card', {
        cardId: editingCardId.value,
        content: finalContent,
        imageName: mainImageName,
        disclosed: isDisclosed.value
      });
    } else {
      // 2. 调用创建接口
      res = await window.api.invoke('shudong-create-card', {
        content: finalContent,
        imageName: mainImageName,
        disclosed: isDisclosed.value
      });
    }

    if (res && res.success) {
      // 成功后清除临时无用文件
      try {
        await window.api.invoke('shudong-clear-temp-images');
      } catch (_) {}

      // 重置编辑器状态
      blocks.value = [{ id: Math.random().toString(), type: 'text', value: '' }];
      const savedCardId = editingCardId.value;
      editingCardId.value = null;
      isDisclosed.value = false;
      
      await loadCards();

      if (savedCardId) {
        // 如果是编辑卡片，发布后直接刷回详情页
        const updatedCard = cards.value.find(c => c.id === savedCardId);
        if (updatedCard) {
          selectedCard.value = updatedCard;
        }
        viewMode.value = 'detail';
      } else {
        viewMode.value = 'list';
      }
    } else {
      await showCustomDialog({
        title: '保存失败',
        message: '保存失败: ' + (res.error || '未知错误'),
        type: 'danger'
      });
    }
  } catch (err: any) {
    console.error('保存树洞秘密失败:', err);
    await showCustomDialog({
      title: '保存出错',
      message: '保存失败: ' + err.message,
      type: 'danger'
    });
  } finally {
    isPublishing.value = false;
  }
};

// ── 删除秘密卡片 ──
const deleteCard = async (cardId: string) => {
  const confirmed = await showCustomDialog({
    title: '删除心声',
    message: '确定要永久删除这篇秘密心声吗？对应角色的温暖评论也将被一同清除，此操作不可撤销。',
    type: 'danger',
    isConfirm: true
  });
  if (!confirmed) {
    return;
  }
  try {
    const res = await window.api.invoke('shudong-delete-card', { cardId });
    if (res && res.success) {
      if (selectedCard.value && selectedCard.value.id === cardId) {
        selectedCard.value = null;
        viewMode.value = 'list';
      }
      await loadCards();
    } else {
      await showCustomDialog({
        title: '删除失败',
        message: '删除失败: ' + (res.error || '未知错误'),
        type: 'danger'
      });
    }
  } catch (err: any) {
    console.error('删除秘密失败:', err);
  }
};

// ── 放弃编辑返回 ──
const cancelEdit = async () => {
  let hasChanges = false;
  
  if (editingCardId.value) {
    const originalCard = cards.value.find(c => c.id === editingCardId.value);
    if (originalCard) {
      let currentMarkdown = '';
      for (const b of blocks.value) {
        if (b.type === 'text') {
          const val = b.value.trim();
          if (val) currentMarkdown += val + '\n\n';
        } else if (b.type === 'image') {
          currentMarkdown += `![img](/api/shudong/image?name=${b.value})\n\n`;
        }
      }
      currentMarkdown = currentMarkdown.trim();
      hasChanges = currentMarkdown !== originalCard.content.trim() || isDisclosed.value !== originalCard.disclosed;
    }
  } else {
    hasChanges = blocks.value.some(b => b.type === 'text' && b.value.trim().length > 0);
  }

  if (hasChanges) {
    const confirmed = await showCustomDialog({
      title: '放弃修改',
      message: '您修改/写下的心声尚未发布，确定要退出编辑吗？已改动的内容将会丢失。',
      type: 'warning',
      isConfirm: true
    });
    if (!confirmed) {
      return;
    }
  }

  // 清除临时文件
  try {
    await window.api.invoke('shudong-clear-temp-images');
  } catch (_) {}

  blocks.value = [{ id: Math.random().toString(), type: 'text', value: '' }];
  isDisclosed.value = false;

  if (editingCardId.value) {
    editingCardId.value = null;
    viewMode.value = 'detail';
  } else {
    viewMode.value = 'list';
  }
};

// ── 自动聚焦第一行文本框 ──
const focusFirstTextBlock = (e: MouseEvent) => {
  const target = e.target as HTMLElement;
  // 排除点击 textarea、按钮、或图片块删除按钮等自身交互元素
  if (
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'INPUT' ||
    target.tagName === 'BUTTON' ||
    target.closest('button') ||
    target.closest('img')
  ) {
    return;
  }
  
  // 聚焦到第一行（通常就是 blocks.value[0]）的 textarea
  const firstBlock = blocks.value[0];
  if (firstBlock && firstBlock.type === 'text') {
    const el = document.getElementById(`textarea-${firstBlock.id}`) as HTMLTextAreaElement;
    if (el) {
      el.focus();
    }
  } else {
    // 降级寻找第一个文本块
    const textBlock = blocks.value.find(b => b.type === 'text');
    if (textBlock) {
      const el = document.getElementById(`textarea-${textBlock.id}`) as HTMLTextAreaElement;
      if (el) {
        el.focus();
      }
    }
  }
};
</script>

<template>
  <div class="flex-grow flex flex-col h-full bg-background overflow-hidden text-on-surface select-none">
    
    <!-- ── 1. 列表主界面 ── -->
    <template v-if="viewMode === 'list'">
      <!-- 顶部 Header -->
      <header class="h-16 px-6 border-b border-outline-variant/20 flex items-center justify-between flex-shrink-0 bg-surface">
        <div class="flex items-center">
          <button 
            @click="emit('exit')" 
            class="p-2 rounded-xl hover:bg-surface-high text-on-surface transition-all cursor-pointer mr-2 active:scale-95"
            title="返回拓展中心"
          >
            <ArrowLeftIcon class="w-5 h-5" />
          </button>
          <span class="text-base font-black tracking-tight select-none">树洞秘密基地</span>
        </div>
        
        <button 
          @click="viewMode = 'write'"
          class="px-4 py-2 rounded-xl bg-primary text-on-primary hover:opacity-90 transition-all font-bold text-xs shadow-md hover:shadow-lg flex items-center space-x-1.5 cursor-pointer active:scale-95"
        >
          <PlusIcon class="w-4 h-4" />
          <span>写下心声</span>
        </button>
      </header>

      <!-- 标签切换栏 -->
      <div class="px-6 py-4 flex-shrink-0 bg-surface-low border-b border-outline-variant/15 flex items-center justify-between">
        <div class="flex space-x-2">
          <button 
            @click="activeTab = 'all'"
            :class="[
              activeTab === 'all' 
                ? 'bg-primary text-on-primary font-bold' 
                : 'bg-surface hover:bg-surface-high text-on-surface-variant border border-outline-variant/30'
            ]"
            class="px-3.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer shadow-sm active:scale-95"
          >
            全部秘密
          </button>
          <button 
            @click="activeTab = 'private'"
            :class="[
              activeTab === 'private' 
                ? 'bg-primary text-on-primary font-bold' 
                : 'bg-surface hover:bg-surface-high text-on-surface-variant border border-outline-variant/30'
            ]"
            class="px-3.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer shadow-sm active:scale-95"
          >
            仅自己可见
          </button>
          <button 
            @click="activeTab = 'disclosed'"
            :class="[
              activeTab === 'disclosed' 
                ? 'bg-primary text-on-primary font-bold' 
                : 'bg-surface hover:bg-surface-high text-on-surface-variant border border-outline-variant/30'
            ]"
            class="px-3.5 py-1.5 rounded-xl text-xs transition-all cursor-pointer shadow-sm active:scale-95"
          >
            已向角色披露
          </button>
        </div>
        <div class="text-[11px] text-on-surface-variant/40 hidden sm:block">
          倾吐心头的隐秘，拥抱角色的温暖陪伴 🍂
        </div>
      </div>

      <!-- 卡片网格展示区 -->
      <div class="flex-1 overflow-y-auto p-6 bg-background">
        
        <!-- 骨架屏加载中 -->
        <div v-if="isLoading" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-pulse">
          <div v-for="i in 6" :key="i" class="p-5 rounded-2xl bg-surface border border-outline-variant/20 space-y-4">
            <div class="flex justify-between items-center">
              <div class="h-4 bg-on-surface/10 rounded w-1/3"></div>
              <div class="h-5 bg-on-surface/10 rounded-full w-16"></div>
            </div>
            <div class="space-y-2">
              <div class="h-3.5 bg-on-surface/10 rounded w-full"></div>
              <div class="h-3.5 bg-on-surface/10 rounded w-5/6"></div>
              <div class="h-3.5 bg-on-surface/10 rounded w-2/3"></div>
            </div>
            <div class="h-32 bg-on-surface/5 rounded-lg w-full"></div>
            <div class="pt-3 border-t border-outline-variant/10 flex justify-between">
              <div class="h-3 bg-on-surface/10 rounded w-1/4"></div>
              <div class="h-3 bg-on-surface/10 rounded w-1/5"></div>
            </div>
          </div>
        </div>

        <!-- 空白页 -->
        <div v-else-if="filteredCards.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
          <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-4 animate-bounce">
            <HeartIcon class="w-7 h-7" />
          </div>
          <h3 class="text-sm font-bold text-on-surface">树洞里空空的</h3>
          <p class="text-xs text-on-surface-variant/50 max-w-xs mt-2 leading-relaxed">
            有一些话不便倾诉，有一些心情无处安放？
            写下来装进树洞吧。不勾选披露时完全仅自己可见，勾选披露可获得角色暖心留言评论。
          </p>
          <button 
            @click="viewMode = 'write'"
            class="mt-6 px-4 py-2.5 rounded-xl border border-outline-variant bg-surface hover:bg-surface-high hover:shadow-sm text-xs font-bold transition-all active:scale-95 cursor-pointer"
          >
            写下第一篇心声
          </button>
        </div>

        <!-- 正常卡片列表 (优先横向顺序多列 Flex 瀑布流) -->
        <div v-else class="flex gap-6 items-start">
          <div 
            v-for="(col, colIdx) in columnsOfCards" 
            :key="colIdx"
            class="flex-1 flex flex-col gap-6"
          >
            <div 
              v-for="card in col" 
              :key="card.id"
              @click="selectedCard = card; viewMode = 'detail'"
              class="group p-5 rounded-2xl bg-surface border border-outline-variant/30 hover:border-primary/20 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer relative"
            >
              <div>
                <!-- 顶部标签与日期 -->
                <div class="flex items-center justify-between text-[11px] text-on-surface-variant/50 font-mono">
                  <span>{{ formatCardDate(card.timestamp) }}</span>
                  <div class="flex items-center space-x-2">
                    <!-- 极简图标化披露状态，释放横向宽度 -->
                    <span class="flex items-center text-on-surface-variant/60">
                      <UnlockIcon v-if="card.disclosed" class="w-3.5 h-3.5 text-primary" title="已向角色披露" />
                      <LockIcon v-else class="w-3.5 h-3.5 text-on-surface-variant/40" title="仅自己可见" />
                    </span>
                    <!-- 快捷编辑与删除按钮（常驻显示，防事件冒泡） -->
                    <div class="flex items-center space-x-1 flex-shrink-0">
                      <button 
                        @click.stop="startEdit(card)"
                        class="p-1 rounded-lg hover:bg-primary/10 hover:text-primary text-on-surface-variant/40 transition-all duration-200 cursor-pointer active:scale-90 flex items-center justify-center"
                        title="快捷编辑"
                      >
                        <Edit3Icon class="w-3.5 h-3.5" />
                      </button>
                      <button 
                        @click.stop="deleteCard(card.id)"
                        class="p-1 rounded-lg hover:bg-red-500/10 hover:text-red-500 text-on-surface-variant/40 transition-all duration-200 cursor-pointer active:scale-90 flex items-center justify-center"
                        title="快捷删除"
                      >
                        <Trash2Icon class="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 卡片预览文字 -->
                <div 
                  class="text-xs text-on-surface-variant/80 mt-3.5 leading-relaxed break-all line-clamp-2 markdown-body card-markdown"
                  v-html="renderMarkdown(card.content)"
                ></div>

                <!-- 图片缩略图 -->
                <div v-if="card.image_name" class="w-full h-32 overflow-hidden rounded-xl mt-3.5 border border-outline-variant/10 relative">
                  <img 
                    :src="resolveImageUrl(card.image_name)" 
                    class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                    alt="预览图"
                  />
                </div>
              </div>

              <!-- 卡片页脚 -->
              <div class="pt-4 mt-4 border-t border-outline-variant/10 flex items-center justify-between text-xs text-on-surface-variant/50">
                <span class="font-mono hidden sm:inline">心声卡片</span>
                
                <!-- 暖心评论角标 -->
                <div v-if="card.disclosed" class="flex items-center space-x-2">
                  <!-- 留言角色小头像排列 -->
                  <div v-if="card.comments && card.comments.length > 0" class="flex -space-x-1.5 overflow-hidden">
                    <img 
                      v-for="cmt in card.comments.slice(0, 3)" 
                      :key="cmt.id"
                      :src="avatarCache[cmt.character_id] || defaultAvatarUrl"
                      class="inline-block h-5 w-5 rounded-full ring-2 ring-surface object-cover"
                      :title="cmt.character_name"
                    />
                  </div>
                  
                  <span class="flex items-center space-x-1 text-[11px] font-bold text-primary">
                    <MessageSquareIcon class="w-3.5 h-3.5" />
                    <span>{{ card.comments.length > 0 ? `${card.comments.length}条` : '排队中' }}</span>
                  </span>
                </div>
                <div class="flex items-center space-x-1 text-[10px]" v-else>
                  <LockIcon class="w-3.5 h-3.5 text-on-surface-variant/30" />
                  <span>安全保管</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ── 2. 写心声界面（富文本图文块编辑器） ── -->
    <template v-else-if="viewMode === 'write'">
      <!-- 顶部 Header -->
      <header class="h-16 px-6 border-b border-outline-variant/20 flex items-center justify-between flex-shrink-0 bg-surface">
        <div class="flex items-center">
          <button 
            @click="cancelEdit" 
            class="p-2 rounded-xl hover:bg-surface-high text-on-surface transition-all cursor-pointer mr-2 active:scale-95"
            title="放弃返回"
          >
            <ArrowLeftIcon class="w-5 h-5" />
          </button>
          <span class="text-base font-black tracking-tight select-none">{{ editingCardId ? '编辑心声' : '写下心声' }}</span>
        </div>
        
        <button 
          @click="publishCard"
          :disabled="isPublishing"
          class="px-5 py-2 rounded-xl bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-all font-bold text-xs shadow-md hover:shadow-lg flex items-center space-x-1.5 cursor-pointer active:scale-95 whitespace-nowrap"
        >
          <Loader2Icon v-if="isPublishing" class="w-4 h-4 animate-spin" />
          <SendIcon v-else class="w-4 h-4" />
          <span>{{ editingCardId ? '保存修改' : '发布心声' }}</span>
        </button>
      </header>

      <!-- 编辑主体区 -->
      <div class="flex-1 overflow-y-auto p-6 bg-background">
        <div class="max-w-3xl mx-auto w-full flex flex-col space-y-6">
          
          <!-- 编辑白板 -->
          <div @click="focusFirstTextBlock" class="bg-surface rounded-2xl border border-outline-variant/30 p-8 shadow-sm min-h-[380px] flex flex-col relative cursor-text">
            
            <!-- 模块块级编辑器渲染器 -->
            <div class="flex-1 flex flex-col space-y-3">
              <div v-for="(block, idx) in blocks" :key="block.id" class="w-full">
                <!-- 文本段落块 -->
                <div v-if="block.type === 'text'" class="relative group">
                  <textarea
                    :id="`textarea-${block.id}`"
                    v-model="block.value"
                    @focus="currentFocusIndex = idx"
                    @input="adjustHeight($event)"
                    rows="1"
                    :placeholder="idx === 0 ? '在此写下你的心声，支持 Markdown 渲染和图文混排...' : ''"
                    class="block-editor-textarea w-full bg-transparent resize-none border-none outline-none focus:ring-0 p-0 text-sm text-on-surface leading-relaxed placeholder-on-surface-variant/30"
                  ></textarea>
                </div>
                
                <!-- 图片块 (直接显示图片本身) -->
                <div 
                  v-else-if="block.type === 'image'" 
                  class="relative my-4 group rounded-xl overflow-hidden border border-outline-variant/30 max-w-md shadow-sm select-none"
                >
                  <img 
                    :src="resolveImageUrl(block.value)" 
                    class="max-w-full h-auto max-h-[400px] block rounded-xl" 
                    alt="树洞图片"
                  />
                  <!-- 删除按钮 -->
                  <button 
                    @click="removeBlock(idx)"
                    class="absolute top-2.5 right-2.5 p-1.5 rounded-full bg-surface/90 hover:bg-surface text-on-surface border border-outline-variant/40 shadow-md transition-all cursor-pointer active:scale-90"
                    title="移除图片"
                  >
                    <XIcon class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <!-- 底部工具条 -->
            <div class="mt-8 pt-4 border-t border-outline-variant/10 flex flex-wrap gap-4 items-center justify-between">
              
              <!-- 插入图片按钮 -->
              <button 
                @click="insertImage"
                :disabled="isUploadingImage"
                class="px-3.5 py-2 rounded-xl border border-outline-variant/50 bg-surface hover:bg-surface-high disabled:opacity-40 text-xs font-bold text-on-surface flex items-center space-x-1.5 transition-all cursor-pointer active:scale-95"
              >
                <Loader2Icon v-if="isUploadingImage" class="w-3.5 h-3.5 animate-spin" />
                <ImageIcon v-else class="w-3.5 h-3.5 text-primary" />
                <span>插入图片</span>
              </button>
              
              <div class="text-[11px] text-on-surface-variant/30">
                图片将被自适应加密存放于本地 🔐
              </div>
            </div>
          </div>

          <!-- 披露选项面板 -->
          <div 
            @click="isDisclosed = !isDisclosed"
            :class="[
              isDisclosed 
                ? 'bg-primary/5 border-primary/20 text-on-surface' 
                : 'bg-surface border-outline-variant/30 text-on-surface-variant'
            ]"
            class="flex items-start space-x-3.5 p-5 rounded-2xl border cursor-pointer select-none transition-all duration-300 hover:shadow-md"
          >
            <div class="flex items-center h-5 mt-0.5">
              <input
                type="checkbox"
                v-model="isDisclosed"
                @click.stop
                class="w-4 h-4 rounded border-outline-variant/60 text-primary focus:ring-primary focus:ring-offset-0 cursor-pointer"
              />
            </div>
            <div class="flex-grow space-y-1">
              <h4 class="text-xs font-bold flex items-center space-x-1.5">
                <SparklesIcon class="w-3.5 h-3.5 text-primary" />
                <span>向 AI 角色公开披露此心声并生成评论</span>
              </h4>
              <p class="text-[11px] opacity-60 leading-relaxed">
                勾选后，系统将从您的通讯录中随机选取 3 位角色（优先从未设置免打扰的角色中选择）。他们将根据其 Soul.md 性格设定，为您撰写一段温暖、治愈的评论。评论直接呈现在卡片下方，用户无需回复。
              </p>
            </div>
          </div>

        </div>
      </div>
    </template>

    <!-- ── 3. 心声卡片详情与 AI 评论 ── -->
    <template v-else-if="viewMode === 'detail'">
      <!-- 顶部 Header -->
      <header class="h-16 px-6 border-b border-outline-variant/20 flex items-center justify-between flex-shrink-0 bg-surface">
        <div class="flex items-center">
          <button 
            @click="viewMode = 'list'; selectedCard = null" 
            class="p-2 rounded-xl hover:bg-surface-high text-on-surface transition-all cursor-pointer mr-2 active:scale-95"
            title="返回秘密列表"
          >
            <ArrowLeftIcon class="w-5 h-5" />
          </button>
          <span class="text-base font-black tracking-tight select-none">心声回顾</span>
        </div>
        
        <div class="flex items-center space-x-1">
          <button 
            @click="startEdit(selectedCard)"
            class="px-3.5 py-1.5 rounded-xl border border-outline-variant/50 hover:bg-surface-high text-on-surface-variant font-bold text-xs transition-all cursor-pointer active:scale-95 flex items-center"
            title="编辑这篇心声"
          >
            <span>编辑心声</span>
          </button>
          <button 
            @click="deleteCard(selectedCard.id)"
            class="p-2 rounded-xl hover:bg-red-500/10 text-red-500 transition-all cursor-pointer active:scale-95"
            title="删除这篇心声"
          >
            <Trash2Icon class="w-5.5 h-5.5" />
          </button>
        </div>
      </header>

      <!-- 详情回顾滚动区 -->
      <div class="flex-1 overflow-y-auto p-6 bg-background">
        <div v-if="selectedCard" class="max-w-3xl mx-auto w-full space-y-6">
          
          <!-- 日记大信纸面 -->
          <div class="bg-surface rounded-2xl border border-outline-variant/30 p-8 shadow-sm flex flex-col space-y-4">
            
            <!-- 日期和可见度标识 -->
            <div class="flex items-center justify-between text-[11px] text-on-surface-variant/40 border-b border-outline-variant/10 pb-4">
              <span class="font-mono">发布时间：{{ formatDate(selectedCard.timestamp) }}</span>
              <span 
                :class="[
                  selectedCard.disclosed 
                    ? 'bg-primary/10 text-primary border border-primary/10' 
                    : 'bg-on-surface/5 text-on-surface-variant border border-outline-variant/20'
                ]"
                class="px-2.5 py-0.5 rounded-full font-bold scale-95 flex items-center"
              >
                <UnlockIcon v-if="selectedCard.disclosed" class="w-2.5 h-2.5 mr-0.5" />
                <LockIcon v-else class="w-2.5 h-2.5 mr-0.5" />
                <span>{{ selectedCard.disclosed ? '已向角色披露' : '仅自己可见' }}</span>
              </span>
            </div>

            <!-- 正文 Markdown 渲染 -->
            <article 
              class="text-sm leading-relaxed text-on-surface break-all select-text markdown-body"
              v-html="renderMarkdown(selectedCard.content)"
            ></article>
          </div>

          <!-- AI 评论板块 -->
          <div v-if="selectedCard.disclosed" class="space-y-4">
            <h3 class="text-xs font-bold text-on-surface-variant flex items-center space-x-1.5 px-1">
              <HeartIcon class="w-4 h-4 text-primary fill-primary/10" />
              <span>角色的治愈留言</span>
            </h3>

            <!-- 留言生成中占位屏 (支持异步无感刷新) -->
            <div 
              v-if="!selectedCard.comments || selectedCard.comments.length === 0" 
              class="p-8 rounded-2xl bg-surface border border-outline-variant/30 text-center flex flex-col items-center justify-center space-y-3"
            >
              <Loader2Icon class="w-6 h-6 text-primary animate-spin" />
              <div class="text-xs font-bold text-on-surface">留言正在书写中...</div>
              <p class="text-[11px] text-on-surface-variant/50 max-w-xs">
                AI 角色正在认真体会并思索您的心声，暖心评论即将送达，请稍等片刻（无需刷新页面哦）🍂
              </p>
            </div>

            <!-- 正常的评论列表 -->
            <div v-else class="space-y-4">
              <div 
                v-for="comment in selectedCard.comments" 
                :key="comment.id"
                class="flex items-start space-x-4 p-5 rounded-2xl bg-surface border border-outline-variant/30 shadow-sm relative overflow-hidden group hover:shadow-md transition-shadow"
              >
                <!-- 角色头像 -->
                <div class="w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 bg-surface-low border border-outline-variant/40 shadow-sm">
                  <img 
                    :src="avatarCache[comment.character_id] || defaultAvatarUrl" 
                    class="w-full h-full object-cover"
                    alt="角色头像"
                  />
                </div>

                <!-- 留言详情 -->
                <div class="flex-grow">
                  <div class="flex items-center justify-between">
                    <span class="text-xs font-bold text-on-surface">{{ comment.character_name }}</span>
                    <span class="text-[9px] text-on-surface-variant/30 font-mono">{{ formatDate(comment.timestamp) }}</span>
                  </div>
                  <p class="text-xs text-on-surface-variant mt-2 leading-relaxed select-text whitespace-pre-wrap break-all">
                    {{ comment.content }}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <!-- 仅自己可见的空提醒 -->
          <div 
            v-else 
            class="p-6 rounded-2xl bg-surface-low border border-outline-variant/30 text-center text-xs text-on-surface-variant/40 flex items-center justify-center space-x-2"
          >
            <LockIcon class="w-4 h-4 text-on-surface-variant/20" />
            <span>此篇心声已完全在本地高强度对称加密锁存，仅您自己可读 🐾</span>
          </div>

        </div>
      </div>
    </template>

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
/* 针对 markdown-body 正文样式的优雅优化以支持图文混排 */
:deep(.markdown-body) {
  font-family: inherit;
  font-size: 0.875rem;
  line-height: 1.625;
}
:deep(.markdown-body p) {
  margin-bottom: 1rem;
}
:deep(.markdown-body img) {
  max-width: 100%;
  height: auto;
  max-height: 500px;
  object-fit: contain;
  border-radius: 0.75rem;
  margin: 1.25rem 0;
  border: 1px solid var(--outline-variant);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);
}
:deep(.markdown-body blockquote) {
  border-left: 3px solid var(--outline);
  padding-left: 1rem;
  margin-left: 0;
  margin-bottom: 1rem;
  color: var(--on-surface-variant);
  opacity: 0.8;
}

/* 补充多级标题样式以对抗 Tailwind CSS Preflight Reset */
:deep(.markdown-body h1) {
  font-size: 1.45rem;
  font-weight: 800;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  color: var(--on-surface);
  line-height: 1.3;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15);
  padding-bottom: 0.35rem;
}
:deep(.markdown-body h2) {
  font-size: 1.25rem;
  font-weight: 750;
  margin-top: 1.25rem;
  margin-bottom: 0.6rem;
  color: var(--on-surface);
  line-height: 1.35;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  padding-bottom: 0.25rem;
}
:deep(.markdown-body h3) {
  font-size: 1.125rem;
  font-weight: 700;
  margin-top: 1.1rem;
  margin-bottom: 0.5rem;
  color: var(--on-surface);
  line-height: 1.4;
}
:deep(.markdown-body h4) {
  font-size: 1rem;
  font-weight: 700;
  margin-top: 0.9rem;
  margin-bottom: 0.4rem;
  color: var(--on-surface);
}

/* 列表 Reset 与对齐修正 */
:deep(.markdown-body ul) {
  list-style-type: disc !important;
  padding-left: 1.35rem !important;
  margin-bottom: 1rem !important;
}
:deep(.markdown-body ol) {
  list-style-type: decimal !important;
  padding-left: 1.35rem !important;
  margin-bottom: 1rem !important;
}
:deep(.markdown-body li) {
  margin-bottom: 0.35rem !important;
}
:deep(.markdown-body li > ul),
:deep(.markdown-body li > ol) {
  margin-bottom: 0 !important;
  margin-top: 0.25rem !important;
}

/* 加粗和斜体 */
:deep(.markdown-body strong) {
  font-weight: 700;
}
:deep(.markdown-body em) {
  font-style: italic;
}

/* 任务列表样式 */
:deep(.markdown-body li.task-list-item) {
  list-style-type: none !important;
  position: relative !important;
  padding-left: 1.45rem !important;
  margin-left: -1.25rem !important;
}
:deep(.markdown-body .task-list-item-checkbox) {
  position: absolute !important;
  left: 0 !important;
  top: 0.35rem !important;
  width: 0.95rem;
  height: 0.95rem;
  accent-color: var(--primary);
  border-radius: 0.2rem;
  cursor: default;
}

/* 代码及代码块样式 */
:deep(.markdown-body code) {
  background-color: var(--surface-high);
  color: var(--primary);
  padding: 0.15rem 0.3rem;
  border-radius: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.85em;
}
:deep(.markdown-body pre) {
  background-color: var(--surface-high);
  border: 1px solid var(--outline-variant);
  padding: 1rem;
  border-radius: 0.75rem;
  overflow-x: auto;
  margin-bottom: 1rem;
}
:deep(.markdown-body pre code) {
  background-color: transparent !important;
  color: var(--on-surface) !important;
  padding: 0 !important;
  border-radius: 0 !important;
  font-size: 0.825rem !important;
  line-height: 1.5;
  font-family: inherit;
}
:deep(.code-block-wrapper) {
  margin: 1rem 0;
}
:deep(.code-block-wrapper button.copy-code-btn) {
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  z-index: 10;
}
:deep(.code-block-wrapper button.copy-code-btn:active) {
  scale: 0.95;
}

/* 树洞卡片内的 Markdown 极简/紧凑渲染样式 */
:deep(.card-markdown) {
  font-size: 0.75rem !important; /* 12px text-xs */
  line-height: 1.5 !important;
  max-height: 2.5rem; /* 约 2 行行高 */
  overflow: hidden;
  pointer-events: none; /* 防止卡片内部元素捕获点击 */
}

/* 隐藏卡片预览中的图片，避免重复和撑爆卡片 */
:deep(.card-markdown img) {
  display: none !important;
}

/* 隐藏复制按钮 */
:deep(.card-markdown .copy-code-btn) {
  display: none !important;
}

/* 减小卡片中各种元素的间距，以精简展示 */
:deep(.card-markdown p) {
  margin-bottom: 0.25rem !important;
}
:deep(.card-markdown h1) {
  font-size: 0.95rem !important;
  margin-top: 0.5rem !important;
  margin-bottom: 0.25rem !important;
  padding-bottom: 0 !important;
  border-bottom: none !important;
}
:deep(.card-markdown h2) {
  font-size: 0.9rem !important;
  margin-top: 0.4rem !important;
  margin-bottom: 0.2rem !important;
  padding-bottom: 0 !important;
  border-bottom: none !important;
}
:deep(.card-markdown h3) {
  font-size: 0.85rem !important;
  margin-top: 0.3rem !important;
  margin-bottom: 0.15rem !important;
}
:deep(.card-markdown h4) {
  font-size: 0.8rem !important;
  margin-top: 0.25rem !important;
  margin-bottom: 0.1rem !important;
}
:deep(.card-markdown blockquote) {
  border-left-width: 2px !important;
  padding-left: 0.5rem !important;
  margin-bottom: 0.25rem !important;
}
:deep(.card-markdown ul),
:deep(.card-markdown ol) {
  margin-bottom: 0.25rem !important;
  padding-left: 1rem !important;
}
:deep(.card-markdown li) {
  margin-bottom: 0.1rem !important;
}
:deep(.card-markdown li.task-list-item) {
  padding-left: 1.15rem !important;
  margin-left: -1rem !important;
}
:deep(.card-markdown .task-list-item-checkbox) {
  top: 0.2rem !important;
  width: 0.75rem !important;
  height: 0.75rem !important;
}
:deep(.card-markdown pre) {
  padding: 0.4rem !important;
  margin-bottom: 0.25rem !important;
  border-radius: 0.375rem !important;
}
:deep(.card-markdown pre code) {
  font-size: 0.7rem !important;
}
</style>
