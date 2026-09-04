import type { ServiceUnitBillingModelsV1 } from './billing.js';
import type { ServiceCapabilities, TokenPricingUsdPerMillion } from './peer-metadata.js';
import type { ServiceApiProtocol } from './service-api.js';

export interface ProviderPricingMatrixEntry {
  defaults: TokenPricingUsdPerMillion;
  services?: Record<string, TokenPricingUsdPerMillion>;
}

export function snapshotProviderPricing(providers: ReadonlyArray<{
  provider: string;
  services: string[];
  defaultPricing: TokenPricingUsdPerMillion;
  servicePricing?: Record<string, TokenPricingUsdPerMillion>;
}>): Record<string, ProviderPricingMatrixEntry> {
  const result: Record<string, ProviderPricingMatrixEntry> = Object.create(null) as Record<string, ProviderPricingMatrixEntry>;
  for (const provider of providers) {
    const entry = result[provider.provider] ??= { defaults: { ...provider.defaultPricing }, services: Object.create(null) as Record<string, TokenPricingUsdPerMillion> };
    for (const service of provider.services) {
      entry.services![service] ??= { ...(provider.servicePricing?.[service] ?? provider.defaultPricing) };
    }
  }
  return result;
}

export function parseProviderPricing(value: unknown): Record<string, ProviderPricingMatrixEntry> {
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider pricing must be an object');
    return input as Record<string, unknown>;
  };
  const price = (input: unknown): TokenPricingUsdPerMillion => {
    const fields = record(input);
    for (const key of ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion']) {
      const rate = fields[key];
      if (key === 'cachedInputUsdPerMillion' && rate === undefined) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) throw new Error(`Invalid pricing ${key}`);
    }
    if (fields.cachedInputUsdPerMillion !== undefined && (fields.cachedInputUsdPerMillion as number) > (fields.inputUsdPerMillion as number)) {
      throw new Error('Cached input pricing cannot exceed input pricing');
    }
    return {
      inputUsdPerMillion: fields.inputUsdPerMillion as number,
      outputUsdPerMillion: fields.outputUsdPerMillion as number,
      ...(fields.cachedInputUsdPerMillion !== undefined ? { cachedInputUsdPerMillion: fields.cachedInputUsdPerMillion as number } : {}),
    };
  };
  return Object.fromEntries(Object.entries(record(value)).map(([name, input]) => {
    const entry = record(input);
    return [name, {
      defaults: price(entry.defaults),
      ...(entry.services !== undefined
        ? { services: Object.fromEntries(Object.entries(record(entry.services)).map(([service, pricing]) => [service, price(pricing)])) }
        : {}),
    }];
  }));
}

export interface ProviderServiceCategoryMatrixEntry {
  services: Record<string, string[]>;
}

export interface ProviderServiceApiProtocolMatrixEntry {
  services: Record<string, ServiceApiProtocol[]>;
}

export interface ProviderServiceUnitBillingModelMatrixEntry {
  services: ServiceUnitBillingModelsV1;
}

export interface ProviderServiceCapabilityMatrixEntry {
  services: Record<string, ServiceCapabilities>;
}
