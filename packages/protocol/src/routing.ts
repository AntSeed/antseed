import { sha256, toUtf8Bytes } from 'ethers';
import { REASONING_EFFORTS, type ReasoningEffort } from './reasoning.js';

export type RoutingJson = null | boolean | number | string | RoutingJson[] | { [key: string]: RoutingJson };
export type RoutingPreferences = Record<string, string>;
export type RoutingPreferenceField = {
  type: 'string';
  enum: string[];
  description?: string;
  default?: string;
};
export type RoutingPreferenceSchema = {
  type: 'object';
  properties: Record<string, RoutingPreferenceField>;
  additionalProperties: false;
  required?: string[];
};
export type RoutingServiceMetadataV1 = {
  version: 1;
  preferencesSchema: RoutingPreferenceSchema;
  preferencesSchemaHash: string;
};
export type RoutingInference = { reasoningEffort: ReasoningEffort };
export type RoutingRecommendation = { serviceId: string; peerId?: string; inference?: RoutingInference };
export type RoutingCandidate = Pick<RoutingRecommendation, 'serviceId'> & {
  peerId: string;
  reasoningEfforts?: ReasoningEffort[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion?: number | null;
};
export type RoutingUsageObservation = {
  id: string;
  offer: { peerId: string; provider: string; serviceId: string };
  inputTokens: number;
  cachedInputTokens?: number;
  ageMs: number;
};
export type RoutingUsageContext = {
  conversationRef: string;
  usageObservations: RoutingUsageObservation[];
  historyTruncated: boolean;
};
export const MAX_ROUTING_USAGE_OBSERVATIONS = 64;
export const MAX_ROUTING_USAGE_CONTEXT_BYTES = 16 * 1024;
export type RoutingRequestV1 = {
  version: 1;
  service: string;
  preferencesSchemaHash: string;
  request: { path: string; body: { [key: string]: RoutingJson } };
  candidates: RoutingCandidate[];
  preferences: RoutingPreferences;
  context?: RoutingUsageContext;
};
export type RoutingResponseV1 = {
  version: 1;
  recommendations: RoutingRecommendation[];
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number };
};
export const MAX_ROUTING_PREFERENCE_BYTES = 16 * 1024;
export const MAX_ROUTING_PREFERENCE_DEPTH = 8;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function canonicalRoutingJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('Routing JSON nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalRoutingJson(entry, depth + 1)).join(',')}]`;
  if (!object(value)) throw new Error('Expected routing JSON value');
  return `{${Object.keys(value).sort().map((key) => {
    if (forbiddenKeys.has(key)) throw new Error(`Forbidden routing key: ${key}`);
    return `${JSON.stringify(key)}:${canonicalRoutingJson(value[key], depth + 1)}`;
  }).join(',')}}`;
}

function bounded(value: unknown): void {
  if (toUtf8Bytes(canonicalRoutingJson(value)).length > MAX_ROUTING_PREFERENCE_BYTES) throw new Error('Routing preferences/schema exceed 16 KiB');
}

export function assertRoutingPreferences(value: unknown): asserts value is RoutingPreferences {
  if (!object(value) || Object.values(value).some(entry => typeof entry !== 'string')) throw new Error('Routing preferences must be a flat object of string choices');
  bounded(value);
}

export function validateRoutingPreferenceSchema(value: unknown): asserts value is RoutingPreferenceSchema {
  bounded(value);
  if (!object(value) || value.type !== 'object' || !object(value.properties) || value.additionalProperties !== false
    || Object.keys(value).some(key => !['type', 'properties', 'additionalProperties', 'required'].includes(key))) throw new Error('Routing preferences require a flat object schema with additionalProperties: false');
  for (const [key, field] of Object.entries(value.properties)) {
    if (!key.trim() || forbiddenKeys.has(key) || !object(field) || field.type !== 'string'
      || Object.keys(field).some(name => !['type', 'enum', 'description', 'default'].includes(name))
      || !Array.isArray(field.enum) || field.enum.length === 0
      || field.enum.some(choice => typeof choice !== 'string' || !choice.trim())
      || new Set(field.enum).size !== field.enum.length) throw new Error('preferences.' + key + ': expected unique nonempty string choices');
    if (own(field, 'description') && typeof field.description !== 'string') throw new Error('Preference description must be a string');
    if (own(field, 'default') && !field.enum.includes(field.default)) throw new Error('Preference default must be an enum choice');
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length
    || value.required.some(key => typeof key !== 'string' || !own(value.properties as object, key)))) throw new Error('Required preferences must be unique declared fields');
}

export function resolveRoutingPreferences(schema: RoutingPreferenceSchema, values: unknown = {}): RoutingPreferences {
  validateRoutingPreferenceSchema(schema);
  assertRoutingPreferences(values);
  const result: RoutingPreferences = {};
  for (const key of Object.keys(values)) if (!own(schema.properties, key)) throw new Error('preferences.' + key + ': unknown preference');
  for (const [key, field] of Object.entries(schema.properties)) {
    const selected = own(values, key) ? values[key] : field.default;
    if (selected !== undefined) {
      if (!field.enum.includes(selected)) throw new Error('preferences.' + key + ': invalid enum choice');
      result[key] = selected;
    } else if (schema.required?.includes(key)) throw new Error('Required routing preference: ' + key);
  }
  assertRoutingPreferences(result);
  return result;
}

export function createRoutingServiceMetadata(preferencesSchema: RoutingPreferenceSchema): RoutingServiceMetadataV1 {
  validateRoutingPreferenceSchema(preferencesSchema);
  return { version: 1, preferencesSchema: structuredClone(preferencesSchema), preferencesSchemaHash: sha256(toUtf8Bytes(canonicalRoutingJson(preferencesSchema))) };
}

export function validateRoutingServiceMetadata(value: unknown): asserts value is RoutingServiceMetadataV1 {
  if (!object(value) || value.version !== 1 || Object.keys(value).some((key) => !['version', 'preferencesSchema', 'preferencesSchemaHash'].includes(key))) throw new Error('Invalid routing service metadata');
  validateRoutingPreferenceSchema(value.preferencesSchema);
  if (createRoutingServiceMetadata(value.preferencesSchema).preferencesSchemaHash !== value.preferencesSchemaHash) throw new Error('Routing preferences schema hash mismatch');
}

export function validateRoutingRequest(value: unknown, metadata: RoutingServiceMetadataV1): asserts value is RoutingRequestV1 {
  validateRoutingServiceMetadata(metadata);
  if (!object(value) || value.version !== 1 || typeof value.service !== 'string' || !value.service.trim()
    || !object(value.request) || typeof value.request.path !== 'string' || !object(value.request.body)
    || !object(value.preferences) || !Array.isArray(value.candidates) || value.candidates.length === 0) throw new Error('Invalid routing request');
  if (value.preferencesSchemaHash !== metadata.preferencesSchemaHash) throw new Error('Routing preferences schema changed; refresh router metadata');
  if (value.context !== undefined) validateRoutingUsageContext(value.context);
  for (const candidate of value.candidates) {
    if (!object(candidate) || typeof candidate.serviceId !== 'string' || !candidate.serviceId.trim() || typeof candidate.peerId !== 'string' || !/^[0-9a-f]{40}$/i.test(candidate.peerId)) throw new Error('Invalid routing candidate');
    if (candidate.reasoningEfforts !== undefined && (!Array.isArray(candidate.reasoningEfforts)
      || candidate.reasoningEfforts.length > REASONING_EFFORTS.length
      || candidate.reasoningEfforts.some((effort) => !REASONING_EFFORTS.includes(effort))
      || new Set(candidate.reasoningEfforts).size !== candidate.reasoningEfforts.length)) throw new Error('Invalid routing candidate reasoning efforts');
    for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion']) {
      const rate = candidate[key];
      if (rate === undefined && key === 'cachedInputUsdPerMillion') continue;
      if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) throw new Error('Invalid routing candidate price');
    }
  }
  resolveRoutingPreferences(metadata.preferencesSchema, value.preferences);
}

export function validateRoutingUsageContext(value: unknown): asserts value is RoutingUsageContext {
  const identifier = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 256;
  const count = (entry: unknown): entry is number => typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0;
  if (!object(value) || Object.keys(value).some((key) => !['conversationRef', 'usageObservations', 'historyTruncated'].includes(key))
    || !identifier(value.conversationRef) || typeof value.historyTruncated !== 'boolean'
    || !Array.isArray(value.usageObservations) || value.usageObservations.length > MAX_ROUTING_USAGE_OBSERVATIONS) throw new Error('Invalid routing usage context');
  if (toUtf8Bytes(canonicalRoutingJson(value)).length > MAX_ROUTING_USAGE_CONTEXT_BYTES) throw new Error('Routing usage context exceeds 16 KiB');
  const seen = new Set<string>();
  for (const observation of value.usageObservations) {
    if (!object(observation) || Object.keys(observation).some((key) => !['id', 'offer', 'inputTokens', 'cachedInputTokens', 'ageMs'].includes(key))
      || !identifier(observation.id) || seen.has(observation.id) || !count(observation.inputTokens) || !count(observation.ageMs)
      || !object(observation.offer) || Object.keys(observation.offer).some((key) => !['peerId', 'provider', 'serviceId'].includes(key))
      || typeof observation.offer.peerId !== 'string' || !/^[0-9a-f]{40}$/i.test(observation.offer.peerId)
      || !identifier(observation.offer.provider) || !identifier(observation.offer.serviceId)
      || (observation.cachedInputTokens !== undefined && (!count(observation.cachedInputTokens) || observation.cachedInputTokens > observation.inputTokens))) throw new Error('Invalid routing usage observation');
    seen.add(observation.id);
  }
}
