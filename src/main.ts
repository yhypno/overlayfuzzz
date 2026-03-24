import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  type BrowserWindowConstructorOptions,
  type Display,
} from 'electron';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import screenshot from 'screenshot-desktop';
import Jimp from 'jimp';

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

async function runWorkerOcr(imageBuffer: Buffer): Promise<OcrResultPayload> {
  const thread = await ensureOcrWorkerThread();
  const requestId = ++ocrWorkerRequestSeq;
  const bytes = Uint8Array.from(imageBuffer);

  return new Promise((resolve, reject) => {
    ocrWorkerPending.set(requestId, { resolve, reject: (error) => reject(error) });
    try {
      thread.postMessage(
        {
          type: 'recognize',
          requestId,
          image: bytes,
        },
        [bytes.buffer],
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

async function captureAroundCursor(): Promise<Buffer> {
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

  const image = await Jimp.read(buffer);
  const scaleX = image.bitmap.width / Math.max(display.bounds.width, 1);
  const scaleY = image.bitmap.height / Math.max(display.bounds.height, 1);

  const left = Math.round((cursorX - captureWidth / 2) * scaleX);
  const top = Math.round((cursorY - captureHeight / 2) * scaleY);

  const cropX = Math.max(0, Math.min(image.bitmap.width - 1, left));
  const cropY = Math.max(0, Math.min(image.bitmap.height - 1, top));
  const cropW = Math.min(Math.max(1, Math.round(captureWidth * scaleX)), image.bitmap.width - cropX);
  const cropH = Math.min(Math.max(1, Math.round(captureHeight * scaleY)), image.bitmap.height - cropY);

  const cropped = image.clone().crop(cropX, cropY, cropW, cropH);
  return cropped.getBufferAsync(Jimp.MIME_PNG);
}

async function runOcrCapture(captureFn: () => Promise<Buffer>, captureMessage: string): Promise<boolean> {
  if (isCapturing || !overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  isCapturing = true;
  overlayWindow.webContents.send('ocr-status', captureMessage);

  try {
    const imageBuffer = await captureFn();
    overlayWindow.webContents.send('ocr-status', 'Preparing OCR worker...');
    const bestResult = await runWorkerOcr(imageBuffer);

    overlayWindow.webContents.send('ocr-result', {
      text: bestResult.text,
      confidence: bestResult.confidence,
    });
    overlayWindow.webContents.send('ocr-status', 'Done');
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    overlayWindow.webContents.send('ocr-result', {
      text: '',
      confidence: null,
      error: errorMessage,
    });
    overlayWindow.webContents.send('ocr-status', 'Error during OCR');
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
  void runOcrCapture(captureAroundCursor, 'Capturing screen...');
}

function startRegionSelection(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }

  showOverlayForCapture();
  void runOcrCapture(captureAroundCursor, 'Capturing screen...');
}

function registerOverlayIpc(): void {
  ipcMain.on('overlay:hide-console', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    hideOverlay();
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
  ensureOcrWorkerThread().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[overlayFuzz] OCR worker warm-up failed:', message);
  });
  registerOverlayIpc();
  createOverlayWindow();
  displaySyncCleanup = installDisplaySync();
  hotkeyManager = createHotkeyManager({
    onQuickCapture: toggleOverlayAndCapture,
    onRegionSelection: startRegionSelection,
  });
  hotkeyManager.start();
});

app.on('will-quit', async () => {
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
  ipcMain.removeAllListeners('overlay:hide-console');
  await disposeOcrWorkerThread();
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
