import {
  BrowserWindow,
  Menu,
  dialog,
  nativeImage,
  app,
  screen,
  type Rectangle,
  type MenuItemConstructorOptions,
} from 'electron';
import { windowPresetForView, type WindowSizePresetName } from '../../shared/view-windows.js';
import { PRELOAD_PATH } from '../paths.js';
import { adoptCheckoutWindow, checkoutWindowOpenHandler, closeCheckoutWindows } from '../payments/checkout-window.js';

let mainWindow: BrowserWindow | null = null;

/* Floating always-on-top pill: 256x64 content (model + usage lines) plus an
   8px margin so the drop shadow isn't clipped by the transparent window
   edge. 80 sits right at the macOS transparency floor — frameless
   transparent windows paint an opaque backing below ~80px. */
let floatWindow: BrowserWindow | null = null;
const FLOAT_WINDOW_WIDTH = 272;
const FLOAT_WINDOW_HEIGHT = 80;
/** Pill height while a custom dropdown (chat / model) is open. */
const FLOAT_WINDOW_EXPANDED_HEIGHT = 440;
/* Compact mode: just the 40px app badge in a 56px round chip, centered with a
   16px shadow margin on each side. Kept at 88px (not a tighter 72) because
   macOS drops a transparent frameless window's transparency below ~80px,
   painting the backing opaque — an opaque box around the chip. */
const FLOAT_WINDOW_COMPACT_SIZE = 88;
/* Minimum must not exceed the pill height, or setBounds gets clamped. */
const FLOAT_WINDOW_MIN_HEIGHT = Math.min(FLOAT_WINDOW_HEIGHT, FLOAT_WINDOW_COMPACT_SIZE);
/* The main process owns the pill's compact state (it does the resize), and
   pushes it to the float renderer on change and on load. The renderer can't
   reliably infer it from its own size, so this is the source of truth. */
let floatCompact = false;
/* Whether a dropdown currently holds the pill at its expanded height. Tracked
   here (not read back from getBounds) so the Windows drag-inflation guard
   below knows the size the window is supposed to have. */
let floatExpanded = false;

/** The size the pill window should currently have, per main-process state. */
function floatTargetSize(): { width: number; height: number } {
  if (floatCompact) {
    return { width: FLOAT_WINDOW_COMPACT_SIZE, height: FLOAT_WINDOW_COMPACT_SIZE };
  }
  return {
    width: FLOAT_WINDOW_WIDTH,
    height: floatExpanded ? FLOAT_WINDOW_EXPANDED_HEIGHT : FLOAT_WINDOW_HEIGHT,
  };
}

function sendFloatCompact(): void {
  const win = getFloatWindow();
  if (win && !win.webContents.isDestroyed()) {
    win.webContents.send('vpr-float:compact', floatCompact);
  }
}

export function getFloatWindowCompact(): boolean {
  return floatCompact;
}

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

/**
 * Resize the pill window between the full pill and the compact badge chip.
 * Anchored at the top-right corner (the pill's default home is the screen's
 * top-right), clamped into the work area.
 */
export function setFloatWindowCompact(compact: boolean): void {
  const win = getFloatWindow();
  if (!win) return;
  floatCompact = compact;
  // Both entering and leaving compact land on the collapsed pill height.
  floatExpanded = false;
  // Tell the renderer first so the layout swaps even if the OS clamps the
  // resize below — the shape must always match the intended state.
  sendFloatCompact();
  const bounds = win.getBounds();
  const width = compact ? FLOAT_WINDOW_COMPACT_SIZE : FLOAT_WINDOW_WIDTH;
  const height = compact ? FLOAT_WINDOW_COMPACT_SIZE : FLOAT_WINDOW_HEIGHT;
  const workArea = screen.getDisplayMatching(bounds).workArea;
  // macOS ignores setBounds on non-resizable windows; lift the flag around
  // the programmatic resize. setMinimumSize guards against a default minimum
  // clamping the compact size above FLOAT_WINDOW_COMPACT_SIZE.
  win.setResizable(true);
  win.setMinimumSize(FLOAT_WINDOW_COMPACT_SIZE, FLOAT_WINDOW_MIN_HEIGHT);
  win.setBounds({
    x: clamp(bounds.x + bounds.width - width, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  });
  win.setResizable(false);
}

/**
 * Move the pill by a pointer delta. The chip's centre button and the pill face
 * are click targets, so they can't be `-webkit-app-region` drag handles — the
 * renderer streams pointer deltas here instead.
 *
 * Deliberately `setBounds` with the intended size, never `setPosition`:
 * `setPosition` re-submits the size it reads back off the window, and Windows
 * converts window rects DIP↔pixel with an *enclosing* rounding, so on a
 * display with fractional scaling (125%, 150%) a rect whose origin isn't on a
 * pixel boundary comes back a pixel or two wider than it went in. Feeding that
 * back in on the next pointer tick compounds it — the pill visibly grows as
 * it's dragged. Passing the target size every time makes each move idempotent.
 */
export function moveFloatWindowBy(dx: number, dy: number): void {
  const win = getFloatWindow();
  if (!win) return;
  const bounds = win.getBounds();
  const { width, height } = floatTargetSize();
  const x = Math.round(bounds.x + dx);
  const y = Math.round(bounds.y + dy);
  // Recovering a size that already drifted needs the constraints lifted:
  // a non-resizable window's min/max are pinned to whatever size it had when
  // the flag went off, so an inflated size otherwise clamps itself in place.
  const drifted = bounds.width !== width || bounds.height !== height;
  if (drifted) {
    win.setResizable(true);
    win.setMinimumSize(FLOAT_WINDOW_COMPACT_SIZE, FLOAT_WINDOW_MIN_HEIGHT);
  }
  win.setBounds({ x, y, width, height });
  if (drifted) win.setResizable(false);
}

/**
 * Grow the pill window downward while one of its custom dropdowns is open
 * (DOM popovers can't escape the window bounds the way native selects can),
 * and shrink back when it closes. No-op in compact mode.
 */
export function setFloatWindowExpanded(expanded: boolean): void {
  const win = getFloatWindow();
  if (!win || floatCompact) return;
  floatExpanded = expanded;
  const bounds = win.getBounds();
  const height = expanded ? FLOAT_WINDOW_EXPANDED_HEIGHT : FLOAT_WINDOW_HEIGHT;
  if (bounds.height === height) return;
  const workArea = screen.getDisplayMatching(bounds).workArea;
  win.setResizable(true);
  win.setMinimumSize(FLOAT_WINDOW_COMPACT_SIZE, FLOAT_WINDOW_MIN_HEIGHT);
  win.setBounds({
    x: bounds.x,
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width: FLOAT_WINDOW_WIDTH,
    height,
  });
  win.setResizable(false);
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
    // Windows drops the topmost flag on showInactive() — put it back.
    if (process.platform === 'win32') existing.setAlwaysOnTop(true, 'floating');
    return existing;
  }

  const anchor = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.getBounds()
    : { x: 0, y: 0, width: 0, height: 0 };
  const workArea = screen.getDisplayMatching(anchor).workArea;

  // A freshly opened pill always starts full-size, collapsed.
  floatCompact = false;
  floatExpanded = false;

  floatWindow = new BrowserWindow({
    // Shown inactive after load: the pill is a passive overlay and must not
    // steal focus from the app the user is working in — especially when it
    // auto-opens on incoming traffic.
    show: false,
    width: FLOAT_WINDOW_WIDTH,
    height: FLOAT_WINDOW_HEIGHT,
    minWidth: FLOAT_WINDOW_COMPACT_SIZE,
    minHeight: FLOAT_WINDOW_MIN_HEIGHT,
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
      preload: PRELOAD_PATH,
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

  // Windows: dragging a frameless non-resizable window on a display with
  // fractional DPI scaling inflates its bounds a bit on every drag — the
  // native move loop re-applies size constraints with mismatched DIP↔pixel
  // rounding (long-standing Electron bug). Snap back to the intended size
  // after each move.
  if (process.platform === 'win32') {
    created.on('moved', () => {
      if (created.isDestroyed()) return;
      const { width, height } = floatTargetSize();
      const bounds = created.getBounds();
      if (bounds.width !== width || bounds.height !== height) {
        created.setBounds({ x: bounds.x, y: bounds.y, width, height });
      }
    });
    // Windows silently drops the topmost flag — showInactive() clears it, and
    // z-order shuffles by other windows can too (long-standing Electron bugs).
    // Re-assert it whenever the pill is shown or loses focus.
    const reassertOnTop = (): void => {
      if (!created.isDestroyed()) created.setAlwaysOnTop(true, 'floating');
    };
    created.on('show', reassertOnTop);
    created.on('blur', reassertOnTop);
  }

  created.webContents.once('did-finish-load', () => {
    if (created.isDestroyed()) return;
    created.showInactive();
    // Windows drops the topmost flag on showInactive() — put it back.
    if (process.platform === 'win32') created.setAlwaysOnTop(true, 'floating');
    if (initialData !== undefined) {
      created.webContents.send('vpr-float:data', initialData);
    }
    // Push the authoritative compact state so a reload can't leave the layout
    // out of sync with the window's real state.
    created.webContents.send('vpr-float:compact', floatCompact);
    // The pill is a separate window, so the main window's DevTools can't
    // inspect it. Open its own DevTools in dev; the shortcut below reopens it.
    if (config.isDev) {
      created.webContents.openDevTools({ mode: 'detach' });
    }
  });

  // ⌘⌥I (macOS) / Ctrl+Shift+I to (re)open the pill's DevTools. Focus the
  // pill first (click it) so it receives the keystroke.
  created.webContents.on('before-input-event', (_event, input) => {
    const toggle =
      (input.meta && input.alt && input.key === 'i')
      || (input.control && input.shift && input.key === 'I');
    if (toggle && !created.isDestroyed()) {
      created.webContents.openDevTools({ mode: 'detach' });
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
  return win.getContentBounds();
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
    lastStandardBounds = win.getContentBounds();
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
    win.setContentBounds(targetBounds, true);
    return { ok: true };
  }

  win.setMinimumSize(preset.minWidth, preset.minHeight);
  win.setContentBounds(centerBoundsWithinDisplay(currentBounds, preset), true);
  return { ok: true };
}

export function applyWindowView(viewName: string): { ok: true; skipped?: 'fullscreen' | 'maximized' | 'missing-window' } {
  return applySizePreset(windowPresetForView(viewName));
}

/* Explicit preset override for views that support both sizes — the chat view
   opens compact but can be expanded to reveal the conversation-list panel.
   Expanding only grows the window horizontally: it takes the standard
   preset's width but keeps the current height and vertical position, so the
   panel slides in without the window jumping to the tall standard size. */
export function applyWindowPreset(presetName: string): { ok: true; skipped?: 'fullscreen' | 'maximized' | 'missing-window' } {
  if (presetName !== 'standard') {
    return applySizePreset('compact');
  }

  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    return { ok: true, skipped: 'missing-window' };
  }
  const currentBounds = normalWindowBounds(win);
  if (!currentBounds) {
    return { ok: true, skipped: win.isFullScreen() ? 'fullscreen' : 'maximized' };
  }

  const standard = WINDOW_SIZE_PRESETS.standard;
  const display = screen.getDisplayMatching(currentBounds).workArea;
  const width = Math.min(standard.width, display.width);
  const x = clamp(
    Math.round(currentBounds.x + (currentBounds.width - width) / 2),
    display.x,
    display.x + display.width - width,
  );

  win.setResizable(true);
  // Width grows to the standard minimum; height keeps the compact floor
  // since the expanded chat window stays at its current (compact) height.
  win.setMinimumSize(standard.minWidth, WINDOW_SIZE_PRESETS.compact.minHeight);
  win.setContentBounds({ x, y: currentBounds.y, width, height: currentBounds.height }, true);
  return { ok: true };
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
    useContentSize: true,
    autoHideMenuBar: process.platform !== 'darwin',
    // Starts on the compact preset, which is fixed-size; applySizePreset
    // re-enables resizing when a standard-preset view (chat) is shown.
    resizable: false,
    title: config.appName,
    icon: config.appIconPath,
    backgroundColor: '#ececec',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
    ...macosWindowChrome,
  });

  // Sized popups (the Fun checkout's card/sign-in flows) open as app-owned
  // child windows so they can be closed when the payment lands; everything
  // else leaves for the system browser.
  mainWindow.webContents.setWindowOpenHandler(checkoutWindowOpenHandler);
  mainWindow.webContents.on('did-create-window', (child) => adoptCheckoutWindow(child));

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
    closeCheckoutWindows();
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
