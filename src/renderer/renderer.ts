interface OverlayResultPayload {
  text: string;
  confidence: number | null;
  error?: string;
}

interface OverlayModePayload {
  mode: 'console';
  hotkeys?: {
    quick?: string;
    region?: string;
  };
}

interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResultPayload) => void): void;
  onMode(callback: (payload: OverlayModePayload) => void): void;
  hideOverlay(): void;
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

const uiState = {
  status: 'Press Ctrl/Cmd + Shift + O for quick OCR.',
  result: 'Waiting for OCR...',
  confidence: null as number | null,
  error: '',
  state: 'idle' as 'idle' | 'capturing' | 'processing' | 'done' | 'error',
  hotkeys: {
    quick: 'Ctrl/Cmd + Shift + O',
    region: 'Ctrl/Cmd + Shift + R',
  },
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
    quickHotkeyEl.textContent = `Quick: ${uiState.hotkeys.quick}`;
  }
  if (regionHotkeyEl) {
    regionHotkeyEl.textContent = `Region: ${uiState.hotkeys.region}`;
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

  const region = prettifyHotkey(payload?.hotkeys?.region);
  if (region) {
    uiState.hotkeys.region = region;
  }

  syncUI();
}

if (window.overlayApi) {
  uiState.state = 'idle';
  window.overlayApi.onStatus(updateStatus);
  window.overlayApi.onResult(updateResult);
  window.overlayApi.onMode(applyMode);
  syncUI();
} else {
  uiState.state = 'error';
  uiState.error = 'Bridge unavailable';
  syncUI();
}

export {};
