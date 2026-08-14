export type ConnectedAppModelCatalogEntry = {
  provider: string;
  id: string;
  name: string;
  peerId?: string;
};

export type ConnectedAppModelCatalogSnapshot = {
  models: ConnectedAppModelCatalogEntry[];
};

const MAX_MODELS = 2_000;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 256;

export function parseConnectedAppModelCatalog(value: unknown): ConnectedAppModelCatalogSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model catalog must be an object');
  const rawModels = (value as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) throw new Error('model catalog models must be a list');
  if (rawModels.length > MAX_MODELS) throw new Error('model catalog has too many models');

  const seen = new Set<string>();
  const models: ConnectedAppModelCatalogEntry[] = [];
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const provider = typeof (raw as { provider?: unknown }).provider === 'string'
      ? (raw as { provider: string }).provider.trim().toLowerCase()
      : '';
    const id = typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id.trim() : '';
    const name = typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name.trim() : '';
    const peerId = typeof (raw as { peerId?: unknown }).peerId === 'string'
      ? (raw as { peerId: string }).peerId.trim().toLowerCase()
      : '';
    if (!provider || provider.length > MAX_MODEL_ID_LENGTH || !/^[a-z0-9][a-z0-9._-]*$/.test(provider)) continue;
    if (!id || id.length > MAX_MODEL_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(id) || id.startsWith('/') || id.endsWith('/')) continue;
    if (id.toLowerCase() === 'antseed') continue;
    const key = `${provider}\u0000${id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (peerId && !/^[a-f0-9]{40}$/.test(peerId)) continue;
    models.push({
      provider,
      id,
      name: (name || id).slice(0, MAX_MODEL_NAME_LENGTH),
      ...(peerId ? { peerId } : {}),
    });
  }
  return { models };
}
