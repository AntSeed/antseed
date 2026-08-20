type DoubleClickConfigurableTray = {
  setIgnoreDoubleClickEvents: (ignore: boolean) => void;
};

export function configureTrayClickBehavior(
  tray: DoubleClickConfigurableTray,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
}
