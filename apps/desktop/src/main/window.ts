import {
  BrowserWindow,
  shell,
  Menu,
  dialog,
  nativeImage,
  app,
  screen,
  type Rectangle,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowPresetForView, type WindowSizePresetName } from '../shared/view-windows.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

/* Floating always-on-top pill: 256x72 content (model / app / usage lines)
   plus an 8px margin so the drop shadow isn't clipped by the transparent
   window edge. */
let floatWindow: BrowserWindow | null = null;
const FLOAT_WINDOW_WIDTH = 272;
const FLOAT_WINDOW_HEIGHT = 88;

type WindowSizePreset = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

const WINDOW_SIZE_PRESETS: Record<WindowSizePresetName, WindowSizePreset> = {
  standard: {
    width: 1240,
    height: 860,
    minWidth: 980,
    minHeight: 700,
  },
  compact: {
    // 88px nav rail + 424px pane: the pane shows the 392px content stack
    // with 16px view padding, so the 408px-wide banner asset renders at its
    // native size with the design's 8px side gutters.
    width: 512,
    height: 656,
    minWidth: 480,
    minHeight: 560,
  },
};

let activeSizePreset: WindowSizePresetName = 'standard';
let lastStandardBounds: Rectangle | null = null;

export interface WindowConfig {
  appName: string;
  appIconPath: string | undefined;
  isDev: boolean;
  rendererUrl: string;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getFloatWindow(): BrowserWindow | null {
  return floatWindow && !floatWindow.isDestroyed() ? floatWindow : null;
}

export function closeFloatWindow(): void {
  getFloatWindow()?.close();
}

function floatRendererUrl(rendererUrl: string): string {
  // Dev: http://127.0.0.1:5174/ -> .../float.html
  // Prod: file://.../renderer/index.html -> .../renderer/float.html
  return rendererUrl.includes('index.html')
    ? rendererUrl.replace('index.html', 'float.html')
    : new URL('float.html', rendererUrl).toString();
}

export function openFloatWindow(config: WindowConfig, initialData: unknown): BrowserWindow {
  const existing = getFloatWindow();
  if (existing) {
    if (initialData !== undefined) {
      existing.webContents.send('vpr-float:data', initialData);
    }
    existing.showInactive();
    return existing;
  }

  const anchor = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: 0, y: 0, width: 0, height: 0 };
  const workArea = screen.getDisplayMatching(anchor).workArea;

  floatWindow = new BrowserWindow({
    width: FLOAT_WINDOW_WIDTH,
    height: FLOAT_WINDOW_HEIGHT,
    x: workArea.x + workArea.width - FLOAT_WINDOW_WIDTH - 24,
    y: workArea.y + 24,
    title: config.appName,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const created = floatWindow;

  // 'floating' keeps the pill above normal app windows without fighting
  // system-level panels; visible on every space so it follows the user.
  // Deliberately NOT visibleOnFullScreen: that option flips the macOS
  // activation policy to accessory, removing the app from Cmd+Tab and
  // the Dock.
  created.setAlwaysOnTop(true, 'floating');
  created.setVisibleOnAllWorkspaces(true);

  created.webContents.once('did-finish-load', () => {
    if (initialData !== undefined && !created.isDestroyed()) {
      created.webContents.send('vpr-float:data', initialData);
    }
  });

  void created.loadURL(floatRendererUrl(config.rendererUrl));

  created.on('closed', () => {
    if (floatWindow === created) floatWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vpr-float:closed');
    }
  });

  return created;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalWindowBounds(win: BrowserWindow): Rectangle | null {
  if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) {
    return null;
  }
  return win.getBounds();
}

function centerBoundsWithinDisplay(current: Rectangle, preset: WindowSizePreset): Rectangle {
  const display = screen.getDisplayMatching(current).workArea;
  const width = Math.min(preset.width, display.width);
  const height = Math.min(preset.height, display.height);
  const x = clamp(
    Math.round(current.x + (current.width - width) / 2),
    display.x,
    display.x + display.width - width,
  );
  const y = clamp(
    Math.round(current.y + (current.height - height) / 2),
    display.y,
    display.y + display.height - height,
  );

  return { x, y, width, height };
}

function clampBoundsToPreset(bounds: Rectangle, preset: WindowSizePreset): Rectangle {
  return {
    ...bounds,
    width: Math.max(bounds.width, preset.minWidth),
    height: Math.max(bounds.height, preset.minHeight),
  };
}

function applySizePreset(presetName: WindowSizePresetName): { ok: true; skipped?: 'fullscreen' | 'maximized' | 'missing-window' } {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return { ok: true, skipped: 'missing-window' };
  }

  if (activeSizePreset === 'standard') {
    lastStandardBounds = win.getNormalBounds();
  }
  activeSizePreset = presetName;

  const currentBounds = normalWindowBounds(win);
  if (!currentBounds) {
    return { ok: true, skipped: win.isFullScreen() ? 'fullscreen' : 'maximized' };
  }

  const preset = WINDOW_SIZE_PRESETS[presetName];
  // The compact panel is a fixed-size surface — no manual resizing (on macOS
  // this also disables the zoom button). The standard (chat) preset stays
  // user-resizable. Programmatic setBounds below is unaffected.
  win.setResizable(presetName === 'standard');
  if (presetName === 'standard') {
    const targetBounds = clampBoundsToPreset(
      lastStandardBounds ?? centerBoundsWithinDisplay(currentBounds, preset),
      preset,
    );
    win.setMinimumSize(preset.minWidth, preset.minHeight);
    win.setBounds(targetBounds, true);
    return { ok: true };
  }

  win.setMinimumSize(preset.minWidth, preset.minHeight);
  win.setBounds(centerBoundsWithinDisplay(currentBounds, preset), true);
  return { ok: true };
}

export function applyWindowView(viewName: string): { ok: true; skipped?: 'fullscreen' | 'maximized' | 'missing-window' } {
  return applySizePreset(windowPresetForView(viewName));
}

export function createWindow(config: WindowConfig): void {
  // The default view is 'home', which maps to the compact preset (see
  // applyWindowView). Open at that size so the window doesn't briefly render
  // large and then snap down on first mount.
  const initialPreset = WINDOW_SIZE_PRESETS.compact;
  activeSizePreset = 'compact';
  const macosWindowChrome = process.platform === 'darwin'
    ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 16 },
    }
    : {};

  mainWindow = new BrowserWindow({
    width: initialPreset.width,
    height: initialPreset.height,
    minWidth: initialPreset.minWidth,
    minHeight: initialPreset.minHeight,
    // Starts on the compact preset, which is fixed-size; applySizePreset
    // re-enables resizing when a standard-preset view (chat) is shown.
    resizable: false,
    title: config.appName,
    icon: config.appIconPath,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
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
    setTimeout(() => applySizePreset(activeSizePreset), 0);
  });
  mainWindow.on('unmaximize', () => {
    setTimeout(() => applySizePreset(activeSizePreset), 0);
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

    // Windows: Ctrl++ sends Ctrl+Shift+= which does not match the viewMenu's
    // CmdOrCtrl+= zoom-in accelerator. Handle it explicitly so zoom is symmetrical.
    if (
      input.type === 'keyDown' &&
      input.control &&
      !input.alt &&
      input.key === '+' &&
      mainWindow
    ) {
      mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeFloatWindow();
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
