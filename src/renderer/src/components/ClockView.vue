<template>
  <div 
    class="w-full h-full select-none flex flex-col justify-center px-3 py-2 font-sans relative text-[13px] border rounded-lg shadow-2xl transition-all duration-300"
    :class="isDark ? 'bg-zinc-900/85 text-zinc-200 border-white/10 shadow-black/40' : 'bg-white/85 text-zinc-800 border-zinc-200/50 shadow-zinc-300/50'"
    style="backdrop-filter: blur(24px); -webkit-app-region: no-drag;"
  >
    <!-- 第一项：当前日期 -->
    <div 
      class="h-[24px] flex items-center px-2 rounded tracking-wide font-normal pointer-events-none select-none"
      :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
    >
      当前日期：{{ dateStr }}
    </div>

    <!-- 第二项：当前时间（精致跳秒项，无花哨动画，和原生一致） -->
    <div 
      class="h-[24px] flex items-center px-2 rounded tracking-wide font-normal pointer-events-none select-none"
      :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
    >
      当前时间：{{ timeStr }}
    </div>

    <!-- 系统级精致菜单分隔线 -->
    <div class="h-[1px] my-1" :class="isDark ? 'bg-white/10' : 'bg-zinc-200/80'"></div>

    <!-- 第三项：打开 Echo -->
    <div 
      class="menu-item h-[24px] flex items-center px-2 rounded cursor-default select-none font-normal transition-colors duration-75"
      :class="isDark ? 'text-zinc-200 hover:bg-[#007aff] hover:text-white' : 'text-zinc-800 hover:bg-[#007aff] hover:text-white'"
      @click="handleOpenMain"
    >
      打开 Echo
    </div>

    <!-- 系统级精致菜单分隔线 -->
    <div class="h-[1px] my-1" :class="isDark ? 'bg-white/10' : 'bg-zinc-200/80'"></div>

    <!-- 第四项：退出 Echo -->
    <div 
      class="menu-item h-[24px] flex items-center px-2 rounded cursor-default select-none font-normal transition-colors duration-75"
      :class="isDark ? 'text-zinc-200 hover:bg-[#007aff] hover:text-white' : 'text-zinc-800 hover:bg-[#007aff] hover:text-white'"
      @click="handleQuit"
    >
      退出 Echo
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const isDark = ref(false)
const dateStr = ref('')
const timeStr = ref('')

const checkTheme = () => {
  const isDocDark = document.documentElement.classList.contains('dark')
  const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  isDark.value = isDocDark || isSystemDark
}

let timer: NodeJS.Timeout | null = null

onMounted(() => {
  checkTheme()
  
  const tick = () => {
    const now = new Date()
    // 2026年5月27日
    dateStr.value = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    // 18:57:47
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    const ss = String(now.getSeconds()).padStart(2, '0')
    timeStr.value = `${hh}:${mm}:${ss}`
  }
  
  tick()
  timer = setInterval(tick, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const handleOpenMain = () => {
  if (window.api && typeof window.api.invoke === 'function') {
    window.api.invoke('clock-open-main-window')
  }
}

const handleQuit = () => {
  if (window.api && typeof window.api.invoke === 'function') {
    window.api.invoke('clock-quit-app')
  }
}
</script>

<style scoped>
.menu-item {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Icons", "Helvetica Neue", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.menu-item:active {
  background-color: #0063db !important;
  color: white !important;
}
</style>
