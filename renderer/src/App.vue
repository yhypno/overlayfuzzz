<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import AppTitlebar from './components/AppTitlebar.vue';
import type { CaptureSettings, LlmProvider, OverlayModePayload, OverlayResult } from './types/overlay';

type Stage = 'idle' | 'capturing' | 'processing' | 'done' | 'error';
type Page = 'console' | 'settings';

interface UiPreferences {
  compactLayout: boolean;
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

const status = ref('Ready to capture.');
const result = ref('Waiting for capture.');
const error = ref('');
const bridgeReady = ref(false);
const lastUpdate = ref('Idle');
const queryInputEl = ref<HTMLInputElement | null>(null);
const queryText = ref('');
const querySubmitting = ref(false);
const activePage = ref<Page>('console');
const settingsError = ref('');
const settingsNotice = ref('');
const settingsSaving = ref(false);

const preferences = ref<UiPreferences>({
  compactLayout: false,
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

function setResult(payload: OverlayResult) {
  result.value = payload.text || '(no text detected)';
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
      lastSavedCaptureSettingsJson.value = JSON.stringify(loaded);
    }
  } catch (loadError) {
    settingsError.value = loadError instanceof Error ? loadError.message : String(loadError);
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

        <div v-if="error" class="meta-row">
          <span class="meta-error">{{ error }}</span>
        </div>
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
              <span>Animate output updates</span>
              <input type="checkbox" v-model="preferences.animateTextUpdates" />
            </label>

            <label class="toggle-row">
              <span>Hide in screenshots</span>
              <input type="checkbox" v-model="preferences.hideFromScreenshots" />
            </label>
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
  grid-template-rows: auto minmax(0, 1fr) auto auto;
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
