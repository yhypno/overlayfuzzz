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
  submitQuery?(query: string): Promise<boolean>;
}

declare global {
  interface Window {
    overlayApi?: OverlayApi;
  }
}

const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const statePillEl = document.getElementById('statePill');
const errorValueEl = document.getElementById('errorValue');

const uiState = {
  status: 'Ready to capture.',
  result: 'Waiting for LLM output...',
  error: '',
  state: 'idle' as 'idle' | 'capturing' | 'processing' | 'done' | 'error',
};

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

  if (errorValueEl) {
    errorValueEl.textContent = uiState.error || 'No errors reported.';
    errorValueEl.classList.toggle('metric__value--error', Boolean(uiState.error));
  }
}

function updateStatus(text: string): void {
  uiState.status = text;
  uiState.state = deriveState(text, { error: uiState.error, text: uiState.result, confidence: null });
  syncUI();
}

function updateResult(payload: OverlayResultPayload): void {
  if (!payload) return;
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

function applyMode(_payload: OverlayModePayload): void {
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
