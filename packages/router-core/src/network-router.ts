import { isRouteRecommendationEligible, type Router, type RouteRecommendation, type SerializedHttpResponse } from '@antseed/node';

export function parseRoutingResponse(response: SerializedHttpResponse, candidates: readonly { serviceId: string; peerId: string }[]): RouteRecommendation[] {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Routing service rejected the request');
  const value: unknown = JSON.parse(new TextDecoder().decode(response.body));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid routing response');
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || Object.keys(result).some((key) => !['version', 'recommendation', 'usage'].includes(key))
    || !isRouteRecommendationEligible(result.recommendation, candidates)
    || Object.keys(result.recommendation).some((key) => !['serviceId', 'peerId'].includes(key))) throw new Error('Routing response must contain one eligible recommendation');
  if (result.usage !== undefined) {
    if (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)) throw new Error('Invalid routing usage');
    const usage = result.usage as Record<string, unknown>;
    if (Object.keys(usage).some((key) => !['input_tokens', 'output_tokens', 'cached_input_tokens'].includes(key))) throw new Error('Invalid routing usage');
    for (const key of ['input_tokens', 'output_tokens', ...(usage.cached_input_tokens === undefined ? [] : ['cached_input_tokens'])]) {
      if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) throw new Error('Invalid routing usage');
    }
  }
  return [{ ...result.recommendation }];
}

export const selectNetworkRoute: NonNullable<Router['selectRoute']> = async (request, _peers, _conversation, _preferences, _defaultRoute, context) => {
  if (!context?.networkRouting || !context.invokeService) throw new Error('Select a structured network routing service');
  context.signal.throwIfAborted();
  const candidates = structuredClone(context.candidates ?? []);
  if (!candidates.length) throw new Error('No eligible routing candidates');
  const previous = context.routing?.previousRoute;
  if (context.routing?.shouldRoute === false && previous && isRouteRecommendationEligible(previous, candidates)) return [previous];
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
  }, parseResponse);
  context.signal.throwIfAborted();
  return parseResponse(response);
};
