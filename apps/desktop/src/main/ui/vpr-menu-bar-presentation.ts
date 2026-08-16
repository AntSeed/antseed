type PresentableWindow = {
  show: () => void;
  showInactive: () => void;
};

export function presentVprMenuBarWindow(
  window: PresentableWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'darwin') {
    window.show();
    return;
  }

  window.showInactive();
}
