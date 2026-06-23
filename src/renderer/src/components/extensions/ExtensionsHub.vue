<script setup lang="ts">
import { LayoutGridIcon } from 'lucide-vue-next';
import theaterIcon from '../../plugins/theater/assets/theater.webp';
import zhiboIcon from '../../plugins/livestream/assets/zhibo.webp';
import xinliIcon from '../../plugins/xinli/assets/xinli.webp';
import shudongIcon from '../../plugins/shudong/assets/shudong.webp';
import zhenxinhuaIcon from '../../plugins/zhenxinhua/assets/zhenxinhua.webp';

defineEmits<{
  (e: 'enter-theater'): void;
  (e: 'enter-livestream'): void;
  (e: 'enter-therapy'): void;
  (e: 'enter-shudong'): void;
  (e: 'enter-truth'): void;
  (e: 'show-toast', msg: string): void;
}>();
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0 bg-background overflow-hidden pt-6 pb-8 px-8 select-none">
    <!-- 顶部 Header -->
    <header class="mb-3 flex-shrink-0">
      <div class="flex items-center space-x-3">
        <div class="p-2.5 rounded-xl bg-primary/10 text-primary">
          <LayoutGridIcon class="w-6 h-6 animate-pulse" />
        </div>
        <div>
          <h1 class="text-xl font-black text-on-surface">拓展功能 Beta</h1>
        </div>
      </div>
    </header>

    <!-- 拓展列表网格 -->
    <div class="flex-1 overflow-y-auto min-h-0 pr-2">
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-6 py-1 justify-items-start">
        <!-- 大剧院 (AI文字跑团) 卡片 -->
        <div
          @click="$emit('enter-theater')"
          class="group relative flex flex-col items-center pt-3.5 pb-4 px-4 w-full max-w-[11rem] rounded-2xl bg-surface-low hover:bg-surface-high transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1"
        >
          <!-- 渐变光晕背景 (Hover 显示) -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- 图标容器 -->
          <div class="relative w-24 h-24 mb-4 rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-all duration-300">
            <img
              :src="theaterIcon"
              alt="大剧院"
              class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
            />
          </div>

          <!-- 标题 -->
          <h3 class="text-sm font-bold text-on-surface text-center group-hover:text-primary transition-colors">大剧院</h3>
          <!-- 标签/描述 -->
          <span class="text-[10px] px-2 py-0.5 mt-2 rounded-full bg-surface-high text-on-surface-variant font-medium">AI剧情演绎</span>
        </div>

        <!-- 回音直播 卡片 -->
        <div
          @click="$emit('enter-livestream')"
          class="group relative flex flex-col items-center pt-3.5 pb-4 px-4 w-full max-w-[11rem] rounded-2xl bg-surface-low hover:bg-surface-high transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1"
        >
          <!-- 渐变光晕背景 -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- 图标容器 -->
          <div class="relative w-24 h-24 mb-4 rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-all duration-300">
            <img
              :src="zhiboIcon"
              alt="回音直播"
              class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
            />
          </div>

          <!-- 标题 -->
          <h3 class="text-sm font-bold text-on-surface text-center group-hover:text-primary transition-colors">回音直播</h3>
          <!-- 标签/描述 -->
          <span class="text-[10px] px-2 py-0.5 mt-2 rounded-full bg-surface-high text-on-surface-variant font-medium">直播间互动</span>
        </div>

        <!-- 心理按摩 卡片 -->
        <div
          @click="$emit('enter-therapy')"
          class="group relative flex flex-col items-center pt-3.5 pb-4 px-4 w-full max-w-[11rem] rounded-2xl bg-surface-low hover:bg-surface-high transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1"
        >
          <!-- 渐变光晕背景 -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- 图标容器 -->
          <div class="relative w-24 h-24 mb-4 rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-all duration-300">
            <img
              :src="xinliIcon"
              alt="心理按摩"
              class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
            />
          </div>

          <!-- 标题 -->
          <h3 class="text-sm font-bold text-on-surface text-center group-hover:text-primary transition-colors">心理按摩</h3>
          <!-- 标签/描述 -->
          <span class="text-[10px] px-2 py-0.5 mt-2 rounded-full bg-surface-high text-on-surface-variant font-medium">情绪疏导</span>
        </div>

        <!-- 树洞 卡片 -->
        <div
          @click="$emit('enter-shudong')"
          class="group relative flex flex-col items-center pt-3.5 pb-4 px-4 w-full max-w-[11rem] rounded-2xl bg-surface-low hover:bg-surface-high transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1"
        >
          <!-- 渐变光晕背景 -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- 图标容器 -->
          <div class="relative w-24 h-24 mb-4 rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-all duration-300">
            <img
              :src="shudongIcon"
              alt="树洞"
              class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
            />
          </div>

          <!-- 标题 -->
          <h3 class="text-sm font-bold text-on-surface text-center group-hover:text-primary transition-colors">树洞</h3>
          <!-- 标签/描述 -->
          <span class="text-[10px] px-2 py-0.5 mt-2 rounded-full bg-surface-high text-on-surface-variant font-medium">你的秘密基地</span>
        </div>

        <!-- 真心话真心话 卡片 -->
        <div
          @click="$emit('enter-truth')"
          class="group relative flex flex-col items-center pt-3.5 pb-4 px-4 w-full max-w-[11rem] rounded-2xl bg-surface-low hover:bg-surface-high transition-all duration-300 cursor-pointer hover:shadow-lg hover:shadow-primary/5 hover:-translate-y-1"
        >
          <!-- 渐变光晕背景 -->
          <div class="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"></div>

          <!-- 图标容器 -->
          <div class="relative w-24 h-24 mb-4 rounded-xl overflow-hidden shadow-md group-hover:shadow-xl transition-all duration-300">
            <img
              :src="zhenxinhuaIcon"
              alt="真心话真心话"
              class="w-full h-full object-cover transform group-hover:scale-110 transition-transform duration-500"
            />
          </div>

          <!-- 标题 -->
          <h3 class="text-sm font-bold text-on-surface text-center group-hover:text-primary transition-colors">真心话真心话</h3>
          <!-- 标签/描述 -->
          <span class="text-[10px] px-2 py-0.5 mt-2 rounded-full bg-surface-high text-on-surface-variant font-medium">趣味互动</span>
        </div>
      </div>
    </div>
  </div>
</template>
