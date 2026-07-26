/**
 * Per-model seller pins.
 *
 * The route selection holds one model and one peer, so switching models used
 * to throw away the pin the old model had. Pins live here instead — keyed by
 * model — so a model you pinned to a seller comes back pinned to that seller
 * when you select it again. The selection still carries the *active* pin; this
 * store is what re-fills it on a model switch.
 */

export const VPR_MODEL_PINS_STORAGE_KEY = 'antseed.desktop.vpr.modelPins';

/** `provider:serviceId` -> pinned peer id. */
export type VprModelPins = Record<string, string>;

export function modelPinKey(provider: string, serviceId: string): string {
  return `${provider}:${serviceId}`;
}

export function loadVprModelPins(): VprModelPins {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(VPR_MODEL_PINS_STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const pins: VprModelPins = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const peerId = value.trim();
      if (key.length > 0 && peerId.length > 0) pins[key] = peerId;
    }
    return pins;
  } catch {
    return {};
  }
}

export function saveVprModelPins(pins: VprModelPins): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(VPR_MODEL_PINS_STORAGE_KEY, JSON.stringify(pins));
}

export function vprModelPinFor(
  pins: VprModelPins,
  provider: string,
  serviceId: string,
): string | null {
  return pins[modelPinKey(provider, serviceId)] ?? null;
}

export function setVprModelPin(
  pins: VprModelPins,
  provider: string,
  serviceId: string,
  peerId: string,
): VprModelPins {
  const id = peerId.trim();
  if (id.length === 0) return pins;
  return { ...pins, [modelPinKey(provider, serviceId)]: id };
}

export function clearVprModelPin(
  pins: VprModelPins,
  provider: string,
  serviceId: string,
): VprModelPins {
  const key = modelPinKey(provider, serviceId);
  if (!(key in pins)) return pins;
  const next = { ...pins };
  delete next[key];
  return next;
}

/** Drop every pin on a peer — for peers the routing rules now exclude, which
 * would otherwise keep re-pinning the models they serve. */
export function clearVprPinsForPeer(pins: VprModelPins, peerId: string): VprModelPins {
  const next: VprModelPins = {};
  for (const [key, value] of Object.entries(pins)) {
    if (value !== peerId) next[key] = value;
  }
  return next;
}
