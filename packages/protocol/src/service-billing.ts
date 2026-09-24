import type { ProviderAnnouncement } from './peer-metadata.js';
import { isKnownServiceApiProtocol, type ServiceApiProtocol } from './service-api.js';
import { isCompletedRequestBillingModel, usdToMicroUsdc, validateUnitBillingModelV1, type ServiceUnitBillingModelsV1 } from './billing.js';
export { parseMicroUsdc } from './billing.js';

export interface ServiceBillingOffer {
  provider: string;
  service: string;
  serviceApiProtocol: ServiceApiProtocol;
  priceMicroUsdc: string;
}

export function resolveCompletedRequestPrice(
  models: ServiceUnitBillingModelsV1[string] | undefined,
): Pick<ServiceBillingOffer, 'serviceApiProtocol' | 'priceMicroUsdc'> {
  let price: Pick<ServiceBillingOffer, 'serviceApiProtocol' | 'priceMicroUsdc'> | undefined;
  for (const [serviceApiProtocol, model] of Object.entries(models ?? {})) {
    if (!isKnownServiceApiProtocol(serviceApiProtocol) || !model || !isCompletedRequestBillingModel(model)) {
      throw new Error('Invalid completed-request billing model');
    }
    const errors = validateUnitBillingModelV1(model);
    if (errors.length) throw new Error(errors.join('; '));
    const priceMicroUsdc = usdToMicroUsdc(model.components[0]!.priceUsd).toString();
    if (price && price.priceMicroUsdc !== priceMicroUsdc) {
      throw new Error('Ambiguous completed-request price; all API protocols must use the same unit price');
    }
    price ??= { serviceApiProtocol, priceMicroUsdc };
  }
  if (!price) throw new Error('Missing completed-request billing model');
  return price;
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
  const price = resolveCompletedRequestPrice(models);
  for (const protocol of Object.keys(models ?? {})) {
    if (!announcement.serviceApiProtocols?.[service]?.includes(protocol as ServiceApiProtocol)) {
      throw new Error('Invalid completed-request billing model');
    }
  }
  if (announcement.serviceApiProtocols?.[service]?.some(protocol => !models?.[protocol])) {
    throw new Error('Missing completed-request billing model');
  }
  return { provider, service, ...price };
}
