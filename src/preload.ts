import { contextBridge, ipcRenderer } from 'electron';

type LlmProvider = 'openrouter' | 'ollama' | 'openai' | 'anthropic' | 'gemini';

interface LlmProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface CaptureSettings {
  useOcr: boolean;
  provider: LlmProvider;
  prompt: string;
  providers: Record<LlmProvider, LlmProviderConfig>;
}

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
  getSettings: async (): Promise<CaptureSettings> => {
    return ipcRenderer.invoke('overlay:get-settings');
  },
  updateSettings: async (settings: CaptureSettings): Promise<CaptureSettings> => {
    return ipcRenderer.invoke('overlay:update-settings', settings);
  },
});
