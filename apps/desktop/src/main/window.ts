import {
  BrowserWindow,
  shell,
  Menu,
  dialog,
  nativeImage,
  app,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

export interface WindowConfig {
  appName: string;
  appIconPath: string | undefined;
  isDev: boolean;
  rendererUrl: string;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function createWindow(config: WindowConfig): void {
  const macosWindowChrome = process.platform === 'darwin'
    ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 16 },
    }
    : {};

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: config.appName,
    icon: config.appIconPath,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...macosWindowChrome,
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', true);
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('fullscreen-change', false);
  });
  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('window-focus-change', true);
  });
  mainWindow.on('blur', () => {
    mainWindow?.webContents.send('window-focus-change', false);
  });

  void mainWindow.loadURL(config.rendererUrl);

  mainWindow.webContents.on('did-finish-load', () => {
    if (!config.isDev || !mainWindow) return;
    void mainWindow.webContents
      .executeJavaScript('Boolean(window.antseedDesktop)', true)
      .then((ok) => {
        console.log(`[desktop] preload bridge ${ok ? 'ready' : 'missing'}`);
      })
      .catch((err) => {
        console.error(`[desktop] preload bridge check failed: ${String(err)}`);
      });
  });

  if (config.isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Allow opening DevTools in production for debugging (Cmd+Option+I / Ctrl+Shift+I).
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const devToolsShortcut =
      (input.meta && input.alt && input.key === 'i') ||   // macOS: Cmd+Option+I
      (input.control && input.shift && input.key === 'I'); // Windows/Linux: Ctrl+Shift+I
    if (devToolsShortcut && mainWindow) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showAboutDialog(appName: string, appIconPath: string | undefined): void {
  void dialog.showMessageBox({
    type: 'none',
    title: `About ${appName}`,
    message: appName,
    detail: `Version ${app.getVersion()}`,
    buttons: ['OK'],
    icon: appIconPath ? nativeImage.createFromPath(appIconPath) : undefined,
  });
}

export function createApplicationMenu(appName: string, appIconPath: string | undefined): void {
  const template: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
      {
        label: appName,
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: `Hide ${appName}` },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: `Quit ${appName}` },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
        ],
      },
    ]
    : [
      {
        role: 'fileMenu',
      },
      {
        role: 'editMenu',
      },
      {
        role: 'viewMenu',
      },
      {
        role: 'windowMenu',
      },
      {
        role: 'help',
        submenu: [
          { label: `About ${appName}`, click: () => showAboutDialog(appName, appIconPath) },
        ],
      },
    ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
