import { ipcMain, Notification } from 'electron';
import { applyWindowView, getMainWindow } from '../ui/window.js';

type ConversionNotifyPayload = {
  variant: 'd1' | 'd2' | 'd5' | 'd15';
  retrospectiveUsd: string;
  prospectiveUsd: string;
};

function validVariant(value: unknown): value is ConversionNotifyPayload['variant'] {
  return value === 'd1' || value === 'd2' || value === 'd5' || value === 'd15';
}

const activeNotifications = new Set<Notification>();

function validUsd(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\d+)(?:\.\d{1,2})?$/.test(value);
}

function parsePayload(value: unknown): ConversionNotifyPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!validVariant(payload.variant)) return null;
  if (payload.retrospectiveUsd !== '' && !validUsd(payload.retrospectiveUsd)) return null;
  if (!validUsd(payload.prospectiveUsd)) return null;
  return {
    variant: payload.variant,
    retrospectiveUsd: payload.retrospectiveUsd,
    prospectiveUsd: payload.prospectiveUsd,
  };
}

function openDepositView(): void {
  const window = getMainWindow();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  applyWindowView('deposit');
  window.webContents.send('desktop:navigate-view', 'deposit');
  window.show();
  window.focus();
}

export function registerConversionIpc(): void {
  ipcMain.handle('conversion:notify', (_event, rawPayload: unknown) => {
    const payload = parsePayload(rawPayload);
    if (!payload) return { ok: false, error: 'Invalid conversion notification payload' };
    if (!Notification.isSupported()) return { ok: false, error: 'Notifications are not supported' };

    const retrospective = payload.retrospectiveUsd
      ? `$${payload.retrospectiveUsd} of free inference${payload.variant === 'd1' ? ' today' : ' so far'}.`
      : 'Your AntSeed requests have been free.';
    const notification = new Notification({
      title: 'AntSeed',
      body: `${retrospective} $10 ≈ $${payload.prospectiveUsd} of frontier models.`,
    });
    activeNotifications.add(notification);
    notification.once('click', () => {
      activeNotifications.delete(notification);
      openDepositView();
    });
    notification.once('close', () => activeNotifications.delete(notification));
    notification.show();
    return { ok: true };
  });
}
