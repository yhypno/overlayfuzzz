# OverlayFuzz

Electron-based overlay + OCR hotkey capture, inspired by Exiled-Exchange-2's tech approach (Electron overlay window + OCR + global hotkeys).

## What it does
- Press `Ctrl/Cmd + Shift + O` to show a transparent overlay and OCR the area around your cursor.
- The overlay displays the recognized text and OCR confidence.
- Press the same hotkey again to hide the overlay.

## Setup
1. Install dependencies:
   - `npm install`
2. Run the app:
   - `npm run dev`

## Notes
- On macOS, you must grant Screen Recording permission to the Electron app for screenshots/OCR to work.
- The OCR worker is provided by `tesseract.js`. If you want to use offline language data, place `eng.traineddata` under `src/tessdata/` and update `createWorker` options.
- Adjust the capture size in `src/main.js` (`CAPTURE_SIZE`).

## Tech choices
- Electron main process for global hotkey + capture orchestration.
- Transparent always-on-top renderer for overlay UI.
- `screenshot-desktop` + `jimp` for capture and cropping.
- `tesseract.js` for OCR.
