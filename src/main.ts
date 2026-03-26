import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  type BrowserWindowConstructorOptions,
  type Display,
} from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import screenshot from 'screenshot-desktop';

const HOTKEY_QUICK_CAPTURE = 'CommandOrControl+Shift+O';
const HOTKEY_REGION_CAPTURE = 'CommandOrControl+Shift+R';
const HOTKEY_DEBOUNCE_MS = 250;
const CAPTURE_SIZE = { width: 700, height: 260 };
const OVERLAY_TARGET_TITLE = (process.env.OVERLAY_FUZZ_TARGET_WINDOW_TITLE || '').trim();
const ENABLE_OVERLAY_ATTACH = (process.env.OVERLAY_FUZZ_ATTACH_TO_TARGET || '').trim() === '1';
const VITE_DEV_SERVER_URL = (process.env.VITE_DEV_SERVER_URL || '').trim();
const PROJECT_ROOT = path.join(__dirname, '..');
const RENDERER_DIST_INDEX = path.join(PROJECT_ROOT, 'renderer', 'dist', 'index.html');
const LEGACY_RENDERER_INDEX = path.join(PROJECT_ROOT, 'build', 'renderer', 'index.html');
const OVERLAY_MODES = {
  CONSOLE: 'console',
} as const;
const CONSOLE_MIN_SIZE = { width: 520, height: 360 };
const CONSOLE_DEFAULT_SIZE = { width: 760, height: 540 };
const CONSOLE_WINDOW_MARGIN = 28;
const OCR_WORKER_ENTRY = path.join(__dirname, 'ocr-worker.js');
const CAPTURE_SETTINGS_FILE = 'overlayfuzz-settings.json';
const LLM_PROVIDERS = ['openrouter', 'ollama', 'openai', 'anthropic', 'gemini'] as const;

type LlmProvider = (typeof LLM_PROVIDERS)[number];

interface LlmProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface CaptureSettings {
  useOcr: boolean;
  provider: LlmProvider;
  prompt: string;
  providers: Record<LlmProvider, LlmProviderConfig>;
}

const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  useOcr: false,
  provider: 'openrouter',
  prompt: 'Read this screenshot and return the important text in plain form. Keep line breaks where useful.',
  providers: {
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
      model: 'openai/gpt-4o-mini',
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      model: 'llava:latest',
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: (process.env.OPENAI_API_KEY || '').trim(),
      model: 'gpt-4.1-mini',
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com',
      apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
      model: 'claude-3-5-sonnet-latest',
    },
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
      model: 'gemini-2.0-flash',
    },
  },
};

type OverlayMode = (typeof OVERLAY_MODES)[keyof typeof OVERLAY_MODES];

interface OcrResultPayload {
  text: string;
  confidence: number | null;
}

interface OcrPendingRequest {
  resolve: (payload: OcrResultPayload) => void;
  reject: (error: Error) => void;
}

interface OverlayWindowController {
  attachByTitle: (targetWindow: BrowserWindow, title: string, options?: { hasTitleBarOnMac?: boolean }) => void;
}

interface OverlayWindowBackend {
  defaults: Partial<BrowserWindowConstructorOptions>;
  controller: OverlayWindowController | null;
}

interface UiohookEvent {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  keycode?: number;
}

interface UiohookBackend {
  hook: {
    on: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
    off?: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
    removeListener?: (event: 'keydown', listener: (event: UiohookEvent) => void) => void;
    start: () => void;
    stop?: () => void;
  };
  keycodes: Record<string, number | undefined>;
}

type OcrWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; requestId: number; status?: string }
  | { type: 'result'; requestId: number; text?: string; confidence?: number | null }
  | { type: 'error'; requestId: number; error?: string };

let overlayWindow: BrowserWindow | null = null;
let isCapturing = false;
let ocrWorkerThread: Worker | null = null;
let ocrWorkerRequestSeq = 0;
const ocrWorkerPending = new Map<number, OcrPendingRequest>();
let hotkeyManager: { start: () => void; dispose: () => void } | null = null;
let displaySyncCleanup: (() => void) | null = null;
let overlayBridgeInitialized = false;
let isAppQuitting = false;
let overlayMode: OverlayMode = OVERLAY_MODES.CONSOLE;
let consoleWindowBounds: Electron.Rectangle | null = null;
let captureSettings: CaptureSettings = cloneCaptureSettings(DEFAULT_CAPTURE_SETTINGS);
let hideOverlayFromScreenshots = true;

function safeRequire(moduleName: string): { module: any; error: Error | null } {
  try {
    return { module: require(moduleName), error: null };
  } catch (error) {
    return { module: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function resolveUiohookBackend(): UiohookBackend | null {
  const loaded = safeRequire('uiohook-napi');

  if (!loaded.module) {
    return null;
  }

  const mod = loaded.module;
  const hook = mod.uIOhook || mod.uiohook || mod.default?.uIOhook || mod.default?.uiohook || mod.default || mod;
  const keycodes = mod.UiohookKey || mod.default?.UiohookKey || mod.keycodes || mod.keys || {};

  if (!hook || typeof hook.on !== 'function' || typeof hook.start !== 'function') {
    return null;
  }

  if (keycodes.O === undefined || keycodes.R === undefined) {
    return null;
  }

  return { hook, keycodes };
}

function resolveOverlayWindowBackend(): OverlayWindowBackend | null {
  const loaded = safeRequire('electron-overlay-window');

  if (!loaded.module) {
    return null;
  }

  const mod = loaded.module;
  const defaults = mod.OVERLAY_WINDOW_OPTS || mod.default?.OVERLAY_WINDOW_OPTS || {};
  let controller = mod.OverlayController || mod.default?.OverlayController || null;

  if (!controller && typeof mod.attachByTitle === 'function') {
    controller = mod;
  }

  if (typeof controller === 'function' && controller.prototype?.attachByTitle) {
    try {
      controller = new controller();
    } catch {
      // Fall back to the original export shape if instantiation is not supported.
    }
  }

  if (!controller || typeof controller.attachByTitle !== 'function') {
    return { defaults, controller: null };
  }

  return { defaults, controller };
}

const overlayWindowBackend = resolveOverlayWindowBackend();

function getOverlayWindowOptions(): BrowserWindowConstructorOptions {
  return {
    ...(overlayWindowBackend?.defaults || {}),
    width: CONSOLE_DEFAULT_SIZE.width,
    height: CONSOLE_DEFAULT_SIZE.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    movable: true,
    minWidth: CONSOLE_MIN_SIZE.width,
    minHeight: CONSOLE_MIN_SIZE.height,
    hasShadow: false,
    focusable: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

function getCursorDisplay(): Display {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDisplayWorkArea(display: Display | null): Electron.Rectangle | null {
  return display?.workArea || display?.bounds || null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  return value.trim();
}

function cloneCaptureSettings(settings: CaptureSettings): CaptureSettings {
  return {
    useOcr: Boolean(settings.useOcr),
    provider: settings.provider,
    prompt: settings.prompt,
    providers: {
      openrouter: { ...settings.providers.openrouter },
      ollama: { ...settings.providers.ollama },
      openai: { ...settings.providers.openai },
      anthropic: { ...settings.providers.anthropic },
      gemini: { ...settings.providers.gemini },
    },
  };
}

function normalizeProvider(value: unknown, fallback: LlmProvider): LlmProvider {
  if (typeof value !== 'string') {
    return fallback;
  }

  const lowered = value.trim().toLowerCase();
  if ((LLM_PROVIDERS as readonly string[]).includes(lowered)) {
    return lowered as LlmProvider;
  }

  return fallback;
}

function sanitizeProviderConfig(value: unknown, fallback: LlmProviderConfig): LlmProviderConfig {
  const source = typeof value === 'object' && value ? (value as Partial<LlmProviderConfig>) : {};
  return {
    baseUrl: normalizeString(source.baseUrl, fallback.baseUrl),
    apiKey: normalizeString(source.apiKey, fallback.apiKey),
    model: normalizeString(source.model, fallback.model),
  };
}

function sanitizeCaptureSettings(input: unknown, fallback: CaptureSettings = DEFAULT_CAPTURE_SETTINGS): CaptureSettings {
  const defaults = cloneCaptureSettings(fallback);
  const source = typeof input === 'object' && input ? (input as Partial<CaptureSettings>) : {};
  const sourceProviders = typeof source.providers === 'object' && source.providers ? source.providers : {};

  const prompt = normalizeString(source.prompt, defaults.prompt) || defaults.prompt;
  const provider = normalizeProvider(source.provider, defaults.provider);

  return {
    useOcr: typeof source.useOcr === 'boolean' ? source.useOcr : defaults.useOcr,
    provider,
    prompt,
    providers: {
      openrouter: sanitizeProviderConfig((sourceProviders as Record<string, unknown>).openrouter, defaults.providers.openrouter),
      ollama: sanitizeProviderConfig((sourceProviders as Record<string, unknown>).ollama, defaults.providers.ollama),
      openai: sanitizeProviderConfig((sourceProviders as Record<string, unknown>).openai, defaults.providers.openai),
      anthropic: sanitizeProviderConfig((sourceProviders as Record<string, unknown>).anthropic, defaults.providers.anthropic),
      gemini: sanitizeProviderConfig((sourceProviders as Record<string, unknown>).gemini, defaults.providers.gemini),
    },
  };
}

function getCaptureSettingsPath(): string {
  return path.join(app.getPath('userData'), CAPTURE_SETTINGS_FILE);
}

function loadCaptureSettingsFromDisk(): CaptureSettings {
  try {
    const filePath = getCaptureSettingsPath();
    if (!fs.existsSync(filePath)) {
      return cloneCaptureSettings(DEFAULT_CAPTURE_SETTINGS);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return cloneCaptureSettings(DEFAULT_CAPTURE_SETTINGS);
    }

    const parsed = JSON.parse(raw);
    return sanitizeCaptureSettings(parsed, DEFAULT_CAPTURE_SETTINGS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[overlayFuzz] Failed to load settings. Using defaults:', message);
    return cloneCaptureSettings(DEFAULT_CAPTURE_SETTINGS);
  }
}

function persistCaptureSettings(nextSettings: CaptureSettings): void {
  try {
    const filePath = getCaptureSettingsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextSettings, null, 2), 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[overlayFuzz] Failed to save settings:', message);
  }
}

function extractTextFromContentBlock(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const fragments = content
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') return '';

        const maybeText = (entry as { text?: unknown }).text;
        return typeof maybeText === 'string' ? maybeText : '';
      })
      .filter((entry) => entry.trim());
    return fragments.join('\n').trim();
  }

  return '';
}

function extractHttpError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const objectBody = body as Record<string, any>;

    if (typeof objectBody.error === 'string' && objectBody.error.trim()) {
      return objectBody.error;
    }

    if (objectBody.error && typeof objectBody.error.message === 'string' && objectBody.error.message.trim()) {
      return objectBody.error.message;
    }

    if (typeof objectBody.message === 'string' && objectBody.message.trim()) {
      return objectBody.message;
    }
  }

  return `HTTP ${status}`;
}

async function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let parsed: any = null;

  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { message: raw };
    }
  }

  if (!response.ok) {
    throw new Error(extractHttpError(parsed, response.status));
  }

  return parsed;
}

function buildPrompt(prompt: string, ocrHint: string): string {
  const basePrompt = prompt.trim() || DEFAULT_CAPTURE_SETTINGS.prompt;
  const normalizedHint = ocrHint.trim();

  if (!normalizedHint) {
    return basePrompt;
  }

  return `${basePrompt}\n\nOCR hint (may include mistakes):\n${normalizedHint}`;
}

function ensureApiKey(
  provider: LlmProvider,
  apiKey: string,
  providerConfigs?: Record<LlmProvider, LlmProviderConfig>,
): void {
  if (provider === 'ollama') {
    return;
  }

  if (!apiKey.trim()) {
    const providerName = providerLabel(provider);
    const configuredElsewhere = providerConfigs
      ? LLM_PROVIDERS.filter((candidate) => candidate !== provider && providerConfigs[candidate].apiKey.trim())
      : [];

    if (configuredElsewhere.length > 0) {
      const configuredLabels = configuredElsewhere.map((candidate) => providerLabel(candidate)).join(', ');
      throw new Error(
        `Missing API key for ${providerName}. A key exists for ${configuredLabels}. Choose the matching provider or add a ${providerName} key in Settings, then save.`,
      );
    }

    throw new Error(`Missing API key for ${providerName}. Add it in Settings for ${providerName}, then save.`);
  }
}

function providerLabel(provider: LlmProvider): string {
  switch (provider) {
    case 'openrouter':
      return 'OpenRouter';
    case 'ollama':
      return 'Ollama';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    default:
      return provider;
  }
}

async function requestOpenAiCompatible(
  provider: LlmProvider,
  config: LlmProviderConfig,
  prompt: string,
  imageBase64: string,
  extraHeaders: Record<string, string> = {},
  providerConfigs?: Record<LlmProvider, LlmProviderConfig>,
): Promise<string> {
  ensureApiKey(provider, config.apiKey, providerConfigs);
  if (!config.model.trim()) {
    throw new Error(`Missing model for ${provider}. Update it in Settings.`);
  }
  if (!config.baseUrl.trim()) {
    throw new Error(`Missing base URL for ${provider}. Update it in Settings.`);
  }

  const endpoint = `${stripTrailingSlash(config.baseUrl)}/chat/completions`;
  const payload = await postJson(
    endpoint,
    {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${imageBase64}`,
              },
            },
          ],
        },
      ],
    },
    {
      Authorization: `Bearer ${config.apiKey}`,
      ...extraHeaders,
    },
  );

  const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const messageContent = firstChoice?.message?.content;
  const text = extractTextFromContentBlock(messageContent);

  if (!text) {
    throw new Error(`${providerLabel(provider)} returned an empty response.`);
  }

  return text;
}

async function requestOllama(config: LlmProviderConfig, prompt: string, imageBase64: string): Promise<string> {
  if (!config.model.trim()) {
    throw new Error('Missing model for ollama. Update it in Settings.');
  }
  if (!config.baseUrl.trim()) {
    throw new Error('Missing base URL for ollama. Update it in Settings.');
  }

  const endpoint = `${stripTrailingSlash(config.baseUrl)}/api/chat`;
  const payload = await postJson(endpoint, {
    model: config.model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [imageBase64],
      },
    ],
  });

  const text = extractTextFromContentBlock(payload?.message?.content);
  if (!text) {
    throw new Error('Ollama returned an empty response.');
  }

  return text;
}

async function requestAnthropic(
  config: LlmProviderConfig,
  prompt: string,
  imageBase64: string,
  providerConfigs?: Record<LlmProvider, LlmProviderConfig>,
): Promise<string> {
  ensureApiKey('anthropic', config.apiKey, providerConfigs);
  if (!config.model.trim()) {
    throw new Error('Missing model for anthropic. Update it in Settings.');
  }
  if (!config.baseUrl.trim()) {
    throw new Error('Missing base URL for anthropic. Update it in Settings.');
  }

  const endpoint = `${stripTrailingSlash(config.baseUrl)}/v1/messages`;
  const payload = await postJson(
    endpoint,
    {
      model: config.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: imageBase64,
              },
            },
          ],
        },
      ],
    },
    {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
  );

  const text = extractTextFromContentBlock(payload?.content);
  if (!text) {
    throw new Error('Anthropic returned an empty response.');
  }

  return text;
}

async function requestGemini(
  config: LlmProviderConfig,
  prompt: string,
  imageBase64: string,
  providerConfigs?: Record<LlmProvider, LlmProviderConfig>,
): Promise<string> {
  ensureApiKey('gemini', config.apiKey, providerConfigs);
  if (!config.model.trim()) {
    throw new Error('Missing model for gemini. Update it in Settings.');
  }
  if (!config.baseUrl.trim()) {
    throw new Error('Missing base URL for gemini. Update it in Settings.');
  }

  const endpoint = `${stripTrailingSlash(config.baseUrl)}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const payload = await postJson(endpoint, {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/png',
              data: imageBase64,
            },
          },
        ],
      },
    ],
  });

  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0];
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : [];
  const text = parts
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .filter((part: string) => part.trim())
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Gemini returned an empty response.');
  }

  return text;
}

async function runLlmCapture(imageBuffer: Buffer, activeSettings: CaptureSettings, ocrHint: string): Promise<string> {
  const provider = activeSettings.provider;
  const providerConfig = activeSettings.providers[provider];
  const prompt = buildPrompt(activeSettings.prompt, ocrHint);
  const imageBase64 = imageBuffer.toString('base64');

  if (provider === 'openrouter') {
    return requestOpenAiCompatible(provider, providerConfig, prompt, imageBase64, {
      'HTTP-Referer': 'https://overlayfuzz.local',
      'X-Title': 'overlayFuzz',
    }, activeSettings.providers);
  }

  if (provider === 'openai') {
    return requestOpenAiCompatible(provider, providerConfig, prompt, imageBase64, {}, activeSettings.providers);
  }

  if (provider === 'ollama') {
    return requestOllama(providerConfig, prompt, imageBase64);
  }

  if (provider === 'anthropic') {
    return requestAnthropic(providerConfig, prompt, imageBase64, activeSettings.providers);
  }

  return requestGemini(providerConfig, prompt, imageBase64, activeSettings.providers);
}

function getConsoleBoundsForDisplay(
  display: Display | null,
  sourceBounds: Electron.Rectangle | null = null,
): Electron.Rectangle {
  const workArea = getDisplayWorkArea(display);
  if (!workArea) {
    return sourceBounds || consoleWindowBounds || { ...CONSOLE_DEFAULT_SIZE, x: 0, y: 0 };
  }

  const rawBounds =
    sourceBounds ||
    consoleWindowBounds || {
      width: Math.min(CONSOLE_DEFAULT_SIZE.width, workArea.width),
      height: Math.min(CONSOLE_DEFAULT_SIZE.height, workArea.height),
      x: workArea.x + workArea.width - CONSOLE_DEFAULT_SIZE.width - CONSOLE_WINDOW_MARGIN,
      y: workArea.y + CONSOLE_WINDOW_MARGIN,
    };

  const width = clamp(Math.round(rawBounds.width), CONSOLE_MIN_SIZE.width, workArea.width);
  const height = clamp(Math.round(rawBounds.height), CONSOLE_MIN_SIZE.height, workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  const x = clamp(Math.round(rawBounds.x), workArea.x, maxX);
  const y = clamp(Math.round(rawBounds.y), workArea.y, maxY);

  return { x, y, width, height };
}

function applyConsoleWindowBounds(display: Display = getCursorDisplay(), sourceBounds: Electron.Rectangle | null = null): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const nextBounds = getConsoleBoundsForDisplay(display, sourceBounds);
  consoleWindowBounds = nextBounds;
  overlayWindow.setBounds(nextBounds, false);
}

function rememberConsoleWindowBounds(): void {
  if (
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    overlayMode !== OVERLAY_MODES.CONSOLE ||
    !overlayWindow.isVisible() ||
    overlayBridgeInitialized
  ) {
    return;
  }

  const currentBounds = overlayWindow.getBounds();
  const centerPoint = {
    x: currentBounds.x + Math.round(currentBounds.width / 2),
    y: currentBounds.y + Math.round(currentBounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(centerPoint);
  consoleWindowBounds = getConsoleBoundsForDisplay(display, currentBounds);
}

function emitOverlayMode(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  try {
    overlayWindow.webContents.send('overlay-mode', {
      mode: overlayMode,
      hotkeys: {
        quick: HOTKEY_QUICK_CAPTURE,
        region: HOTKEY_REGION_CAPTURE,
      },
    });
  } catch {
    // Ignore renderer delivery errors during startup/shutdown races.
  }
}

function setOverlayMode(_nextMode: OverlayMode): void {
  overlayMode = OVERLAY_MODES.CONSOLE;
  emitOverlayMode();
}

function setOverlayInteractivity(interactive: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (interactive) {
    overlayWindow.setIgnoreMouseEvents(false);
  } else {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  if (typeof overlayWindow.setFocusable === 'function') {
    try {
      overlayWindow.setFocusable(Boolean(interactive));
    } catch {
      // setFocusable is platform-dependent.
    }
  }

  if (interactive) {
    overlayWindow.focus();
  } else if (overlayWindow.isFocused()) {
    overlayWindow.blur();
  }
}

function applyOverlayScreenshotVisibility(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  try {
    overlayWindow.setContentProtection(Boolean(hideOverlayFromScreenshots));
  } catch {
    // setContentProtection can be unsupported on some window managers.
  }
}

function settleOcrRequest(requestId: number, error: Error | null, payload?: OcrResultPayload): void {
  const pending = ocrWorkerPending.get(requestId);
  if (!pending) return;
  ocrWorkerPending.delete(requestId);

  if (error) {
    pending.reject(error);
    return;
  }

  pending.resolve(payload || { text: '', confidence: null });
}

function handleOcrWorkerMessage(message: OcrWorkerMessage): void {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'progress' && overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('ocr-status', message.status || 'Running OCR...');
    return;
  }

  if (message.type === 'result') {
    settleOcrRequest(message.requestId, null, {
      text: typeof message.text === 'string' ? message.text : '',
      confidence: Number.isFinite(message.confidence) ? Number(message.confidence) : null,
    });
    return;
  }

  if (message.type === 'error') {
    settleOcrRequest(message.requestId, new Error(message.error || 'OCR worker failed.'));
  }
}

function handleOcrWorkerExit(code: number): void {
  const reason = new Error(`OCR worker exited unexpectedly (code ${code}).`);
  for (const requestId of ocrWorkerPending.keys()) {
    settleOcrRequest(requestId, reason);
  }
  ocrWorkerThread = null;
}

function ensureOcrWorkerThread(): Promise<Worker> {
  if (ocrWorkerThread) {
    return Promise.resolve(ocrWorkerThread);
  }

  return new Promise((resolve, reject) => {
    try {
      const thread = new Worker(OCR_WORKER_ENTRY);
      let ready = false;

      thread.on('message', (message: OcrWorkerMessage) => {
        if (!ready && message?.type === 'ready') {
          ready = true;
          resolve(thread);
          return;
        }

        handleOcrWorkerMessage(message);
      });

      thread.once('error', (error) => {
        if (!ready) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        handleOcrWorkerExit(-1);
      });

      thread.once('exit', (code) => {
        handleOcrWorkerExit(code);
        if (!ready) {
          reject(new Error(`OCR worker exited before initialization (code ${code}).`));
        }
      });

      ocrWorkerThread = thread;
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function runWorkerOcr(capture: CaptureResult): Promise<OcrResultPayload> {
  const thread = await ensureOcrWorkerThread();
  const requestId = ++ocrWorkerRequestSeq;
  const bytes = new Uint8Array(capture.buffer.buffer, capture.buffer.byteOffset, capture.buffer.byteLength);

  return new Promise((resolve, reject) => {
    ocrWorkerPending.set(requestId, { resolve, reject: (error) => reject(error) });
    try {
      thread.postMessage(
        {
          type: 'crop-and-recognize',
          requestId,
          image: bytes,
          crop: capture.crop,
          displayWidth: capture.displayWidth,
          displayHeight: capture.displayHeight,
        },
        [bytes.buffer as ArrayBuffer],
      );
    } catch (error) {
      settleOcrRequest(requestId, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function disposeOcrWorkerThread(): Promise<void> {
  if (!ocrWorkerThread) {
    return;
  }

  const thread = ocrWorkerThread;
  ocrWorkerThread = null;

  try {
    await thread.terminate();
  } catch {
    // Ignore cleanup failures.
  }

  for (const requestId of ocrWorkerPending.keys()) {
    settleOcrRequest(requestId, new Error('OCR worker terminated.'));
  }
}

interface CaptureResult {
  buffer: Buffer;
  crop: { x: number; y: number; width: number; height: number };
  displayWidth: number;
  displayHeight: number;
}

async function captureAroundCursor(): Promise<CaptureResult> {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const captureWidth = Math.min(CAPTURE_SIZE.width, display.bounds.width);
  const captureHeight = Math.min(CAPTURE_SIZE.height, display.bounds.height);

  const cursorX = cursor.x - display.bounds.x;
  const cursorY = cursor.y - display.bounds.y;

  let buffer: Buffer;
  try {
    buffer = (await screenshot({ format: 'png', screen: display.id })) as Buffer;
  } catch {
    buffer = (await screenshot({ format: 'png' })) as Buffer;
  }

  return {
    buffer,
    crop: {
      x: cursorX - captureWidth / 2,
      y: cursorY - captureHeight / 2,
      width: captureWidth,
      height: captureHeight,
    },
    displayWidth: display.bounds.width,
    displayHeight: display.bounds.height,
  };
}

function getLlmImageBuffer(capture: CaptureResult): Buffer {
  const sourceImage = nativeImage.createFromBuffer(capture.buffer);
  if (sourceImage.isEmpty()) {
    return capture.buffer;
  }

  const sourceSize = sourceImage.getSize();
  if (sourceSize.width <= 0 || sourceSize.height <= 0) {
    return capture.buffer;
  }

  const scaleX = sourceSize.width / Math.max(capture.displayWidth, 1);
  const scaleY = sourceSize.height / Math.max(capture.displayHeight, 1);
  const left = Math.round(capture.crop.x * scaleX);
  const top = Math.round(capture.crop.y * scaleY);
  const cropX = Math.max(0, Math.min(sourceSize.width - 1, left));
  const cropY = Math.max(0, Math.min(sourceSize.height - 1, top));
  const cropW = Math.min(Math.max(1, Math.round(capture.crop.width * scaleX)), sourceSize.width - cropX);
  const cropH = Math.min(Math.max(1, Math.round(capture.crop.height * scaleY)), sourceSize.height - cropY);

  try {
    return sourceImage
      .crop({
        x: cropX,
        y: cropY,
        width: cropW,
        height: cropH,
      })
      .toPNG();
  } catch {
    return capture.buffer;
  }
}

async function runCapturePipeline(captureFn: () => Promise<CaptureResult>, captureMessage: string): Promise<boolean> {
  if (isCapturing || !overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  isCapturing = true;
  overlayWindow.webContents.send('ocr-status', captureMessage);

  try {
    const activeSettings = cloneCaptureSettings(captureSettings);
    const activeProvider = providerLabel(activeSettings.provider);
    const capture = await captureFn();
    const imageBuffer = getLlmImageBuffer(capture);
    let ocrText = '';
    let ocrConfidence: number | null = null;

    if (activeSettings.useOcr) {
      overlayWindow.webContents.send('ocr-status', 'Preparing OCR worker...');
      const bestResult = await runWorkerOcr(capture);
      ocrText = bestResult.text || '';
      ocrConfidence = bestResult.confidence ?? null;
    }

    let llmText = '';
    try {
      overlayWindow.webContents.send('ocr-status', `Sending screenshot to ${activeProvider}...`);
      llmText = await runLlmCapture(imageBuffer, activeSettings, ocrText);
    } catch (llmError) {
      const llmErrorMessage = llmError instanceof Error ? llmError.message : String(llmError);
      const hasOcrText = Boolean(activeSettings.useOcr && ocrText.trim());
      if (hasOcrText) {
        overlayWindow.webContents.send('ocr-result', {
          text: ocrText.trim(),
          confidence: ocrConfidence,
          error: `LLM request failed: ${llmErrorMessage}. Showing OCR output only.`,
        });
        overlayWindow.webContents.send('ocr-status', 'LLM failed. Showing OCR output only.');
        return true;
      }

      throw llmError;
    }

    overlayWindow.webContents.send('ocr-result', {
      text: llmText,
      confidence: ocrConfidence,
    });
    overlayWindow.webContents.send('ocr-status', `Done (${activeProvider})`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    overlayWindow.webContents.send('ocr-result', {
      text: '',
      confidence: null,
      error: errorMessage,
    });
    overlayWindow.webContents.send('ocr-status', 'Error during capture');
    return false;
  } finally {
    isCapturing = false;
  }
}

function clearSelectionContext(): void {
  setOverlayMode(OVERLAY_MODES.CONSOLE);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setResizable(true);
    overlayWindow.setMovable(true);
  }
}

function hideOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  clearSelectionContext();
  setOverlayInteractivity(false);
  overlayWindow.hide();
}

function showOverlayForCapture(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (!overlayBridgeInitialized) {
    applyConsoleWindowBounds(getCursorDisplay());
  }

  overlayWindow.setResizable(true);
  overlayWindow.setMovable(true);
  setOverlayMode(OVERLAY_MODES.CONSOLE);
  setOverlayInteractivity(true);
  overlayWindow.show();
}

function toggleOverlayAndCapture(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }

  showOverlayForCapture();
  void runCapturePipeline(captureAroundCursor, 'Capturing screen...');
}

function startRegionSelection(): void {
  toggleOverlayAndCapture();
}

function registerOverlayIpc(): void {
  ipcMain.handle('overlay:hide-console', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return false;
    }

    hideOverlay();
    return true;
  });

  // Backward compatibility for older renderer bundles that still use send().
  ipcMain.on('overlay:hide-console', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    hideOverlay();
  });

  ipcMain.handle('overlay:get-settings', () => {
    return cloneCaptureSettings(captureSettings);
  });

  ipcMain.handle('overlay:update-settings', (_event, nextSettings: unknown) => {
    const previous = captureSettings;
    captureSettings = sanitizeCaptureSettings(nextSettings, captureSettings);
    persistCaptureSettings(captureSettings);

    if (!previous.useOcr && captureSettings.useOcr) {
      ensureOcrWorkerThread().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[overlayFuzz] OCR worker warm-up failed after enabling OCR:', message);
      });
    }

    if (previous.useOcr && !captureSettings.useOcr) {
      void disposeOcrWorkerThread();
    }

    return cloneCaptureSettings(captureSettings);
  });

  ipcMain.handle('overlay:set-screenshot-exclusion', (_event, enabled: unknown) => {
    hideOverlayFromScreenshots = Boolean(enabled);
    applyOverlayScreenshotVisibility();
    return hideOverlayFromScreenshots;
  });

  ipcMain.handle('overlay:get-screenshot-exclusion', () => {
    return hideOverlayFromScreenshots;
  });
}

function createHotkeyManager({
  onQuickCapture,
  onRegionSelection,
}: {
  onQuickCapture: () => void;
  onRegionSelection: () => void;
}) {
  const uiohookBackend = resolveUiohookBackend();
  let activeBackend: 'uiohook' | 'globalShortcut' | null = null;
  const lastTriggeredAt = {
    quick: 0,
    region: 0,
  };
  let keydownListener: ((event: UiohookEvent) => void) | null = null;

  function unregisterGlobalShortcut(): void {
    try {
      globalShortcut.unregister(HOTKEY_QUICK_CAPTURE);
      globalShortcut.unregister(HOTKEY_REGION_CAPTURE);
    } catch {
      // Ignore cleanup errors.
    }
  }

  function unregisterUiohook(): void {
    if (!uiohookBackend) return;

    const { hook } = uiohookBackend;
    if (keydownListener) {
      if (typeof hook.off === 'function') {
        hook.off('keydown', keydownListener);
      } else if (typeof hook.removeListener === 'function') {
        hook.removeListener('keydown', keydownListener);
      }
    }

    if (typeof hook.stop === 'function') {
      try {
        hook.stop();
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  function resolveHotkeyAction(event: UiohookEvent | null | undefined): 'quick' | 'region' | null {
    if (!event) return null;

    const needsMeta = process.platform === 'darwin';
    const modifierMatch = needsMeta ? event.metaKey : event.ctrlKey;
    if (!modifierMatch || !event.shiftKey) {
      return null;
    }

    const keycodes = uiohookBackend?.keycodes;
    if (!keycodes) return null;

    if (event.keycode === keycodes.O) {
      return 'quick';
    }

    if (event.keycode === keycodes.R) {
      return 'region';
    }

    return null;
  }

  function triggerAction(action: 'quick' | 'region'): void {
    const now = Date.now();
    if (now - lastTriggeredAt[action] < HOTKEY_DEBOUNCE_MS) {
      return;
    }

    lastTriggeredAt[action] = now;

    if (action === 'quick') {
      onQuickCapture();
      return;
    }

    if (action === 'region') {
      onRegionSelection();
    }
  }

  return {
    start(): void {
      if (uiohookBackend) {
        try {
          keydownListener = (event) => {
            const action = resolveHotkeyAction(event);
            if (!action) return;
            triggerAction(action);
          };

          uiohookBackend.hook.on('keydown', keydownListener);
          uiohookBackend.hook.start();
          activeBackend = 'uiohook';
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[overlayFuzz] uiohook-napi failed, falling back to globalShortcut:', message);
          unregisterUiohook();
          activeBackend = null;
        }
      }

      try {
        const quickRegistered = globalShortcut.register(HOTKEY_QUICK_CAPTURE, onQuickCapture);
        const regionRegistered = globalShortcut.register(HOTKEY_REGION_CAPTURE, onRegionSelection);

        if (quickRegistered || regionRegistered) {
          activeBackend = 'globalShortcut';
        } else {
          console.warn(
            '[overlayFuzz] globalShortcut registration failed for hotkeys:',
            HOTKEY_QUICK_CAPTURE,
            HOTKEY_REGION_CAPTURE,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[overlayFuzz] globalShortcut failed for hotkeys:', message);
      }
    },

    dispose(): void {
      if (activeBackend === 'uiohook') {
        unregisterUiohook();
      } else if (activeBackend === 'globalShortcut') {
        unregisterGlobalShortcut();
      } else {
        unregisterUiohook();
        unregisterGlobalShortcut();
      }

      activeBackend = null;
      keydownListener = null;
    },
  };
}

function configureOptionalOverlayBridge(): boolean {
  if (
    !ENABLE_OVERLAY_ATTACH ||
    !overlayWindow ||
    !overlayWindowBackend?.controller ||
    !OVERLAY_TARGET_TITLE ||
    overlayBridgeInitialized
  ) {
    return false;
  }

  try {
    overlayWindowBackend.controller.attachByTitle(overlayWindow, OVERLAY_TARGET_TITLE, {
      hasTitleBarOnMac: false,
    });
    overlayBridgeInitialized = true;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[overlayFuzz] electron-overlay-window attachByTitle failed:', message);
    return false;
  }
}

function createOverlayWindow(): void {
  overlayWindow = new BrowserWindow(getOverlayWindowOptions());

  loadOverlayRenderer(overlayWindow).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[overlayFuzz] Renderer load failed:', message);
  });

  setOverlayInteractivity(false);
  applyOverlayScreenshotVisibility();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.hide();

  overlayWindow.webContents.on('did-finish-load', () => {
    emitOverlayMode();
  });

  overlayWindow.on('close', (event) => {
    if (isAppQuitting) {
      return;
    }

    event.preventDefault();
    hideOverlay();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  overlayWindow.on('move', () => {
    rememberConsoleWindowBounds();
  });

  overlayWindow.on('resize', () => {
    rememberConsoleWindowBounds();
  });

  configureOptionalOverlayBridge();
}

async function loadOverlayRenderer(targetWindow: BrowserWindow): Promise<void> {
  const rendererTarget = resolveRendererTarget();

  if (rendererTarget.type === 'url') {
    try {
      await targetWindow.loadURL(rendererTarget.value);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[overlayFuzz] Failed to load Vite renderer URL, falling back to file:', message);
      const fallbackFile = resolveFileRendererIndex();
      await targetWindow.loadFile(fallbackFile);
      return;
    }
  }

  await targetWindow.loadFile(rendererTarget.value);
}

function resolveRendererTarget(): { type: 'url' | 'file'; value: string } {
  if (VITE_DEV_SERVER_URL) {
    return {
      type: 'url',
      value: VITE_DEV_SERVER_URL,
    };
  }

  if (fs.existsSync(RENDERER_DIST_INDEX)) {
    return { type: 'file', value: RENDERER_DIST_INDEX };
  }

  return { type: 'file', value: LEGACY_RENDERER_INDEX };
}

function resolveFileRendererIndex(): string {
  if (fs.existsSync(RENDERER_DIST_INDEX)) {
    return RENDERER_DIST_INDEX;
  }

  return LEGACY_RENDERER_INDEX;
}

function installDisplaySync(): () => void {
  const syncOverlay = () => {
    if (overlayBridgeInitialized || !overlayWindow || !overlayWindow.isVisible()) {
      return;
    }

    const sourceBounds = consoleWindowBounds || overlayWindow.getBounds();
    const centerPoint = {
      x: sourceBounds.x + Math.round(sourceBounds.width / 2),
      y: sourceBounds.y + Math.round(sourceBounds.height / 2),
    };
    const display = screen.getDisplayNearestPoint(centerPoint);
    applyConsoleWindowBounds(display, sourceBounds);
  };

  screen.on('display-added', syncOverlay);
  screen.on('display-removed', syncOverlay);
  screen.on('display-metrics-changed', syncOverlay);

  return () => {
    screen.off('display-added', syncOverlay);
    screen.off('display-removed', syncOverlay);
    screen.off('display-metrics-changed', syncOverlay);
  };
}

app.whenReady().then(() => {
  captureSettings = loadCaptureSettingsFromDisk();
  if (captureSettings.useOcr) {
    ensureOcrWorkerThread().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[overlayFuzz] OCR worker warm-up failed:', message);
    });
  }
  registerOverlayIpc();
  createOverlayWindow();
  displaySyncCleanup = installDisplaySync();
  hotkeyManager = createHotkeyManager({
    onQuickCapture: toggleOverlayAndCapture,
    onRegionSelection: startRegionSelection,
  });
  hotkeyManager.start();
});

app.on('will-quit', () => {
  isAppQuitting = true;

  if (displaySyncCleanup) {
    displaySyncCleanup();
    displaySyncCleanup = null;
  }

  if (hotkeyManager) {
    hotkeyManager.dispose();
    hotkeyManager = null;
  }

  globalShortcut.unregisterAll();
  ipcMain.removeHandler('overlay:hide-console');
  ipcMain.removeHandler('overlay:get-settings');
  ipcMain.removeHandler('overlay:update-settings');
  ipcMain.removeHandler('overlay:set-screenshot-exclusion');
  ipcMain.removeHandler('overlay:get-screenshot-exclusion');
  ipcMain.removeAllListeners('overlay:hide-console');

  // Fire-and-forget — Electron does not await async will-quit handlers.
  if (ocrWorkerThread) {
    const thread = ocrWorkerThread;
    ocrWorkerThread = null;
    thread.terminate().catch(() => {});
    for (const requestId of ocrWorkerPending.keys()) {
      settleOcrRequest(requestId, new Error('OCR worker terminated.'));
    }
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createOverlayWindow();
  }
});
