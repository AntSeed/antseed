import { areRouteRecommendationsEligible, type RouteRecommendation, type SerializedHttpResponse } from '@antseed/node';

export function parseRoutingResponse(response: SerializedHttpResponse, candidates: Parameters<typeof areRouteRecommendationsEligible>[1]): RouteRecommendation[] {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error('Routing service rejected the request');
  const value: unknown = JSON.parse(new TextDecoder().decode(response.body));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid routing response');
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || Object.keys(result).some((key) => !['version', 'recommendations', 'usage'].includes(key))
    || !areRouteRecommendationsEligible(result.recommendations, candidates)) throw new Error('Routing response must contain a nonempty ranked list of unique eligible recommendations');
  if (result.usage !== undefined) {
    if (!result.usage || typeof result.usage !== 'object' || Array.isArray(result.usage)) throw new Error('Invalid routing usage');
    const usage = result.usage as Record<string, unknown>;
    if (Object.keys(usage).some((key) => !['input_tokens', 'output_tokens', 'cached_input_tokens'].includes(key))) throw new Error('Invalid routing usage');
    for (const key of ['input_tokens', 'output_tokens', ...(usage.cached_input_tokens === undefined ? [] : ['cached_input_tokens'])]) {
      if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) throw new Error('Invalid routing usage');
    }
  }
  return structuredClone(result.recommendations);
}
