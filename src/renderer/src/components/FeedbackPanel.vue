<template>
  <div class="flex flex-col h-full bg-surface text-on-surface select-none font-sans text-xs">
    
    <!-- ── 头部导航 ── -->
    <div class="flex items-center justify-between p-4 border-b border-outline-variant/20 flex-shrink-0 bg-surface">
      <div class="flex items-center gap-2">
        <MessageSquareIcon class="w-4 h-4 text-primary" />
        <span class="text-sm font-bold">意见反馈与跟进</span>
      </div>
      
      <div class="flex gap-2">
        <button 
          v-if="currentView !== 'list'"
          @click="switchView('list')"
          class="px-2.5 py-1 text-xs border border-outline text-on-surface-variant hover:text-on-surface hover:bg-surface-high rounded-[2px] cursor-pointer transition-all duration-200 active:scale-95"
        >
          返回列表
        </button>
        <button 
          v-if="currentView === 'list'"
          @click="switchView('create')"
          class="px-2.5 py-1 text-xs bg-primary text-on-primary hover:opacity-90 rounded-[2px] cursor-pointer transition-all duration-200 flex items-center gap-1 font-bold active:scale-95"
        >
          <PlusIcon class="w-3.5 h-3.5" />
          <span>新建反馈</span>
        </button>
      </div>
    </div>

    <!-- ── 主内容区 ── -->
    <div class="flex-1 overflow-hidden min-h-0 bg-background/50 select-text">
      
      <!-- 视图 1: 反馈历史列表 -->
      <div v-if="currentView === 'list'" class="h-full flex flex-col p-4 overflow-y-auto space-y-3">
        <div class="text-[10px] text-on-surface-variant/60 font-mono tracking-wider select-none uppercase">本地反馈记录</div>
        
        <div v-if="loadingList" class="flex flex-col items-center justify-center py-20 text-on-surface-variant/70 gap-2 select-none">
          <RefreshCwIcon class="w-5 h-5 animate-spin text-primary" />
          <span class="text-[10px] font-mono">正在同步云端反馈状态...</span>
        </div>

        <div v-else-if="feedbacksList.length === 0" class="flex flex-col items-center justify-center py-20 text-on-surface-variant/50 select-none">
          <MessageSquareIcon class="w-10 h-10 opacity-20 mb-2" />
          <p class="text-xs">您还没有提交过任何意见反馈哦🐾</p>
        </div>

        <div v-else class="grid grid-cols-1 gap-2.5">
          <div 
            v-for="fb in feedbacksList" 
            :key="fb.id"
            @click="enterFeedbackDetail(fb)"
            class="p-3 bg-surface-low border border-outline-variant/60 hover:border-primary/50 rounded-[2px] cursor-pointer transition-all duration-200"
          >
            <div class="flex items-center justify-between mb-2 select-none">
              <span :class="getTypeBadgeStyle(fb.type)">
                {{ getTypeLabel(fb.type) }}
              </span>
              <span :class="getStatusBadgeStyle(fb.status)">
                {{ getStatusLabel(fb.status) }}
              </span>
            </div>
            <h4 class="text-xs font-bold text-on-surface mb-1 truncate">{{ fb.title }}</h4>
            <p class="text-[11px] text-on-surface-variant line-clamp-1 leading-relaxed">{{ fb.content }}</p>
            <div v-if="fb.target_version" class="text-[9px] font-mono mt-1 text-on-surface-variant/70">
              {{ fb.status === 'completed' ? '🎉 实现版本: ' : '🎯 预计版本: ' }}{{ fb.target_version }}
            </div>
            <div class="flex justify-between items-center text-[9px] text-on-surface-variant/50 font-mono mt-2.5 select-none">
              <span>单号: {{ fb.id.substring(0, 8) }}...</span>
              <span>{{ formatDate(fb.created_at) }}</span>
            </div>
          </div>
        </div>

        <!-- 查看更新计划友情提示 -->
        <div class="pt-6 border-t border-outline-variant/10 select-none text-center">
          <p class="text-[10px] text-on-surface-variant/60 leading-relaxed">
            您也可以在浏览器中直接访问 
            <span class="text-primary font-mono select-all mx-1 font-bold">https://echo-kanban.jiuwo.me</span>
            <br/>
            查阅所有功能和意见反馈的排期与最新更新计划。🐾
          </p>
        </div>
      </div>

      <!-- 视图 2: 新建反馈表单 -->
      <div v-else-if="currentView === 'create'" class="h-full overflow-y-auto p-4 max-w-[520px] mx-auto">
        <form @submit.prevent="submitNewFeedback" class="space-y-4">
          <div v-if="errorMessage" class="p-3 bg-error/10 border border-error/20 text-error flex items-center gap-2 rounded-[2px] text-[11px]">
            <AlertCircleIcon class="w-3.5 h-3.5 flex-shrink-0" />
            <span>{{ errorMessage }}</span>
          </div>

          <div class="space-y-1.5 select-none">
            <label class="text-[10px] text-on-surface-variant/80 font-bold">选择反馈类型</label>
            <div class="grid grid-cols-3 gap-2">
              <button 
                type="button"
                @click="formType = 'bug'"
                :class="['py-2 border text-xs rounded-[2px] cursor-pointer text-center flex items-center justify-center gap-1 transition-all duration-200', formType === 'bug' ? 'border-primary text-primary bg-primary/5 font-semibold' : 'border-outline-variant/60 hover:border-outline text-on-surface-variant']"
              >
                <BugIcon class="w-3.5 h-3.5" />
                <span>BUG反馈</span>
              </button>
              <button 
                type="button"
                @click="formType = 'suggestion'"
                :class="['py-2 border text-xs rounded-[2px] cursor-pointer text-center flex items-center justify-center gap-1 transition-all duration-200', formType === 'suggestion' ? 'border-primary text-primary bg-primary/5 font-semibold' : 'border-outline-variant/60 hover:border-outline text-on-surface-variant']"
              >
                <LightbulbIcon class="w-3.5 h-3.5" />
                <span>功能建议</span>
              </button>
              <button 
                type="button"
                @click="formType = 'feedback'"
                :class="['py-2 border text-xs rounded-[2px] cursor-pointer text-center flex items-center justify-center gap-1 transition-all duration-200', formType === 'feedback' ? 'border-primary text-primary bg-primary/5 font-semibold' : 'border-outline-variant/60 hover:border-outline text-on-surface-variant']"
              >
                <HelpCircleIcon class="w-3.5 h-3.5" />
                <span>意见反馈</span>
              </button>
            </div>
          </div>

          <div class="space-y-1.5">
            <label class="text-[10px] text-on-surface-variant/80 font-bold">反馈标题</label>
            <input 
              type="text"
              v-model="formTitle"
              maxLength="100"
              placeholder="请输入精炼的标题 (100字以内)"
              class="w-full bg-surface-low border border-outline-variant focus:border-primary focus:outline-none p-2 text-xs rounded-[2px] text-on-surface placeholder-on-surface-variant/40 transition-all"
            />
          </div>


          <div class="space-y-1.5">
            <label class="text-[10px] text-on-surface-variant/80 font-bold">详细描述</label>
            <textarea 
              rows="5"
              v-model="formContent"
              maxLength="1000"
              placeholder="请详细书写您遇到的BUG、复现流程，或对功能的详细设定构想..."
              class="w-full bg-surface-low border border-outline-variant focus:border-primary focus:outline-none p-2 text-xs rounded-[2px] resize-none leading-relaxed text-on-surface placeholder-on-surface-variant/40 transition-all"
            ></textarea>
          </div>

          <div class="flex justify-end gap-3 pt-2 select-none">
            <button 
              type="button"
              @click="switchView('list')"
              class="px-4 py-1.5 border border-outline text-on-surface-variant hover:text-on-surface hover:bg-surface-high rounded-[2px] cursor-pointer transition-all duration-200 active:scale-95"
            >
              取消
            </button>
            <button 
              type="submit"
              :disabled="submitting"
              class="px-4 py-1.5 bg-primary text-on-primary rounded-[2px] disabled:opacity-50 cursor-pointer font-bold transition-all hover:opacity-90 active:scale-95"
            >
              {{ submitting ? '正在提交...' : '确认提交' }}
            </button>
          </div>
        </form>
      </div>

      <!-- 视图 3: 双向会话交互详情 -->
      <div v-else-if="currentView === 'detail' && activeFeedback" class="h-full flex flex-col min-h-0 bg-background/20">
        
        <!-- 对话展示区 -->
        <div class="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
          
          <!-- 本地反馈卡片 -->
          <div class="p-3.5 bg-surface-low border border-outline-variant/60 rounded-[2px]">
            <div class="flex items-center gap-2 mb-2 select-none">
              <span :class="getTypeBadgeStyle(activeFeedback.type)">
                {{ getTypeLabel(activeFeedback.type) }}
              </span>
              <span :class="getStatusBadgeStyle(activeFeedback.status)">
                {{ getStatusLabel(activeFeedback.status) }}
              </span>
            </div>
            <h3 class="text-xs font-bold text-on-surface mb-1.5">{{ activeFeedback.title }}</h3>
            <p class="text-[11px] text-on-surface-variant leading-relaxed whitespace-pre-wrap select-text">{{ activeFeedback.content }}</p>
            <div v-if="activeFeedback.target_version" class="text-[9px] font-mono mt-2">
              <span class="px-1.5 py-0.5 rounded-[2px] border bg-outline/10 text-on-surface-variant/80 border-outline-variant/30">
                {{ activeFeedback.status === 'completed' ? '🎉 实现版本: ' : '🎯 预计版本: ' }}{{ activeFeedback.target_version }}
              </span>
            </div>
            <div class="text-[9px] text-on-surface-variant/40 font-mono mt-3 select-none">
              单号: {{ activeFeedback.id }} | 提交时间: {{ formatDate(activeFeedback.created_at) }}
            </div>
          </div>

          <div class="border-t border-outline-variant/10 my-2 select-none"></div>

          <!-- 双向聊天会话记录 -->
          <div v-if="loadingChat" class="flex justify-center py-6 select-none">
            <RefreshCwIcon class="w-4 h-4 animate-spin text-primary" />
          </div>

          <div v-else-if="repliesList.length === 0" class="text-center py-6 text-[10px] text-on-surface-variant/50 font-mono select-none">
            暂无项目组回复。您可以在底部输入新情况继续跟进。
          </div>

          <div class="space-y-4">
            <div 
              v-for="(reply, idx) in repliesList" 
              :key="idx"
              :class="['flex flex-col max-w-[85%]', reply.sender === 'admin' ? 'mr-auto items-start' : 'ml-auto items-end']"
            >
              <div class="flex items-center gap-2 text-[9px] text-on-surface-variant/40 mb-1 select-none">
                <span>{{ reply.sender === 'admin' ? '官方回复' : '我的追加' }}</span>
                <span>{{ formatTime(reply.created_at) }}</span>
              </div>
              <div 
                :class="['p-2.5 text-[11px] rounded-[2px] leading-relaxed whitespace-pre-wrap', reply.sender === 'admin' ? 'bg-surface-high/60 border border-outline-variant text-on-surface' : 'bg-primary/10 border border-primary/20 text-primary']"
              >
                {{ reply.content }}
              </div>
            </div>
          </div>
        </div>

        <!-- 对话输入栏 -->
        <div class="p-3 border-t border-outline-variant/20 bg-surface flex-shrink-0 flex gap-2">
          <input 
            type="text"
            v-model="chatInput"
            maxLength="500"
            placeholder="在此输入跟进内容..."
            @keyup.enter="sendChatReply"
            class="flex-1 bg-surface-low border border-outline-variant focus:border-primary focus:outline-none px-3 py-1.5 text-xs rounded-[2px] placeholder-on-surface-variant/40 text-on-surface transition-all"
          />
          <button 
            @click="sendChatReply"
            :disabled="sendingReply || !chatInput.trim()"
            class="p-2 bg-primary text-on-primary disabled:opacity-50 flex items-center justify-center rounded-[2px] cursor-pointer hover:opacity-90 active:scale-95 transition-all"
          >
            <SendIcon class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

    </div>

    <!-- ── 自定义高保真提示弹窗 ── -->
    <div v-if="dialogVisible" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm select-none animate-fade-in">
      <div class="bg-surface border border-outline-variant w-[280px] p-6 rounded-[2px] shadow-[0_12px_40px_-6px_rgba(0,0,0,0.5)] flex flex-col items-center text-center">
        <!-- 成功状态图标 -->
        <div v-if="isDialogSuccess" class="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center mb-3">
          <CheckIcon class="w-5 h-5 text-primary" />
        </div>
        <!-- 失败/警告状态图标 -->
        <div v-else class="w-10 h-10 bg-error/10 rounded-full flex items-center justify-center mb-3">
          <AlertCircleIcon class="w-5 h-5 text-error" />
        </div>
        
        <p class="text-xs font-bold text-on-surface leading-relaxed mb-5 select-text">
          {{ dialogMessage }}
        </p>
        
        <button 
          @click="closeDialog"
          class="w-full py-1.5 bg-primary text-on-primary rounded-[2px] font-bold text-xs hover:opacity-95 active:scale-95 transition-all cursor-pointer"
        >
          确定
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { 
  MessageSquare as MessageSquareIcon, 
  Plus as PlusIcon, 
  RefreshCw as RefreshCwIcon,
  AlertCircle as AlertCircleIcon,
  Bug as BugIcon,
  Lightbulb as LightbulbIcon,
  HelpCircle as HelpCircleIcon,
  Send as SendIcon,
  Check as CheckIcon
} from 'lucide-vue-next'

// ── 类型定义 ──
interface FeedbackRecord {
  id: string;
  title: string;
  content: string;
  type: 'bug' | 'suggestion' | 'feedback' | 'wife_treasure';
  contact?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'rejected';
  target_version?: string;
  created_at: number;
}

interface ChatReply {
  sender: 'user' | 'admin';
  content: string;
  created_at: string;
}

// ── 状态管理 ──
const currentView = ref<'list' | 'create' | 'detail'>('list')
const feedbacksList = ref<FeedbackRecord[]>([])
const loadingList = ref(false)
const apiBaseUrl = ref('https://echo-kanban.jiuwo.me') // 写死后端物理接口基准地址

// 新反馈表单
const formTitle = ref('')
const formType = ref<'bug' | 'suggestion' | 'feedback'>('feedback')
const formContact = ref('')
const formContent = ref('')
const errorMessage = ref('')
const submitting = ref(false)

// 当前反馈详情与跟进
const activeFeedback = ref<FeedbackRecord | null>(null)
const repliesList = ref<ChatReply[]>([])
const loadingChat = ref(false)
const chatInput = ref('')
const sendingReply = ref(false)

// 设备唯一ID
const deviceId = ref('')

// 自定义高保真提示弹窗状态
const dialogVisible = ref(false)
const dialogMessage = ref('')
const isDialogSuccess = ref(true)

function showCustomDialog(message: string, isSuccess = true) {
  dialogMessage.value = message
  isDialogSuccess.value = isSuccess
  dialogVisible.value = true
}

function closeDialog() {
  dialogVisible.value = false
}

onMounted(async () => {
  // 1. 调用主进程 IPC 获取设备唯一ID
  if (window.api && window.api.invoke) {
    try {
      const dId = await window.api.invoke('get-device-id')
      deviceId.value = dId || 'unknown'
    } catch (_) {
      deviceId.value = getFallbackDeviceId()
    }
  } else {
    deviceId.value = getFallbackDeviceId()
  }

  // 2. 加载本地反馈历史，同步云端状态
  loadLocalFeedbacks()
})

// 浏览器降级获取设备ID
function getFallbackDeviceId() {
  let id = localStorage.getItem('echo_device_id')
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
    localStorage.setItem('echo_device_id', id)
  }
  return id
}

// ── 视图切换 ──
function switchView(view: 'list' | 'create' | 'detail') {
  currentView.value = view
  errorMessage.value = ''
  if (view === 'list') {
    loadLocalFeedbacks()
  }
}

// ── 1. 加载本地反馈列表并自动向云端拉取最新状态 ──
async function loadLocalFeedbacks() {
  loadingList.value = true
  feedbacksList.value = []

  let localList: FeedbackRecord[] = []
  if (window.api && window.api.invoke) {
    try {
      const res = await window.api.invoke('get-user-feedbacks')
      if (res && res.success) {
        localList = res.list || []
      }
    } catch (err) {
      console.error('从 SQLite 读取反馈失败:', err)
    }
  } else {
    // Web 降级读取 localStorage
    const localStr = localStorage.getItem('echo_local_feedbacks')
    if (localStr) {
      try { localList = JSON.parse(localStr); } catch (_) {}
    }
  }

  feedbacksList.value = localList

  if (localList.length === 0) {
    loadingList.value = false
    return
  }

  // 增量自愈：如果本地有反馈单号，向看板服务器拉取最新的 status 状态并同步到本地 SQLite 中
  try {
    const ids = localList.map(item => item.id).join(',')
    const res = await fetch(`${apiBaseUrl.value.trim()}/api/feedbacks?ids=${ids}`)
    if (res.ok) {
      const json = await res.json()
      if (json.success && Array.isArray(json.list)) {
        // 同步最新的 status 状态到本地
        for (const remoteFb of json.list) {
          const localItem = localList.find(item => item.id === remoteFb.id)
          if (localItem && localItem.status !== remoteFb.status) {
            localItem.status = remoteFb.status
            // 同步写入 SQLite
            if (window.api && window.api.invoke) {
              await window.api.invoke('update-user-feedback-status', { id: remoteFb.id, status: remoteFb.status })
            }
          }
        }
        // 同步更新网页端 localStorage
        if (!window.api || !window.api.invoke) {
          localStorage.setItem('echo_local_feedbacks', JSON.stringify(localList))
        }
        feedbacksList.value = [...localList]
      }
    }
  } catch (err) {
    console.warn('[Sync feedbacks failed]: 看板服务器暂时连接不上，展示本地状态缓存', err)
  } finally {
    loadingList.value = false
  }
}

// ── 2. 提交新反馈 ──
// 本地天限流 3 次判断
function checkLocalRateLimit(): boolean {
  const today = new Date().toLocaleDateString()
  const rateData = localStorage.getItem('echo_rate_limit')
  if (rateData) {
    try {
      const parsed = JSON.parse(rateData)
      if (parsed.date === today && parsed.count >= 3) {
        return false
      }
    } catch (_) {}
  }
  return true
}

function incrementRateLimitCount() {
  const today = new Date().toLocaleDateString()
  const rateData = localStorage.getItem('echo_rate_limit')
  let count = 1
  if (rateData) {
    try {
      const parsed = JSON.parse(rateData)
      if (parsed.date === today) {
        count = parsed.count + 1
      }
    } catch (_) {}
  }
  localStorage.setItem('echo_rate_limit', JSON.stringify({ date: today, count }))
}

async function submitNewFeedback() {
  errorMessage.value = ''
  if (!formTitle.value.trim() || !formContent.value.trim()) {
    errorMessage.value = '请填写完整的标题与详细描述'
    return
  }

  // 1. 本地拦截天限流校验
  if (!checkLocalRateLimit()) {
    errorMessage.value = '您今天提交的反馈次数已达上限（每天最多3次），请明天再试哦！🐾'
    return
  }

  submitting.value = true
  const feedbackId = crypto.randomUUID()
  const createdTimestamp = Date.now()

  const payload = {
    id: feedbackId,
    device_id: deviceId.value,
    title: formTitle.value.trim(),
    content: formContent.value.trim(),
    type: formType.value,
    contact: formContact.value.trim() || undefined
  }

  try {
    // 2. 发送网络请求往云端保存
    const res = await fetch(`${apiBaseUrl.value.trim()}/api/feedbacks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    let json: any = {}
    try {
      json = await res.json()
    } catch (parseErr: any) {
      console.error('[Feedback submit JSON Parse Error]:', parseErr)
      const text = await res.text().catch(() => '')
      console.error('[Feedback submit Raw Response]:', text)
      errorMessage.value = `服务器响应格式异常 (状态码: ${res.status})。请检查 Vercel 部署日志。🐾`
      submitting.value = false
      return
    }

    if (!res.ok || !json.success) {
      errorMessage.value = json.error || '提交失败，请稍后重试'
      submitting.value = false
      return
    }

    // 3. 提交成功，写入本地数据库
    const record: FeedbackRecord = {
      id: feedbackId,
      title: formTitle.value.trim(),
      content: formContent.value.trim(),
      type: formType.value,
      contact: formContact.value.trim() || undefined,
      status: 'pending',
      created_at: createdTimestamp
    }

    if (window.api && window.api.invoke) {
      await window.api.invoke('save-user-feedback', record)
    } else {
      // 网页端 localStorage 缓存
      const localStr = localStorage.getItem('echo_local_feedbacks')
      let localList: FeedbackRecord[] = []
      if (localStr) {
        try { localList = JSON.parse(localStr); } catch (_) {}
      }
      localList.unshift(record)
      localStorage.setItem('echo_local_feedbacks', JSON.stringify(localList))
    }

    // 更新限流计数
    incrementRateLimitCount()

    // 4. 重置表单，切回列表
    formTitle.value = ''
    formContent.value = ''
    formContact.value = ''
    formType.value = 'feedback'
    submitting.value = false
    showCustomDialog('意见反馈已成功飞入数据库，我们将尽快为您处理！🐾', true)
    switchView('list')

  } catch (err: any) {
    console.error('[Feedback submit Network Error]:', err)
    errorMessage.value = `连接看板服务器异常: ${err.message || err}。请检查您的网络连接或稍后重试。🐾`
    submitting.value = false
  }
}

// ── 3. 进入反馈对话详情 ──
async function enterFeedbackDetail(fb: FeedbackRecord) {
  activeFeedback.value = fb
  currentView.value = 'detail'
  loadingChat.value = true
  repliesList.value = []

  try {
    const res = await fetch(`${apiBaseUrl.value.trim()}/api/feedbacks/detail?id=${fb.id}`)
    let json: any = {}
    try {
      json = await res.json()
    } catch (parseErr: any) {
      console.error('[Feedback detail JSON Parse Error]:', parseErr)
      loadingChat.value = false
      return
    }
    if (json.success) {
      repliesList.value = json.replies || []
      
      // 同步更新本地状态，防止云端已更改本地状态未变
      if (fb.status !== json.feedback.status) {
        fb.status = json.feedback.status
        if (window.api && window.api.invoke) {
          await window.api.invoke('update-user-feedback-status', { id: fb.id, status: fb.status })
        }
      }
    }
  } catch (err) {
    console.error('获取跟进对话流失败:', err)
  } finally {
    loadingChat.value = false
  }
}

// ── 4. 追加对话回复 ──
async function sendChatReply() {
  if (!chatInput.value.trim() || !activeFeedback.value) return
  sendingReply.value = true

  const payload = {
    feedback_id: activeFeedback.value.id,
    sender: 'user',
    content: chatInput.value.trim()
  }

  try {
    const res = await fetch(`${apiBaseUrl.value.trim()}/api/feedbacks/detail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    let json: any = {}
    try {
      json = await res.json()
    } catch (parseErr: any) {
      console.error('[Feedback reply JSON Parse Error]:', parseErr)
      showCustomDialog(`服务器响应格式异常 (状态码: ${res.status})，回复发送失败`, false)
      sendingReply.value = false
      return
    }
    if (json.success) {
      chatInput.value = ''
      // 重新拉取
      const detailRes = await fetch(`${apiBaseUrl.value.trim()}/api/feedbacks/detail?id=${activeFeedback.value.id}`)
      let detailJson: any = {}
      try {
        detailJson = await detailRes.json()
      } catch (err) {
        console.error('[Feedback reply detail parse error]:', err)
      }
      if (detailJson.success) {
        repliesList.value = detailJson.replies || []
      }
    } else {
      showCustomDialog(json.error || '回复发送失败', false)
    }
  } catch (err: any) {
    console.error('[Feedback reply Network Error]:', err)
    showCustomDialog(`连接看板接口失败: ${err.message || err}`, false)
  } finally {
    sendingReply.value = false
  }
}

// ── 辅助函数 ──
function getTypeLabel(type: string) {
  if (type === 'bug') return 'BUG反馈'
  if (type === 'suggestion') return '功能建议'
  if (type === 'wife_treasure') return '老婆宝'
  return '意见反馈'
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatTime(isoStr: string) {
  return new Date(isoStr).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getTypeBadgeStyle(type: string) {
  const base = 'inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-[2px] font-medium border '
  if (type === 'bug') return base + 'bg-error/10 text-error border-error/20'
  if (type === 'suggestion') return base + 'bg-primary/10 text-primary border-primary/20'
  if (type === 'wife_treasure') return base + 'bg-pink-500/10 text-pink-500 border-pink-500/20'
  return base + 'bg-outline/10 text-on-surface-variant border-outline-variant/30'
}

function getStatusLabel(status: string) {
  if (status === 'pending') return '待实现'
  if (status === 'in_progress') return '进行中'
  if (status === 'completed') return '已完成'
  return '已拒绝'
}

function getStatusBadgeStyle(status: string) {
  const base = 'inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-[2px] font-mono border '
  if (status === 'pending') return base + 'bg-amber-500/10 text-amber-500 border-amber-500/20'
  if (status === 'in_progress') return base + 'bg-primary/10 text-primary border-primary/20'
  if (status === 'completed') return base + 'bg-on-surface-variant/10 text-on-surface-variant border-outline-variant/30'
  return base + 'bg-error/10 text-error border-error/20'
}
</script>
