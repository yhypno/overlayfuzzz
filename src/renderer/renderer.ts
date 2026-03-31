interface OverlayResultPayload {
  text: string;
  confidence: number | null;
  error?: string;
}

interface OverlayModePayload {
  mode: 'console';
  hotkeys?: {
    quick?: string;
    capture?: string;
    region?: string;
  };
}

interface CapturePreviewPayload {
  id: string;
  thumbnailDataUrl: string;
  capturedAt: number;
}

interface CaptureCollectionPayload {
  captures: CapturePreviewPayload[];
  activeCaptureId: string | null;
}

interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResultPayload) => void): void;
  onMode(callback: (payload: OverlayModePayload) => void): void;
  onCaptures?(callback: (payload: CaptureCollectionPayload) => void): void;
  hideOverlay(): void;
  getCaptures?(): Promise<CaptureCollectionPayload>;
  submitQuery?(query: string): Promise<boolean>;
}

declare global {
  interface Window {
    overlayApi?: OverlayApi;
  }
}

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');
const statePillEl = document.getElementById('statePill');
const confidenceValueEl = document.getElementById('confidenceValue');
const confidenceBarEl = document.getElementById('confidenceBar');
const errorValueEl = document.getElementById('errorValue');
const quickHotkeyEl = document.getElementById('quickHotkey');
const regionHotkeyEl = document.getElementById('regionHotkey');
const captureStripEl = document.getElementById('captureStrip');
const captureEmptyEl = document.getElementById('captureEmpty');

const uiState = {
  status: 'Press Ctrl/Cmd + Shift + O to open, then Ctrl/Cmd + Shift + 1 to capture.',
  result: 'Waiting for LLM output...',
  confidence: null as number | null,
  error: '',
  state: 'idle' as 'idle' | 'capturing' | 'processing' | 'done' | 'error',
  hotkeys: {
    quick: 'Ctrl/Cmd + Shift + O',
    capture: 'Ctrl/Cmd + Shift + 1',
  },
  captures: [] as CapturePreviewPayload[],
  activeCaptureId: null as string | null,
};

function clampConfidence(value: number | null | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function prettifyHotkey(value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  return value
    .replace(/CommandOrControl/gi, 'Ctrl/Cmd')
    .replace(/\+/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveState(status: string, payload?: OverlayResultPayload): 'idle' | 'capturing' | 'processing' | 'done' | 'error' {
  const text = `${status || ''} ${payload?.error || ''}`.toLowerCase();
  if (payload?.error || text.includes('error')) return 'error';
  if (text.includes('captur')) return 'capturing';
  if (text.includes('running') || text.includes('process')) return 'processing';
  if (text.includes('done') || text.includes('complete') || text.includes('success')) return 'done';
  return 'idle';
}

function syncUI(): void {
  document.body.dataset.state = uiState.state;
  if (statusEl) statusEl.textContent = uiState.status;
  if (resultEl) resultEl.textContent = uiState.result;
  if (metaEl) {
    metaEl.textContent =
      uiState.state === 'error'
        ? 'Bridge reported an error'
        : 'Bridge ready';
  }
  if (statePillEl) {
    statePillEl.textContent =
      uiState.state === 'capturing'
        ? 'Capturing'
        : uiState.state === 'processing'
          ? 'Processing'
          : uiState.state === 'done'
            ? 'Ready'
            : uiState.state === 'error'
              ? 'Error'
              : 'Idle';
  }

  if (confidenceValueEl && confidenceBarEl) {
    if (uiState.confidence === null || uiState.confidence === undefined) {
      confidenceValueEl.textContent = '--';
      (confidenceBarEl as HTMLElement).style.width = '0%';
    } else {
      confidenceValueEl.textContent = `${uiState.confidence.toFixed(1)}%`;
      (confidenceBarEl as HTMLElement).style.width = `${clampConfidence(uiState.confidence)}%`;
    }
  }

  if (errorValueEl) {
    errorValueEl.textContent = uiState.error || 'No errors reported.';
    errorValueEl.classList.toggle('metric__value--error', Boolean(uiState.error));
  }

  if (quickHotkeyEl) {
    quickHotkeyEl.textContent = `Open: ${uiState.hotkeys.quick}`;
  }
  if (regionHotkeyEl) {
    regionHotkeyEl.textContent = `Capture: ${uiState.hotkeys.capture}`;
  }

  renderCaptureStrip();
}

function formatCaptureTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return '--:--:--';
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderCaptureStrip(): void {
  if (!captureStripEl || !captureEmptyEl) {
    return;
  }

  captureStripEl.textContent = '';
  if (!uiState.captures.length) {
    captureStripEl.setAttribute('hidden', 'hidden');
    captureEmptyEl.textContent = `No screenshots yet. Press ${uiState.hotkeys.capture}.`;
    captureEmptyEl.removeAttribute('hidden');
    return;
  }

  captureEmptyEl.setAttribute('hidden', 'hidden');
  captureStripEl.removeAttribute('hidden');

  for (let index = 0; index < uiState.captures.length; index += 1) {
    const capture = uiState.captures[index];
    const itemEl = document.createElement('article');
    itemEl.className = 'captures__item';
    if (capture.id === uiState.activeCaptureId) {
      itemEl.classList.add('captures__item--active');
    }

    const thumbEl = document.createElement('img');
    thumbEl.className = 'captures__thumb';
    thumbEl.src = capture.thumbnailDataUrl;
    thumbEl.alt = `Screenshot ${index + 1}`;
    itemEl.appendChild(thumbEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'captures__meta';
    metaEl.textContent = `#${index + 1} ${formatCaptureTime(capture.capturedAt)}`;
    itemEl.appendChild(metaEl);

    captureStripEl.appendChild(itemEl);
  }
}

function updateStatus(text: string): void {
  uiState.status = text;
  uiState.state = deriveState(text, { error: uiState.error, text: uiState.result, confidence: uiState.confidence });
  syncUI();
}

function updateResult(payload: OverlayResultPayload): void {
  if (!payload) return;
  uiState.confidence = payload.confidence ?? null;
  if (payload.error) {
    uiState.error = payload.error;
    uiState.result = `Error: ${payload.error}`;
    uiState.state = deriveState(uiState.status, payload);
  } else {
    uiState.error = '';
    uiState.result = payload.text || '(no text detected)';
    uiState.state = deriveState(uiState.status, payload);
  }
  syncUI();
}

function applyMode(payload: OverlayModePayload): void {
  const quick = prettifyHotkey(payload?.hotkeys?.quick);
  if (quick) {
    uiState.hotkeys.quick = quick;
  }

  const capture = prettifyHotkey(payload?.hotkeys?.capture || payload?.hotkeys?.region);
  if (capture) {
    uiState.hotkeys.capture = capture;
  }

  syncUI();
}

function applyCaptures(payload: CaptureCollectionPayload): void {
  if (!payload || !Array.isArray(payload.captures)) {
    uiState.captures = [];
    uiState.activeCaptureId = null;
    syncUI();
    return;
  }

  uiState.captures = payload.captures;
  uiState.activeCaptureId = payload.activeCaptureId || null;
  syncUI();
}

if (window.overlayApi) {
  uiState.state = 'idle';
  window.overlayApi.onStatus(updateStatus);
  window.overlayApi.onResult(updateResult);
  window.overlayApi.onMode(applyMode);
  window.overlayApi.onCaptures?.(applyCaptures);
  void window.overlayApi.getCaptures?.().then(applyCaptures).catch(() => {});
  syncUI();
} else {
  uiState.state = 'error';
  uiState.error = 'Bridge unavailable';
  syncUI();
}

export {};
