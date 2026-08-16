import { ipcMain, type Rectangle } from 'electron';
import type { BrowserWindow } from 'electron';
import {
  normalizeVprMenuBarAction,
  type VprMenuBarState,
} from '../../shared/vpr-menu-bar.js';
import {
  APP_ICON_PATH,
  APP_NAME,
  isDev,
  rendererUrl,
} from '../app-context.js';
import {
  getMainWindow,
  hideVprMenuBarWindow,
  openVprMenuBarWindow,
  updateVprMenuBarWindow,
} from '../ui/window.js';
import { updateDesktopTray } from '../ui/tray.js';

let currentState: VprMenuBarState | null = null;
let ensureMainWindow: ((visible: boolean) => BrowserWindow | null) | null = null;
let showFloatingWindow: (() => void) | null = null;

export function initVprMenuBarIpc(options: {
  ensureMainWindow: (visible: boolean) => BrowserWindow | null;
  showFloatingWindow: () => void;
}): void {
  ensureMainWindow = options.ensureMainWindow;
  showFloatingWindow = options.showFloatingWindow;
}

function sendToMainRenderer(channel: string, payload: unknown, visible: boolean): void {
  const win = ensureMainWindow?.(visible) ?? getMainWindow();
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

function showModelsOverview(): void {
  const win = ensureMainWindow?.(true) ?? getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  const navigate = (): void => {
    if (!win.isDestroyed()) win.webContents.send('desktop:navigate-view', 'explore');
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', navigate);
  } else {
    navigate();
  }
}

export function setVprMenuBarState(state: VprMenuBarState): void {
  currentState = state;
  updateDesktopTray({ title: '' });
  updateVprMenuBarWindow(state);
}

export function openVprMenuBar(anchor: Rectangle): void {
  if (!currentState) return;
  openVprMenuBarWindow(
    { appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl },
    anchor,
    currentState,
  );
}

export function registerVprMenuBarIpc(): void {
  ipcMain.handle('vpr-menu-bar:get-state', () => currentState);
  ipcMain.on('vpr-menu-bar:action', (_event, raw: unknown) => {
    const action = normalizeVprMenuBarAction(raw);
    if (!action) return;
    if (action.type === 'dismiss') {
      hideVprMenuBarWindow();
      return;
    }
    if (action.type === 'browse-models') {
      hideVprMenuBarWindow();
      showModelsOverview();
      return;
    }
    if (action.type === 'open-main') {
      hideVprMenuBarWindow();
      ensureMainWindow?.(true);
      return;
    }
    if (action.type === 'open-floating-window') {
      hideVprMenuBarWindow();
      showFloatingWindow?.();
      return;
    }
    sendToMainRenderer('vpr-menu-bar:action', action, false);
  });
}
