# OverlayFuzz

Electron-based overlay + OCR hotkey capture, inspired by Exiled-Exchange-2's approach (overlay window + OCR + global input hooks).

## What it does
- Press `Ctrl/Cmd + Shift + O` to show a transparent overlay and OCR around your cursor.
- Overlay UI shows OCR text, confidence, status, and error state.
- Press the same hotkey again to hide the overlay.

## Stack
- Electron main process (`src/main.js`) orchestrates capture, OCR, and global input hooks.
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
2. Run full dev mode (Vite + Electron):
   - `bun run dev`
3. Build renderer bundle:
   - `bun run build:renderer`
4. Run Electron directly:
   - `bun run start`
5. Optional npm fallback:
   - `npm install && npm run dev`

## Notes
- On macOS, grant Screen Recording permission for capture/OCR.
- `uiohook-napi` and `electron-overlay-window` are optional dependencies, so installs can still succeed if native builds are unavailable.
- To enable overlay attachment by title, set:
  - `OVERLAY_FUZZ_TARGET_WINDOW_TITLE="<target window title>"`
- Adjust OCR capture size in `src/main.js` via `CAPTURE_SIZE`.
