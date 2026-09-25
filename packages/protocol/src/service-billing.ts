import type { ProviderAnnouncement } from './peer-metadata.js';
import { isKnownServiceApiProtocol, type ServiceApiProtocol } from './service-api.js';
import { completedRequestPrice, type UnitBillingModelV1, type ServiceUnitBillingModelsV1 } from './billing.js';
export { completedRequestPrice, parseMicroUsdc } from './billing.js';

export interface ServiceBillingOffer {
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  unitModel: UnitBillingModelV1;
}

export function resolveCompletedRequestBilling(
  models: ServiceUnitBillingModelsV1[string] | undefined,
): Pick<ServiceBillingOffer, 'serviceApiProtocol' | 'unitModel'> {
  let billing: Pick<ServiceBillingOffer, 'serviceApiProtocol' | 'unitModel'> | undefined;
  let price: bigint | undefined;
  for (const [serviceApiProtocol, model] of Object.entries(models ?? {})) {
    if (!isKnownServiceApiProtocol(serviceApiProtocol) || !model) {
      throw new Error('Invalid completed-request billing model');
    }
    const modelPrice = completedRequestPrice(model);
    if (price !== undefined && price !== modelPrice) {
      throw new Error('Ambiguous completed-request price; all API protocols must use the same unit price');
    }
    price = modelPrice;
    billing ??= { serviceApiProtocol, unitModel: model };
  }
  if (!billing) throw new Error('Missing completed-request billing model');
  return billing;
}

export function resolveServiceBillingOffer(
  providers: readonly ProviderAnnouncement[] | undefined,
  provider: string,
  service: string,
): ServiceBillingOffer {
  const matches = (providers ?? []).filter(entry => entry.provider === provider && entry.services.includes(service));
  if (matches.length !== 1) throw new Error('Missing or ambiguous signed completed-request offer');
  const announcement = matches[0]!;
  const models = announcement.serviceUnitBillingModels?.[service];
  const billing = resolveCompletedRequestBilling(models);
  for (const protocol of Object.keys(models ?? {})) {
    if (!announcement.serviceApiProtocols?.[service]?.includes(protocol as ServiceApiProtocol)) {
      throw new Error('Invalid completed-request billing model');
    }
  }
  if (announcement.serviceApiProtocols?.[service]?.some(protocol => !models?.[protocol])) {
    throw new Error('Missing completed-request billing model');
  }
  return { provider, service, ...billing };
}
