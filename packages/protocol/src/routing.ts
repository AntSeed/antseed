import { sha256, toUtf8Bytes } from 'ethers';

export type RoutingJson = null | boolean | number | string | RoutingJson[] | { [key: string]: RoutingJson };
export type RoutingPreferences = { [key: string]: RoutingJson };
export type RoutingPreferenceSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, RoutingPreferenceSchema>;
  additionalProperties?: false;
  required?: string[];
  items?: RoutingPreferenceSchema;
  enum?: RoutingJson[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  title?: string;
  description?: string;
  default?: RoutingJson;
};
export type RoutingServiceMetadataV1 = {
  version: 1;
  preferencesSchema: RoutingPreferenceSchema;
  preferencesSchemaHash: string;
};
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
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
  request: { path: string; body: RoutingPreferences };
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
const MAX_ROUTING_VALIDATION_STEPS = 65_536;
type RoutingValidationWork = { remainingSteps: number };
type RoutingValueBudget = { remainingBytes: number; work: RoutingValidationWork };
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function createRoutingValueBudget(work: RoutingValidationWork = { remainingSteps: MAX_ROUTING_VALIDATION_STEPS }): RoutingValueBudget {
  return { remainingBytes: MAX_ROUTING_PREFERENCE_BYTES, work };
}

function consumeRoutingWork(work: RoutingValidationWork): void {
  if (--work.remainingSteps < 0) throw new Error('Routing preferences/schema validation work limit exceeded');
}

function consumeRoutingBytes(budget: RoutingValueBudget, bytes: number): void {
  budget.remainingBytes -= bytes;
  if (budget.remainingBytes < 0) throw new Error('Expanded routing preferences/defaults exceed 16 KiB');
}

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

export function assertRoutingPreferences(value: unknown, depth = 0): asserts value is RoutingPreferences {
  if (!object(value)) throw new Error('Routing preferences must be an object');
  const visit = (entry: unknown, level: number): void => {
    if (level > MAX_ROUTING_PREFERENCE_DEPTH) throw new Error('Routing preferences nesting exceeds 8');
    if (Array.isArray(entry)) entry.forEach((child) => visit(child, level + 1));
    else if (object(entry)) Object.values(entry).forEach((child) => visit(child, level + 1));
  };
  bounded(value);
  visit(value, depth);
}

export function validateRoutingPreferenceSchema(value: unknown): asserts value is RoutingPreferenceSchema {
  bounded(value);
  const work: RoutingValidationWork = { remainingSteps: MAX_ROUTING_VALIDATION_STEPS };
  const visit = (schema: unknown, path: string, depth: number): void => {
    consumeRoutingWork(work);
    if (depth > MAX_ROUTING_PREFERENCE_DEPTH || !object(schema)) throw new Error(`${path}: invalid schema or nesting exceeds 8`);
    const common = ['type', 'title', 'description', 'default', 'enum'];
    const fields: Record<string, string[]> = {
      object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
      string: ['minLength', 'maxLength'], number: ['minimum', 'maximum'], integer: ['minimum', 'maximum'], boolean: [],
    };
    const type = schema.type;
    if (typeof type !== 'string' || !own(fields, type)) throw new Error(`${path}: unsupported schema type`);
    for (const key of Object.keys(schema)) if (![...common, ...fields[type]!].includes(key)) throw new Error(`${path}.${key}: unsupported schema keyword`);
    for (const key of ['title', 'description']) if (own(schema, key) && typeof schema[key] !== 'string') throw new Error(`${path}.${key}: expected string`);
    if (type === 'object') {
      if (!object(schema.properties) || schema.additionalProperties !== false) throw new Error(`${path}: objects require properties and additionalProperties: false`);
      for (const [key, child] of Object.entries(schema.properties)) visit(child, `${path}.${key}`, depth + 1);
      if (schema.required !== undefined && (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length
        || schema.required.some((key) => typeof key !== 'string' || !own(schema.properties as object, key)))) throw new Error(`${path}.required: expected unique declared properties`);
    }
    if (type === 'array') visit(schema.items, `${path}[]`, depth + 1);
    for (const [minKey, maxKey] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']] as const) {
      for (const key of [minKey, maxKey]) if (own(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])
        || (key !== 'minimum' && key !== 'maximum' && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0)))) throw new Error(`${path}.${key}: invalid bound`);
      if (typeof schema[minKey] === 'number' && typeof schema[maxKey] === 'number' && schema[minKey] > schema[maxKey]) throw new Error(`${path}: inverted bounds`);
    }
    if (own(schema, 'enum')) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error(`${path}.enum: expected nonempty array`);
      const encoded = schema.enum.map((entry) => canonicalRoutingJson(entry));
      if (new Set(encoded).size !== encoded.length) throw new Error(`${path}.enum: duplicate values`);
      for (const entry of schema.enum) validateValue({ ...schema, enum: undefined } as RoutingPreferenceSchema, entry, path, depth, createRoutingValueBudget(work));
    }
    if (own(schema, 'default')) validateValue(schema as RoutingPreferenceSchema, schema.default, `${path}.default`, depth, createRoutingValueBudget(work));
  };
  visit(value, 'preferences', 0);
  if ((value as RoutingPreferenceSchema).type !== 'object') throw new Error('Routing preferences schema must be an object');
}

function validateValue(schema: RoutingPreferenceSchema, value: unknown, path: string, depth: number, budget: RoutingValueBudget): RoutingJson {
  consumeRoutingWork(budget.work);
  if (depth > MAX_ROUTING_PREFERENCE_DEPTH) throw new Error(`${path}: nesting exceeds 8`);
  let result: RoutingJson;
  if (schema.type === 'object') {
    if (!object(value)) throw new Error(`${path}: expected object`);
    for (const key of Object.keys(value)) if (!own(schema.properties!, key)) throw new Error(`${path}.${key}: unknown preference`);
    consumeRoutingBytes(budget, 2);
    const output: RoutingPreferences = {};
    let propertyCount = 0;
    for (const [key, child] of Object.entries(schema.properties!)) {
      consumeRoutingWork(budget.work);
      if (own(value, key) || own(child, 'default')) {
        consumeRoutingBytes(budget, toUtf8Bytes(JSON.stringify(key)).length + 1 + (propertyCount > 0 ? 1 : 0));
        output[key] = validateValue(child, own(value, key) ? value[key] : child.default, `${path}.${key}`, depth + 1, budget);
        propertyCount++;
      } else if (schema.required?.includes(key)) throw new Error(`${path}.${key}: required preference`);
    }
    result = output;
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${path}: invalid array`);
    consumeRoutingBytes(budget, 2 + Math.max(0, value.length - 1));
    result = value.map((entry, index) => validateValue(schema.items!, entry, `${path}[${index}]`, depth + 1, budget));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || [...value].length < (schema.minLength ?? 0) || [...value].length > (schema.maxLength ?? Infinity)) throw new Error(`${path}: invalid string`);
    result = value;
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path}: expected boolean`);
    result = value;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))
      || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error(`${path}: invalid ${schema.type}`);
    result = value;
  }
  if (schema.type !== 'object' && schema.type !== 'array') consumeRoutingBytes(budget, toUtf8Bytes(JSON.stringify(result)).length);
  if (schema.enum) {
    const encodedResult = canonicalRoutingJson(result);
    if (!schema.enum.some((entry) => {
      consumeRoutingWork(budget.work);
      return canonicalRoutingJson(entry) === encodedResult;
    })) throw new Error(`${path}: value is not in enum`);
  }
  return result;
}

export function resolveRoutingPreferences(schema: RoutingPreferenceSchema, values: unknown = {}): RoutingPreferences {
  validateRoutingPreferenceSchema(schema);
  assertRoutingPreferences(values);
  const result = validateValue(schema, values, 'preferences', 0, createRoutingValueBudget());
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
