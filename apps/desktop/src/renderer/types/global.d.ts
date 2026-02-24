import type { DesktopBridge } from './bridge';

declare global {
  interface Window {
    antseedDesktop?: DesktopBridge;
  }
}

export {};
