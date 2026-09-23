import type { Provider } from '../interfaces/seller-provider.js';
import type { ServiceBillingOffer } from '@antseed/protocol/service-billing';
import type { ServiceUnitBillingModelsV1 } from '@antseed/protocol/billing';
import { validateUnitBillingModel } from '@antseed/protocol/billing';
import { isKnownServiceApiProtocol } from '@antseed/protocol/service-api';

export function completedRequestOffer(provider: Provider, service: string): ServiceBillingOffer | undefined {
  const billingModels = provider.serviceUnitBillingModels?.[service];
  const models = Object.values(billingModels ?? {});
  const entry = Object.entries(billingModels ?? {}).find(([, model]) => model?.version === 2);
  if (!entry) return undefined;
  const [serviceApiProtocol, model] = entry;
  if (!model || model.version !== 2 || !isKnownServiceApiProtocol(serviceApiProtocol)) throw new Error('Unknown service API protocol');
  const errors = validateUnitBillingModel(model);
  if (errors.length) throw new Error(errors.join('; '));
  if (models.some(candidate => candidate?.version !== 2 || validateUnitBillingModel(candidate).length > 0
    || candidate.components[0]?.priceMicroUsdc !== model.components[0]!.priceMicroUsdc)
    || provider.serviceApiProtocols?.[service]?.some(protocol => billingModels?.[protocol]?.version !== 2)) {
    throw new Error('Completed-request services require the same unit price across their API protocols');
  }
  return { provider: provider.name, service, serviceApiProtocol, priceMicroUsdc: model.components[0]!.priceMicroUsdc };
}

export function isLegacyInferenceService(provider: Provider, service: string): boolean {
  return !provider.serviceApiProtocols?.[service]?.includes('levanto-routing') && !completedRequestOffer(provider, service);
}

export function inferenceServiceFields<Value>(provider: Provider, fields: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(fields).filter(([service]) => isLegacyInferenceService(provider, service)));
}

export function legacyUnitBillingModels(provider: Provider): ServiceUnitBillingModelsV1 {
  const result: ServiceUnitBillingModelsV1 = {};
  for (const [service, protocols] of Object.entries(inferenceServiceFields(provider, provider.serviceUnitBillingModels ?? {}))) {
    for (const [protocol, model] of Object.entries(protocols)) {
      if (model?.version !== 1) throw new Error('New billing models cannot be advertised in legacy inference metadata');
      (result[service] ??= {})[protocol as keyof typeof protocols] = model;
    }
  }
  return result;
}
