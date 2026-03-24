interface OverlayResultPayload {
  text: string;
  confidence: number | null;
  error?: string;
}

interface OverlayModePayload {
  mode: 'console' | 'selecting';
  hotkeys?: {
    quick?: string;
    region?: string;
  };
}

interface OverlaySelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResultPayload) => void): void;
  onMode(callback: (payload: OverlayModePayload) => void): void;
  hideOverlay(): void;
  cancelSelection?(): void;
  submitRegion?(rect: OverlaySelectionRect): Promise<{ ok: boolean; error?: string }>;
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
const selectionLayerEl = document.getElementById('selectionLayer');
const selectionRectEl = document.getElementById('selectionRect');
const selectionRectLabelEl = document.getElementById('selectionRectLabel');

const MIN_SELECTION_SIZE = 6;

const uiState = {
  status: 'Press Ctrl/Cmd + Shift + O for quick OCR or Ctrl/Cmd + Shift + R to select a region.',
  result: 'Waiting for OCR...',
  confidence: null as number | null,
  error: '',
  state: 'idle' as 'idle' | 'capturing' | 'processing' | 'done' | 'error',
  mode: 'console' as 'console' | 'selecting',
  hotkeys: {
    quick: 'Ctrl/Cmd + Shift + O',
    region: 'Ctrl/Cmd + Shift + R',
  },
};

const selectionState = {
  dragging: false,
  submitting: false,
  start: null as { x: number; y: number } | null,
  current: null as { x: number; y: number } | null,
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

function currentSelectionRect(): OverlaySelectionRect | null {
  if (!selectionState.start || !selectionState.current) {
    return null;
  }

  const left = Math.min(selectionState.start.x, selectionState.current.x);
  const top = Math.min(selectionState.start.y, selectionState.current.y);
  const width = Math.abs(selectionState.current.x - selectionState.start.x);
  const height = Math.abs(selectionState.current.y - selectionState.start.y);

  return { x: left, y: top, width, height };
}

function clearSelectionRect(): void {
  selectionState.dragging = false;
  selectionState.start = null;
  selectionState.current = null;
}

function updateSelectionRectUI(): void {
  if (!selectionRectEl || !selectionRectLabelEl) return;

  const rect = currentSelectionRect();
  if (!rect) {
    selectionRectEl.classList.add('hidden');
    return;
  }

  selectionRectEl.classList.remove('hidden');
  (selectionRectEl as HTMLElement).style.left = `${rect.x}px`;
  (selectionRectEl as HTMLElement).style.top = `${rect.y}px`;
  (selectionRectEl as HTMLElement).style.width = `${rect.width}px`;
  (selectionRectEl as HTMLElement).style.height = `${rect.height}px`;
  selectionRectLabelEl.textContent = `${Math.round(rect.width)} x ${Math.round(rect.height)}`;
}

function syncUI(): void {
  document.body.dataset.state = uiState.state;
  document.body.dataset.mode = uiState.mode;
  if (statusEl) statusEl.textContent = uiState.status;
  if (resultEl) resultEl.textContent = uiState.result;
  if (metaEl) {
    metaEl.textContent =
      uiState.mode === 'selecting'
        ? 'Selection mode active'
        : uiState.state === 'error'
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

  if (selectionLayerEl) {
    selectionLayerEl.classList.toggle('hidden', uiState.mode !== 'selecting');
  }

  updateSelectionRectUI();
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

function selectionPointFromEvent(event: PointerEvent): { x: number; y: number } {
  if (!selectionLayerEl) return { x: 0, y: 0 };
  const bounds = selectionLayerEl.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function cancelSelection(): void {
  clearSelectionRect();
  selectionState.submitting = false;
  syncUI();

  if (window.overlayApi?.cancelSelection) {
    window.overlayApi.cancelSelection();
  }
}

async function submitSelection(rect: OverlaySelectionRect): Promise<void> {
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
    uiState.error = error instanceof Error ? error.message : String(error);
    uiState.state = 'error';
    syncUI();
  } finally {
    selectionState.submitting = false;
  }
}

function onSelectionPointerDown(event: PointerEvent): void {
  if (
    uiState.mode !== 'selecting' ||
    selectionState.submitting ||
    event.button !== 0 ||
    !selectionLayerEl ||
    !(event.target instanceof Node) ||
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

function onSelectionPointerMove(event: PointerEvent): void {
  if (!selectionState.dragging || uiState.mode !== 'selecting' || selectionState.submitting) {
    return;
  }

  selectionState.current = selectionPointFromEvent(event);
  updateSelectionRectUI();
}

async function onSelectionPointerUp(event: PointerEvent): Promise<void> {
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

function onSelectionPointerCancel(event: PointerEvent): void {
  if (selectionLayerEl?.releasePointerCapture && selectionLayerEl.hasPointerCapture(event.pointerId)) {
    selectionLayerEl.releasePointerCapture(event.pointerId);
  }

  clearSelectionRect();
  syncUI();
}

function onWindowKeydown(event: KeyboardEvent): void {
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

export {};
