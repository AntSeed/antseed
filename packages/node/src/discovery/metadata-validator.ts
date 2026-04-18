import type { PeerMetadata } from "./peer-metadata.js";
import { METADATA_VERSION, WELL_KNOWN_SERVICE_API_PROTOCOLS } from "./peer-metadata.js";
import { encodeMetadata } from "./metadata-codec.js";
import { MAX_PUBLIC_ADDRESS_LENGTH, parsePublicAddress } from "./public-address.js";

export const MAX_METADATA_SIZE = 1000;
export const MAX_PROVIDERS = 10;
export const MAX_SERVICES_PER_PROVIDER = 20;
export const MAX_SERVICE_NAME_LENGTH = 64;
export const MAX_REGION_LENGTH = 32;
export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_SERVICE_CATEGORIES_PER_SERVICE = 8;
export const MAX_SERVICE_CATEGORY_LENGTH = 32;
export const MAX_SERVICE_API_PROTOCOLS_PER_SERVICE = 4;
const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SERVICE_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

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

  // peerId length (40 hex chars = 20 bytes, EVM address)
  if (!/^[0-9a-f]{40}$/.test(metadata.peerId)) {
    errors.push({
      field: "peerId",
      message: "PeerId must be exactly 40 lowercase hex characters",
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

  if (metadata.publicAddress !== undefined) {
    const value = metadata.publicAddress.trim();
    if (value.length === 0) {
      errors.push({
        field: "publicAddress",
        message: "Public address must not be empty when provided",
      });
    } else if (value.length > MAX_PUBLIC_ADDRESS_LENGTH) {
      errors.push({
        field: "publicAddress",
        message: `Public address length ${value.length} exceeds max ${MAX_PUBLIC_ADDRESS_LENGTH}`,
      });
    } else if (parsePublicAddress(value) === null) {
      errors.push({
        field: "publicAddress",
        message: 'Public address must be in the form "host:port" with a valid port',
      });
    }
  }

  if (metadata.sellerDelegation !== undefined) {
    const d = metadata.sellerDelegation;
    if (!/^[0-9a-f]{40}$/.test(d.peerAddress)) {
      errors.push({ field: "sellerDelegation.peerAddress", message: "Must be 40 lowercase hex chars" });
    }
    if (!/^[0-9a-f]{40}$/.test(d.sellerContract)) {
      errors.push({ field: "sellerDelegation.sellerContract", message: "Must be 40 lowercase hex chars" });
    }
    if (!Number.isInteger(d.chainId) || d.chainId <= 0) {
      errors.push({ field: "sellerDelegation.chainId", message: "Must be a positive integer" });
    }
    if (!Number.isInteger(d.expiresAt) || d.expiresAt <= 0) {
      errors.push({ field: "sellerDelegation.expiresAt", message: "Must be a positive unix seconds integer" });
    }
    if (!/^[0-9a-f]{130}$/.test(d.signature)) {
      errors.push({ field: "sellerDelegation.signature", message: "Must be 130 lowercase hex chars (65-byte secp256k1 sig)" });
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
      for (const [serviceName, servicePricing] of Object.entries(p.servicePricing)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.inputUsdPerMillion) || servicePricing.inputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}.inputUsdPerMillion`,
            message: "Service input price must be a non-negative finite number",
          });
        }
        if (!servicePricing || !Number.isFinite(servicePricing.outputUsdPerMillion) || servicePricing.outputUsdPerMillion < 0) {
          errors.push({
            field: `providers[${i}].servicePricing.${serviceName}.outputUsdPerMillion`,
            message: "Service output price must be a non-negative finite number",
          });
        }
      }
    }

    if (p.serviceCategories !== undefined) {
      for (const [serviceName, categories] of Object.entries(p.serviceCategories)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: "Service categories must reference a service listed in providers[].services",
          });
        }
        if (!Array.isArray(categories) || categories.length === 0) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: "Service categories must be a non-empty string array",
          });
          continue;
        }
        if (categories.length > MAX_SERVICE_CATEGORIES_PER_SERVICE) {
          errors.push({
            field: `providers[${i}].serviceCategories.${serviceName}`,
            message: `Service category count ${categories.length} exceeds max ${MAX_SERVICE_CATEGORIES_PER_SERVICE}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < categories.length; j++) {
          const category = categories[j];
          if (typeof category !== "string" || category.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category must be a non-empty string",
            });
            continue;
          }
          const normalized = category.trim().toLowerCase();
          if (normalized.length > MAX_SERVICE_CATEGORY_LENGTH) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: `Service category length ${normalized.length} exceeds max ${MAX_SERVICE_CATEGORY_LENGTH}`,
            });
          }
          if (!SERVICE_CATEGORY_PATTERN.test(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category must use lowercase letters, digits, or hyphen",
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceCategories.${serviceName}[${j}]`,
              message: "Service category values must be unique per service",
            });
          }
          deduped.add(normalized);
        }
      }
    }

    if (p.serviceApiProtocols !== undefined) {
      for (const [serviceName, protocols] of Object.entries(p.serviceApiProtocols)) {
        if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: `Service name length ${serviceName.length} exceeds max ${MAX_SERVICE_NAME_LENGTH}`,
          });
        }
        if (!hasWildcardServices && !p.services.includes(serviceName)) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: "Service API protocols must reference a service listed in providers[].services",
          });
        }
        if (!Array.isArray(protocols) || protocols.length === 0) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: "Service API protocols must be a non-empty string array",
          });
          continue;
        }
        if (protocols.length > MAX_SERVICE_API_PROTOCOLS_PER_SERVICE) {
          errors.push({
            field: `providers[${i}].serviceApiProtocols.${serviceName}`,
            message: `Service API protocol count ${protocols.length} exceeds max ${MAX_SERVICE_API_PROTOCOLS_PER_SERVICE}`,
          });
        }
        const deduped = new Set<string>();
        for (let j = 0; j < protocols.length; j++) {
          const protocol = protocols[j];
          if (typeof protocol !== "string" || protocol.trim().length === 0) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
              message: "Service API protocol must be a non-empty string",
            });
            continue;
          }
          const normalized = protocol.trim().toLowerCase();
          if (!SERVICE_API_PROTOCOL_SET.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
              message: `Unsupported service API protocol "${normalized}"`,
            });
          }
          if (deduped.has(normalized)) {
            errors.push({
              field: `providers[${i}].serviceApiProtocols.${serviceName}[${j}]`,
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

  // signature length (130 hex chars = 65 bytes, secp256k1 r+s+v)
  if (!/^[0-9a-f]{130}$/.test(metadata.signature)) {
    errors.push({
      field: "signature",
      message: "Signature must be exactly 130 lowercase hex characters (65 bytes)",
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
