<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import AppTitlebar from './components/AppTitlebar.vue';
import type { OverlayModePayload, OverlayResult } from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';

const status = ref('Press Ctrl/Cmd + Shift + O for quick OCR. Ctrl/Cmd + Shift + R mirrors quick OCR.');
const result = ref('Waiting for OCR...');
const confidence = ref<number | null>(null);
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');
const quickHotkey = ref('Ctrl/Cmd + Shift + O');
const regionHotkey = ref('Ctrl/Cmd + Shift + R');

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

function applyMode(payload: OverlayModePayload) {
  if (payload?.hotkeys?.quick) {
    quickHotkey.value = prettifyHotkey(payload.hotkeys.quick) || quickHotkey.value;
  }

  if (payload?.hotkeys?.region) {
    regionHotkey.value = prettifyHotkey(payload.hotkeys.region) || regionHotkey.value;
  }

  if (payload?.mode === 'selecting') {
    status.value = 'Region selection is disabled. Running quick OCR instead.';
    lastUpdate.value = 'Selection disabled';
  }
}

function hideConsole() {
  if (!window.overlayApi?.hideOverlay) {
    return;
  }

  window.overlayApi.hideOverlay();
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  hideConsole();
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
    <main id="overlay-window" class="relative h-full w-full overflow-hidden">
      <div class="overlay-bg" />
      <section class="console-shell widget-default-style" :class="stageClass">
        <AppTitlebar title="OCR Console" @close="hideConsole" />

        <div class="console-body no-drag">
          <div class="status-row">
            <span class="status-label">Status</span>
            <span class="status-value">{{ status }}</span>
            <span class="status-stage">{{ stageLabel }}</span>
          </div>

          <section class="result-panel">
            <div class="result-head">
              <span>Detected text</span>
              <span>{{ bridgeReady ? 'Bridge connected' : 'Bridge unavailable' }}</span>
            </div>
            <Transition name="fade-swap" mode="out-in">
              <pre :key="result" class="result-output">{{ result }}</pre>
            </Transition>
          </section>

          <section class="metrics-row">
            <div class="metric-chip">
              <span class="metric-label">Confidence</span>
              <span class="metric-value">{{ confidenceValue }}</span>
              <span class="metric-meter"><span :style="{ width: confidenceWidth }" /></span>
            </div>
            <div class="metric-chip">
              <span class="metric-label">Error</span>
              <span class="metric-error">{{ error || 'No errors reported.' }}</span>
            </div>
          </section>

          <footer class="console-footer">
            <span>{{ quickHotkey }}</span>
            <span>{{ regionHotkey }} (mirrors quick OCR)</span>
            <span>{{ lastUpdate }}</span>
          </footer>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.overlay-bg {
  position: absolute;
  inset: 0;
  background: rgba(129, 139, 149, 0.15);
  pointer-events: none;
}

.console-shell {
  position: absolute;
  top: 8px;
  right: 8px;
  width: calc(100% - 16px);
  height: calc(100% - 16px);
  overflow: hidden;
}

.console-body {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  height: calc(100% - 47px);
  padding: 0.45rem;
}

.status-row {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  min-width: 0;
  font-size: 0.68rem;
}

.status-label {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(148, 163, 184, 1);
  flex: 0 0 auto;
}

.status-value {
  color: rgba(229, 231, 235, 1);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.status-stage {
  margin-left: auto;
  border: 1px solid rgba(75, 85, 99, 1);
  border-radius: 999px;
  background: rgba(31, 41, 55, 1);
  padding: 0 0.45rem;
  line-height: 1.15rem;
  font-size: 0.54rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(156, 163, 175, 1);
  flex: 0 0 auto;
}

.result-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  border: 1px solid rgba(55, 65, 81, 1);
  border-radius: 0.3rem;
  background: rgba(17, 24, 39, 0.9);
  overflow: hidden;
}

.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  border-bottom: 1px solid rgba(55, 65, 81, 1);
  background: rgba(31, 41, 55, 0.6);
  padding: 0.34rem 0.45rem;
  font-size: 0.56rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 1);
}

.result-output {
  margin: 0;
  min-height: 0;
  overflow: auto;
  padding: 0.45rem;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.78rem;
  line-height: 1.36;
  color: rgba(243, 244, 246, 1);
  font-family: 'SFMono-Regular', Consolas, Monaco, monospace;
}

.metrics-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.metric-chip {
  border: 1px solid rgba(55, 65, 81, 1);
  border-radius: 0.3rem;
  background: rgba(17, 24, 39, 0.9);
  padding: 0.34rem 0.45rem;
  display: grid;
  gap: 0.22rem;
}

.metric-label {
  font-size: 0.56rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(148, 163, 184, 1);
}

.metric-value {
  font-size: 1.05rem;
  font-weight: 600;
  line-height: 1.1;
  color: rgba(229, 231, 235, 1);
}

.metric-meter {
  margin-top: 0.1rem;
  width: 100%;
  height: 0.2rem;
  border-radius: 999px;
  background: rgba(31, 41, 55, 1);
  overflow: hidden;
}

.metric-meter > span {
  display: block;
  height: 100%;
  background: rgba(209, 213, 219, 1);
  transition: width 0.2s ease;
}

.metric-error {
  font-size: 0.66rem;
  line-height: 1.3;
  color: rgba(229, 231, 235, 1);
  min-height: 2.1rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.console-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.55rem;
  margin: 0;
  font-size: 0.56rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: rgba(148, 163, 184, 1);
}

.no-drag {
  -webkit-app-region: no-drag;
}

.stage-capturing {
  border-color: rgba(96, 165, 250, 1);
}

.stage-processing {
  border-color: rgba(250, 204, 21, 1);
}

.stage-done {
  border-color: rgba(74, 222, 128, 1);
}

.stage-error {
  border-color: rgba(248, 113, 113, 1);
}

.stage-error .metric-error {
  color: rgba(254, 205, 211, 0.96);
}

.widget-default-style {
  border-radius: 0.25rem;
  background: rgba(17, 24, 39, 1);
  box-shadow:
    0 1px 3px 0 rgba(0, 0, 0, 0.75),
    0 1px 2px 0 rgba(0, 0, 0, 0.75);
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

@media (max-width: 720px) {
  .metrics-row {
    grid-template-columns: 1fr;
  }
}
</style>
