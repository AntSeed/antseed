import { Menu, nativeImage, Tray } from 'electron';

let tray: Tray | null = null;

export type DesktopTrayOptions = {
  appName: string;
  iconPath: string | undefined;
  onShow: () => void;
};

export function createDesktopTray({ appName, iconPath, onShow }: DesktopTrayOptions): void {
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
  tray.setToolTip(appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Show ${appName}`, click: onShow },
    { type: 'separator' },
    { role: 'quit', label: `Quit ${appName}` },
  ]));
  tray.on('click', onShow);
}
