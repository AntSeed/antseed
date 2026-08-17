type PresentableWindow = {
  show: () => void;
  showInactive: () => void;
};

type MacosNotificationCenter = {
  subscribeNotification: (
    event: string | null,
    callback: (event: string, userInfo: Record<string, unknown>, object: string) => void,
  ) => number;
  unsubscribeNotification: (id: number) => void;
};

type RectangleLike = { x: number; y: number; width: number; height: number };

export const MACOS_BEGIN_MENU_TRACKING_NOTIFICATION = 'com.apple.HIToolbox.beginMenuTrackingNotification';
export const VPR_MENU_BAR_WINDOW_WIDTH = 416;

export function vprMenuBarWindowHeight(conversationCount: number, workAreaHeight: number): number {
  const count = Math.max(0, Math.min(Math.floor(conversationCount), 8));
  const contentHeight = count === 0 ? 348 : 268 + Math.min(count, 7) * 72;
  return Math.min(Math.max(348, Math.min(760, contentHeight)), Math.max(120, workAreaHeight - 16));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function vprMenuBarBounds(
  anchor: RectangleLike,
  workArea: RectangleLike,
  conversationCount: number,
): RectangleLike {
  const height = vprMenuBarWindowHeight(conversationCount, workArea.height);
  return {
    x: clamp(
      Math.round(anchor.x + anchor.width / 2 - VPR_MENU_BAR_WINDOW_WIDTH / 2),
      workArea.x + 8,
      workArea.x + workArea.width - VPR_MENU_BAR_WINDOW_WIDTH - 8,
    ),
    y: clamp(anchor.y + anchor.height + 4, workArea.y + 2, workArea.y + workArea.height - height - 8),
    width: VPR_MENU_BAR_WINDOW_WIDTH,
    height,
  };
}

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

export function subscribeToMacosMenuTracking(
  notifications: MacosNotificationCenter,
  onMenuTracking: () => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'darwin') return () => {};

  const subscriptionId = notifications.subscribeNotification(
    MACOS_BEGIN_MENU_TRACKING_NOTIFICATION,
    onMenuTracking,
  );
  return () => notifications.unsubscribeNotification(subscriptionId);
}
