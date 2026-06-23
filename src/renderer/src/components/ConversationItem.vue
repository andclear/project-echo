<template>
  <!-- 会话列表条目：显示角色头像、名称、最后消息、时间、未读数、免打扰图标 -->
  <div
    class="px-3 h-[68px] flex-shrink-0 flex items-center space-x-2.5 cursor-pointer transition-colors relative select-none"
    style="touch-action: manipulation;"
    :class="[
      isSelected ? 'bg-conversation-selected' : (isPinned ? 'bg-secondary/[0.04] dark:bg-secondary/[0.03] hover:bg-conversation-hover' : 'hover:bg-conversation-hover'),
      isMuted ? 'opacity-70' : ''
    ]"
    @click="$emit('click')"
    @contextmenu.prevent="$emit('contextmenu', $event)"
  >
    <div class="relative flex-shrink-0">
      <div class="w-10 h-10 rounded overflow-hidden bg-surface-high border border-on-surface/5 shadow-sm flex items-center justify-center">
        <template v-if="character.id === 'character_creator_bot'">
          <img :src="creatorBotAvatarUrl" class="w-full h-full object-cover" />
        </template>
        <template v-else>
          <img v-if="avatar" :src="avatar" class="w-full h-full object-cover" />
          <div v-else class="w-full h-full flex items-center justify-center">
            <UserIcon class="w-5 h-5 text-on-surface-variant/50" />
          </div>
        </template>
      </div>
      <!-- 未读数 badge -->
      <div
        v-if="unread > 0"
        class="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center shadow-sm"
      >{{ unread > 9 ? '9+' : unread }}</div>
      
      <!-- 头像右下角免打扰徽章挂件 -->
      <div
        v-if="isMuted"
        class="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-800 border border-outline-variant/50 text-on-surface-variant/80 flex items-center justify-center shadow-md active:scale-95 transition-all select-none"
        title="消息免打扰"
      >
        <BellOffIcon class="w-2.5 h-2.5" />
      </div>
    </div>

    <!-- 右侧内容 -->
    <div class="flex-1 min-w-0">
      <div class="flex items-center justify-between mb-0.5">
        <span class="text-sm font-semibold text-on-surface truncate max-w-[120px]">{{ character.name }}</span>
        <div class="flex items-center space-x-1.5 flex-shrink-0">
          <!-- 置顶小图钉 -->
          <PinIcon v-if="isPinned" class="w-3 h-3 text-secondary/60 dark:text-secondary/50 transform rotate-45" />
          <!-- 免打扰图标 -->
          <BellOffIcon v-if="isMuted" class="w-3 h-3 text-on-surface-variant/40" />
          <!-- 最后消息时间 -->
          <span v-if="lastMessage" class="text-[10px] text-on-surface-variant/50">{{ formatTime(lastMessage.timestamp) }}</span>
        </div>
      </div>
      <div class="text-xs text-on-surface-variant/60 truncate">
        <template v-if="lastMessage">
          <span v-if="lastMessage.role === 'user'" class="text-on-surface-variant/40">我：</span>
          <template v-if="lastMessage.isImage || lastMessage.imageBase64 || (typeof lastMessage.content === 'string' && lastMessage.content.includes('[wechat_image_media]:'))">
            [图片消息]
          </template>
          <template v-else>
            {{ typeof lastMessage.content === 'string' ? lastMessage.content.replace(/^\[System Dynamic Context Update\][\s\S]*?---\n\n/, '') : (lastMessage.content || '...') }}
          </template>
        </template>
        <span v-else class="text-on-surface-variant/30 italic">暂无消息</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { BellOffIcon, UserIcon, Brain as BrainIcon, Pin as PinIcon } from 'lucide-vue-next'
import creatorBotAvatarUrl from '../assets/creat_char.png'

const props = defineProps<{
  character: any
  avatar: string
  isSelected: boolean
  unread: number
  lastMessage: any
  isMuted?: boolean
  isHidden?: boolean
  isPinned?: boolean
}>()

defineEmits<{
  (e: 'click'): void
  (e: 'contextmenu', event: MouseEvent): void
}>()

// 格式化时间（今天显示 HH:mm，超过今天显示月/日）
function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return ''
  const now = new Date()
  const date = new Date(timestamp)
  const isToday = date.toDateString() === now.toDateString()
  if (isToday) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}
</script>
