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
  background: rgba(17, 24, 39, 1);
  color: rgba(107, 114, 128, 1);
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 1.5rem;
  line-height: 1.5rem;
  border-bottom: 1px solid rgba(55, 65, 81, 1);
  padding: 0 0.2rem;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.titlebar-nav {
  display: flex;
  gap: 0.22rem;
}

.titlebar-main,
.titlebar-close,
.titlebar-nav-btn {
  border: none;
  background: transparent;
  color: inherit;
  height: 1.2rem;
  line-height: 1.2rem;
  border-radius: 0.22rem;
}

.titlebar-main,
.titlebar-close {
  padding: 0 0.5rem;
}

.titlebar-main {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.66rem;
  max-width: 10rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.titlebar-nav-btn {
  font-size: 0.56rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 0 0.42rem;
  border: 1px solid transparent;
}

.titlebar-nav-btn.active {
  color: rgba(229, 231, 235, 1);
  border-color: rgba(75, 85, 99, 1);
  background: rgba(31, 41, 55, 0.85);
}

.titlebar-close {
  width: 1.5rem;
  font-size: 0.9rem;
  line-height: 1;
  border-radius: 0.2rem;
  padding: 0;
}

.titlebar-main:hover,
.titlebar-close:hover,
.titlebar-nav-btn:hover {
  color: rgba(156, 163, 175, 1);
  background: linear-gradient(to top, rgba(17, 24, 39, 1), rgba(55, 65, 81, 1));
}

.titlebar-close:hover {
  color: rgba(254, 202, 202, 1);
  background: rgba(239, 68, 68, 0.95);
}

.drag-region {
  -webkit-app-region: drag;
  user-select: none;
}

.no-drag {
  -webkit-app-region: no-drag;
}
</style>
