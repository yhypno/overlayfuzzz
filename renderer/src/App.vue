<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import AppTitlebar from './components/AppTitlebar.vue';
import type {
  CaptureCollectionPayload,
  CapturePreviewPayload,
  CaptureSettings,
  LlmProvider,
  OverlayModePayload,
  OverlayResult,
} from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';
type Page = 'console' | 'settings';

interface UiPreferences {
  compactLayout: boolean;
  showConfidenceMeter: boolean;
  showFooterHints: boolean;
  animateTextUpdates: boolean;
  hideFromScreenshots: boolean;
}

const SETTINGS_STORAGE_KEY = 'overlayfuzz-ui-settings';
const PROVIDER_OPTIONS: Array<{ value: LlmProvider; label: string }> = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];

const status = ref('Press Ctrl/Cmd + Shift + O to open, then Ctrl/Cmd + Shift + 1 to capture.');
const result = ref('Waiting for screenshot.');
const confidence = ref<number | null>(null);
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');
const openHotkey = ref('Ctrl/Cmd + Shift + O');
const captureHotkey = ref('Ctrl/Cmd + Shift + 1');
const captures = ref<CapturePreviewPayload[]>([]);
const activeCaptureId = ref<string | null>(null);
const queryInputEl = ref<HTMLInputElement | null>(null);
const queryText = ref('');
const querySubmitting = ref(false);
const activePage = ref<Page>('console');
const settingsError = ref('');
const settingsNotice = ref('');
const settingsSaving = ref(false);

const preferences = ref<UiPreferences>({
  compactLayout: false,
  showConfidenceMeter: true,
  showFooterHints: true,
  animateTextUpdates: true,
  hideFromScreenshots: true,
});

function createDefaultCaptureSettings(): CaptureSettings {
  return {
    useOcr: false,
    imageLlm: {
      provider: 'openrouter',
      prompt: 'Read this screenshot and return the important text in plain form. Keep line breaks where useful.',
      config: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openai/gpt-4o-mini',
      },
    },
    taskLlm: {
      provider: 'openrouter',
      prompt: 'Using the extracted text below, return the final result in plain form. Keep line breaks where useful.',
      config: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openai/gpt-4o-mini',
      },
    },
  };
}

function providerLabel(provider: LlmProvider): string {
  const found = PROVIDER_OPTIONS.find((option) => option.value === provider);
  return found?.label || 'LLM';
}

function providerPreset(provider: LlmProvider) {
  switch (provider) {
    case 'openrouter':
      return {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openai/gpt-4o-mini',
      };
    case 'ollama':
      return {
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: '',
        model: 'llava:latest',
      };
    case 'openai':
      return {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4.1-mini',
      };
    case 'anthropic':
      return {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        model: 'claude-3-5-sonnet-latest',
      };
    case 'gemini':
      return {
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: '',
        model: 'gemini-2.0-flash',
      };
    default:
      return {
        baseUrl: '',
        apiKey: '',
        model: '',
      };
  }
}

function applyProviderDefaults(role: 'imageLlm' | 'taskLlm') {
  const roleSettings = captureSettings.value[role];
  roleSettings.config = providerPreset(roleSettings.provider);
}

const captureSettings = ref<CaptureSettings>(createDefaultCaptureSettings());
const lastSavedCaptureSettingsJson = ref(JSON.stringify(captureSettings.value));
const captureSettingsDirty = computed(
  () => JSON.stringify(captureSettings.value) !== lastSavedCaptureSettingsJson.value,
);

const stage = computed<Stage>(() => {
  if (error.value) return 'error';

  const text = `${status.value} ${lastUpdate.value}`.toLowerCase();
  if (text.includes('capturing')) return 'capturing';
  if (text.includes('running') || text.includes('process') || text.includes('extract')) return 'processing';
  if (text.includes('screenshot captured') || text.includes('done') || text.includes('complete')) return 'done';
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
const imageProviderLabel = computed(() => providerLabel(captureSettings.value.imageLlm.provider));
const taskProviderLabel = computed(() => providerLabel(captureSettings.value.taskLlm.provider));
const ocrModeLabel = computed(() => (captureSettings.value.useOcr ? 'OCR -> Task LLM' : 'Image LLM -> Task LLM'));
const llmPipelineLabel = computed(() =>
  captureSettings.value.useOcr
    ? `Task LLM: ${taskProviderLabel.value}`
    : `Image LLM: ${imageProviderLabel.value} -> Task LLM: ${taskProviderLabel.value}`,
);
const confidenceValue = computed(() => (confidence.value === null ? '--' : `${confidence.value.toFixed(1)}%`));
const hasCaptures = computed(() => captures.value.length > 0);

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
  if (value.toLowerCase().includes('screenshot captured')) {
    void nextTick(() => {
      queryInputEl.value?.focus();
      queryInputEl.value?.select();
    });
  }
}

function applyMode(payload: OverlayModePayload) {
  if (payload?.hotkeys?.quick) {
    openHotkey.value = prettifyHotkey(payload.hotkeys.quick) || openHotkey.value;
  }

  const captureShortcut = payload?.hotkeys?.capture || payload?.hotkeys?.region;
  if (captureShortcut) {
    captureHotkey.value = prettifyHotkey(captureShortcut) || captureHotkey.value;
  }

  if (payload?.mode === 'selecting') {
    status.value = 'Region selection is disabled. Use the capture shortcut instead.';
    lastUpdate.value = 'Selection disabled';
  }
}

function applyCaptureCollection(payload: CaptureCollectionPayload) {
  if (!payload || !Array.isArray(payload.captures)) {
    captures.value = [];
    activeCaptureId.value = null;
    return;
  }

  captures.value = payload.captures;
  activeCaptureId.value = payload.activeCaptureId || null;
}

function formatCaptureTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '--:--:--';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function loadCaptureSettings() {
  if (!window.overlayApi?.getSettings) {
    return;
  }

  try {
    const loaded = await window.overlayApi.getSettings();
    if (loaded) {
      captureSettings.value = loaded;
      lastSavedCaptureSettingsJson.value = JSON.stringify(loaded);
    }
  } catch (loadError) {
    settingsError.value = loadError instanceof Error ? loadError.message : String(loadError);
  }
}

async function loadCaptureCollection() {
  if (!window.overlayApi?.getCaptures) {
    return;
  }

  try {
    const payload = await window.overlayApi.getCaptures();
    applyCaptureCollection(payload);
  } catch {
    // Ignore capture history load failures and continue.
  }
}

async function saveCaptureSettings(): Promise<boolean> {
  settingsError.value = '';
  settingsNotice.value = '';

  if (!window.overlayApi?.updateSettings) {
    settingsError.value = 'Bridge unavailable. Unable to save settings.';
    return false;
  }

  settingsSaving.value = true;
  try {
    const payload = JSON.parse(JSON.stringify(captureSettings.value)) as CaptureSettings;
    const saved = await window.overlayApi.updateSettings(payload);
    captureSettings.value = saved;
    lastSavedCaptureSettingsJson.value = JSON.stringify(saved);
    settingsNotice.value = 'Saved';
    window.setTimeout(() => {
      settingsNotice.value = '';
    }, 2200);
    return true;
  } catch (saveError) {
    settingsError.value = saveError instanceof Error ? saveError.message : String(saveError);
    return false;
  } finally {
    settingsSaving.value = false;
  }
}

async function persistCaptureSettingsBeforeLeavingSettings(): Promise<boolean> {
  if (!captureSettingsDirty.value || settingsSaving.value) {
    return true;
  }

  return saveCaptureSettings();
}

async function openConsolePage() {
  const canLeave = await persistCaptureSettingsBeforeLeavingSettings();
  if (!canLeave) {
    return;
  }

  activePage.value = 'console';
}

function openSettingsPage() {
  activePage.value = 'settings';
}

async function closeOverlayFromUi() {
  const canLeave = await persistCaptureSettingsBeforeLeavingSettings();
  if (!canLeave) {
    return;
  }

  await hideConsole();
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
      hideFromScreenshots: parsed.hideFromScreenshots !== false,
    };
  } catch {
    // Ignore malformed local settings and keep defaults.
  }
}

async function syncScreenshotExclusion(enabled: boolean) {
  if (!window.overlayApi?.setScreenshotExclusion) {
    return;
  }

  try {
    await window.overlayApi.setScreenshotExclusion(enabled);
  } catch {
    // Ignore bridge errors so settings UI remains responsive.
  }
}

watch(
  preferences,
  (next) => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  },
  { deep: true },
);

watch(
  () => preferences.value.hideFromScreenshots,
  (enabled) => {
    void syncScreenshotExclusion(enabled);
  },
  { immediate: true },
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

async function submitQueryFromComposer() {
  if (querySubmitting.value) {
    return;
  }

  const normalized = queryText.value.trim();
  if (!normalized) {
    setStatus('Enter a query before sending.');
    return;
  }

  if (!window.overlayApi?.submitQuery) {
    setStatus('Bridge unavailable. Unable to send query.');
    return;
  }

  querySubmitting.value = true;
  try {
    const submitted = await window.overlayApi.submitQuery(normalized);
    if (submitted) {
      queryText.value = '';
    }
  } catch (submitError) {
    error.value = submitError instanceof Error ? submitError.message : String(submitError);
    setStatus('Failed to submit query.');
  } finally {
    querySubmitting.value = false;
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (activePage.value === 'settings') {
      void openConsolePage();
      return;
    }
    void closeOverlayFromUi();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === ',') {
    event.preventDefault();
    openSettingsPage();
  }
}

onMounted(() => {
  bridgeReady.value = Boolean(window.overlayApi);
  window.addEventListener('keydown', onWindowKeydown);
  loadPreferences();
  void loadCaptureSettings();
  void loadCaptureCollection();

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

  window.overlayApi.onCaptures((payload) => {
    applyCaptureCollection(payload);
  });
});

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <div class="app-root">
    <section class="app-shell" :class="shellClass">
      <AppTitlebar
        title="OverlayFuzz"
        :active-page="activePage"
        @console="openConsolePage"
        @settings="openSettingsPage"
        @close="closeOverlayFromUi"
      />

      <div v-if="activePage === 'console'" class="console-view no-drag">
        <div class="status-row">
          <span class="status-text">{{ status }}</span>
          <span class="status-chip">{{ stageLabel }}</span>
        </div>

        <section class="captures-panel">
          <div v-if="hasCaptures" class="captures-strip">
            <article
              v-for="(capture, index) in captures"
              :key="capture.id"
              class="capture-thumb"
              :class="{ active: capture.id === activeCaptureId }"
            >
              <img :src="capture.thumbnailDataUrl" :alt="`Screenshot ${index + 1}`" />
              <span class="capture-meta">#{{ index + 1 }} {{ formatCaptureTime(capture.capturedAt) }}</span>
            </article>
          </div>
          <p v-else class="captures-empty">No screenshots yet. Press {{ captureHotkey }} to add one.</p>
        </section>

        <section class="result-panel">
          <Transition v-if="preferences.animateTextUpdates" name="fade-swap" mode="out-in">
            <pre :key="result" class="result-output">{{ result }}</pre>
          </Transition>
          <pre v-else class="result-output">{{ result }}</pre>
        </section>

        <div class="query-row">
          <input
            ref="queryInputEl"
            class="query-input"
            type="text"
            v-model="queryText"
            placeholder="Query"
            :disabled="querySubmitting || !bridgeReady"
            @keydown.enter.prevent="submitQueryFromComposer"
          />
          <button
            type="button"
            class="send-button"
            :disabled="querySubmitting || !bridgeReady || !queryText.trim()"
            @click="submitQueryFromComposer"
          >
            {{ querySubmitting ? 'Sending' : 'Send' }}
          </button>
        </div>

        <div class="meta-row">
          <span>{{ bridgeReady ? 'Bridge connected' : 'Bridge unavailable' }}</span>
          <span v-if="preferences.showConfidenceMeter">Confidence {{ confidenceValue }}</span>
          <span v-if="error" class="meta-error">{{ error }}</span>
        </div>

        <footer class="footer-row" v-if="preferences.showFooterHints">
          <span>Open {{ openHotkey }}</span>
          <span>Capture {{ captureHotkey }}</span>
          <span>{{ ocrModeLabel }}</span>
          <span>{{ llmPipelineLabel }}</span>
        </footer>
      </div>

      <section v-else class="settings-view no-drag">
        <div class="settings-grid">
          <div class="settings-panel">
            <h2>Capture</h2>

            <label class="toggle-row">
              <span>Use OCR first</span>
              <input type="checkbox" v-model="captureSettings.useOcr" />
            </label>

            <section class="role-group" v-if="!captureSettings.useOcr">
              <h3>Image model</h3>
              <div class="field-grid">
                <label class="field">
                  <span>Provider</span>
                  <select v-model="captureSettings.imageLlm.provider" @change="applyProviderDefaults('imageLlm')">
                    <option v-for="option in PROVIDER_OPTIONS" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>

                <label class="field">
                  <span>Model</span>
                  <input type="text" v-model="captureSettings.imageLlm.config.model" />
                </label>

                <label class="field field-full">
                  <span>Base URL</span>
                  <input type="text" v-model="captureSettings.imageLlm.config.baseUrl" />
                </label>

                <label class="field field-full" v-if="captureSettings.imageLlm.provider !== 'ollama'">
                  <span>API key</span>
                  <input type="password" v-model="captureSettings.imageLlm.config.apiKey" />
                </label>
              </div>

              <label class="field field-full">
                <span>Prompt</span>
                <textarea rows="4" v-model="captureSettings.imageLlm.prompt"></textarea>
              </label>
            </section>

            <section class="role-group">
              <h3>Task model</h3>
              <div class="field-grid">
                <label class="field">
                  <span>Provider</span>
                  <select v-model="captureSettings.taskLlm.provider" @change="applyProviderDefaults('taskLlm')">
                    <option v-for="option in PROVIDER_OPTIONS" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </option>
                  </select>
                </label>

                <label class="field">
                  <span>Model</span>
                  <input type="text" v-model="captureSettings.taskLlm.config.model" />
                </label>

                <label class="field field-full">
                  <span>Base URL</span>
                  <input type="text" v-model="captureSettings.taskLlm.config.baseUrl" />
                </label>

                <label class="field field-full" v-if="captureSettings.taskLlm.provider !== 'ollama'">
                  <span>API key</span>
                  <input type="password" v-model="captureSettings.taskLlm.config.apiKey" />
                </label>
              </div>

              <label class="field field-full">
                <span>Prompt</span>
                <textarea rows="4" v-model="captureSettings.taskLlm.prompt"></textarea>
              </label>
            </section>

            <div class="settings-actions">
              <button type="button" class="save-button" @click="saveCaptureSettings" :disabled="settingsSaving">
                {{ settingsSaving ? 'Saving' : 'Save' }}
              </button>
              <span v-if="settingsNotice" class="settings-notice">{{ settingsNotice }}</span>
            </div>
            <p v-if="settingsError" class="settings-error">{{ settingsError }}</p>
          </div>

          <div class="settings-panel">
            <h2>Interface</h2>

            <label class="toggle-row">
              <span>Compact layout</span>
              <input type="checkbox" v-model="preferences.compactLayout" />
            </label>

            <label class="toggle-row">
              <span>Show confidence</span>
              <input type="checkbox" v-model="preferences.showConfidenceMeter" />
            </label>

            <label class="toggle-row">
              <span>Show hotkeys</span>
              <input type="checkbox" v-model="preferences.showFooterHints" />
            </label>

            <label class="toggle-row">
              <span>Animate output updates</span>
              <input type="checkbox" v-model="preferences.animateTextUpdates" />
            </label>

            <label class="toggle-row">
              <span>Hide in screenshots</span>
              <input type="checkbox" v-model="preferences.hideFromScreenshots" />
            </label>

            <div class="settings-meta">
              <span>{{ bridgeReady ? 'Bridge connected' : 'Bridge unavailable' }}</span>
              <span>{{ ocrModeLabel }}</span>
              <span>{{ llmPipelineLabel }}</span>
            </div>
          </div>
        </div>

        <div class="shortcuts-panel">
          <div>
            <span>Open</span>
            <strong>{{ openHotkey }}</strong>
          </div>
          <div>
            <span>Capture</span>
            <strong>{{ captureHotkey }}</strong>
          </div>
          <div>
            <span>Settings</span>
            <strong>Ctrl/Cmd + ,</strong>
          </div>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.app-root {
  width: 100%;
  height: 100%;
  padding: 8px;
  box-sizing: border-box;
}

.app-shell {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #2f2f2f;
  border-radius: 8px;
  background: #151515;
  transition: border-color 0.14s ease;
}

.console-view {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto auto auto;
  gap: 8px;
  padding: 10px;
}

.compact .console-view {
  padding: 8px;
  gap: 6px;
}

.status-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid #2b2b2b;
  border-radius: 8px;
  background: #101010;
  padding: 7px 10px;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #d7d7d7;
}

.status-chip {
  flex: 0 0 auto;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  color: #bfbfbf;
  background: #171717;
}

.captures-panel {
  border: 1px solid #2b2b2b;
  border-radius: 8px;
  background: #101010;
  min-height: 84px;
  padding: 6px;
  overflow: hidden;
}

.captures-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 2px;
}

.capture-thumb {
  flex: 0 0 116px;
  display: grid;
  gap: 4px;
}

.capture-thumb img {
  width: 100%;
  height: 64px;
  border-radius: 6px;
  border: 1px solid #2f2f2f;
  object-fit: cover;
  background: #171717;
  box-sizing: border-box;
}

.capture-thumb.active img {
  border-color: #5d7f6a;
}

.capture-meta {
  display: block;
  font-size: 10px;
  color: #a3a3a3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
}

.captures-empty {
  margin: 0;
  padding: 8px;
  font-size: 11px;
  color: #959595;
}

.result-panel {
  min-height: 0;
  border: 1px solid #2b2b2b;
  border-radius: 8px;
  background: #101010;
  overflow: hidden;
}

.result-output {
  margin: 0;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  color: #f0f0f0;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
}

.query-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.query-input {
  width: 100%;
  min-width: 0;
  border: 1px solid #3d3d3d;
  border-radius: 8px;
  background: #111111;
  color: #ececec;
  font-size: 13px;
  padding: 8px 10px;
  box-sizing: border-box;
}

.query-input::placeholder {
  color: #8a8a8a;
}

.query-input:focus-visible,
.send-button:focus-visible,
.save-button:focus-visible,
.field input:focus-visible,
.field select:focus-visible,
.field textarea:focus-visible {
  outline: 2px solid #5f5f5f;
  outline-offset: 0;
}

.send-button {
  border: 1px solid #454545;
  border-radius: 8px;
  background: #202020;
  color: #e9e9e9;
  font-size: 12px;
  font-weight: 600;
  padding: 8px 12px;
}

.send-button:disabled,
.query-input:disabled,
.save-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.meta-row {
  min-height: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  font-size: 11px;
  color: #a7a7a7;
}

.meta-error {
  color: #d39595;
}

.footer-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: #949494;
}

.settings-view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: grid;
  gap: 10px;
  padding: 10px;
  align-content: start;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.settings-panel {
  border: 1px solid #2b2b2b;
  border-radius: 8px;
  background: #101010;
  padding: 10px;
  display: grid;
  gap: 10px;
  align-content: start;
}

.settings-panel h2,
.settings-panel h3 {
  margin: 0;
  color: #ececec;
}

.settings-panel h2 {
  font-size: 14px;
  font-weight: 600;
}

.settings-panel h3 {
  font-size: 12px;
  font-weight: 600;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  color: #d7d7d7;
}

.toggle-row input[type='checkbox'] {
  accent-color: #5b8f79;
}

.role-group {
  border-top: 1px solid #2b2b2b;
  padding-top: 10px;
  display: grid;
  gap: 8px;
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.field {
  display: block;
}

.field span {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #b9b9b9;
}

.field input,
.field select,
.field textarea {
  width: 100%;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  background: #151515;
  color: #ececec;
  font-size: 13px;
  padding: 8px 10px;
  box-sizing: border-box;
}

.field textarea {
  resize: vertical;
  min-height: 92px;
}

.field-full {
  grid-column: 1 / -1;
}

.settings-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.save-button {
  border: 1px solid #454545;
  border-radius: 8px;
  background: #202020;
  color: #ececec;
  font-size: 12px;
  font-weight: 600;
  padding: 8px 12px;
}

.settings-notice {
  font-size: 12px;
  color: #89b09d;
}

.settings-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: #d39595;
  white-space: pre-wrap;
}

.settings-meta {
  border-top: 1px solid #2b2b2b;
  padding-top: 8px;
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: #adadad;
}

.shortcuts-panel {
  border: 1px solid #2b2b2b;
  border-radius: 8px;
  background: #101010;
  padding: 10px;
  display: grid;
  gap: 8px;
}

.shortcuts-panel div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: #c1c1c1;
}

.shortcuts-panel strong {
  color: #ececec;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, monospace;
  font-weight: 500;
}

.no-drag {
  -webkit-app-region: no-drag;
}

.stage-capturing {
  border-color: #3a5145;
}

.stage-processing {
  border-color: #62573d;
}

.stage-done {
  border-color: #3f5b44;
}

.stage-error {
  border-color: #6e4444;
}

.fade-swap-enter-active,
.fade-swap-leave-active {
  transition: opacity 0.14s ease;
}

.fade-swap-enter-from,
.fade-swap-leave-to {
  opacity: 0;
}

@media (max-width: 900px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 700px) {
  .query-row {
    grid-template-columns: 1fr;
  }

  .send-button {
    width: 100%;
  }

  .field-grid {
    grid-template-columns: 1fr;
  }
}
</style>
