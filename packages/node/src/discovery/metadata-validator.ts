import type { PeerMetadata } from "./peer-metadata.js";
import { METADATA_VERSION, WELL_KNOWN_SERVICE_API_PROTOCOLS } from "./peer-metadata.js";
import { encodeMetadata } from "./metadata-codec.js";

export const MAX_METADATA_SIZE = 1000;
export const MAX_PROVIDERS = 10;
export const MAX_SERVICES_PER_PROVIDER = 20;
export const MAX_SERVICE_NAME_LENGTH = 64;
export const MAX_REGION_LENGTH = 32;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_MODEL_CATEGORIES_PER_MODEL = 8;
export const MAX_MODEL_CATEGORY_LENGTH = 32;
export const MAX_MODEL_API_PROTOCOLS_PER_MODEL = 4;
const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MODEL_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

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

  if (metadata.displayName !== undefined) {
    if (metadata.displayName.trim().length === 0) {
      errors.push({
        field: "displayName",
        message: "Display name must not be empty when provided",
      });
    } else if (metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.push({
        field: "displayName",
        message: `Display name length ${metadata.displayName.length} exceeds max ${MAX_DISPLAY_NAME_LENGTH}`,
      });
    }
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
    const hasWildcardServices = p.services.length === 0;

    // services count
    if (p.services.length > MAX_SERVICES_PER_PROVIDER) {
      errors.push({
        field: `providers[${i}].services`,
        message: `Service count ${p.services.length} exceeds max ${MAX_SERVICES_PER_PROVIDER}`,
      });
    }

    // service name length
    for (let j = 0; j < p.services.length; j++) {
      const service = p.services[j]!;
      if (service.length > MAX_SERVICE_NAME_LENGTH) {
        errors.push({
          field: `providers[${i}].services[${j}]`,
          message: `Service name length ${service.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
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

    // service pricing (optional)
    if (p.servicePricing !== undefined) {
      for (const [modelName, servicePricing] of Object.entries(p.servicePricing)) {
        if (modelName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].servicePricing.${modelName}`,
            message: `Service name length ${modelName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.inputUsdPerMillion) || servicePricing.inputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${modelName}.inputUsdPerMillion`,
            message: "Service input price must be a non-negative finite number",
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.outputUsdPerMillion) || servicePricing.outputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${modelName}.outputUsdPerMillion`,
            message: "Service output price must be a non-negative finite number",
          });
        }
      }
    }

    if (p.serviceCategories !== undefined) {
      for (const [modelName, categories] of Object.entries(p.serviceCategories)) {
        if (modelName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceCategories.${modelName}`,
            message: `Service name length ${modelName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(modelName)) {
          errors.push({
            field: `providers[${i}].serviceCategories.${modelName}`,
            message: "Service categories must reference a model listed in providers[].services",
          });
        }
        if (!Array.isArray(categories) || categories.length === 0) {
          errors.push({
            field: `providers[${i}].serviceCategories.${modelName}`,
            message: "Service categories must be a non-empty string array",
          });
          continue;
        }
        if (categories.length > MAX_MODEL_CATEGORIES_PER_MODEL) {
          errors.push({
            field: `providers[${i}].serviceCategories.${modelName}`,
            message: `Service category count ${categories.length} exceeds max ${MAX_MODEL_CATEGORIES_PER_MODEL}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < categories.length; j++) {
          const category = categories[j];
          if (typeof category !== "string" || category.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceCategories.${modelName}[${j}]`,
              message: "Service category must be a non-empty string",
            });
            continue;
          }
          const normalized = category.trim().toLowerCase();
          if (normalized.length > MAX_MODEL_CATEGORY_LENGTH) {
            errors.push({
              field: `providers[${i}].serviceCategories.${modelName}[${j}]`,
              message: `Service category length ${normalized.length} exceeds max ${MAX_MODEL_CATEGORY_LENGTH}`,
            });
          }
          if (!SERVICE_CATEGORY_PATTERN.test(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${modelName}[${j}]`,
              message: "Service category must use lowercase letters, digits, or hyphen",
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${modelName}[${j}]`,
              message: "Service category values must be unique per service",
            });
          }
          deduped.add(normalized);
        }
      }
    }

    if (p.serviceApiProtocols !== undefined) {
      for (const [modelName, protocols] of Object.entries(p.serviceApiProtocols)) {
        if (modelName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${modelName}`,
            message: `Service name length ${modelName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(modelName)) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${modelName}`,
            message: "Service API protocols must reference a model listed in providers[].services",
          });
        }
        if (!Array.isArray(protocols) || protocols.length === 0) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${modelName}`,
            message: "Service API protocols must be a non-empty string array",
          });
          continue;
        }
        if (protocols.length > MAX_MODEL_API_PROTOCOLS_PER_MODEL) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${modelName}`,
            message: `Service API protocol count ${protocols.length} exceeds max ${MAX_MODEL_API_PROTOCOLS_PER_MODEL}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < protocols.length; j++) {
          const protocol = protocols[j];
          if (typeof protocol !== "string" || protocol.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${modelName}[${j}]`,
              message: "Service API protocol must be a non-empty string",
            });
            continue;
          }
          const normalized = protocol.trim().toLowerCase();
          if (!MODEL_API_PROTOCOL_SET.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${modelName}[${j}]`,
              message: `Unsupported service API protocol "${normalized}"`,
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${modelName}[${j}]`,
              message: "Service API protocol values must be unique per service",
            });
          }
          deduped.add(normalized);
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
