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
const CONSOLE_MIN_SIZE = { width: 520, height: 360 };
const CONSOLE_DEFAULT_SIZE = { width: 760, height: 540 };
const CONSOLE_WINDOW_MARGIN = 28;
const OCR_UPSCALE_THRESHOLD = 1600;
const OCR_THRESHOLD_MAX = 165;
const OCR_PASSES = [
  { label: 'balanced', contrast: 0.38, threshold: false },
  { label: 'high-contrast', contrast: 0.64, threshold: true },
];

let overlayWindow = null;
let isCapturing = false;
let workerPromise = null;
let hotkeyManager = null;
let displaySyncCleanup = null;
let overlayBridgeInitialized = false;
let isAppQuitting = false;
let overlayMode = OVERLAY_MODES.CONSOLE;
let selectionDisplayId = null;
let consoleWindowBounds = null;

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getDisplayWorkArea(display) {
  return display?.workArea || display?.bounds || null;
}

function getConsoleBoundsForDisplay(display, sourceBounds = null) {
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

function applyConsoleWindowBounds(display = getCursorDisplay(), sourceBounds = null) {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const nextBounds = getConsoleBoundsForDisplay(display, sourceBounds);
  consoleWindowBounds = nextBounds;
  overlayWindow.setBounds(nextBounds, false);
}

function rememberConsoleWindowBounds() {
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
    workerPromise = (async () => {
      const worker = await Tesseract.createWorker('eng');

      try {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          preserve_interword_spaces: '1',
        });
      } catch {
        // Not all engines support every runtime parameter.
      }

      return worker;
    })();
  }

  return workerPromise;
}

function normalizeRecognizedText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function buildOcrPassBuffers(imageBuffer) {
  const source = await Jimp.read(imageBuffer);
  const shouldUpscale = Math.max(source.bitmap.width, source.bitmap.height) < OCR_UPSCALE_THRESHOLD;
  const scaleFactor = shouldUpscale ? 2 : 1;
  const buffers = [];

  for (const pass of OCR_PASSES) {
    const image = source.clone().greyscale().normalize().contrast(pass.contrast);

    if (shouldUpscale) {
      image.resize(
        Math.max(1, Math.round(source.bitmap.width * scaleFactor)),
        Math.max(1, Math.round(source.bitmap.height * scaleFactor)),
        Jimp.RESIZE_BICUBIC,
      );
    }

    if (pass.threshold) {
      image.threshold({ max: OCR_THRESHOLD_MAX });
    }

    buffers.push({
      label: pass.label,
      buffer: await image.getBufferAsync(Jimp.MIME_PNG),
    });
  }

  return buffers;
}

function scoreOcrCandidate(candidate) {
  const textLengthBoost = Math.min(candidate.text.length, 180) * 0.12;
  const emptyPenalty = candidate.text.length > 0 ? 0 : 40;
  return (candidate.confidence || 0) + textLengthBoost - emptyPenalty;
}

function selectBestOcrCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { text: '', confidence: null };
  }

  return candidates.reduce((best, current) => {
    return scoreOcrCandidate(current) > scoreOcrCandidate(best) ? current : best;
  });
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
    const worker = await getWorker();
    const inputs = await buildOcrPassBuffers(imageBuffer);
    const candidates = [];

    for (let index = 0; index < inputs.length; index += 1) {
      const pass = inputs[index];
      overlayWindow.webContents.send('ocr-status', `Running OCR (${pass.label} ${index + 1}/${inputs.length})...`);

      const result = await worker.recognize(pass.buffer);
      candidates.push({
        text: normalizeRecognizedText(result?.data?.text),
        confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : null,
      });
    }

    const bestResult = selectBestOcrCandidate(candidates);

    overlayWindow.webContents.send('ocr-result', {
      text: bestResult.text,
      confidence: bestResult.confidence,
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
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  clearSelectionContext();
  setOverlayInteractivity(false);
  overlayWindow.hide();
}

function showOverlayForCapture() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (!overlayBridgeInitialized) {
    applyConsoleWindowBounds(getCursorDisplay());
  }

  setOverlayMode(OVERLAY_MODES.CONSOLE);
  setOverlayInteractivity(true);
  overlayWindow.show();
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
    rememberConsoleWindowBounds();
  }

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
    if (!overlayBridgeInitialized) {
      applyConsoleWindowBounds(display);
    }
    setOverlayInteractivity(true);
    overlayWindow.show();

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

  overlayWindow.on('move', () => {
    rememberConsoleWindowBounds();
  });

  overlayWindow.on('resize', () => {
    rememberConsoleWindowBounds();
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
