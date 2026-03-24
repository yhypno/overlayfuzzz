const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const Jimp = require('jimp');
const Tesseract = require('tesseract.js');

const HOTKEY = 'CommandOrControl+Shift+O';
const CAPTURE_SIZE = { width: 700, height: 260 };

let overlayWindow = null;
let isCapturing = false;
let workerPromise = null;

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.hide();
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

  positionOverlayToCursorDisplay();
  overlayWindow.showInactive();
  runOcrCapture();
}

app.whenReady().then(() => {
  createOverlayWindow();

  globalShortcut.register(HOTKEY, () => {
    toggleOverlayAndCapture();
  });
});

app.on('will-quit', async () => {
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
