import { areRouteRecommendationsEligible, isRouteRecommendationEligible, type Router, type SerializedHttpResponse } from '@antseed/node';
import { parseRoutingResponse } from './routing-response.js';

export const selectNetworkRoute: NonNullable<Router['selectRoute']> = async (request, _peers, _conversation, _preferences, _defaultRoute, context) => {
  if (!context?.networkRouting || !context.invokeService) throw new Error('Select a structured network routing service');
  context.signal.throwIfAborted();
  const candidates = structuredClone(context.candidates ?? []);
  if (!candidates.length) throw new Error('No eligible routing candidates');
  const previous = context.routing?.previousRoutes ?? (context.routing?.previousRoute ? [context.routing.previousRoute] : []);
  const reusable = previous.filter((recommendation) => isRouteRecommendationEligible(recommendation, candidates));
  if (context.routing?.shouldRoute === false && areRouteRecommendationsEligible(reusable, candidates)) return structuredClone(reusable);
  const body: unknown = JSON.parse(new TextDecoder().decode(request.body));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Routing requires a structured request body');
  const parseResponse = (response: SerializedHttpResponse) => parseRoutingResponse(response, candidates);
  const response = await context.invokeService({
    version: 1,
    service: context.networkRouting.serviceId,
    preferencesSchemaHash: context.networkRouting.metadata.preferencesSchemaHash,
    request: { path: request.path, body: body as import('@antseed/node').RoutingPreferences },
    candidates,
    preferences: structuredClone(context.networkRouting.preferences),
    ...(context.usageContext ? { context: structuredClone(context.usageContext) } : {}),
  }, parseResponse);
  context.signal.throwIfAborted();
  return parseResponse(response);
};
