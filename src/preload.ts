import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('overlayApi', {
  onStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on('ocr-status', (_event, status: string) => callback(status));
  },
  onResult: (callback: (payload: { text: string; confidence: number | null; error?: string }) => void): void => {
    ipcRenderer.on('ocr-result', (_event, payload) => callback(payload));
  },
  onMode: (callback: (payload: { mode: 'console' | 'selecting'; hotkeys?: { quick?: string; region?: string } }) => void): void => {
    ipcRenderer.on('overlay-mode', (_event, payload) => callback(payload));
  },
  hideOverlay: async (): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:hide-console');
  },
  setScreenshotExclusion: async (enabled: boolean): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:set-screenshot-exclusion', enabled);
  },
  getScreenshotExclusion: async (): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:get-screenshot-exclusion');
  },
});
