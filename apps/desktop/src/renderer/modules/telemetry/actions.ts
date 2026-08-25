import type {
  FirstModelShownSignal,
  TelemetryActionSurface,
  TelemetryUserAction,
} from '../../../shared/telemetry.js';
import type { ViewName } from '../../ui/types.js';

const VIEW_SURFACES: Record<ViewName, TelemetryActionSurface> = {
  home: 'home',
  explore: 'explore',
  model: 'model',
  tools: 'apps',
  tunnels: 'tunnels',
  chats: 'chats',
  preferences: 'preferences',
  credits: 'credits',
  deposit: 'deposit',
  activity: 'activity',
  rewards: 'rewards',
  chat: 'chat',
  help: 'help',
  peers: 'peers',
  connection: 'connection',
  desktop: 'desktop',
  config: 'config',
};

export function telemetrySurfaceForView(view: ViewName): TelemetryActionSurface {
  return VIEW_SURFACES[view];
}

export function recordUserAction(action: TelemetryUserAction, surface: TelemetryActionSurface): void {
  try {
    void window.antseedDesktop?.telemetryRecordUserAction?.({ action, surface }).catch(() => undefined);
  } catch {
    // Telemetry must never affect user actions.
  }
}

export function recordFirstModelShown(signal: FirstModelShownSignal): void {
  try {
    void window.antseedDesktop?.telemetryRecordFirstModelShown?.(signal).catch(() => undefined);
  } catch {
    // Telemetry must never affect rendering.
  }
}
