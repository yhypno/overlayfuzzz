<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import AppTitlebar from './components/AppTitlebar.vue';
import type { CaptureSettings, LlmProvider, OverlayModePayload, OverlayResult } from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';
type Page = 'console' | 'settings';

interface UiPreferences {
  compactLayout: boolean;
  showConfidenceMeter: boolean;
  showFooterHints: boolean;
  animateTextUpdates: boolean;
}

const SETTINGS_STORAGE_KEY = 'overlayfuzz-ui-settings';
const PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];

const status = ref('Press Ctrl/Cmd + Shift + O for quick capture. Ctrl/Cmd + Shift + R mirrors quick capture.');
const result = ref('Waiting for LLM output...');
const confidence = ref<number | null>(null);
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');
const quickHotkey = ref('Ctrl/Cmd + Shift + O');
const regionHotkey = ref('Ctrl/Cmd + Shift + R');
const activePage = ref<Page>('console');
const settingsError = ref('');
const settingsNotice = ref('');
const settingsSaving = ref(false);

const preferences = ref<UiPreferences>({
  compactLayout: false,
  showConfidenceMeter: true,
  showFooterHints: true,
  animateTextUpdates: true,
});

function createDefaultCaptureSettings(): CaptureSettings {
  return {
    useOcr: false,
    provider: 'openrouter',
    prompt: 'Read this screenshot and return the important text in plain form. Keep line breaks where useful.',
    providers: {
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openai/gpt-4o-mini',
      },
      ollama: {
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
        model: 'llava:latest',
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4.1-mini',
      },
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        model: 'claude-3-5-sonnet-latest',
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: '',
        model: 'gemini-2.0-flash',
      },
    },
  };
}

const captureSettings = ref<CaptureSettings>(createDefaultCaptureSettings());

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
const shellClass = computed(() => ({
  [stageClass.value]: true,
  compact: preferences.value.compactLayout,
}));
const activeProviderLabel = computed(() => {
  const found = PROVIDER_OPTIONS.find((option) => option.value === captureSettings.value.provider);
  return found?.label || 'LLM';
});
const ocrModeLabel = computed(() => (captureSettings.value.useOcr ? 'OCR + LLM' : 'Screenshot + LLM'));

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
    status.value = 'Region selection is disabled. Running quick capture instead.';
    lastUpdate.value = 'Selection disabled';
  }
}

async function loadCaptureSettings() {
  if (!window.overlayApi?.getSettings) {
    return;
  }

  try {
    const loaded = await window.overlayApi.getSettings();
    if (loaded) {
      captureSettings.value = loaded;
    }
  } catch (loadError) {
    settingsError.value = loadError instanceof Error ? loadError.message : String(loadError);
  }
}

async function saveCaptureSettings() {
  settingsError.value = '';
  settingsNotice.value = '';

  if (!window.overlayApi?.updateSettings) {
    settingsError.value = 'Bridge unavailable. Unable to save settings.';
    return;
  }

  settingsSaving.value = true;
  try {
    const payload = JSON.parse(JSON.stringify(captureSettings.value)) as CaptureSettings;
    const saved = await window.overlayApi.updateSettings(payload);
    captureSettings.value = saved;
    settingsNotice.value = 'Saved';
    window.setTimeout(() => {
      settingsNotice.value = '';
    }, 2200);
  } catch (saveError) {
    settingsError.value = saveError instanceof Error ? saveError.message : String(saveError);
  } finally {
    settingsSaving.value = false;
  }
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;

    preferences.value = {
      compactLayout: Boolean(parsed.compactLayout),
      showConfidenceMeter: parsed.showConfidenceMeter !== false,
      showFooterHints: parsed.showFooterHints !== false,
      animateTextUpdates: parsed.animateTextUpdates !== false,
    };
  } catch {
    // Ignore malformed local settings and keep defaults.
  }
}

watch(
  preferences,
  (next) => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  },
  { deep: true },
);

async function hideConsole() {
  if (!window.overlayApi?.hideOverlay) {
    return;
  }

  try {
    await window.overlayApi.hideOverlay();
  } catch {
    // Ignore hide errors to avoid blocking the UI.
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (activePage.value === 'settings') {
      activePage.value = 'console';
      return;
    }
    void hideConsole();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === ',') {
    event.preventDefault();
    activePage.value = 'settings';
  }
}

onMounted(() => {
  bridgeReady.value = Boolean(window.overlayApi);
  window.addEventListener('keydown', onWindowKeydown);
  loadPreferences();
  void loadCaptureSettings();

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
      <section class="console-shell widget-default-style" :class="shellClass">
        <AppTitlebar
          title="OCR Console"
          :active-page="activePage"
          @console="activePage = 'console'"
          @settings="activePage = 'settings'"
          @close="hideConsole"
        />

        <div class="console-body no-drag" v-if="activePage === 'console'">
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
            <Transition v-if="preferences.animateTextUpdates" name="fade-swap" mode="out-in">
              <pre :key="result" class="result-output">{{ result }}</pre>
            </Transition>
            <pre v-else class="result-output">{{ result }}</pre>
          </section>

          <section class="metrics-row" :class="{ single: !preferences.showConfidenceMeter }">
            <div class="metric-chip" v-if="preferences.showConfidenceMeter">
              <span class="metric-label">Confidence</span>
              <span class="metric-value">{{ confidenceValue }}</span>
              <span class="metric-meter"><span :style="{ width: confidenceWidth }" /></span>
            </div>
            <div class="metric-chip">
              <span class="metric-label">Error</span>
              <span class="metric-error">{{ error || 'No errors reported.' }}</span>
            </div>
          </section>

          <footer class="console-footer" v-if="preferences.showFooterHints">
            <span>{{ quickHotkey }}</span>
            <span>{{ regionHotkey }} (mirrors quick capture)</span>
            <span>{{ ocrModeLabel }}</span>
            <span>{{ activeProviderLabel }}</span>
            <span>{{ lastUpdate }}</span>
          </footer>
        </div>

        <section v-else class="settings-view no-drag">
          <div class="settings-head">
            <h2>Settings</h2>
            <p>Configure screenshot pipeline, LLM provider, and UI preferences.</p>
          </div>

          <div class="settings-grid">
            <div class="settings-panel">
              <h3>Capture + LLM</h3>

              <label class="settings-item">
                <span>Use OCR before LLM</span>
                <input type="checkbox" v-model="captureSettings.useOcr" />
              </label>

              <label class="settings-item">
                <span>Provider</span>
                <select v-model="captureSettings.provider">
                  <option v-for="option in PROVIDER_OPTIONS" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select>
              </label>

              <label class="settings-item">
                <span>Model</span>
                <input type="text" v-model="captureSettings.providers[captureSettings.provider].model" />
              </label>

              <label class="settings-item">
                <span>Base URL</span>
                <input type="text" v-model="captureSettings.providers[captureSettings.provider].baseUrl" />
              </label>

              <label class="settings-item" v-if="captureSettings.provider !== 'ollama'">
                <span>API key</span>
                <input type="password" v-model="captureSettings.providers[captureSettings.provider].apiKey" />
              </label>

              <label class="settings-item settings-item-column">
                <span>Prompt</span>
                <textarea rows="4" v-model="captureSettings.prompt" />
              </label>

              <div class="settings-actions">
                <button type="button" @click="saveCaptureSettings" :disabled="settingsSaving">
                  {{ settingsSaving ? 'Saving...' : 'Save LLM Settings' }}
                </button>
                <span v-if="settingsNotice" class="settings-notice">{{ settingsNotice }}</span>
              </div>
              <p v-if="settingsError" class="settings-error">{{ settingsError }}</p>
            </div>

            <div class="settings-panel">
              <h3>UI Preferences</h3>

              <label class="settings-item">
                <span>Compact layout</span>
                <input type="checkbox" v-model="preferences.compactLayout" />
              </label>

              <label class="settings-item">
                <span>Show confidence meter</span>
                <input type="checkbox" v-model="preferences.showConfidenceMeter" />
              </label>

              <label class="settings-item">
                <span>Show footer hints</span>
                <input type="checkbox" v-model="preferences.showFooterHints" />
              </label>

              <label class="settings-item">
                <span>Animate result updates</span>
                <input type="checkbox" v-model="preferences.animateTextUpdates" />
              </label>
            </div>
          </div>

          <div class="settings-shortcuts">
            <div>
              <span>Quick Capture</span>
              <strong>{{ quickHotkey }}</strong>
            </div>
            <div>
              <span>Region Capture</span>
              <strong>{{ regionHotkey }}</strong>
            </div>
            <div>
              <span>Open Settings</span>
              <strong>Ctrl/Cmd + ,</strong>
            </div>
          </div>
        </section>
      </section>
    </main>
  </div>
</template>

<style scoped>
.overlay-bg {
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at 82% 8%, rgba(59, 130, 246, 0.15), rgba(2, 6, 23, 0.32) 38%, rgba(2, 6, 23, 0.62));
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

.compact .console-body {
  gap: 6px;
  padding: 0.35rem;
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

.metrics-row.single {
  grid-template-columns: 1fr;
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

.settings-view {
  height: calc(100% - 47px);
  padding: 0.6rem;
  display: grid;
  gap: 0.75rem;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.settings-head h2 {
  margin: 0;
  font-size: 0.9rem;
  color: rgba(229, 231, 235, 1);
}

.settings-head p {
  margin: 0.2rem 0 0;
  font-size: 0.66rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 1);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
  overflow: auto;
}

.settings-panel {
  border: 1px solid rgba(55, 65, 81, 1);
  border-radius: 0.35rem;
  background: rgba(17, 24, 39, 0.88);
  overflow: hidden;
}

.settings-panel h3 {
  margin: 0;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid rgba(55, 65, 81, 0.7);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 1);
}

.settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid rgba(55, 65, 81, 0.6);
  font-size: 0.72rem;
  color: rgba(229, 231, 235, 1);
}

.settings-item input[type='checkbox'] {
  accent-color: rgba(14, 165, 233, 1);
}

.settings-item input[type='text'],
.settings-item input[type='password'],
.settings-item select,
.settings-item textarea {
  width: min(260px, 55%);
  border-radius: 0.25rem;
  border: 1px solid rgba(71, 85, 105, 0.9);
  background: rgba(15, 23, 42, 0.95);
  color: rgba(226, 232, 240, 1);
  font-size: 0.68rem;
  padding: 0.3rem 0.45rem;
}

.settings-item textarea {
  width: 100%;
  min-height: 4.8rem;
  resize: vertical;
  margin-top: 0.35rem;
}

.settings-item-column {
  align-items: flex-start;
  flex-direction: column;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 0.6rem 0.6rem;
}

.settings-actions button {
  border: 1px solid rgba(56, 189, 248, 0.55);
  background: rgba(14, 116, 144, 0.48);
  color: rgba(224, 242, 254, 1);
  border-radius: 0.3rem;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.34rem 0.55rem;
}

.settings-actions button:disabled {
  cursor: default;
  opacity: 0.55;
}

.settings-notice {
  font-size: 0.63rem;
  color: rgba(134, 239, 172, 0.96);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.settings-error {
  margin: 0;
  padding: 0 0.6rem 0.58rem;
  font-size: 0.66rem;
  color: rgba(254, 202, 202, 0.96);
  line-height: 1.3;
  white-space: pre-wrap;
}

.settings-shortcuts {
  border: 1px solid rgba(55, 65, 81, 1);
  border-radius: 0.35rem;
  background: rgba(15, 23, 42, 0.88);
  padding: 0.55rem 0.6rem;
  display: grid;
  gap: 0.34rem;
}

.settings-shortcuts div {
  display: flex;
  justify-content: space-between;
  gap: 0.8rem;
  font-size: 0.66rem;
  color: rgba(148, 163, 184, 1);
}

.settings-shortcuts strong {
  color: rgba(229, 231, 235, 1);
  font-family: 'SFMono-Regular', Consolas, Monaco, monospace;
  font-size: 0.64rem;
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
  border-radius: 0.3rem;
  background: rgba(17, 24, 39, 0.95);
  border: 1px solid rgba(51, 65, 85, 0.8);
  box-shadow:
    0 6px 16px rgba(2, 6, 23, 0.6),
    0 2px 6px rgba(2, 6, 23, 0.55);
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

  .settings-grid {
    grid-template-columns: 1fr;
  }

  .settings-item input[type='text'],
  .settings-item input[type='password'],
  .settings-item select {
    width: 58%;
  }

  .settings-view {
    padding: 0.45rem;
  }
}
</style>
