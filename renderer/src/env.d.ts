/// <reference types="vite/client" />

import type { OverlayApi } from './types/overlay';

declare global {
  interface Window {
    overlayApi?: OverlayApi;
  }
}

export {};
