import type { PeerOffering } from './capability.js';

export const FIXED_FEE_CAPABILITY = 'payments.fixed-fee.v1';
export const FIXED_FEE_CONTRACT_HEADER = 'x-antseed-fixed-fee-contract';
export const FIXED_FEE_PRICE_HEADER = 'x-antseed-fixed-fee-price';

export interface FixedFeeService {
  service: string;
  contract: string;
  priceMicroUsdc: string;
}

export interface FixedFeeOffer extends FixedFeeService {
  provider: string;
}

export function parseMicroUsdc(value: string): bigint {
  if (!/^(0|[1-9]\d{0,15})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Price must be a canonical non-negative safe integer micro-USDC amount');
  }
  return BigInt(value);
}

export function fixedFeeOffering(offer: FixedFeeOffer): PeerOffering {
  for (const identifier of [offer.provider, offer.service, offer.contract]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(identifier)) throw new Error('Invalid fixed-fee service identifier');
  }
  const amount = parseMicroUsdc(offer.priceMicroUsdc);
  const price = Math.fround(Number(amount) / 1_000_000);
  if (!Number.isSafeInteger(Math.round(price * 1_000_000)) || BigInt(Math.round(price * 1_000_000)) !== amount) {
    throw new Error('Fixed fee cannot round-trip through signed offering pricing');
  }
  return {
    capability: 'agent',
    name: `fixed-fee.v1:${offer.provider}:${offer.contract}`,
    description: 'Fixed fee per fulfilled response',
    services: [offer.service],
    pricing: { unit: 'request', pricePerUnit: price, currency: 'USD' },
  };
}

export function resolveFixedFeeOffer(
  offerings: readonly PeerOffering[] | undefined,
  provider: string,
  service: string,
): FixedFeeOffer {
  const matches = (offerings ?? []).filter(offer => offer.name.startsWith(`fixed-fee.v1:${provider}:`) && offer.services?.includes(service));
  if (matches.length !== 1) throw new Error('Missing or ambiguous signed fixed-fee offer');
  const offering = matches[0]!;
  if (offering.capability !== 'agent' || offering.pricing.unit !== 'request' || offering.pricing.currency !== 'USD'
    || offering.services?.length !== 1 || !Number.isFinite(offering.pricing.pricePerUnit) || offering.pricing.pricePerUnit < 0) {
    throw new Error('Invalid fixed-fee offering');
  }
  const offer = {
    provider, service, contract: offering.name.slice(`fixed-fee.v1:${provider}:`.length),
    priceMicroUsdc: String(Math.round(Math.fround(offering.pricing.pricePerUnit) * 1_000_000)),
  };
  const canonical = fixedFeeOffering(offer);
  if (canonical.pricing.pricePerUnit !== Math.fround(offering.pricing.pricePerUnit)) throw new Error('Noncanonical fixed-fee price');
  return offer;
}
