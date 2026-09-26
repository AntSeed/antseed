import { sha256, toUtf8Bytes } from 'ethers';
import { canonicalRoutingJson, validateRoutingPreferenceSchema, type RoutingPreferenceSchema } from './routing-preferences.js';

export type RoutingCatalogModel = { provider: string; serviceId: string };
export type RoutingCatalogV1 = {
  version: 1;
  title?: string;
  revision: string;
  models: RoutingCatalogModel[];
  preferencesSchema: RoutingPreferenceSchema;
};
export const MAX_ROUTING_CATALOG_MODELS = 256;
export const MAX_ROUTING_CATALOG_BYTES = 32 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isRoutingModelIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && toUtf8Bytes(value).length <= 64 && !/[\u0000-\u001f\u007f*]/.test(value);
}

export function routingModelKey(model: RoutingCatalogModel): string {
  return JSON.stringify([model.provider, model.serviceId]);
}

export function validateRoutingCatalog(value: unknown): asserts value is RoutingCatalogV1 {
  if (!object(value) || value.version !== 1
    || Object.keys(value).some(key => !['version', 'title', 'revision', 'models', 'preferencesSchema'].includes(key))
    || !Array.isArray(value.models) || value.models.length > MAX_ROUTING_CATALOG_MODELS) throw new Error('Invalid routing catalog');
  validateRoutingPreferenceSchema(value.preferencesSchema);
  if (Object.prototype.hasOwnProperty.call(value, 'title') && (typeof value.title !== 'string'
    || !value.title.trim() || value.title !== value.title.trim() || toUtf8Bytes(value.title).length > 128
    || /[\u0000-\u001f\u007f]/.test(value.title))) throw new Error('Invalid routing catalog title');
  const keys = new Set<string>();
  for (const model of value.models) {
    if (!object(model) || Object.keys(model).some(key => key !== 'provider' && key !== 'serviceId')
      || !isRoutingModelIdentifier(model.provider) || !isRoutingModelIdentifier(model.serviceId)) throw new Error('Invalid routing catalog model');
    const key = routingModelKey(model as RoutingCatalogModel);
    if (keys.has(key)) throw new Error('Duplicate routing catalog model');
    keys.add(key);
  }
  if (toUtf8Bytes(canonicalRoutingJson(value)).length > MAX_ROUTING_CATALOG_BYTES) throw new Error('Routing catalog exceeds size limit');
  const { revision, ...content } = value;
  if (revision !== sha256(toUtf8Bytes(canonicalRoutingJson(content)))) throw new Error('Routing catalog revision mismatch');
}

export function createRoutingCatalog(models: RoutingCatalogModel[], preferencesSchema: RoutingPreferenceSchema = { type: 'object', properties: {}, additionalProperties: false }, options: { title?: string } = {}): RoutingCatalogV1 {
  const content = { version: 1 as const, preferencesSchema: structuredClone(preferencesSchema),
    ...(options.title !== undefined ? { title: options.title } : {}),
    models: models.map(({ provider, serviceId }) => ({ provider, serviceId })).sort((first, second) =>
      routingModelKey(first) < routingModelKey(second) ? -1 : routingModelKey(first) > routingModelKey(second) ? 1 : 0) };
  const catalog = { ...content, revision: sha256(toUtf8Bytes(canonicalRoutingJson(content))) };
  validateRoutingCatalog(catalog);
  return catalog;
}
