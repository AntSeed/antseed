import type { Provider, ServiceApiProtocol, ServiceBillingModelV1, ServiceBillingModelsV1, BillingComponentV1 } from '@antseed/node';
import { isKnownServiceApiProtocol, validateServiceBillingModelV1 } from '@antseed/node';

export function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

export function parseServicePricingJson(raw: string | undefined): Provider['pricing']['services'] {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_SERVICE_PRICING_JSON must be an object map of service -> pricing');
  }

  const out: NonNullable<Provider['pricing']['services']> = {};
  for (const [service, pricing] of Object.entries(parsed as Record<string, unknown>)) {
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error(`Service pricing for "${service}" must be an object`);
    }
    const input = (pricing as Record<string, unknown>)['inputUsdPerMillion'];
    const output = (pricing as Record<string, unknown>)['outputUsdPerMillion'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative inputUsdPerMillion`);
    }
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error(`Service pricing for "${service}" requires non-negative outputUsdPerMillion`);
    }
    const cached = (pricing as Record<string, unknown>)['cachedInputUsdPerMillion'];
    if (cached != null && (typeof cached !== 'number' || !Number.isFinite(cached) || cached < 0)) {
      throw new Error(`Service pricing for "${service}" cachedInputUsdPerMillion must be a non-negative number`);
    }
    out[service] = {
      inputUsdPerMillion: input,
      outputUsdPerMillion: output,
      ...(typeof cached === 'number' ? { cachedInputUsdPerMillion: cached } : {}),
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseServiceBillingModelsJson(raw: string | undefined, key = 'ANTSEED_SERVICE_BILLING_MODELS_JSON'): ServiceBillingModelsV1 | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be an object map of service -> protocol -> billing model`);
  }

  const out: ServiceBillingModelsV1 = {};
  for (const [service, protocols] of Object.entries(parsed as Record<string, unknown>)) {
    if (!protocols || typeof protocols !== 'object' || Array.isArray(protocols)) {
      throw new Error(`${key}.${service} must be an object map of protocol -> billing model`);
    }
    for (const [protocol, model] of Object.entries(protocols as Record<string, unknown>)) {
      if (!isKnownServiceApiProtocol(protocol)) {
        throw new Error(`${key}.${service}.${protocol} must be a known service API protocol`);
      }
      if (!model || typeof model !== 'object' || Array.isArray(model)) {
        throw new Error(`${key}.${service}.${protocol} must be a billing model object`);
      }
      const normalized = normalizeBillingModel(model as Record<string, unknown>, `${key}.${service}.${protocol}`);
      const errors = validateServiceBillingModelV1(normalized);
      if (errors.length > 0) {
        throw new Error(`${key}.${service}.${protocol}: ${errors.join('; ')}`);
      }
      out[service] = {
        ...(out[service] ?? {}),
        [protocol]: normalized,
      } as ServiceBillingModelsV1[string];
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeBillingModel(raw: Record<string, unknown>, field: string): ServiceBillingModelV1 {
  if (raw.version !== 1 || !Array.isArray(raw.components)) {
    throw new Error(`${field} must have version=1 and a components array`);
  }
  const components = raw.components.map((component, index): BillingComponentV1 => {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw new Error(`${field}.components[${index}] must be an object`);
    }
    const c = component as Record<string, unknown>;
    if (typeof c.meter !== 'string' || typeof c.unit !== 'string' || typeof c.priceUsd !== 'number') {
      throw new Error(`${field}.components[${index}] requires meter, unit, and numeric priceUsd`);
    }
    const match = c.match;
    return {
      meter: c.meter,
      unit: c.unit,
      priceUsd: c.priceUsd,
      ...(match && typeof match === 'object' && !Array.isArray(match) ? { match: match as Record<string, string> } : {}),
    } as BillingComponentV1;
  });
  return { version: 1, components };
}

export function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

export function parseJsonObject(raw: string | undefined, key: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${key} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

export function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
}
