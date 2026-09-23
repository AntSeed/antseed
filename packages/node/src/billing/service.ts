import type { Provider } from '../interfaces/seller-provider.js';
import type { ServiceBillingOffer } from '@antseed/protocol/service-billing';
import type { ServiceUnitBillingModelsV1 } from '@antseed/protocol/billing';
import { validateUnitBillingModel } from '@antseed/protocol/billing';

export function completedRequestOffer(provider: Provider, service: string): ServiceBillingOffer | undefined {
  const billingModels = provider.serviceUnitBillingModels?.[service];
  const models = Object.values(billingModels ?? {});
  const model = models.find(candidate => candidate?.version === 2);
  if (!model) return undefined;
  const errors = validateUnitBillingModel(model);
  const execution = provider.serviceExecution?.[service];
  if (errors.length || !execution) throw new Error(errors.join('; ') || 'Completed-request billing requires a service execution contract');
  if (models.some(candidate => candidate?.version !== 2 || validateUnitBillingModel(candidate).length > 0
    || candidate.components[0]?.priceMicroUsdc !== model.components[0]!.priceMicroUsdc)
    || provider.serviceApiProtocols?.[service]?.some(protocol => billingModels?.[protocol]?.version !== 2)) {
    throw new Error('Completed-request services require the same unit price across their API protocols');
  }
  return { provider: provider.name, service, contract: execution.contract, priceMicroUsdc: model.components[0]!.priceMicroUsdc };
}

export function inferenceServiceFields<Value>(provider: Provider, fields: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(fields).filter(([service]) => !provider.serviceExecution?.[service]));
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
