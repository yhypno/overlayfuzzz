<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { OverlayModePayload, OverlayRegion, OverlayResult } from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';
type OverlayMode = 'console' | 'selecting';
type Point = { x: number; y: number };

const status = ref('Press Ctrl/Cmd + Shift + O for quick OCR or Ctrl/Cmd + Shift + R to select a region.');
const result = ref('Waiting for OCR...');
const confidence = ref<number | null>(null);
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');
const overlayMode = ref<OverlayMode>('console');
const quickHotkey = ref('Ctrl/Cmd + Shift + O');
const regionHotkey = ref('Ctrl/Cmd + Shift + R');
const dragStart = ref<Point | null>(null);
const dragCurrent = ref<Point | null>(null);
const isSubmittingRegion = ref(false);

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

const selectionRect = computed<OverlayRegion | null>(() => {
  if (!dragStart.value || !dragCurrent.value) return null;

  const left = Math.min(dragStart.value.x, dragCurrent.value.x);
  const top = Math.min(dragStart.value.y, dragCurrent.value.y);
  const width = Math.abs(dragCurrent.value.x - dragStart.value.x);
  const height = Math.abs(dragCurrent.value.y - dragStart.value.y);

  return { x: left, y: top, width, height };
});

const selectionRectStyle = computed<Record<string, string> | null>(() => {
  if (!selectionRect.value) return null;

  return {
    left: `${selectionRect.value.x}px`,
    top: `${selectionRect.value.y}px`,
    width: `${selectionRect.value.width}px`,
    height: `${selectionRect.value.height}px`,
  };
});

const selectionLabel = computed(() => {
  if (!selectionRect.value) return '';
  return `${Math.round(selectionRect.value.width)} x ${Math.round(selectionRect.value.height)}`;
});

function prettifyHotkey(value?: string) {
  if (!value) return '';

  return value
    .replace(/CommandOrControl/gi, 'Ctrl/Cmd')
    .replace(/\+/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function clearDrag() {
  dragStart.value = null;
  dragCurrent.value = null;
}

function applyMode(payload: OverlayModePayload) {
  overlayMode.value = payload?.mode === 'selecting' ? 'selecting' : 'console';

  if (payload?.hotkeys?.quick) {
    quickHotkey.value = prettifyHotkey(payload.hotkeys.quick) || quickHotkey.value;
  }

  if (payload?.hotkeys?.region) {
    regionHotkey.value = prettifyHotkey(payload.hotkeys.region) || regionHotkey.value;
  }

  if (overlayMode.value === 'selecting') {
    clearDrag();
    error.value = '';
    confidence.value = null;
    status.value = 'Draw a rectangle to OCR. Press Esc to cancel.';
    lastUpdate.value = 'Selection mode';
  } else {
    isSubmittingRegion.value = false;
  }
}

function pointFromEvent(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  const bounds = target.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function onSelectionPointerDown(event: PointerEvent) {
  if (overlayMode.value !== 'selecting' || event.button !== 0 || isSubmittingRegion.value) return;

  event.preventDefault();
  const point = pointFromEvent(event);
  dragStart.value = point;
  dragCurrent.value = point;
  error.value = '';
  status.value = 'Drag to define the OCR region.';

  const target = event.currentTarget as HTMLElement;
  if (target?.setPointerCapture) {
    target.setPointerCapture(event.pointerId);
  }
}

function onSelectionPointerMove(event: PointerEvent) {
  if (overlayMode.value !== 'selecting' || !dragStart.value || isSubmittingRegion.value) return;
  dragCurrent.value = pointFromEvent(event);
}

async function submitRegionSelection(region: OverlayRegion) {
  if (!window.overlayApi) {
    error.value = 'Bridge unavailable';
    return;
  }

  isSubmittingRegion.value = true;
  status.value = 'Capturing selected region...';
  lastUpdate.value = 'Submitting selection';

  try {
    const response = await window.overlayApi.submitRegion(region);
    if (!response.ok) {
      error.value = response.error || 'Failed to capture selected region.';
      status.value = 'Selection failed';
      lastUpdate.value = 'Selection failed';
    }
  } catch (submissionError) {
    error.value = submissionError instanceof Error ? submissionError.message : String(submissionError);
    status.value = 'Selection failed';
    lastUpdate.value = 'Selection failed';
  } finally {
    isSubmittingRegion.value = false;
  }
}

async function onSelectionPointerUp(event: PointerEvent) {
  if (overlayMode.value !== 'selecting' || !dragStart.value || isSubmittingRegion.value) return;

  const target = event.currentTarget as HTMLElement;
  if (target?.releasePointerCapture && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }

  dragCurrent.value = pointFromEvent(event);
  const region = selectionRect.value;
  clearDrag();

  if (!region || region.width < 6 || region.height < 6) {
    status.value = 'Selection too small. Drag a larger rectangle.';
    return;
  }

  await submitRegionSelection(region);
}

function onSelectionPointerCancel(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement;
  if (target?.releasePointerCapture && target.hasPointerCapture(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }

  clearDrag();
}

function cancelSelection() {
  clearDrag();
  isSubmittingRegion.value = false;

  if (window.overlayApi) {
    window.overlayApi.cancelSelection();
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || overlayMode.value !== 'selecting') return;
  event.preventDefault();
  cancelSelection();
}

onMounted(() => {
  bridgeReady.value = Boolean(window.overlayApi);
  window.addEventListener('keydown', onWindowKeydown);

  if (!window.overlayApi) return;

  window.overlayApi.onStatus((next) => {
    setStatus(next);
  });

  window.overlayApi.onResult((payload) => {
    setResult(payload);
  });

  window.overlayApi.onMode((payload) => {
    applyMode(payload);
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <div class="relative h-screen w-screen overflow-hidden bg-transparent text-white">
    <main v-if="overlayMode === 'console'" class="relative flex h-full items-start justify-end p-4 sm:p-6">
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

        <div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-[0.66rem] uppercase tracking-[0.24em] text-slate-500">
          <span>Quick OCR: {{ quickHotkey }}</span>
          <span>Region OCR: {{ regionHotkey }}</span>
          <span>{{ lastUpdate }}</span>
        </div>
      </section>
    </main>

    <main
      v-else
      class="relative h-full w-full select-none"
      @pointerdown="onSelectionPointerDown"
      @pointermove="onSelectionPointerMove"
      @pointerup="onSelectionPointerUp"
      @pointercancel="onSelectionPointerCancel"
      @contextmenu.prevent="cancelSelection"
    >
      <div class="absolute inset-0 bg-slate-950/30 backdrop-blur-[1.2px]" />

      <div
        class="pointer-events-none absolute left-1/2 top-6 z-10 w-[min(92vw,42rem)] -translate-x-1/2 rounded-2xl border border-white/30 bg-slate-900/55 px-4 py-3 text-center text-sm leading-6 text-slate-100 shadow-[0_18px_50px_rgba(2,6,23,0.45)] backdrop-blur-md"
      >
        Drag to draw an OCR rectangle, then release to capture.
        <div class="mt-1 text-[0.68rem] uppercase tracking-[0.24em] text-slate-300">
          Press Esc or right-click to cancel
        </div>
      </div>

      <div
        v-if="selectionRect && selectionRectStyle"
        class="pointer-events-none absolute z-20 border-2 border-mint-300 bg-mint-300/12 shadow-[0_0_0_9999px_rgba(2,6,23,0.3)]"
        :style="selectionRectStyle"
      >
        <div
          class="absolute -top-7 left-0 rounded-md bg-slate-950/85 px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.18em] text-mint-200"
        >
          {{ selectionLabel }}
        </div>
      </div>

      <div
        v-if="isSubmittingRegion"
        class="pointer-events-none absolute bottom-6 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/25 bg-slate-950/80 px-4 py-2 text-[0.68rem] uppercase tracking-[0.2em] text-slate-100"
      >
        Capturing selected region...
      </div>
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
