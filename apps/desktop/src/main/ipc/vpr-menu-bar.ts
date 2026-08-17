import { ipcMain, type BrowserWindow, type Rectangle } from 'electron';
import { normalizeVprMenuBarAction } from '../../shared/vpr-menu-bar.js';
import {
  APP_ICON_PATH,
  APP_NAME,
  isDev,
  rendererUrl,
} from '../app-context.js';
import { getLastVprFloatData, routeVprSurfaceAction } from './float.js';
import {
  getVprMenuBarPointerPosition,
  getMainWindow,
  hideVprMenuBarWindow,
  openVprMenuBarWindow,
} from '../ui/window.js';

let ensureMainWindow: ((visible: boolean) => BrowserWindow | null) | null = null;
let showFloatingWindow: (() => void) | null = null;

export function initVprMenuBarIpc(options: {
  ensureMainWindow: (visible: boolean) => BrowserWindow | null;
  showFloatingWindow: () => void;
}): void {
  ensureMainWindow = options.ensureMainWindow;
  showFloatingWindow = options.showFloatingWindow;
}

function sendToMainRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win) return;
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function showMainView(view: 'home' | 'chats'): void {
  const win = ensureMainWindow?.(true) ?? getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const navigate = (): void => {
    if (!win.isDestroyed()) win.webContents.send('desktop:navigate-view', view);
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', navigate);
  } else {
    navigate();
  }
}

function notifyVisibility(visible: boolean): void {
  sendToMainRenderer('vpr-menu-bar:visibility', visible);
}

export function openVprMenuBar(anchor: Rectangle): void {
  ensureMainWindow?.(false);
  openVprMenuBarWindow(
    { appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl },
    anchor,
    getLastVprFloatData(),
    notifyVisibility,
  );
}

export function registerVprMenuBarIpc(): void {
  ipcMain.handle('vpr-menu-bar:get-state', () => getLastVprFloatData());
  ipcMain.handle('vpr-menu-bar:get-placement', () => getVprMenuBarPointerPosition());
  ipcMain.on('vpr-menu-bar:action', (_event, raw: unknown) => {
    const action = normalizeVprMenuBarAction(raw);
    if (!action) return;
    if (action.type === 'dismiss') {
      hideVprMenuBarWindow();
      return;
    }
    if (action.type === 'open-main' || action.type === 'open-chats') {
      hideVprMenuBarWindow();
      showMainView(action.type === 'open-chats' ? 'chats' : 'home');
      return;
    }
    if (action.type === 'open-floating-window') {
      hideVprMenuBarWindow();
      showFloatingWindow?.();
      return;
    }
    routeVprSurfaceAction(action);
  });
}
