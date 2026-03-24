<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { OverlayResult } from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';

const status = ref('Press Ctrl/Cmd + Shift + O to capture.');
const result = ref('Waiting for OCR...');
const confidence = ref<number | null>(null);
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');

const stage = computed<Stage>(() => {
  if (error.value) return 'error';

  const text = `${status.value} ${lastUpdate.value}`.toLowerCase();
  if (text.includes('captur')) return 'capturing';
  if (text.includes('running') || text.includes('process')) return 'processing';
  if (text.includes('done') || text.includes('complete')) return 'done';
  return 'idle';
});

const stageLabel = computed(() => {
  switch (stage.value) {
    case 'capturing':
      return 'Capturing';
    case 'processing':
      return 'Processing';
    case 'done':
      return 'Ready';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
});

const confidenceValue = computed(() =>
  confidence.value === null ? '--' : `${confidence.value.toFixed(1)}%`,
);

const confidenceWidth = computed(() => {
  const raw = confidence.value ?? 0;
  return `${Math.max(0, Math.min(100, raw))}%`;
});

const stageClass = computed(() => {
  switch (stage.value) {
    case 'capturing':
      return 'border-cyan-400/30 shadow-[0_30px_100px_rgba(34,211,238,0.18)]';
    case 'processing':
      return 'border-amber-300/30 shadow-[0_30px_100px_rgba(251,191,36,0.18)]';
    case 'done':
      return 'border-emerald-300/30 shadow-[0_30px_100px_rgba(52,211,153,0.18)]';
    case 'error':
      return 'border-rose-400/30 shadow-[0_30px_100px_rgba(251,113,133,0.18)]';
    default:
      return 'border-white/10 shadow-[0_30px_100px_rgba(3,8,25,0.55)]';
  }
});

function setResult(payload: OverlayResult) {
  result.value = payload.text || '(no text detected)';
  confidence.value = payload.confidence ?? null;
  error.value = payload.error ?? '';
  lastUpdate.value = payload.error ? 'Error reported' : payload.text ? 'Text updated' : 'No text found';
}

function setStatus(value: string) {
  status.value = value;
  lastUpdate.value = value;
}

onMounted(() => {
  bridgeReady.value = Boolean(window.overlayApi);

  if (!window.overlayApi) return;

  window.overlayApi.onStatus((next) => {
    setStatus(next);
  });

  window.overlayApi.onResult((payload) => {
    setResult(payload);
  });
});
</script>

<template>
  <div class="relative h-screen w-screen overflow-hidden bg-transparent text-white">
    <main class="relative flex h-full items-start justify-end p-4 sm:p-6">
      <section
        class="relative w-full max-w-[38rem] overflow-hidden rounded-[2rem] border bg-ink-900/[0.82] p-5 shadow-glow backdrop-blur-3xl sm:p-6"
        :class="stageClass"
      >
        <div class="pointer-events-none absolute -left-16 top-10 h-32 w-32 rounded-full bg-mint-400/[0.14] blur-3xl" />
        <div class="pointer-events-none absolute -right-10 bottom-16 h-40 w-40 rounded-full bg-sky-400/[0.12] blur-3xl" />
        <div class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
        <div class="absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-white/10 to-transparent" />

        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="text-[0.72rem] uppercase tracking-[0.42em] text-mint-300/[0.7]">OverlayFuzz</p>
            <h1 class="mt-2 text-2xl font-display font-semibold tracking-tight sm:text-[1.85rem]">
              OCR capture console
            </h1>
          </div>

          <div
            class="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[0.7rem] uppercase tracking-[0.32em] text-slate-200"
          >
            {{ stageLabel }}
          </div>
        </div>

        <p class="mt-4 max-w-[34rem] text-sm leading-6 text-slate-300">
          {{ status }}
        </p>

        <div class="mt-5 rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
          <div class="flex items-center justify-between gap-3">
            <div class="text-[0.7rem] uppercase tracking-[0.32em] text-slate-400">Detected text</div>
            <div class="text-[0.7rem] uppercase tracking-[0.24em] text-slate-500">
              {{ bridgeReady ? 'Bridge connected' : 'Bridge unavailable' }}
            </div>
          </div>

          <Transition name="fade-swap" mode="out-in">
            <pre
              :key="result"
              class="mt-3 min-h-[12rem] whitespace-pre-wrap break-words font-mono text-[0.98rem] leading-7 text-slate-50"
            >{{ result }}</pre>
          </Transition>

          <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              class="h-full rounded-full bg-gradient-to-r from-mint-400 via-sky-400 to-amber-300 transition-[width] duration-500 ease-out"
              :style="{ width: confidenceWidth }"
            />
          </div>
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <div class="rounded-[1.25rem] border border-white/10 bg-white/5 p-4">
            <div class="text-[0.7rem] uppercase tracking-[0.28em] text-slate-400">Confidence</div>
            <div class="mt-2 flex items-end justify-between gap-4">
              <div class="text-3xl font-semibold tracking-tight text-white">{{ confidenceValue }}</div>
              <div class="text-xs uppercase tracking-[0.24em] text-slate-500">0 - 100 scale</div>
            </div>
          </div>

          <div class="rounded-[1.25rem] border border-white/10 bg-white/5 p-4">
            <div class="text-[0.7rem] uppercase tracking-[0.28em] text-slate-400">Error</div>
            <p class="mt-2 min-h-[3.5rem] text-sm leading-6 text-slate-200">
              {{ error || 'No errors reported.' }}
            </p>
          </div>
        </div>

        <div class="mt-4 flex items-center justify-between gap-4 text-[0.7rem] uppercase tracking-[0.26em] text-slate-500">
          <span>Hotkey: Ctrl/Cmd + Shift + O</span>
          <span>{{ lastUpdate }}</span>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.fade-swap-enter-active,
.fade-swap-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.fade-swap-enter-from,
.fade-swap-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
