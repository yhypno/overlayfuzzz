const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const metaEl = document.getElementById('meta');

function updateStatus(text) {
  statusEl.textContent = text;
}

function updateResult(payload) {
  if (!payload) return;
  if (payload.error) {
    resultEl.textContent = `Error: ${payload.error}`;
    metaEl.textContent = '';
    return;
  }

  resultEl.textContent = payload.text || '(no text detected)';
  if (payload.confidence === null || payload.confidence === undefined) {
    metaEl.textContent = '';
  } else {
    metaEl.textContent = `Confidence: ${payload.confidence.toFixed(2)}`;
  }
}

if (window.overlayApi) {
  window.overlayApi.onStatus(updateStatus);
  window.overlayApi.onResult(updateResult);
}
