export interface OverlayResult {
  text: string;
  confidence: number | null;
  error?: string;
}

export type LlmProvider = 'openrouter' | 'ollama' | 'openai' | 'anthropic' | 'gemini';

export interface LlmProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmRoleSettings {
  provider: LlmProvider;
  prompt: string;
  config: LlmProviderConfig;
}

export interface CaptureSettings {
  useOcr: boolean;
  imageLlm: LlmRoleSettings;
  taskLlm: LlmRoleSettings;
}

export interface OverlayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayModePayload {
  mode: 'console' | 'selecting';
  hotkeys?: {
    quick?: string;
    capture?: string;
    region?: string;
  };
}

export interface CapturePreviewPayload {
  id: string;
  thumbnailDataUrl: string;
  capturedAt: number;
}

export interface CaptureCollectionPayload {
  captures: CapturePreviewPayload[];
  activeCaptureId: string | null;
}

export interface OverlayRegionResponse {
  ok: boolean;
  error?: string;
}

export interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResult) => void): void;
  onMode(callback: (payload: OverlayModePayload) => void): void;
  onCaptures(callback: (payload: CaptureCollectionPayload) => void): void;
  hideOverlay(): Promise<boolean>;
  getSettings(): Promise<CaptureSettings>;
  getCaptures(): Promise<CaptureCollectionPayload>;
  updateSettings(settings: CaptureSettings): Promise<CaptureSettings>;
  setScreenshotExclusion(enabled: boolean): Promise<boolean>;
  getScreenshotExclusion(): Promise<boolean>;
  submitQuery(query: string): Promise<boolean>;
}
