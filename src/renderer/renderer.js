const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');
const statePillEl = document.getElementById('statePill');
const confidenceValueEl = document.getElementById('confidenceValue');
const confidenceBarEl = document.getElementById('confidenceBar');
const errorValueEl = document.getElementById('errorValue');
const quickHotkeyEl = document.getElementById('quickHotkey');
const regionHotkeyEl = document.getElementById('regionHotkey');
const selectionLayerEl = document.getElementById('selectionLayer');
const selectionRectEl = document.getElementById('selectionRect');
const selectionRectLabelEl = document.getElementById('selectionRectLabel');

const MIN_SELECTION_SIZE = 6;

const uiState = {
  status: 'Press Ctrl/Cmd + Shift + O for quick OCR or Ctrl/Cmd + Shift + R to select a region.',
  result: 'Waiting for OCR...',
  confidence: null,
  error: '',
  state: 'idle',
  mode: 'console',
  hotkeys: {
    quick: 'Ctrl/Cmd + Shift + O',
    region: 'Ctrl/Cmd + Shift + R',
  },
};

const selectionState = {
  dragging: false,
  submitting: false,
  start: null,
  current: null,
};

function clampConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function prettifyHotkey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  return value
    .replace(/CommandOrControl/gi, 'Ctrl/Cmd')
    .replace(/\+/g, ' + ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveState(status, payload) {
  const text = `${status || ''} ${payload?.error || ''}`.toLowerCase();
  if (payload?.error || text.includes('error')) return 'error';
  if (text.includes('captur')) return 'capturing';
  if (text.includes('running') || text.includes('process')) return 'processing';
  if (text.includes('done') || text.includes('complete') || text.includes('success')) return 'done';
  return 'idle';
}

function currentSelectionRect() {
  if (!selectionState.start || !selectionState.current) {
    return null;
  }

  const left = Math.min(selectionState.start.x, selectionState.current.x);
  const top = Math.min(selectionState.start.y, selectionState.current.y);
  const width = Math.abs(selectionState.current.x - selectionState.start.x);
  const height = Math.abs(selectionState.current.y - selectionState.start.y);

  return { x: left, y: top, width, height };
}

function clearSelectionRect() {
  selectionState.dragging = false;
  selectionState.start = null;
  selectionState.current = null;
}

function updateSelectionRectUI() {
  if (!selectionRectEl || !selectionRectLabelEl) return;

  const rect = currentSelectionRect();
  if (!rect) {
    selectionRectEl.classList.add('hidden');
    return;
  }

  selectionRectEl.classList.remove('hidden');
  selectionRectEl.style.left = `${rect.x}px`;
  selectionRectEl.style.top = `${rect.y}px`;
  selectionRectEl.style.width = `${rect.width}px`;
  selectionRectEl.style.height = `${rect.height}px`;
  selectionRectLabelEl.textContent = `${Math.round(rect.width)} x ${Math.round(rect.height)}`;
}

function syncUI() {
  document.body.dataset.state = uiState.state;
  document.body.dataset.mode = uiState.mode;
  statusEl.textContent = uiState.status;
  resultEl.textContent = uiState.result;
  metaEl.textContent =
    uiState.mode === 'selecting'
      ? 'Selection mode active'
      : uiState.state === 'error'
        ? 'Bridge reported an error'
        : 'Bridge ready';
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

  if (quickHotkeyEl) {
    quickHotkeyEl.textContent = `Quick: ${uiState.hotkeys.quick}`;
  }
  if (regionHotkeyEl) {
    regionHotkeyEl.textContent = `Region: ${uiState.hotkeys.region}`;
  }

  if (selectionLayerEl) {
    selectionLayerEl.classList.toggle('hidden', uiState.mode !== 'selecting');
  }

  updateSelectionRectUI();
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

function applyMode(payload) {
  uiState.mode = payload?.mode === 'selecting' ? 'selecting' : 'console';

  const quick = prettifyHotkey(payload?.hotkeys?.quick);
  if (quick) {
    uiState.hotkeys.quick = quick;
  }

  const region = prettifyHotkey(payload?.hotkeys?.region);
  if (region) {
    uiState.hotkeys.region = region;
  }

  if (uiState.mode === 'selecting') {
    uiState.error = '';
    uiState.confidence = null;
    uiState.status = 'Draw a rectangle to OCR. Press Esc to cancel.';
    uiState.state = 'capturing';
  } else {
    selectionState.submitting = false;
  }

  clearSelectionRect();
  syncUI();
}

function selectionPointFromEvent(event) {
  const bounds = selectionLayerEl.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function cancelSelection() {
  clearSelectionRect();
  selectionState.submitting = false;
  syncUI();

  if (window.overlayApi?.cancelSelection) {
    window.overlayApi.cancelSelection();
  }
}

async function submitSelection(rect) {
  if (!window.overlayApi?.submitRegion) {
    uiState.error = 'Bridge unavailable';
    uiState.state = 'error';
    syncUI();
    return;
  }

  selectionState.submitting = true;
  uiState.status = 'Capturing selected region...';
  uiState.state = 'capturing';
  syncUI();

  try {
    const response = await window.overlayApi.submitRegion(rect);
    if (!response?.ok) {
      uiState.error = response?.error || 'Failed to capture selected region.';
      uiState.state = 'error';
      syncUI();
    }
  } catch (error) {
    uiState.error = error?.message || String(error);
    uiState.state = 'error';
    syncUI();
  } finally {
    selectionState.submitting = false;
  }
}

function onSelectionPointerDown(event) {
  if (
    uiState.mode !== 'selecting' ||
    selectionState.submitting ||
    event.button !== 0 ||
    !selectionLayerEl ||
    !selectionLayerEl.contains(event.target)
  ) {
    return;
  }

  event.preventDefault();
  selectionState.dragging = true;
  selectionState.start = selectionPointFromEvent(event);
  selectionState.current = selectionPointFromEvent(event);
  uiState.status = 'Drag to define the OCR region.';

  if (selectionLayerEl.setPointerCapture) {
    selectionLayerEl.setPointerCapture(event.pointerId);
  }

  syncUI();
}

function onSelectionPointerMove(event) {
  if (!selectionState.dragging || uiState.mode !== 'selecting' || selectionState.submitting) {
    return;
  }

  selectionState.current = selectionPointFromEvent(event);
  updateSelectionRectUI();
}

async function onSelectionPointerUp(event) {
  if (!selectionState.dragging || uiState.mode !== 'selecting' || selectionState.submitting) {
    return;
  }

  if (selectionLayerEl?.releasePointerCapture && selectionLayerEl.hasPointerCapture(event.pointerId)) {
    selectionLayerEl.releasePointerCapture(event.pointerId);
  }

  selectionState.current = selectionPointFromEvent(event);
  const rect = currentSelectionRect();
  clearSelectionRect();
  syncUI();

  if (!rect || rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE) {
    uiState.status = 'Selection too small. Drag a larger rectangle.';
    syncUI();
    return;
  }

  await submitSelection(rect);
}

function onSelectionPointerCancel(event) {
  if (selectionLayerEl?.releasePointerCapture && selectionLayerEl.hasPointerCapture(event.pointerId)) {
    selectionLayerEl.releasePointerCapture(event.pointerId);
  }

  clearSelectionRect();
  syncUI();
}

function onWindowKeydown(event) {
  if (event.key !== 'Escape' || uiState.mode !== 'selecting') {
    return;
  }

  event.preventDefault();
  cancelSelection();
}

if (selectionLayerEl) {
  selectionLayerEl.addEventListener('pointerdown', onSelectionPointerDown);
  selectionLayerEl.addEventListener('pointermove', onSelectionPointerMove);
  selectionLayerEl.addEventListener('pointerup', onSelectionPointerUp);
  selectionLayerEl.addEventListener('pointercancel', onSelectionPointerCancel);
  selectionLayerEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (uiState.mode === 'selecting') {
      cancelSelection();
    }
  });
}

window.addEventListener('keydown', onWindowKeydown);

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
