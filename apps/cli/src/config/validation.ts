import type {
  HierarchicalPricingConfig,
  AntseedConfig,
  TokenPricingUsdPerMillion,
} from './types.js';

const ONION_HOST_RE = /^([a-z2-7]{16}|[a-z2-7]{56})\.onion$/;

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

    for (const [model, modelPricing] of Object.entries(providerPricing.models ?? {})) {
      validatePricingLeaf(
        `${path}.providers.${provider}.models.${model}`,
        modelPricing,
        errors
      );
    }
  }
}

/**
 * Validate the full config and return all issues.
 */
export function validateConfig(config: AntseedConfig): string[] {
  const errors: string[] = [];

  validateHierarchicalPricing('seller.pricing', config.seller.pricing, errors);
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

  const tor = config.network.tor;
  if (tor) {
    if (tor.socksProxy !== undefined) {
      if (typeof tor.socksProxy !== 'string' || tor.socksProxy.trim().length === 0) {
        errors.push('network.tor.socksProxy must be a non-empty host:port string');
      } else {
        const raw = tor.socksProxy.trim();
        const sep = raw.lastIndexOf(':');
        const host = sep > 0 ? raw.slice(0, sep).trim() : '';
        const port = sep > 0 ? Number.parseInt(raw.slice(sep + 1), 10) : Number.NaN;
        if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push('network.tor.socksProxy must use host:port with port in range 1-65535');
        }
      }
    }

    if (tor.manualPeers !== undefined) {
      if (!Array.isArray(tor.manualPeers)) {
        errors.push('network.tor.manualPeers must be an array of strings');
      } else {
        for (const [index, entry] of tor.manualPeers.entries()) {
          if (typeof entry !== 'string' || entry.trim().length === 0) {
            errors.push(`network.tor.manualPeers[${index}] must be a non-empty string`);
            continue;
          }
          const raw = entry.trim();
          const endpoint = raw.includes('@') ? raw.slice(raw.indexOf('@') + 1) : raw;
          const sep = endpoint.lastIndexOf(':');
          const host = sep > 0 ? endpoint.slice(0, sep).trim() : '';
          const port = sep > 0 ? Number.parseInt(endpoint.slice(sep + 1), 10) : Number.NaN;
          if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
            errors.push(`network.tor.manualPeers[${index}] must be in [peerId@]host:port format`);
            continue;
          }
          if (tor.enabled === true && host.toLowerCase().endsWith('.onion') && !raw.includes('@')) {
            errors.push(`network.tor.manualPeers[${index}] onion peer must include peerId@host:port`);
          }
        }
      }
    }

    if (tor.onionAddress !== undefined) {
      if (typeof tor.onionAddress !== 'string' || tor.onionAddress.trim().length === 0) {
        errors.push('network.tor.onionAddress must be a non-empty .onion hostname');
      } else if (!ONION_HOST_RE.test(tor.onionAddress.trim().toLowerCase())) {
        errors.push('network.tor.onionAddress must be a valid v2/v3 .onion hostname');
      }
    }

    if (tor.onionPort !== undefined) {
      if (!Number.isInteger(tor.onionPort) || tor.onionPort < 1 || tor.onionPort > 65535) {
        errors.push('network.tor.onionPort must be an integer in range 1-65535');
      }
    }

    if (tor.onionPort !== undefined && tor.onionAddress === undefined) {
      errors.push('network.tor.onionPort requires network.tor.onionAddress');
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
