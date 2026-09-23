import type { PeerOffering } from './capability.js';
import { isKnownServiceApiProtocol, type ServiceApiProtocol } from './service-api.js';
import { parseMicroUsdc } from './billing.js';
export { parseMicroUsdc } from './billing.js';

export const COMPLETED_REQUESTS_CAPABILITY = 'payments.completed-requests.v1';
export interface ServiceBillingOffer {
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  priceMicroUsdc: string;
}

export function serviceBillingOffering(offer: ServiceBillingOffer): PeerOffering {
  for (const identifier of [offer.provider, offer.service]) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(identifier)) throw new Error('Invalid completed-request service identifier');
  }
  if (!isKnownServiceApiProtocol(offer.serviceApiProtocol)) throw new Error('Unknown service API protocol');
  const amount = parseMicroUsdc(offer.priceMicroUsdc);
  const price = Math.fround(Number(amount) / 1_000_000);
  if (!Number.isSafeInteger(Math.round(price * 1_000_000)) || BigInt(Math.round(price * 1_000_000)) !== amount) {
    throw new Error('Unit price cannot round-trip through signed offering pricing');
  }
  return {
    capability: 'agent',
    name: `unit-billing.v2:${offer.provider}:${offer.serviceApiProtocol}`,
    description: 'Price per completed request',
    services: [offer.service],
    pricing: { unit: 'request', pricePerUnit: price, currency: 'USD' },
  };
}

export function resolveServiceBillingOffer(
  offerings: readonly PeerOffering[] | undefined,
  provider: string,
  service: string,
): ServiceBillingOffer {
  const matches = (offerings ?? []).filter(offer => offer.name.startsWith(`unit-billing.v2:${provider}:`) && offer.services?.includes(service));
  if (matches.length !== 1) throw new Error('Missing or ambiguous signed completed-request offer');
  const offering = matches[0]!;
  if (offering.capability !== 'agent' || offering.pricing.unit !== 'request' || offering.pricing.currency !== 'USD'
    || offering.services?.length !== 1 || !Number.isFinite(offering.pricing.pricePerUnit) || offering.pricing.pricePerUnit < 0) {
    throw new Error('Invalid completed-request offering');
  }
  const serviceApiProtocol = offering.name.slice(`unit-billing.v2:${provider}:`.length);
  if (!isKnownServiceApiProtocol(serviceApiProtocol)) throw new Error('Unknown service API protocol');
  const offer = {
    provider, service, serviceApiProtocol,
    priceMicroUsdc: String(Math.round(Math.fround(offering.pricing.pricePerUnit) * 1_000_000)),
  };
  const canonical = serviceBillingOffering(offer);
  if (canonical.pricing.pricePerUnit !== Math.fround(offering.pricing.pricePerUnit)) throw new Error('Noncanonical completed-request price');
  return offer;
}
