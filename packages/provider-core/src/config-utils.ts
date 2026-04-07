import type { Provider, ServiceApiProtocol } from '@antseed/node';

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
