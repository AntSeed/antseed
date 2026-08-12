import type { DesktopBridge } from './bridge';

declare global {
  const __ANTSEED_CONVERSION_DEV__: boolean;

  interface Window {
    antseedDesktop?: DesktopBridge;
    antseedConversionDev?: {
      show: (variant?: 'd1' | 'd2' | 'd5' | 'd15') => string;
      hide: () => void;
    };
  }
}

export {};
