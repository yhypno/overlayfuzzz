export interface OverlayResult {
  text: string;
  confidence: number | null;
  error?: string;
}

export interface OverlayApi {
  onStatus(callback: (status: string) => void): void;
  onResult(callback: (payload: OverlayResult) => void): void;
}
