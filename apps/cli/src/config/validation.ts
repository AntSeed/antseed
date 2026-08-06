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

// The loader preserves this section as-is, so reject unknown keys here rather
// than silently accepting verifier typos.
const VERIFIER_KEYS = new Set([
  'referencesDir', 'banksDir', 'evidenceDir', 'probeRequestTimeoutMs', 'responseAuthWaitTimeoutMs',
  'auditMaxConcurrentModels', 'auditMaxConcurrentPeersPerModel',
  'auditMaxConcurrentBatches', 'auditMaxConcurrentBatchesPerPeer',
  'auditConcurrencyPromotionLatencyMs', 'auditPeerTimeoutMs',
  'contrastSelection', 'referenceEndpoint',
  'referenceMaxRequestsPerBuild', 'referenceBatchRetryCount', 'referenceRetryBaseDelayMs',
  'referenceMaxNoProgressRounds', 'referenceMaxConcurrentRequests', 'referenceMaxConcurrentRequestsPerModel',
  'referenceMinimumProbeCount', 'referenceMaximumProbeCount', 'referenceProbeStep',
  'referenceMinimumStatisticalPower',
]);
const VERIFIER_REFERENCE_ENDPOINT_KEYS = new Set([
  'baseUrl', 'apiKey', 'apiKeyEnv', 'sourceId', 'trust', 'antseedPeerId', 'models', 'contrastModelBank',
]);
const VERIFIER_REFERENCE_MODEL_KEYS = new Set(['enabled', 'upstreamModel', 'pricing', 'contrastModels']);
const VERIFIER_CONTRAST_SELECTION_KEYS = new Set([
  'catalogSource', 'inputWeight', 'maxPriceRatio', 'maxModels', 'minimumIntelligenceIndex',
]);
const VERIFIER_CONTRAST_MODEL_KEYS = new Set(['enabled', 'upstreamModel', 'pricing', 'capabilityRank']);
const VERIFIER_PRICING_KEYS = new Set(['inputUsdPerMillion', 'outputUsdPerMillion']);

function validateVerifierConfig(
  path: string,
  verifier: AntseedConfig['verifier'],
  errors: string[],
): void {
  if (verifier === undefined) return;
  if (!verifier || typeof verifier !== 'object' || Array.isArray(verifier)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  for (const key of Object.keys(verifier).filter((k) => !VERIFIER_KEYS.has(k))) {
    errors.push(`${path}.${key} is not a supported verifier option`);
  }
  const positiveInts: Array<[string, number | undefined]> = [
    ['probeRequestTimeoutMs', verifier.probeRequestTimeoutMs],
    ['responseAuthWaitTimeoutMs', verifier.responseAuthWaitTimeoutMs],
    ['auditMaxConcurrentModels', verifier.auditMaxConcurrentModels],
    ['auditMaxConcurrentPeersPerModel', verifier.auditMaxConcurrentPeersPerModel],
    ['auditMaxConcurrentBatches', verifier.auditMaxConcurrentBatches],
    ['auditMaxConcurrentBatchesPerPeer', verifier.auditMaxConcurrentBatchesPerPeer],
    ['auditConcurrencyPromotionLatencyMs', verifier.auditConcurrencyPromotionLatencyMs],
    ['auditPeerTimeoutMs', verifier.auditPeerTimeoutMs],
    ['referenceMaxRequestsPerBuild', verifier.referenceMaxRequestsPerBuild],
    ['referenceRetryBaseDelayMs', verifier.referenceRetryBaseDelayMs],
    ['referenceMaxNoProgressRounds', verifier.referenceMaxNoProgressRounds],
    ['referenceMaxConcurrentRequests', verifier.referenceMaxConcurrentRequests],
    ['referenceMaxConcurrentRequestsPerModel', verifier.referenceMaxConcurrentRequestsPerModel],
    ['referenceMinimumProbeCount', verifier.referenceMinimumProbeCount],
    ['referenceMaximumProbeCount', verifier.referenceMaximumProbeCount],
    ['referenceProbeStep', verifier.referenceProbeStep],
  ];
  for (const [key, value] of positiveInts) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      errors.push(`${path}.${key} must be an integer >= 1`);
    }
  }
  if (verifier.referenceBatchRetryCount !== undefined
    && (!Number.isInteger(verifier.referenceBatchRetryCount) || verifier.referenceBatchRetryCount < 0)) {
    errors.push(`${path}.referenceBatchRetryCount must be an integer >= 0`);
  }
  const minimumProbeCount = verifier.referenceMinimumProbeCount ?? 100;
  const maximumProbeCount = verifier.referenceMaximumProbeCount ?? 500;
  const probeStep = verifier.referenceProbeStep ?? 10;
  for (const [key, value] of [
    ['referenceMinimumProbeCount', minimumProbeCount],
    ['referenceMaximumProbeCount', maximumProbeCount],
    ['referenceProbeStep', probeStep],
  ] as const) {
    if (value < 10 || value > 500 || value % 10 !== 0) {
      errors.push(`${path}.${key} must be a multiple of 10 from 10 through 500`);
    }
  }
  if (minimumProbeCount > maximumProbeCount) {
    errors.push(`${path}.referenceMinimumProbeCount must not exceed referenceMaximumProbeCount`);
  } else if ((maximumProbeCount - minimumProbeCount) % probeStep !== 0) {
    errors.push(`${path}.referenceProbeStep must divide the configured probe-count range`);
  }
  if (verifier.referenceMinimumStatisticalPower !== undefined
    && (!(verifier.referenceMinimumStatisticalPower > 0) || verifier.referenceMinimumStatisticalPower > 1)) {
    errors.push(`${path}.referenceMinimumStatisticalPower must be in (0, 1]`);
  }
  const dirKeys: Array<[string, unknown]> = [
    ['referencesDir', verifier.referencesDir],
    ['banksDir', verifier.banksDir],
    ['evidenceDir', verifier.evidenceDir],
  ];
  for (const [key, value] of dirKeys) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      errors.push(`${path}.${key} must be a non-empty string when provided`);
    }
  }
  const maxContrastModels = validateContrastSelection(
    `${path}.contrastSelection`,
    verifier.contrastSelection,
    errors,
  );
  if (verifier.referenceEndpoint !== undefined) {
    validateReferenceEndpoint(
      `${path}.referenceEndpoint`,
      verifier.referenceEndpoint,
      maxContrastModels,
      verifier.contrastSelection?.catalogSource === 'openrouter',
      errors,
    );
  }
}

function validateContrastSelection(path: string, selection: unknown, errors: string[]): number {
  const defaultMaximum = 3;
  if (selection === undefined) return defaultMaximum;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    errors.push(`${path} must be an object when provided`);
    return defaultMaximum;
  }
  const value = selection as Record<string, unknown>;
  for (const key of Object.keys(value).filter((key) => !VERIFIER_CONTRAST_SELECTION_KEYS.has(key))) {
    errors.push(`${path}.${key} is not supported`);
  }
  if (value.catalogSource !== undefined && value.catalogSource !== 'openrouter') {
    errors.push(`${path}.catalogSource must be "openrouter" when provided`);
  }
  if (value.inputWeight !== undefined
    && (typeof value.inputWeight !== 'number' || !Number.isFinite(value.inputWeight)
      || value.inputWeight < 0 || value.inputWeight > 1)) {
    errors.push(`${path}.inputWeight must be in [0, 1]`);
  }
  if (value.maxPriceRatio !== undefined
    && (typeof value.maxPriceRatio !== 'number' || !Number.isFinite(value.maxPriceRatio)
      || value.maxPriceRatio <= 0 || value.maxPriceRatio > 1)) {
    errors.push(`${path}.maxPriceRatio must be in (0, 1]`);
  }
  if (value.maxModels !== undefined
    && (!Number.isInteger(value.maxModels) || Number(value.maxModels) < 1 || Number(value.maxModels) > 3)) {
    errors.push(`${path}.maxModels must be an integer from 1 through 3`);
  }
  if (value.minimumIntelligenceIndex !== undefined
    && (typeof value.minimumIntelligenceIndex !== 'number'
      || !Number.isFinite(value.minimumIntelligenceIndex)
      || value.minimumIntelligenceIndex < 0)) {
    errors.push(`${path}.minimumIntelligenceIndex must be a finite number >= 0`);
  }
  return Number.isInteger(value.maxModels) && Number(value.maxModels) >= 1 && Number(value.maxModels) <= 3
    ? Number(value.maxModels)
    : defaultMaximum;
}

function validateReferenceEndpoint(
  path: string,
  endpoint: unknown,
  maxContrastModels: number,
  usesOpenRouterCatalog: boolean,
  errors: string[],
): void {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    errors.push(`${path} must be an object when provided`);
    return;
  }
  const value = endpoint as Record<string, unknown>;
  for (const key of Object.keys(value).filter((key) => !VERIFIER_REFERENCE_ENDPOINT_KEYS.has(key))) {
    errors.push(`${path}.${key} is not a supported reference endpoint option`);
  }
  for (const key of ['baseUrl', 'sourceId'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length === 0) {
      errors.push(`${path}.${key} must be a non-empty string`);
    }
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== 'string') errors.push(`${path}.apiKey must be a string`);
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv.trim().length === 0)) {
    errors.push(`${path}.apiKeyEnv must be a non-empty string`);
  }
  if (value.antseedPeerId !== undefined && (typeof value.antseedPeerId !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value.antseedPeerId))) {
    errors.push(`${path}.antseedPeerId must be a 40-character hex peer id`);
  }
  if (value.trust !== 'smoke' && value.trust !== 'trusted') errors.push(`${path}.trust must be "smoke" or "trusted"`);
  if (!value.models || typeof value.models !== 'object' || Array.isArray(value.models)) {
    errors.push(`${path}.models must be a non-empty object`);
    return;
  }
  const models = Object.entries(value.models as Record<string, unknown>);
  if (models.length === 0) errors.push(`${path}.models must not be empty`);
  if (usesOpenRouterCatalog && value.contrastModelBank !== undefined) {
    errors.push(`${path}.contrastModelBank must be omitted when contrastSelection.catalogSource is "openrouter"`);
  }
  for (const [service, modelConfig] of models) {
    const modelPath = `${path}.models[${JSON.stringify(service)}]`;
    if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) {
      errors.push(`${modelPath} must be an object`);
      continue;
    }
    const model = modelConfig as Record<string, unknown>;
    for (const key of Object.keys(model).filter((key) => !VERIFIER_REFERENCE_MODEL_KEYS.has(key))) {
      errors.push(`${modelPath}.${key} is not supported`);
    }
    if (typeof model.upstreamModel !== 'string' || model.upstreamModel.trim().length === 0) {
      errors.push(`${modelPath}.upstreamModel must be a non-empty string`);
    }
    if (model.enabled !== undefined && typeof model.enabled !== 'boolean') {
      errors.push(`${modelPath}.enabled must be a boolean`);
    }
    const hasExplicitContrasts = Array.isArray(model.contrastModels) && model.contrastModels.length > 0;
    if (model.pricing !== undefined) {
      validatePricing(`${modelPath}.pricing`, model.pricing, errors);
      if (usesOpenRouterCatalog) {
        errors.push(`${modelPath}.pricing must be omitted when contrastSelection.catalogSource is "openrouter"`);
      }
    } else if (!usesOpenRouterCatalog && !hasExplicitContrasts && model.enabled !== false) {
      errors.push(`${modelPath}.pricing is required for automatic contrast-model selection`);
    }
    if (model.contrastModels !== undefined) {
      if (!Array.isArray(model.contrastModels)
        || model.contrastModels.some((contrast) => typeof contrast !== 'string' || contrast.trim().length === 0)) {
        errors.push(`${modelPath}.contrastModels must be a string array when provided`);
      } else if (model.contrastModels.length > maxContrastModels) {
        errors.push(`${modelPath}.contrastModels must contain at most ${maxContrastModels} entries`);
      } else if (new Set(model.contrastModels.map((contrast) => contrast.trim().toLowerCase())).size
        !== model.contrastModels.length) {
        errors.push(`${modelPath}.contrastModels must not contain duplicates`);
      }
    }
  }
  const requiresAutomaticSelection = models.some(([, modelConfig]) => {
    if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) return false;
    const model = modelConfig as Record<string, unknown>;
    return model.enabled !== false && (!Array.isArray(model.contrastModels) || model.contrastModels.length === 0);
  });
  if (!usesOpenRouterCatalog && requiresAutomaticSelection && value.contrastModelBank === undefined) {
    errors.push(`${path}.contrastModelBank is required when an enabled model has no explicit contrastModels`);
  }
  if (value.contrastModelBank !== undefined) {
    validateContrastModelBank(`${path}.contrastModelBank`, value.contrastModelBank, errors);
  }
}

function validateContrastModelBank(path: string, bank: unknown, errors: string[]): void {
  if (!bank || typeof bank !== 'object' || Array.isArray(bank)) {
    errors.push(`${path} must be a non-empty object when provided`);
    return;
  }
  const entries = Object.entries(bank as Record<string, unknown>);
  if (entries.length === 0) errors.push(`${path} must not be empty`);
  for (const [name, candidateConfig] of entries) {
    const candidatePath = `${path}[${JSON.stringify(name)}]`;
    if (!candidateConfig || typeof candidateConfig !== 'object' || Array.isArray(candidateConfig)) {
      errors.push(`${candidatePath} must be an object`);
      continue;
    }
    const candidate = candidateConfig as Record<string, unknown>;
    for (const key of Object.keys(candidate).filter((key) => !VERIFIER_CONTRAST_MODEL_KEYS.has(key))) {
      errors.push(`${candidatePath}.${key} is not supported`);
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean') {
      errors.push(`${candidatePath}.enabled must be a boolean`);
    }
    if (typeof candidate.upstreamModel !== 'string' || candidate.upstreamModel.trim().length === 0) {
      errors.push(`${candidatePath}.upstreamModel must be a non-empty string`);
    }
    validatePricing(`${candidatePath}.pricing`, candidate.pricing, errors);
    if (typeof candidate.capabilityRank !== 'number'
      || !Number.isFinite(candidate.capabilityRank) || candidate.capabilityRank < 0) {
      errors.push(`${candidatePath}.capabilityRank must be a finite number >= 0`);
    }
  }
}

function validatePricing(path: string, pricing: unknown, errors: string[]): void {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const value = pricing as Record<string, unknown>;
  for (const key of Object.keys(value).filter((key) => !VERIFIER_PRICING_KEYS.has(key))) {
    errors.push(`${path}.${key} is not supported`);
  }
  for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Number(value[key]) < 0) {
      errors.push(`${path}.${key} must be a finite number >= 0`);
    }
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

  validateVerifierConfig('verifier', config.verifier, errors);

  if (config.relayer !== undefined) {
    if (config.relayer.enabled !== undefined && typeof config.relayer.enabled !== 'boolean') {
      errors.push('relayer.enabled must be a boolean');
    }
    if (config.relayer.minProfitBaseUnits !== undefined && !/^-?[0-9]+$/.test(config.relayer.minProfitBaseUnits)) {
      errors.push('relayer.minProfitBaseUnits must be an integer string (USDC base units, may be negative)');
    }
    if (config.relayer.maxInFlight !== undefined && (!Number.isInteger(config.relayer.maxInFlight) || config.relayer.maxInFlight < 1)) {
      errors.push('relayer.maxInFlight must be an integer >= 1');
    }
    if (config.relayer.maxPerPeerPerMinute !== undefined && (!Number.isInteger(config.relayer.maxPerPeerPerMinute) || config.relayer.maxPerPeerPerMinute < 1)) {
      errors.push('relayer.maxPerPeerPerMinute must be an integer >= 1');
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
