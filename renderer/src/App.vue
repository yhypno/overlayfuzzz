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

const stageClass = computed(() => `stage-${stage.value}`);

const confidenceValue = computed(() =>
  confidence.value === null ? '--' : `${confidence.value.toFixed(1)}%`,
);

const confidenceWidth = computed(() => {
  const raw = confidence.value ?? 0;
  return `${Math.max(0, Math.min(100, raw))}%`;
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
    <main v-if="overlayMode === 'console'" class="h-full w-full p-2">
      <section class="console-shell" :class="stageClass">
        <header class="console-titlebar drag-region">
          <div class="titlebar-left">
            <p class="titlebar-app">OverlayFuzz</p>
            <p class="titlebar-subtitle">OCR Console</p>
          </div>
          <div class="titlebar-right">
            <span class="state-pill">{{ stageLabel }}</span>
            <span class="bridge-pill no-drag">{{ bridgeReady ? 'Bridge Online' : 'Bridge Offline' }}</span>
          </div>
        </header>

        <div class="console-body no-drag">
          <p class="status-text">
            {{ status }}
          </p>

          <div class="result-panel">
            <div class="result-topline">
              <span>Detected Text</span>
              <span>{{ lastUpdate }}</span>
            </div>
            <Transition name="fade-swap" mode="out-in">
              <pre :key="result" class="result-output">{{ result }}</pre>
            </Transition>
            <div class="confidence-track">
              <div class="confidence-fill" :style="{ width: confidenceWidth }" />
            </div>
          </div>

          <div class="meta-grid">
            <div class="meta-card">
              <p class="meta-label">Confidence</p>
              <p class="meta-value">{{ confidenceValue }}</p>
            </div>
            <div class="meta-card">
              <p class="meta-label">Error</p>
              <p class="meta-error">{{ error || 'No errors reported.' }}</p>
            </div>
          </div>

          <footer class="console-footer">
            <span>Quick: {{ quickHotkey }}</span>
            <span>Region: {{ regionHotkey }}</span>
            <span>Drag title bar. Resize from window edges.</span>
          </footer>
        </div>
        <div class="resize-grip no-drag" aria-hidden="true" />
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
.console-shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background:
    radial-gradient(circle at 22% -12%, rgba(92, 214, 255, 0.14), transparent 42%),
    radial-gradient(circle at 100% 120%, rgba(255, 183, 76, 0.1), transparent 44%),
    linear-gradient(180deg, rgba(10, 17, 31, 0.94), rgba(5, 10, 20, 0.95));
  box-shadow:
    0 26px 90px rgba(2, 8, 25, 0.62),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.console-shell::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.25;
  background-image: linear-gradient(to bottom, rgba(164, 186, 235, 0.1) 1px, transparent 1px);
  background-size: 100% 18px;
}

.console-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02));
}

.titlebar-left {
  min-width: 0;
}

.titlebar-app {
  margin: 0;
  font-size: 0.68rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: rgba(163, 230, 249, 0.88);
}

.titlebar-subtitle {
  margin: 4px 0 0;
  font-size: 0.88rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(226, 232, 240, 0.86);
}

.titlebar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.state-pill,
.bridge-pill {
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  padding: 4px 9px;
  font-size: 0.64rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: rgba(226, 232, 240, 0.92);
}

.console-body {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-rows: auto 1fr auto auto;
  gap: 10px;
  height: calc(100% - 61px);
  padding: 12px;
}

.status-text {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.6;
  color: rgba(203, 213, 225, 0.9);
}

.result-panel {
  display: grid;
  grid-template-rows: auto 1fr auto;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.65);
  overflow: hidden;
}

.result-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  padding: 8px 10px;
  font-size: 0.65rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 0.92);
}

.result-output {
  margin: 0;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.88rem;
  line-height: 1.55;
  color: rgba(241, 245, 249, 0.96);
  font-family: 'SFMono-Regular', Consolas, Monaco, monospace;
}

.confidence-track {
  height: 4px;
  background: rgba(15, 23, 42, 0.8);
}

.confidence-fill {
  height: 100%;
  background: linear-gradient(90deg, rgba(125, 211, 252, 0.9), rgba(74, 222, 128, 0.92), rgba(251, 191, 36, 0.94));
  transition: width 0.26s ease;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.meta-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  padding: 9px 10px;
}

.meta-label {
  margin: 0;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: rgba(148, 163, 184, 0.9);
}

.meta-value {
  margin: 6px 0 0;
  font-size: 1.4rem;
  line-height: 1;
  font-weight: 600;
  color: rgba(248, 250, 252, 0.96);
}

.meta-error {
  margin: 6px 0 0;
  min-height: 2.8rem;
  font-size: 0.75rem;
  line-height: 1.45;
  color: rgba(241, 245, 249, 0.88);
}

.console-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 0;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(148, 163, 184, 0.86);
}

.resize-grip {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 12px;
  height: 12px;
  border-right: 2px solid rgba(148, 163, 184, 0.75);
  border-bottom: 2px solid rgba(148, 163, 184, 0.75);
  opacity: 0.78;
  pointer-events: none;
}

.drag-region {
  -webkit-app-region: drag;
  user-select: none;
}

.no-drag {
  -webkit-app-region: no-drag;
}

.stage-capturing {
  border-color: rgba(56, 189, 248, 0.52);
}

.stage-processing {
  border-color: rgba(251, 191, 36, 0.52);
}

.stage-done {
  border-color: rgba(74, 222, 128, 0.52);
}

.stage-error {
  border-color: rgba(251, 113, 133, 0.58);
}

.stage-error .meta-error {
  color: rgba(254, 205, 211, 0.96);
}

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

@media (max-width: 780px) {
  .meta-grid {
    grid-template-columns: 1fr;
  }

  .titlebar-right {
    justify-content: flex-start;
  }
}
</style>
