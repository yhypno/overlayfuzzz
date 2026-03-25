# OverlayFuzz

Electron-based overlay + OCR hotkey capture, inspired by Exiled-Exchange-2's approach (overlay window + OCR + global input hooks).

## What it does
- Press `Ctrl/Cmd + Shift + O` to show a transparent overlay and capture around your cursor.
- Press `Ctrl/Cmd + Shift + R` to trigger the secondary capture hotkey. Right now it mirrors the quick capture flow rather than opening a drag-to-select region tool.
- Default pipeline is screenshot -> LLM.
- OCR is optional and can be enabled from Settings to augment prompts before the LLM call.
- Supported LLM providers: OpenRouter, Ollama, OpenAI, Anthropic, Gemini.
- Overlay UI shows LLM output, OCR confidence (when OCR is enabled), status, and error state.
- Press the active hotkey again to hide the overlay.
- Press `Esc` while the overlay is focused to hide it, or `Ctrl/Cmd + ,` to open the overlay settings page.

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
   - or `npm install`
2. (Optional) Provide OCR runtime files if you want OCR enabled in Settings:
   - Preferred: place `tesseract-core-simd.js` (or another supported tesseract core build) and `eng.traineddata` in `./cv-ocr/`
   - Or set:
     - `OVERLAY_FUZZ_TESS_CORE_PATH=/absolute/path/to/tesseract-core-simd.js`
     - `OVERLAY_FUZZ_TRAINEDDATA_PATH=/absolute/path/to/eng.traineddata`
3. Run full dev mode (Vite + Electron + TypeScript watch for main/preload/worker):
   - `bun run dev`
   - or `npm run dev`
4. Optional: build only the Vue renderer bundle:
   - `bun run build:renderer`
   - or `npm run build:renderer`
5. Build everything:
   - `bun run build`
   - or `npm run build`
6. Launch Electron:
   - `bun run start`
   - or `npm run start`

## macOS warning
- Screen capture will not work until the app has Screen Recording permission in `System Settings -> Privacy & Security -> Screen Recording`.
- Global hotkeys and low-level input hooks may not fire until Accessibility access is enabled for the app you launch from (for example Terminal, iTerm, or Electron) in `System Settings -> Privacy & Security -> Accessibility`.
- If hotkeys still do not register on macOS after enabling Accessibility, restart the app after changing permissions.

## Notes
- `uiohook-napi` and `electron-overlay-window` are optional dependencies, so installs can still succeed if native builds are unavailable.
- LLM provider settings (provider, model, base URL, API key, OCR toggle, prompt) are configured from the in-window Settings screen and stored under Electron's user data folder (`overlayfuzz-settings.json`).
- Overlay attachment by target window is opt-in. To enable it, set both:
  - `OVERLAY_FUZZ_ATTACH_TO_TARGET=1`
  - `OVERLAY_FUZZ_TARGET_WINDOW_TITLE="<target window title>"`
- Adjust quick OCR capture size in `src/main.ts` via `CAPTURE_SIZE`.
- OCR worker looks for OCR files in this order:
  - `OVERLAY_FUZZ_TESS_CORE_PATH` / `OVERLAY_FUZZ_TRAINEDDATA_PATH`
  - `./cv-ocr/`
  - fallback paths: `./eng.traineddata` and `node_modules/tesseract.js-core/*`
- If `renderer/dist/index.html` exists, the app loads the Vue renderer. Otherwise it falls back to the legacy renderer copied into `build/renderer/`.
