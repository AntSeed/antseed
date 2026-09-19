import { assertRoutingPreferences, type RoutingPreferences } from '@antseed/protocol';

export type RoutingServiceTarget = {
  peerId: string;
  provider: string;
  serviceId: string;
};

export type RoutingSelection =
  | { kind: 'model'; model: string | null }
  | { kind: 'router'; service?: RoutingServiceTarget; preferences?: RoutingPreferences };

export function isRoutingSelection(value: unknown): value is RoutingSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  if (selection.kind === 'model') {
    return Object.keys(selection).every((key) => key === 'kind' || key === 'model')
      && (selection.model === null || (typeof selection.model === 'string' && selection.model.trim().length > 0));
  }
  if (selection.kind !== 'router' || Object.keys(selection).some((key) => key !== 'kind' && key !== 'service' && key !== 'preferences')) return false;
  if (selection.preferences !== undefined) {
    try { assertRoutingPreferences(selection.preferences); } catch { return false; }
  }
  if (selection.service === undefined) return selection.preferences === undefined;
  if (!selection.service || typeof selection.service !== 'object' || Array.isArray(selection.service)) return false;
  const service = selection.service as Record<string, unknown>;
  return Object.keys(service).every((key) => ['peerId', 'provider', 'serviceId'].includes(key))
    && typeof service.peerId === 'string' && /^(?:0x)?[0-9a-f]{40}$/i.test(service.peerId)
    && typeof service.provider === 'string' && service.provider.trim().length > 0
    && typeof service.serviceId === 'string' && service.serviceId.trim().length > 0;
}
