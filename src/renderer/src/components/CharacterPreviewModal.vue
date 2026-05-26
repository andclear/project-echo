<template>
  <!-- 遮罩层使用微透科技蓝灰色或强对比黑，结合高毛玻璃度，塑造极致高级感 -->
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/40 dark:bg-black/80 backdrop-blur-md animate-fade-in">
    <!-- Modal 主面板：采用大尺寸宽幅与高占比视口，彻底拉伸编辑器高度。背景使用实色 bg-surface-lowest 规避脏灰问题 -->
    <div class="w-full max-w-4xl h-[82vh] min-h-[600px] max-h-[750px] flex flex-col rounded-xl border border-outline-variant bg-surface-lowest shadow-2xl dark:shadow-[0_24px_48px_-12px_rgba(0,0,0,0.7)] overflow-hidden select-none transition-all duration-300">
      
      <!-- 头部：微弱低亮度对比以创造雅致感 -->
      <header class="px-6 py-4 border-b border-outline-variant/60 flex items-center justify-between bg-surface-low/40 dark:bg-surface-dim/20">
        <h3 class="text-sm font-bold text-on-surface flex items-center uppercase tracking-wide">
          <SparklesIcon class="w-4 h-4 mr-2 text-primary animate-pulse" />
          <span>AI 角色智能设定提炼预览与确认</span>
        </h3>
        <button @click="onCancel" class="text-on-surface-variant hover:text-on-surface transition-colors" title="关闭">
          <XIcon class="w-4 h-4" />
        </button>
      </header>

      <!-- 内容区：移除外层滚动，使得下方编辑器容器能够完美分发并伸展高度 -->
      <main class="flex-1 p-6 space-y-5 flex flex-col min-h-0 select-text">
        <!-- 基础元数据 & 拼音文件夹框 -->
        <div class="flex items-center space-x-6 p-4 rounded-lg bg-surface-low/50 border border-outline-variant/30 select-none shadow-sm">
          <!-- 头像 -->
          <div class="relative w-16 h-16 rounded overflow-hidden border border-on-surface/5 bg-surface flex-shrink-0 flex items-center justify-center shadow-sm">
            <img v-if="avatarUrl" :src="avatarUrl" class="w-full h-full object-cover" />
            <UserIcon v-else class="w-8 h-8 text-on-surface-variant" />
          </div>

          <!-- 信息 -->
          <div class="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="flex flex-col">
              <span class="text-[11px] text-on-surface-variant font-semibold mb-1 flex items-center justify-between">
                <span>角色姓名</span>
                <span class="text-[10px] text-primary italic">* 支持自定义纠偏</span>
              </span>
              <input 
                v-model="customName"
                type="text" 
                placeholder="请输入角色姓名" 
                class="w-full pl-3 pr-3 py-1.5 rounded-lg border border-outline-variant bg-surface-lowest text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-sans font-bold" 
              />
            </div>
            
            <div class="flex flex-col">
              <span class="text-[11px] text-on-surface-variant font-semibold mb-1 flex items-center justify-between">
                <span>专属物理文件夹名称 (拼音/英文)</span>
                <span class="text-[10px] text-primary italic">* 支持微调纠音</span>
              </span>
              <div class="relative flex items-center">
                <input 
                  v-model="customFolder"
                  @input="validateFolderName"
                  type="text" 
                  placeholder="请输入小写拼音或英文" 
                  class="w-full pl-3 pr-28 py-1.5 rounded-lg border border-outline-variant bg-surface-lowest text-on-surface text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all font-mono" 
                />
                <span class="absolute right-3 text-[10px] font-mono text-on-surface-variant opacity-60">characters/</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Tab 切换区 & 编辑器 -->
        <div class="flex-1 flex flex-col min-h-0 select-none">
          <div class="flex space-x-1 border-b border-outline-variant/50 mb-3">
            <button 
              @click="activeTab = 'soul'" 
              class="px-4 py-2 border-b-2 text-xs font-bold transition-all flex items-center"
              :class="activeTab === 'soul' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant/80 hover:text-on-surface'"
            >
              <SmileIcon class="w-3.5 h-3.5 mr-1.5" />
              <span>性格特征 (Soul.md)</span>
            </button>
            <button 
              @click="activeTab = 'world'" 
              class="px-4 py-2 border-b-2 text-xs font-bold transition-all flex items-center"
              :class="activeTab === 'world' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant/80 hover:text-on-surface'"
            >
              <GlobeIcon class="w-3.5 h-3.5 mr-1.5" />
              <span>世界设定 (World.md)</span>
            </button>
          </div>

          <!-- 编辑器：通过 flex-1 垂直撑满全部剩余空间 -->
          <div class="flex-1 flex flex-col min-h-0 bg-surface-low/30 dark:bg-black/20 border border-outline-variant rounded-lg overflow-hidden">
            <!-- 编辑器标题与字数状态栏：以极客风格温和显示，不再显示警告报错 -->
            <div class="px-4 py-2.5 bg-surface-low/80 dark:bg-surface-dim/40 border-b border-outline-variant/40 flex justify-between items-center text-[10px] text-on-surface-variant font-bold select-none font-mono tracking-wider">
              <span>MARKDOWN EDITOR</span>
              <span class="text-primary-container dark:text-primary font-bold">
                字数: {{ wordCount }} (建议 ≤ {{ wordLimit }})
              </span>
            </div>
            
            <textarea 
              v-if="activeTab === 'soul'"
              v-model="editableSoul"
              class="flex-1 w-full p-4 bg-transparent text-on-surface text-sm font-mono focus:outline-none resize-none leading-relaxed overflow-y-auto select-text focus:bg-surface-low/10 transition-colors duration-150"
              placeholder="请输入 Soul.md 性格特征内容..."
            ></textarea>
            
            <textarea 
              v-else
              v-model="editableWorld"
              class="flex-1 w-full p-4 bg-transparent text-on-surface text-sm font-mono focus:outline-none resize-none leading-relaxed overflow-y-auto select-text focus:bg-surface-low/10 transition-colors duration-150"
              placeholder="请输入 World.md 世界设定内容..."
            ></textarea>
          </div>
        </div>
      </main>

      <!-- 底部操作栏：极浅背景打底，与 header 呼应 -->
      <footer class="px-6 py-4 border-t border-outline-variant bg-surface-low/40 dark:bg-surface-dim/20 flex justify-end items-center space-x-4 select-none">
        <button 
          @click="onCancel"
          class="px-4 py-2 rounded-lg border border-outline-variant hover:bg-surface-high/50 text-on-surface text-xs font-bold transition-all"
        >
          取消导入
        </button>
        <!-- 移去字数限制的 disabled，仅在专属物理文件夹名称为空时禁用 -->
        <button 
          @click="onConfirm"
          :disabled="!customFolder"
          class="px-5 py-2 rounded-lg bg-primary hover:bg-primary-container text-on-primary text-xs font-bold transition-all flex items-center disabled:opacity-40"
        >
          <CheckIcon class="w-3.5 h-3.5 mr-1.5" />
          <span>确认导入并建立角色</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import {
  Sparkles as SparklesIcon,
  X as XIcon,
  Smile as SmileIcon,
  Globe as GlobeIcon,
  User as UserIcon,
  Check as CheckIcon
} from 'lucide-vue-next'

const props = defineProps<{
  isOpen: boolean
  cardData: any
  pinyinName: string
  soulContent: string
  worldContent: string
  avatarUrl: string
}>()

const emit = defineEmits<{
  (e: 'confirm', data: { folderName: string; name: string; soul: string; world: string }): void
  (e: 'cancel'): void
  (e: 'show-alert', title: string, text: string, type: 'info' | 'success' | 'error'): void
}>()

const activeTab = ref<'soul' | 'world'>('soul')
const customFolder = ref('')
const customName = ref('')
const editableSoul = ref('')
const editableWorld = ref('')

// 监听打开状态并进行数据同步
watch(() => props.isOpen, (newVal) => {
  if (newVal) {
    customFolder.value = props.pinyinName
    customName.value = props.cardData?.name || ''
    editableSoul.value = props.soulContent
    editableWorld.value = props.worldContent
    activeTab.value = 'soul'
  }
})

// 计算当前编辑文本字数
const wordCount = computed(() => {
  if (activeTab.value === 'soul') {
    return editableSoul.value.trim().length
  }
  return editableWorld.value.trim().length
})

// 字数建议：性格与人设建议 800 字以内；世界设定建议 1000 字以内
const wordLimit = computed(() => {
  return activeTab.value === 'soul' ? 800 : 1000
})

// 物理文件夹命名合法化校验：仅允许小写字母、数字、下划线、减号
function validateFolderName() {
  customFolder.value = customFolder.value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

function onCancel() {
  emit('cancel')
}

// 移除代码与系统层面的字数硬性拦截，AI 生成多少即以多少为准
function onConfirm() {
  if (!customName.value.trim()) {
    emit('show-alert', '配置错误', '角色姓名不能为空，请重新配置。', 'error')
    return
  }
  if (!customFolder.value) {
    emit('show-alert', '配置错误', '专属物理文件夹名称不能为空，请重新配置。', 'error')
    return
  }
  emit('confirm', {
    folderName: customFolder.value,
    name: customName.value.trim(),
    soul: editableSoul.value,
    world: editableWorld.value
  })
}
</script>

