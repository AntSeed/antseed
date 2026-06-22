import type {
  DomainVerificationConfig,
  DomainVerificationMethod,
  GithubVerificationConfig,
  HierarchicalPricingConfig,
  AntseedConfig,
  SellerProviderConfig,
  TokenPricingUsdPerMillion,
} from './types.js';

const SERVICE_CATEGORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_PUBLIC_ADDRESS_LENGTH = 255;
const MAX_DOMAIN_VERIFICATION_CLAIMS = 5;
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_VERIFICATION_METHODS = new Set<DomainVerificationMethod>(['dns-txt', 'https-well-known']);
const MAX_GITHUB_VERIFICATION_CLAIMS = 5;
const MAX_GITHUB_USERNAME_LENGTH = 39;
const MAX_GITHUB_REPOSITORY_LENGTH = 100;
const GITHUB_USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]+$/;
const VERIFICATION_NAMESPACES = new Set(['domains', 'github']);
const MIN_SELLER_UPLOAD_BODY_BYTES = 1024 * 1024;
const MIN_BUYER_PEER_REFRESH_INTERVAL_MS = 1_000;
export const MIN_BUYER_METADATA_FETCH_TIMEOUT_MS = 100;

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
  if (value.cachedInputUsdPerMillion != null && (!Number.isFinite(value.cachedInputUsdPerMillion) || value.cachedInputUsdPerMillion < 0)) {
    errors.push(`${path}.cachedInputUsdPerMillion must be a non-negative finite number`);
  }
}

function validateHierarchicalPricing(
  path: string,
  pricing: HierarchicalPricingConfig,
  errors: string[]
): void {
  validatePricingLeaf(`${path}.defaults`, pricing.defaults, errors);
}

function validateCategoryList(
  path: string,
  tags: string[] | undefined,
  errors: string[],
): void {
  if (!tags) return;
  if (!Array.isArray(tags) || tags.length === 0) {
    errors.push(`${path} must be a non-empty string array when provided`);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i < tags.length; i += 1) {
    const rawTag = tags[i];
    if (typeof rawTag !== 'string') {
      errors.push(`${path}[${i}] must be a string`);
      continue;
    }
    const tag = rawTag.trim().toLowerCase();
    if (tag.length === 0) {
      errors.push(`${path}[${i}] must not be empty`);
      continue;
    }
    if (!SERVICE_CATEGORY_PATTERN.test(tag)) {
      errors.push(`${path}[${i}] must use lowercase letters, digits, or hyphen`);
    }
    if (seen.has(tag)) {
      errors.push(`${path}[${i}] is duplicated`);
    }
    seen.add(tag);
  }
}

function validateSellerProviders(
  path: string,
  providers: Record<string, SellerProviderConfig>,
  errors: string[],
): void {
  for (const [providerName, providerCfg] of Object.entries(providers)) {
    const providerPath = `${path}.${providerName}`;
    if (typeof providerCfg.plugin !== 'string' || providerCfg.plugin.trim().length === 0) {
      errors.push(`${providerPath}.plugin must be a non-empty string`);
    }
    if (providerCfg.defaults) {
      validatePricingLeaf(`${providerPath}.defaults`, providerCfg.defaults, errors);
    }
    if (providerCfg.baseUrl !== undefined) {
      try {
        // eslint-disable-next-line no-new
        new URL(providerCfg.baseUrl);
      } catch {
        errors.push(`${providerPath}.baseUrl must be a valid URL`);
      }
    }
    for (const [serviceId, serviceCfg] of Object.entries(providerCfg.services)) {
      const servicePath = `${providerPath}.services.${serviceId}`;
      if (serviceCfg.upstreamModel !== undefined && serviceCfg.upstreamModel.trim().length === 0) {
        errors.push(`${servicePath}.upstreamModel must be a non-empty string when provided`);
      }
      if (serviceCfg.pricing) {
        validatePricingLeaf(`${servicePath}.pricing`, serviceCfg.pricing, errors);
      }
      validateCategoryList(`${servicePath}.categories`, serviceCfg.categories, errors);
    }
  }
}

function parsePublicAddress(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PUBLIC_ADDRESS_LENGTH) {
    return null;
  }

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0 || lastColon === trimmed.length - 1) {
    return null;
  }

  const host = trimmed.slice(0, lastColon).trim();
  const portText = trimmed.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }

  const port = Number(portText);
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return { host, port };
}

function isValidDomainName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false;
  if (value.includes('..') || value.endsWith('.')) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => DOMAIN_LABEL_PATTERN.test(label));
}

function validateDomainVerification(
  path: string,
  claims: DomainVerificationConfig[] | undefined,
  errors: string[],
): void {
  if (claims === undefined) return;
  if (!Array.isArray(claims)) {
    errors.push(`${path} must be an array when provided`);
    return;
  }
  if (claims.length === 0) {
    errors.push(`${path} must be a non-empty array when provided`);
    return;
  }
  if (claims.length > MAX_DOMAIN_VERIFICATION_CLAIMS) {
    errors.push(`${path} must contain at most ${MAX_DOMAIN_VERIFICATION_CLAIMS} claims`);
  }
  const domains = new Set<string>();
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    const claimPath = `${path}[${i}]`;
    const domain = typeof claim?.domain === 'string' ? claim.domain.trim().toLowerCase() : '';
    if (!isValidDomainName(domain)) {
      errors.push(`${claimPath}.domain must be a lower-case hostname with at least two labels`);
    } else if (domains.has(domain)) {
      errors.push(`${claimPath}.domain is duplicated`);
    }
    domains.add(domain);

    if (claim?.methods !== undefined) {
      if (!Array.isArray(claim.methods) || claim.methods.length === 0) {
        errors.push(`${claimPath}.methods must be a non-empty array when provided`);
      } else {
        const methods = new Set<string>();
        for (let j = 0; j < claim.methods.length; j += 1) {
          const method = claim.methods[j];
          if (typeof method !== 'string' || !DOMAIN_VERIFICATION_METHODS.has(method as DomainVerificationMethod)) {
            errors.push(`${claimPath}.methods[${j}] must be "dns-txt" or "https-well-known"`);
            continue;
          }
          if (methods.has(method)) {
            errors.push(`${claimPath}.methods[${j}] is duplicated`);
          }
          methods.add(method);
        }
      }
    }
  }
}

function validateGithubVerification(
  path: string,
  claims: GithubVerificationConfig[] | undefined,
  errors: string[],
): void {
  if (claims === undefined) return;
  if (!Array.isArray(claims)) {
    errors.push(`${path} must be an array when provided`);
    return;
  }
  if (claims.length === 0) {
    errors.push(`${path} must be a non-empty array when provided`);
    return;
  }
  if (claims.length > MAX_GITHUB_VERIFICATION_CLAIMS) {
    errors.push(`${path} must contain at most ${MAX_GITHUB_VERIFICATION_CLAIMS} claims`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    const claimPath = `${path}[${i}]`;
    const username = typeof claim?.username === 'string' ? claim.username.trim().toLowerCase() : '';
    if (
      username.length === 0
      || username.length > MAX_GITHUB_USERNAME_LENGTH
      || username.includes('--')
      || !GITHUB_USERNAME_PATTERN.test(username)
    ) {
      errors.push(`${claimPath}.username must be a valid GitHub username`);
    }
    const rawRepository = claim?.repository;
    let repository = '';
    if (rawRepository !== undefined) {
      repository = typeof rawRepository === 'string' ? rawRepository.trim().toLowerCase() : '';
      if (
        repository.length === 0
        || repository.length > MAX_GITHUB_REPOSITORY_LENGTH
        || repository === '.'
        || repository === '..'
        || !GITHUB_REPOSITORY_PATTERN.test(repository)
      ) {
        errors.push(`${claimPath}.repository must be a valid GitHub repository name`);
      }
    }
    const key = `${username}/${repository}`;
    if (seen.has(key)) {
      errors.push(`${claimPath} is duplicated`);
    }
    seen.add(key);
  }
}

function validateVerifications(
  path: string,
  verifications: AntseedConfig['seller']['verifications'],
  errors: string[],
): void {
  if (verifications === undefined) return;
  if (!verifications || typeof verifications !== 'object' || Array.isArray(verifications)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  validateDomainVerification(`${path}.domains`, verifications.domains, errors);
  validateGithubVerification(`${path}.github`, verifications.github, errors);
  const unknownKeys = Object.keys(verifications).filter((key) => !VERIFICATION_NAMESPACES.has(key));
  for (const key of unknownKeys) {
    errors.push(`${path}.${key} is not a supported verification namespace`);
  }
  if (verifications.domains === undefined && verifications.github === undefined && unknownKeys.length === 0) {
    errors.push(`${path} must include at least one verification namespace when provided`);
  }
}

function validateBuyerVerification(
  path: string,
  verification: AntseedConfig['buyer']['verification'],
  errors: string[],
): void {
  if (verification === undefined) return;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  if (
    verification.sampleRate !== undefined &&
    (!Number.isFinite(verification.sampleRate) || verification.sampleRate < 0 || verification.sampleRate > 1)
  ) {
    errors.push(`${path}.sampleRate must be a number in range 0-1`);
  }
  if (
    verification.maxSampleBytes !== undefined &&
    (!Number.isInteger(verification.maxSampleBytes) || verification.maxSampleBytes < 1)
  ) {
    errors.push(`${path}.maxSampleBytes must be an integer >= 1`);
  }
}

/**
 * Validate the full config and return all issues.
 */
export function validateConfig(config: AntseedConfig): string[] {
  const errors: string[] = [];

  validateSellerProviders('seller.providers', config.seller.providers, errors);
  validateHierarchicalPricing('buyer.maxPricing', config.buyer.maxPricing, errors);

  if (!Number.isFinite(config.buyer.minPeerReputation) || config.buyer.minPeerReputation < 0 || config.buyer.minPeerReputation > 100) {
    errors.push('buyer.minPeerReputation must be in range 0-100');
  }

  if (!Number.isInteger(config.buyer.proxyPort) || config.buyer.proxyPort < 1 || config.buyer.proxyPort > 65535) {
    errors.push('buyer.proxyPort must be an integer in range 1-65535');
  }

  if (!Number.isInteger(config.buyer.peerRefreshIntervalMs) || config.buyer.peerRefreshIntervalMs < MIN_BUYER_PEER_REFRESH_INTERVAL_MS) {
    errors.push('buyer.peerRefreshIntervalMs must be an integer >= 1000');
  }

  if (!Number.isInteger(config.buyer.metadataFetchTimeoutMs) || config.buyer.metadataFetchTimeoutMs < MIN_BUYER_METADATA_FETCH_TIMEOUT_MS) {
    errors.push('buyer.metadataFetchTimeoutMs must be an integer >= 100');
  }

  if (typeof config.buyer.disableMetadataV2Services !== 'boolean') {
    errors.push('buyer.disableMetadataV2Services must be a boolean');
  }

  validateBuyerVerification('buyer.verification', config.buyer.verification, errors);

  if (!Number.isInteger(config.seller.maxConcurrentBuyers) || config.seller.maxConcurrentBuyers < 1) {
    errors.push('seller.maxConcurrentBuyers must be an integer >= 1');
  }

  if (!Number.isFinite(config.seller.reserveFloor) || config.seller.reserveFloor < 0) {
    errors.push('seller.reserveFloor must be a non-negative finite number');
  }

  if (
    config.seller.maxUploadBodyBytes !== undefined &&
    (!Number.isInteger(config.seller.maxUploadBodyBytes) || config.seller.maxUploadBodyBytes < MIN_SELLER_UPLOAD_BODY_BYTES)
  ) {
    errors.push('seller.maxUploadBodyBytes must be an integer >= 1048576');
  }

  if (config.seller.agentDir !== undefined) {
    if (typeof config.seller.agentDir === 'string') {
      if (config.seller.agentDir.trim().length === 0) {
        errors.push('seller.agentDir must be a non-empty string when provided');
      }
    } else {
      const map = config.seller.agentDir as Record<string, string>;
      if (Object.keys(map).length === 0) {
        errors.push('seller.agentDir map must have at least one entry when provided');
      }
      for (const [svc, dir] of Object.entries(map)) {
        if (typeof dir !== 'string' || dir.trim().length === 0) {
          errors.push(`seller.agentDir["${svc}"] must be a non-empty string`);
        }
      }
    }
  }

  if (config.seller.publicAddress) {
    const raw = config.seller.publicAddress.trim();
    if (parsePublicAddress(raw) === null) {
      errors.push('seller.publicAddress must be in the form "host:port" with a valid port');
    }
  }

  validateVerifications('seller.verifications', config.seller.verifications, errors);

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
