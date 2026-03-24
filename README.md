# OverlayFuzz

Electron-based overlay + OCR hotkey capture, inspired by Exiled-Exchange-2's approach (overlay window + OCR + global input hooks).

## What it does
- Press `Ctrl/Cmd + Shift + O` to show a transparent overlay and OCR around your cursor.
- Press `Ctrl/Cmd + Shift + R` to open a translucent selection layer, draw a rectangle, and OCR that exact region.
- Overlay UI shows OCR text, confidence, status, and error state.
- Press the currently active hotkey again to hide/cancel the overlay mode.

## Stack
- Electron main process (`src/main.ts`) orchestrates capture, OCR, and global input hooks.
- Optional hook backends:
  - `uiohook-napi` for low-level global input events.
  - Electron `globalShortcut` fallback when `uiohook-napi` is unavailable.
- Optional `electron-overlay-window` bridge via `OVERLAY_FUZZ_TARGET_WINDOW_TITLE`.
- Renderer stack scaffold under `renderer/`:
  - Vue 3 + Vite + TypeScript + Tailwind CSS.
- Legacy plain renderer fallback under `src/renderer/` remains available.

## Setup
1. Install dependencies:
   - `bun install`
2. Run full dev mode (Vite + Electron + TypeScript watch for main/preload/worker):
   - `bun run dev`
3. Build renderer bundle:
   - `bun run build:renderer`
4. Build everything:
   - `bun run build`
5. Run Electron directly:
   - `bun run start`
6. Optional npm fallback:
   - `npm install && npm run dev`

## Notes
- On macOS, grant Screen Recording permission for capture/OCR.
- `uiohook-napi` and `electron-overlay-window` are optional dependencies, so installs can still succeed if native builds are unavailable.
- Overlay attachment by target window is opt-in. To enable it, set both:
  - `OVERLAY_FUZZ_ATTACH_TO_TARGET=1`
  - `OVERLAY_FUZZ_TARGET_WINDOW_TITLE="<target window title>"`
- Adjust OCR capture size in `src/main.ts` via `CAPTURE_SIZE`.
- OCR worker uses `tesseract-core-simd` directly (`TessBaseAPI`) and looks for OCR files in:
  - `./cv-ocr/` (preferred, Exiled/Awakened style)
  - fallback: `./eng.traineddata` and bundled `node_modules/tesseract.js-core/tesseract-core-simd.js`
