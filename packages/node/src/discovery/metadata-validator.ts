import type { PeerMetadata } from "./peer-metadata.js";
import { METADATA_VERSION } from "./peer-metadata.js";
import { encodeMetadata } from "./metadata-codec.js";

export const MAX_METADATA_SIZE = 1000;
export const MAX_PROVIDERS = 10;
export const MAX_MODELS_PER_PROVIDER = 20;
export const MAX_MODEL_NAME_LENGTH = 64;
export const MAX_REGION_LENGTH = 32;

export interface ValidationError {
  field: string;
  message: string;
}

export function validateMetadata(metadata: PeerMetadata): ValidationError[] {
  const errors: ValidationError[] = [];

  // version
  if (metadata.version !== METADATA_VERSION) {
    errors.push({
      field: "version",
      message: `Expected version ${METADATA_VERSION}, got ${metadata.version}`,
    });
  }

  // peerId length (64 hex chars = 32 bytes)
  if (!/^[0-9a-f]{64}$/.test(metadata.peerId)) {
    errors.push({
      field: "peerId",
      message: "PeerId must be exactly 64 lowercase hex characters",
    });
  }

  // region
  if (!metadata.region || metadata.region.length === 0) {
    errors.push({
      field: "region",
      message: "Region must not be empty",
    });
  } else if (metadata.region.length > MAX_REGION_LENGTH) {
    errors.push({
      field: "region",
      message: `Region length ${metadata.region.length} exceeds max ${MAX_REGION_LENGTH}`,
    });
  }

  // timestamp
  if (metadata.timestamp <= 0 || !Number.isFinite(metadata.timestamp)) {
    errors.push({
      field: "timestamp",
      message: "Timestamp must be a positive finite number",
    });
  }

  // providers count
  if (metadata.providers.length === 0) {
    errors.push({
      field: "providers",
      message: "Must have at least one provider",
    });
  } else if (metadata.providers.length > MAX_PROVIDERS) {
    errors.push({
      field: "providers",
      message: `Provider count ${metadata.providers.length} exceeds max ${MAX_PROVIDERS}`,
    });
  }

  // each provider
  for (let i = 0; i < metadata.providers.length; i++) {
    const p = metadata.providers[i]!;

    // models count
    if (p.models.length > MAX_MODELS_PER_PROVIDER) {
      errors.push({
        field: `providers[${i}].models`,
        message: `Model count ${p.models.length} exceeds max ${MAX_MODELS_PER_PROVIDER}`,
      });
    }

    // model name length
    for (let j = 0; j < p.models.length; j++) {
      const model = p.models[j]!;
      if (model.length > MAX_MODEL_NAME_LENGTH) {
        errors.push({
          field: `providers[${i}].models[${j}]`,
          message: `Model name length ${model.length} exceeds max ${MAX_MODEL_NAME_LENGTH}`,
        });
      }
    }

    // default pricing
    if (!Number.isFinite(p.defaultPricing?.inputUsdPerMillion) || p.defaultPricing.inputUsdPerMillion < 0) {
      errors.push({
        field: `providers[${i}].defaultPricing.inputUsdPerMillion`,
        message: "Default input price must be a non-negative finite number",
      });
    }
    if (!Number.isFinite(p.defaultPricing?.outputUsdPerMillion) || p.defaultPricing.outputUsdPerMillion < 0) {
      errors.push({
        field: `providers[${i}].defaultPricing.outputUsdPerMillion`,
        message: "Default output price must be a non-negative finite number",
      });
    }

    // model pricing (optional)
    if (p.modelPricing !== undefined) {
      for (const [modelName, modelPricing] of Object.entries(p.modelPricing)) {
        if (!modelPricing || !Number.isFinite(modelPricing.inputUsdPerMillion) || modelPricing.inputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].modelPricing.${modelName}.inputUsdPerMillion`,
            message: "Model input price must be a non-negative finite number",
          });
        }
        if (!modelPricing || !Number.isFinite(modelPricing.outputUsdPerMillion) || modelPricing.outputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].modelPricing.${modelName}.outputUsdPerMillion`,
            message: "Model output price must be a non-negative finite number",
          });
        }
      }
    }

    // concurrency
    if (p.maxConcurrency < 1) {
      errors.push({
        field: `providers[${i}].maxConcurrency`,
        message: "Max concurrency must be at least 1",
      });
    }

    // currentLoad
    if (p.currentLoad < 0) {
      errors.push({
        field: `providers[${i}].currentLoad`,
        message: "Current load must be non-negative",
      });
    }
    if (p.currentLoad > p.maxConcurrency) {
      errors.push({
        field: `providers[${i}].currentLoad`,
        message: "Current load must not exceed max concurrency",
      });
    }
  }

  // signature length (128 hex chars = 64 bytes)
  if (!/^[0-9a-f]{128}$/.test(metadata.signature)) {
    errors.push({
      field: "signature",
      message: "Signature must be exactly 128 lowercase hex characters (64 bytes)",
    });
  }

  // encoded size
  try {
    const encoded = encodeMetadata(metadata);
    if (encoded.length > MAX_METADATA_SIZE) {
      errors.push({
        field: "encoded",
        message: `Encoded size ${encoded.length} exceeds max ${MAX_METADATA_SIZE}`,
      });
    }
  } catch {
    errors.push({
      field: "encoded",
      message: "Failed to encode metadata for size check",
    });
  }

  return errors;
}
