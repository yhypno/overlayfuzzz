<template>
  <div class="titlebar drag-region">
    <div class="titlebar-left">
      <button class="titlebar-main no-drag" type="button" @click="emit('console')">{{ title }}</button>
      <div class="titlebar-nav no-drag">
        <button
          class="titlebar-nav-btn"
          :class="{ active: activePage === 'console' }"
          type="button"
          @click="emit('console')"
        >
          Console
        </button>
        <button
          class="titlebar-nav-btn"
          :class="{ active: activePage === 'settings' }"
          type="button"
          @click="emit('settings')"
        >
          Settings
        </button>
      </div>
    </div>
    <button class="titlebar-close no-drag" type="button" @click="emit('close')" title="Close">×</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
  activePage?: 'console' | 'settings';
}>();

const emit = defineEmits<{
  (e: 'console'): void;
  (e: 'settings'): void;
  (e: 'close'): void;
}>();
</script>

<style scoped>
.titlebar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px;
  border-bottom: 1px solid #2b2b2b;
  background: #171717;
  color: #d7d7d7;
}

.titlebar-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.titlebar-main,
.titlebar-close,
.titlebar-nav-btn {
  border: none;
  color: inherit;
  background: transparent;
  border-radius: 6px;
  font: inherit;
}

.titlebar-main {
  min-width: 0;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 6px;
}

.titlebar-nav {
  display: flex;
  gap: 4px;
}

.titlebar-nav-btn {
  font-size: 12px;
  color: #adadad;
  padding: 4px 8px;
}

.titlebar-nav-btn.active {
  color: #ececec;
  background: #212121;
}

.titlebar-close {
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
  padding: 0;
}

.titlebar-main:hover,
.titlebar-nav-btn:hover {
  background: #1d1d1d;
  color: #ececec;
}

.titlebar-close:hover {
  background: #3a2424;
  color: #f0d4d4;
}

.drag-region {
  -webkit-app-region: drag;
  user-select: none;
}

.no-drag {
  -webkit-app-region: no-drag;
}
</style>
