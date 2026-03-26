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
    region?: string;
  };
}

export interface OverlayRegionResponse {
  ok: boolean;
  error?: string;
}

export interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResult) => void): void;
  onMode(callback: (payload: OverlayModePayload) => void): void;
  hideOverlay(): Promise<boolean>;
  getSettings(): Promise<CaptureSettings>;
  updateSettings(settings: CaptureSettings): Promise<CaptureSettings>;
  setScreenshotExclusion(enabled: boolean): Promise<boolean>;
  getScreenshotExclusion(): Promise<boolean>;
}
