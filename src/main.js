const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const screenshot = require('screenshot-desktop');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');

const HOTKEY_QUICK_CAPTURE = 'CommandOrControl+Shift+O';
const HOTKEY_REGION_CAPTURE = 'CommandOrControl+Shift+R';
const HOTKEY_DEBOUNCE_MS = 250;
const CAPTURE_SIZE = { width: 700, height: 260 };
const OVERLAY_TARGET_TITLE = (process.env.OVERLAY_FUZZ_TARGET_WINDOW_TITLE || '').trim();
const VITE_DEV_SERVER_URL = (process.env.VITE_DEV_SERVER_URL || '').trim();
const RENDERER_DIST_INDEX = path.join(__dirname, '..', 'renderer', 'dist', 'index.html');
const LEGACY_RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');
const OVERLAY_MODES = {
  CONSOLE: 'console',
  SELECTING: 'selecting',
};
const MIN_REGION_SIZE = 6;

let overlayWindow = null;
let isCapturing = false;
let workerPromise = null;
let hotkeyManager = null;
let displaySyncCleanup = null;
let overlayBridgeInitialized = false;
let isAppQuitting = false;
let overlayMode = OVERLAY_MODES.CONSOLE;
let selectionDisplayId = null;

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

  if (keycodes.O === undefined || keycodes.R === undefined) {
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

function getCursorDisplay() {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

function getDisplayById(id) {
  if (id === null || id === undefined) return null;
  return screen.getAllDisplays().find((display) => display.id === id) || null;
}

function positionOverlayToDisplay(display) {
  if (!overlayWindow || !display) return;
  overlayWindow.setBounds(display.bounds);
}

function positionOverlayToCursorDisplay() {
  if (!overlayWindow) return;
  positionOverlayToDisplay(getCursorDisplay());
}

function emitOverlayMode() {
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

function setOverlayMode(nextMode) {
  overlayMode = nextMode === OVERLAY_MODES.SELECTING ? OVERLAY_MODES.SELECTING : OVERLAY_MODES.CONSOLE;
  emitOverlayMode();
}

function setOverlayInteractivity(interactive) {
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

async function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng');
  }

  return workerPromise;
}

function normalizeRegion(region, maxWidth, maxHeight) {
  const x = Number(region?.x);
  const y = Number(region?.y);
  const width = Number(region?.width);
  const height = Number(region?.height);

  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    return null;
  }

  const left = Math.max(0, Math.min(maxWidth, x));
  const top = Math.max(0, Math.min(maxHeight, y));
  const right = Math.max(0, Math.min(maxWidth, x + width));
  const bottom = Math.max(0, Math.min(maxHeight, y + height));
  const normalizedWidth = right - left;
  const normalizedHeight = bottom - top;

  if (normalizedWidth < MIN_REGION_SIZE || normalizedHeight < MIN_REGION_SIZE) {
    return null;
  }

  return {
    x: left,
    y: top,
    width: normalizedWidth,
    height: normalizedHeight,
  };
}

async function captureAroundCursor() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);

  const captureWidth = Math.min(CAPTURE_SIZE.width, display.bounds.width);
  const captureHeight = Math.min(CAPTURE_SIZE.height, display.bounds.height);

  const cursorX = cursor.x - display.bounds.x;
  const cursorY = cursor.y - display.bounds.y;

  let buffer = null;
  try {
    buffer = await screenshot({ format: 'png', screen: display.id });
  } catch {
    buffer = await screenshot({ format: 'png' });
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

async function captureDisplayRegion(display, region) {
  let buffer = null;
  try {
    buffer = await screenshot({ format: 'png', screen: display.id });
  } catch {
    buffer = await screenshot({ format: 'png' });
  }

  const image = await Jimp.read(buffer);
  const scaleX = image.bitmap.width / Math.max(display.bounds.width, 1);
  const scaleY = image.bitmap.height / Math.max(display.bounds.height, 1);

  const cropX = Math.max(0, Math.min(image.bitmap.width - 1, Math.round(region.x * scaleX)));
  const cropY = Math.max(0, Math.min(image.bitmap.height - 1, Math.round(region.y * scaleY)));
  const desiredWidth = Math.max(1, Math.round(region.width * scaleX));
  const desiredHeight = Math.max(1, Math.round(region.height * scaleY));
  const cropW = Math.min(desiredWidth, image.bitmap.width - cropX);
  const cropH = Math.min(desiredHeight, image.bitmap.height - cropY);

  if (cropW <= 0 || cropH <= 0) {
    throw new Error('Selected region is outside capture bounds.');
  }

  const cropped = image.clone().crop(cropX, cropY, cropW, cropH);
  return cropped.getBufferAsync(Jimp.MIME_PNG);
}

async function runOcrCapture(captureFn, captureMessage) {
  if (isCapturing || !overlayWindow || overlayWindow.isDestroyed()) {
    return false;
  }

  isCapturing = true;
  overlayWindow.webContents.send('ocr-status', captureMessage);

  try {
    const imageBuffer = await captureFn();
    overlayWindow.webContents.send('ocr-status', 'Running OCR...');

    const worker = await getWorker();
    const result = await worker.recognize(imageBuffer);

    overlayWindow.webContents.send('ocr-result', {
      text: (result.data.text || '').trim(),
      confidence: result.data.confidence ?? null,
    });
    overlayWindow.webContents.send('ocr-status', 'Done');
    return true;
  } catch (error) {
    overlayWindow.webContents.send('ocr-result', {
      text: '',
      confidence: null,
      error: error.message || String(error),
    });
    overlayWindow.webContents.send('ocr-status', 'Error during OCR');
    return false;
  } finally {
    isCapturing = false;
  }
}

function clearSelectionContext() {
  selectionDisplayId = null;
  setOverlayMode(OVERLAY_MODES.CONSOLE);
  setOverlayInteractivity(false);
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  clearSelectionContext();
  overlayWindow.hide();
}

function showOverlayForCapture() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (!overlayBridgeInitialized && !overlayWindow.isVisible()) {
    positionOverlayToCursorDisplay();
  }

  setOverlayMode(OVERLAY_MODES.CONSOLE);
  setOverlayInteractivity(false);
  overlayWindow.showInactive();
}

function toggleOverlayAndCapture() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayWindow.isVisible()) {
    hideOverlay();
    return;
  }

  showOverlayForCapture();
  void runOcrCapture(captureAroundCursor, 'Capturing screen...');
}

function startRegionSelection() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (overlayWindow.isVisible() && overlayMode === OVERLAY_MODES.SELECTING) {
    hideOverlay();
    return;
  }

  const display = getCursorDisplay();
  selectionDisplayId = display.id;

  if (!overlayBridgeInitialized) {
    positionOverlayToDisplay(display);
  }

  setOverlayMode(OVERLAY_MODES.SELECTING);
  overlayWindow.show();
  setOverlayInteractivity(true);
  overlayWindow.webContents.send('ocr-status', 'Draw a rectangle to OCR. Press Esc to cancel.');
}

function resolveSelectionDisplay() {
  const fromSelection = getDisplayById(selectionDisplayId);
  if (fromSelection) return fromSelection;
  return getCursorDisplay();
}

function registerOverlayIpc() {
  ipcMain.handle('overlay:ocr-region', async (_event, payload) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return { ok: false, error: 'Overlay window is not available.' };
    }

    if (isCapturing) {
      return { ok: false, error: 'OCR capture is already running.' };
    }

    const display = resolveSelectionDisplay();
    const normalizedRegion = normalizeRegion(payload, display.bounds.width, display.bounds.height);
    if (!normalizedRegion) {
      return { ok: false, error: `Selection must be at least ${MIN_REGION_SIZE}px by ${MIN_REGION_SIZE}px.` };
    }

    setOverlayMode(OVERLAY_MODES.CONSOLE);
    setOverlayInteractivity(false);
    overlayWindow.showInactive();

    const captured = await runOcrCapture(
      () => captureDisplayRegion(display, normalizedRegion),
      'Capturing selected region...',
    );

    selectionDisplayId = null;
    if (!captured) {
      return { ok: false, error: 'OCR failed. See error output for details.' };
    }

    return { ok: true };
  });

  ipcMain.on('overlay:selection-cancel', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    hideOverlay();
  });
}

function createHotkeyManager({ onQuickCapture, onRegionSelection }) {
  const uiohookBackend = resolveUiohookBackend();
  let activeBackend = null;
  const lastTriggeredAt = {
    quick: 0,
    region: 0,
  };
  let keydownListener = null;

  function unregisterGlobalShortcut() {
    try {
      globalShortcut.unregister(HOTKEY_QUICK_CAPTURE);
      globalShortcut.unregister(HOTKEY_REGION_CAPTURE);
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

  function resolveHotkeyAction(event) {
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

  function triggerAction(action) {
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
    start() {
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
          console.warn('[overlayFuzz] uiohook-napi failed, falling back to globalShortcut:', error.message || error);
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
        console.warn('[overlayFuzz] globalShortcut failed for hotkeys:', error.message || error);
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

    if (overlayMode === OVERLAY_MODES.SELECTING) {
      const display = getDisplayById(selectionDisplayId) || getCursorDisplay();
      positionOverlayToDisplay(display);
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
  ipcMain.removeHandler('overlay:ocr-region');
  ipcMain.removeAllListeners('overlay:selection-cancel');

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
