import {
  modelMetadataFor,
  type ModelMetadata,
} from '../../../shared/model-metadata';

export { modelMetadataFor, type ModelMetadata } from '../../../shared/model-metadata';

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
