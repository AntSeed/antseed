import registry from './model-metadata.json';
import { canonicalModelKey } from './model-identity';

export type ModelMetadata = {
  readonly tags: readonly string[];
  readonly aliases?: readonly string[];
  readonly sources: Readonly<Record<string, readonly string[]>>;
};

type ModelMetadataRegistry = {
  version: number;
  reviewedAt: string;
  sources: Record<string, { label: string; url: string }>;
  tagDefinitions: Record<string, string>;
  models: Record<string, ModelMetadata>;
};

const modelMetadataRegistry = registry as ModelMetadataRegistry;
if (modelMetadataRegistry.version !== 2) {
  throw new Error(`Unsupported model metadata registry version: ${String(modelMetadataRegistry.version)}`);
}

const metadataByCanonicalKey = new Map<string, ModelMetadata>();
for (const [registeredId, metadata] of Object.entries(modelMetadataRegistry.models)) {
  for (const candidate of [registeredId, ...(metadata.aliases ?? [])]) {
    const key = canonicalModelKey(candidate);
    if (!key) throw new Error(`Invalid model metadata id: ${candidate}`);
    const existing = metadataByCanonicalKey.get(key);
    if (existing && existing !== metadata) {
      throw new Error(`Duplicate canonical model metadata id: ${candidate}`);
    }
    metadataByCanonicalKey.set(key, metadata);
  }
}

/** Reviewed model-level metadata from maintained upstream catalogs. Unlike
 * discovery categories, this release-owned registry cannot be expanded by a
 * seller. Route-level support must still come from service capabilities. */
export function modelMetadataFor(serviceId: string): ModelMetadata | null {
  return metadataByCanonicalKey.get(canonicalModelKey(serviceId)) ?? null;
}

const HIDDEN_MODEL_TAGS = new Set(['Video input']);

export function modelTagsFor(serviceId: string): string[] {
  return (modelMetadataFor(serviceId)?.tags ?? [])
    .filter((tag) => !HIDDEN_MODEL_TAGS.has(tag));
}

export function availableModelTags(serviceIds: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const serviceId of serviceIds) {
    for (const tag of modelTagsFor(serviceId)) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}
