const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');
const statePillEl = document.getElementById('statePill');
const confidenceValueEl = document.getElementById('confidenceValue');
const confidenceBarEl = document.getElementById('confidenceBar');
const errorValueEl = document.getElementById('errorValue');

const uiState = {
  status: 'Press Ctrl/Cmd + Shift + O to capture.',
  result: 'Waiting for OCR...',
  confidence: null,
  error: '',
  state: 'idle',
};

function clampConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function deriveState(status, payload) {
  const text = `${status || ''} ${payload?.error || ''}`.toLowerCase();
  if (payload?.error || text.includes('error')) return 'error';
  if (text.includes('captur')) return 'capturing';
  if (text.includes('running') || text.includes('process')) return 'processing';
  if (text.includes('done') || text.includes('complete') || text.includes('success')) return 'done';
  return 'idle';
}

function syncUI() {
  document.body.dataset.state = uiState.state;
  statusEl.textContent = uiState.status;
  resultEl.textContent = uiState.result;
  metaEl.textContent = uiState.state === 'error' ? 'Bridge reported an error' : 'Bridge ready';
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

  if (uiState.confidence === null || uiState.confidence === undefined) {
    confidenceValueEl.textContent = '--';
    confidenceBarEl.style.width = '0%';
  } else {
    confidenceValueEl.textContent = `${uiState.confidence.toFixed(1)}%`;
    confidenceBarEl.style.width = `${clampConfidence(uiState.confidence)}%`;
  }

  errorValueEl.textContent = uiState.error || 'No errors reported.';
  errorValueEl.classList.toggle('metric__value--error', Boolean(uiState.error));
}

function updateStatus(text) {
  uiState.status = text;
  uiState.state = deriveState(text, { error: uiState.error });
  syncUI();
}

function updateResult(payload) {
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

if (window.overlayApi) {
  uiState.state = 'idle';
  window.overlayApi.onStatus(updateStatus);
  window.overlayApi.onResult(updateResult);
  syncUI();
} else {
  uiState.state = 'error';
  uiState.error = 'Bridge unavailable';
  syncUI();
}
