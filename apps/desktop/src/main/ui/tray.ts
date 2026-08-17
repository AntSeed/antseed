import {
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type Rectangle,
} from 'electron';

let tray: Tray | null = null;
let currentOptions: DesktopTrayOptions | null = null;
let contextMenu: Menu | null = null;

export type DesktopTrayOptions = {
  appName: string;
  iconPath: string | undefined;
  onShow: () => void;
  buildMenu?: () => MenuItemConstructorOptions[];
  onPrimaryClick?: (bounds: Rectangle) => void;
  onBeforeContextMenu?: () => void;
};

function defaultMenu({ appName, onShow }: Pick<DesktopTrayOptions, 'appName' | 'onShow'>): MenuItemConstructorOptions[] {
  return [
    { label: `Show ${appName}`, click: onShow },
    { type: 'separator' },
    { role: 'quit', label: `Quit ${appName}` },
  ];
}

function rebuildMenu(): void {
  if (!currentOptions) return;
  contextMenu = Menu.buildFromTemplate(
    currentOptions.buildMenu?.() ?? defaultMenu(currentOptions),
  );
}

export function createDesktopTray(options: DesktopTrayOptions): void {
  const { appName, iconPath } = options;
  if (process.platform !== 'darwin' || tray || !iconPath) {
    return;
  }

  const sourceImage = nativeImage.createFromPath(iconPath);
  if (sourceImage.isEmpty()) {
    return;
  }

  const image = sourceImage.resize({ width: 18, height: 18 });
  image.setTemplateImage(true);

  tray = new Tray(image);
  currentOptions = options;
  tray.setToolTip(appName);
  rebuildMenu();
  tray.on('click', (_event, bounds) => {
    if (currentOptions?.onPrimaryClick) {
      currentOptions.onPrimaryClick(bounds);
      return;
    }
    if (contextMenu) tray?.popUpContextMenu(contextMenu);
  });
  tray.on('right-click', () => {
    currentOptions?.onBeforeContextMenu?.();
    if (contextMenu) tray?.popUpContextMenu(contextMenu);
  });
}

export function updateDesktopTray(options: Partial<Omit<DesktopTrayOptions, 'iconPath'>> = {}): void {
  if (!currentOptions) return;
  currentOptions = { ...currentOptions, ...options };
  rebuildMenu();
}
