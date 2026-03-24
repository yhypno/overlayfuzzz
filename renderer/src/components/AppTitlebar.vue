<template>
  <div class="titlebar drag-region">
    <button class="titlebar-main no-drag" @click="emit('click')">{{ title }}</button>
    <button class="titlebar-close no-drag" @click.stop="emit('close')" tabindex="-1" title="Close">×</button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title?: string;
}>();

const emit = defineEmits<{
  (e: 'click'): void;
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
}

.titlebar-main,
.titlebar-close {
  border: none;
  background: transparent;
  color: inherit;
  padding: 0 0.5rem;
}

.titlebar-main {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.66rem;
}

.titlebar-close {
  width: 1.5rem;
  font-size: 0.9rem;
  line-height: 1;
  border-radius: 0.2rem;
  padding: 0;
}

.titlebar-main:hover,
.titlebar-close:hover {
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
