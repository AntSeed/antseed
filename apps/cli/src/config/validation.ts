import type {
  HierarchicalPricingConfig,
  AntseedConfig,
  TokenPricingUsdPerMillion,
} from './types.js';

const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PUBLIC_ADDRESS_PATTERN = /^.+:\d+$/;

function validatePricingLeaf(
  path: string,
  value: TokenPricingUsdPerMillion,
  errors: string[]
): void {
  if (!Number.isFinite(value.inputUsdPerMillion) || value.inputUsdPerMillion < 0) {
    errors.push(`${path}.inputUsdPerMillion must be a non-negative finite number`);
  }
  if (!Number.isFinite(value.outputUsdPerMillion) || value.outputUsdPerMillion < 0) {
    errors.push(`${path}.outputUsdPerMillion must be a non-negative finite number`);
  }
}

function validateHierarchicalPricing(
  path: string,
  pricing: HierarchicalPricingConfig,
  errors: string[]
): void {
  validatePricingLeaf(`${path}.defaults`, pricing.defaults, errors);

  for (const [provider, providerPricing] of Object.entries(pricing.providers ?? {})) {
    if (providerPricing.defaults) {
      validatePricingLeaf(`${path}.providers.${provider}.defaults`, providerPricing.defaults, errors);
    }

    for (const [service, servicePricing] of Object.entries(providerPricing.services ?? {})) {
      validatePricingLeaf(
        `${path}.providers.${provider}.services.${service}`,
        servicePricing,
        errors
      );
    }
  }
}

function validateSellerServiceCategories(
  path: string,
  categories: AntseedConfig['seller']['serviceCategories'] | undefined,
  errors: string[]
): void {
  if (!categories) return;

  for (const [provider, services] of Object.entries(categories)) {
    for (const [service, tags] of Object.entries(services)) {
      const servicePath = `${path}.${provider}.${service}`;
      if (!Array.isArray(tags) || tags.length === 0) {
        errors.push(`${servicePath} must be a non-empty string array`);
        continue;
      }

      const seen = new Set<string>();
      for (let i = 0; i < tags.length; i += 1) {
        const rawTag = tags[i];
        if (typeof rawTag !== 'string') {
          errors.push(`${servicePath}[${i}] must be a string`);
          continue;
        }
        const tag = rawTag.trim().toLowerCase();
        if (tag.length === 0) {
          errors.push(`${servicePath}[${i}] must not be empty`);
          continue;
        }
        if (!SERVICE_CATEGORY_PATTERN.test(tag)) {
          errors.push(`${servicePath}[${i}] must use lowercase letters, digits, or hyphen`);
        }
        if (seen.has(tag)) {
          errors.push(`${servicePath}[${i}] is duplicated`);
        }
        seen.add(tag);
      }
    }
  }
}

/**
 * Validate the full config and return all issues.
 */
export function validateConfig(config: AntseedConfig): string[] {
  const errors: string[] = [];

  validateHierarchicalPricing('seller.pricing', config.seller.pricing, errors);
  validateSellerServiceCategories('seller.serviceCategories', config.seller.serviceCategories, errors);
  validateHierarchicalPricing('buyer.maxPricing', config.buyer.maxPricing, errors);

  if (!Number.isFinite(config.buyer.minPeerReputation) || config.buyer.minPeerReputation < 0 || config.buyer.minPeerReputation > 100) {
    errors.push('buyer.minPeerReputation must be in range 0-100');
  }

  if (!Number.isInteger(config.buyer.proxyPort) || config.buyer.proxyPort < 1 || config.buyer.proxyPort > 65535) {
    errors.push('buyer.proxyPort must be an integer in range 1-65535');
  }

  if (!Number.isInteger(config.seller.maxConcurrentBuyers) || config.seller.maxConcurrentBuyers < 1) {
    errors.push('seller.maxConcurrentBuyers must be an integer >= 1');
  }

  if (!Number.isFinite(config.seller.reserveFloor) || config.seller.reserveFloor < 0) {
    errors.push('seller.reserveFloor must be a non-negative finite number');
  }

  if (config.seller.publicAddress) {
    const raw = config.seller.publicAddress.trim();
    const parts = raw.split(':');
    const port = Number(parts.at(-1));
    const host = parts.slice(0, -1).join(':').trim();
    if (!PUBLIC_ADDRESS_PATTERN.test(raw) || host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push('seller.publicAddress must be in the form "host:port" with a valid port');
    }
  }

  return errors;
}

/**
 * Assert that config is valid. Throws with all discovered violations.
 */
export function assertValidConfig(config: AntseedConfig): void {
  const errors = validateConfig(config);
  if (errors.length === 0) return;

  throw new Error(`Invalid config:\n- ${errors.join('\n- ')}`);
}
