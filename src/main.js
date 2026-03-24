const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const screenshot = require('screenshot-desktop');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');

const HOTKEY = 'CommandOrControl+Shift+O';
const HOTKEY_DEBOUNCE_MS = 250;
const CAPTURE_SIZE = { width: 700, height: 260 };
const OVERLAY_TARGET_TITLE = (process.env.OVERLAY_FUZZ_TARGET_WINDOW_TITLE || '').trim();
const VITE_DEV_SERVER_URL = (process.env.VITE_DEV_SERVER_URL || '').trim();
const RENDERER_DIST_INDEX = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');
const LEGACY_RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');

let overlayWindow = null;
let isCapturing = false;
let workerPromise = null;
let hotkeyManager = null;
let displaySyncCleanup = null;
let overlayBridgeInitialized = false;
let isAppQuitting = false;

function safeRequire(moduleName) {
  try {
    return { module: require(moduleName), error: null };
  } catch (error) {
    return { module: null, error };
  }
}

function resolveUiohookBackend() {
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

  if (keycodes.O === undefined) {
    return null;
  }

  return { hook, keycodes };
}

function resolveOverlayWindowBackend() {
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

  return { defaults, controller };
}

const overlayWindowBackend = resolveOverlayWindowBackend();

function getOverlayWindowOptions() {
  return {
    ...(overlayWindowBackend?.defaults || {}),
    width: 800,
    height: 600,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

function positionOverlayToCursorDisplay() {
  if (!overlayWindow) return;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  overlayWindow.setBounds(display.bounds);
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng');
  }

  return workerPromise;
}

async function captureAroundCursor() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const scale = display.scaleFactor || 1;

  const captureWidth = Math.min(CAPTURE_SIZE.width, display.bounds.width);
  const captureHeight = Math.min(CAPTURE_SIZE.height, display.bounds.height);

  const cursorX = cursor.x - display.bounds.x;
  const cursorY = cursor.y - display.bounds.y;

  const left = Math.round((cursorX - captureWidth / 2) * scale);
  const top = Math.round((cursorY - captureHeight / 2) * scale);

  let buffer = null;
  try {
    buffer = await screenshot({ format: 'png', screen: display.id });
  } catch (error) {
    buffer = await screenshot({ format: 'png' });
  }

  const image = await Jimp.read(buffer);

  const cropX = Math.max(0, Math.min(image.bitmap.width - 1, left));
  const cropY = Math.max(0, Math.min(image.bitmap.height - 1, top));
  const cropW = Math.min(Math.round(captureWidth * scale), image.bitmap.width - cropX);
  const cropH = Math.min(Math.round(captureHeight * scale), image.bitmap.height - cropY);

  const cropped = image.clone().crop(cropX, cropY, cropW, cropH);
  return cropped.getBufferAsync(Jimp.MIME_PNG);
}

async function runOcrCapture() {
  if (isCapturing || !overlayWindow) return;
  isCapturing = true;

  overlayWindow.webContents.send('ocr-status', 'Capturing screen...');

  try {
    const imageBuffer = await captureAroundCursor();
    overlayWindow.webContents.send('ocr-status', 'Running OCR...');

    const worker = await getWorker();
    const result = await worker.recognize(imageBuffer);

    overlayWindow.webContents.send('ocr-result', {
      text: (result.data.text || '').trim(),
      confidence: result.data.confidence ?? null,
    });
    overlayWindow.webContents.send('ocr-status', 'Done');
  } catch (error) {
    overlayWindow.webContents.send('ocr-result', {
      text: '',
      confidence: null,
      error: error.message || String(error),
    });
    overlayWindow.webContents.send('ocr-status', 'Error during OCR');
  } finally {
    isCapturing = false;
  }
}

function toggleOverlayAndCapture() {
  if (!overlayWindow) return;

  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    return;
  }

  if (!overlayBridgeInitialized && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
    positionOverlayToCursorDisplay();
  }

  overlayWindow.showInactive();
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  runOcrCapture();
}

function createHotkeyManager(onToggle) {
  const uiohookBackend = resolveUiohookBackend();
  let activeBackend = null;
  let lastToggleAt = 0;
  let keydownListener = null;

  function unregisterGlobalShortcut() {
    try {
      globalShortcut.unregister(HOTKEY);
    } catch {
      // Ignore cleanup errors.
    }
  }

  function unregisterUiohook() {
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

  function matchesHotkey(event) {
    if (!event) return false;

    const expectedKeycode = uiohookBackend?.keycodes?.O;
    if (expectedKeycode === undefined || event.keycode !== expectedKeycode) {
      return false;
    }

    const needsMeta = process.platform === 'darwin';
    const modifierMatch = needsMeta ? event.metaKey : event.ctrlKey;

    return Boolean(modifierMatch && event.shiftKey);
  }

  function handleToggle() {
    const now = Date.now();
    if (now - lastToggleAt < HOTKEY_DEBOUNCE_MS) {
      return;
    }

    lastToggleAt = now;
    onToggle();
  }

  return {
    start() {
      if (uiohookBackend) {
        try {
          keydownListener = (event) => {
            if (!matchesHotkey(event)) return;
            handleToggle();
          };

          uiohookBackend.hook.on('keydown', keydownListener);
          uiohookBackend.hook.start();
          activeBackend = 'uiohook';
          return;
        } catch (error) {
          console.warn('[overlayFuzz] uiohook-napi failed, falling back to globalShortcut:', error.message || error);
          unregisterUiohook();
          activeBackend = null;
        }
      }

      try {
        if (globalShortcut.register(HOTKEY, onToggle)) {
          activeBackend = 'globalShortcut';
        } else {
          console.warn('[overlayFuzz] globalShortcut registration failed for hotkey:', HOTKEY);
        }
      } catch (error) {
        console.warn('[overlayFuzz] globalShortcut failed for hotkey:', error.message || error);
      }
    },

    dispose() {
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

function configureOptionalOverlayBridge() {
  if (!overlayWindow || !overlayWindowBackend?.controller || !OVERLAY_TARGET_TITLE || overlayBridgeInitialized) {
    return false;
  }

  try {
    overlayWindowBackend.controller.attachByTitle(overlayWindow, OVERLAY_TARGET_TITLE, {
      hasTitleBarOnMac: false,
    });
    overlayBridgeInitialized = true;
    return true;
  } catch (error) {
    console.warn('[overlayFuzz] electron-overlay-window attachByTitle failed:', error.message || error);
    return false;
  }
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow(getOverlayWindowOptions());

  loadOverlayRenderer(overlayWindow).catch((error) => {
    console.error('[overlayFuzz] Renderer load failed:', error.message || error);
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.hide();

  overlayWindow.on('close', (event) => {
    if (isAppQuitting) {
      return;
    }

    event.preventDefault();
    overlayWindow.hide();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  configureOptionalOverlayBridge();
}

async function loadOverlayRenderer(targetWindow) {
  const rendererTarget = resolveRendererTarget();

  if (rendererTarget.type === 'url') {
    try {
      await targetWindow.loadURL(rendererTarget.value);
      return;
    } catch (error) {
      console.warn('[overlayFuzz] Failed to load Vite renderer URL, falling back to file:', error.message || error);
      const fallbackFile = resolveFileRendererIndex();
      await targetWindow.loadFile(fallbackFile);
      return;
    }
  }

  await targetWindow.loadFile(rendererTarget.value);
}

function resolveRendererTarget() {
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

function resolveFileRendererIndex() {
  if (fs.existsSync(RENDERER_DIST_INDEX)) {
    return RENDERER_DIST_INDEX;
  }

  return LEGACY_RENDERER_INDEX;
}

function installDisplaySync() {
  const syncOverlay = () => {
    if (overlayBridgeInitialized || !overlayWindow || !overlayWindow.isVisible()) {
      return;
    }

    positionOverlayToCursorDisplay();
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
  createOverlayWindow();
  displaySyncCleanup = installDisplaySync();
  hotkeyManager = createHotkeyManager(toggleOverlayAndCapture);
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

  if (workerPromise) {
    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch {
      // Ignore cleanup errors.
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
