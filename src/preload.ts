import { contextBridge, ipcRenderer } from 'electron';

type LlmProvider = 'openrouter' | 'ollama' | 'openai' | 'anthropic' | 'gemini';

interface LlmProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LlmRoleSettings {
  provider: LlmProvider;
  prompt: string;
  config: LlmProviderConfig;
}

interface CaptureSettings {
  useOcr: boolean;
  imageLlm: LlmRoleSettings;
  taskLlm: LlmRoleSettings;
}

interface CapturePreviewPayload {
  id: string;
  thumbnailDataUrl: string;
  capturedAt: number;
}

interface CaptureCollectionPayload {
  captures: CapturePreviewPayload[];
  activeCaptureId: string | null;
}

contextBridge.exposeInMainWorld('overlayApi', {
  onStatus: (callback: (status: string) => void): void => {
    ipcRenderer.removeAllListeners('ocr-status');
    ipcRenderer.on('ocr-status', (_event, status: string) => callback(status));
  },
  onResult: (callback: (payload: { text: string; confidence: number | null; error?: string }) => void): void => {
    ipcRenderer.removeAllListeners('ocr-result');
    ipcRenderer.on('ocr-result', (_event, payload) => callback(payload));
  },
  onMode: (callback: (payload: { mode: 'console' | 'selecting'; hotkeys?: { quick?: string; capture?: string; region?: string } }) => void): void => {
    ipcRenderer.removeAllListeners('overlay-mode');
    ipcRenderer.on('overlay-mode', (_event, payload) => callback(payload));
  },
  onCaptures: (callback: (payload: CaptureCollectionPayload) => void): void => {
    ipcRenderer.removeAllListeners('overlay-captures');
    ipcRenderer.on('overlay-captures', (_event, payload) => callback(payload));
  },
  hideOverlay: async (): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:hide-console');
  },
  getSettings: async (): Promise<CaptureSettings> => {
    return ipcRenderer.invoke('overlay:get-settings');
  },
  getCaptures: async (): Promise<CaptureCollectionPayload> => {
    return ipcRenderer.invoke('overlay:get-captures');
  },
  updateSettings: async (settings: CaptureSettings): Promise<CaptureSettings> => {
    return ipcRenderer.invoke('overlay:update-settings', settings);
  },
  setScreenshotExclusion: async (enabled: boolean): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:set-screenshot-exclusion', enabled);
  },
  getScreenshotExclusion: async (): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:get-screenshot-exclusion');
  },
  submitQuery: async (query: string): Promise<boolean> => {
    return ipcRenderer.invoke('overlay:submit-query', query);
  },
});
