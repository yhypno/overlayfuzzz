export interface OverlayResult {
  text: string;
  confidence: number | null;
  error?: string;
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
  setScreenshotExclusion(enabled: boolean): Promise<boolean>;
  getScreenshotExclusion(): Promise<boolean>;
}
