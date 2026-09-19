import { canonicalModelKey } from '@antseed/node/model-identity';
import registry from './model-metadata.json' with { type: 'json' };

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

/** Release-owned model metadata that cannot be expanded by a seller. */
export function modelMetadataFor(serviceId: string): ModelMetadata | null {
  return metadataByCanonicalKey.get(canonicalModelKey(serviceId)) ?? null;
}
