const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onStatus: (callback) => ipcRenderer.on('ocr-status', (_event, status) => callback(status)),
  onResult: (callback) => ipcRenderer.on('ocr-result', (_event, payload) => callback(payload)),
});
