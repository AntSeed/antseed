export const LEVANTO_ROUTING_CONTRACT = 'levanto-routing-v1';
export const LEVANTO_ROUTING_PATH = '/_antseed/levanto-route';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function peerId(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function validateRoutingRequest(contract: string, input: unknown): asserts input is Record<string, unknown> {
  if (contract !== LEVANTO_ROUTING_CONTRACT) throw new Error('Unsupported routing contract');
  if (!object(input) || input.v !== 1 || ![1, 3, 5, 7, 9].includes(input.cqt as number)
    || typeof input.inputMessage !== 'string' || !input.inputMessage.trim()
    || !Number.isSafeInteger(input.promptTokens) || (input.promptTokens as number) < 0
    || !Array.isArray(input.expectedCachedTokens) || !object(input.constraints)) {
    throw new Error('Invalid Levanto routing request');
  }
  if (Object.keys(input).some(key => !['v', 'cqt', 'inputMessage', 'promptTokens', 'expectedCachedTokens', 'constraints', 'service'].includes(key))) throw new Error('Unsupported routing request field');
  for (const entry of input.expectedCachedTokens) {
    if (!object(entry) || typeof entry.model !== 'string' || !entry.model || !peerId(entry.peer)
      || !Number.isSafeInteger(entry.tokens) || (entry.tokens as number) < 0) throw new Error('Invalid cached-token estimate');
  }
  for (const key of ['maxInputUsdPerMillion', 'minTrustScore']) {
    if (input.constraints[key] !== undefined && !nonnegative(input.constraints[key])) throw new Error(`Invalid constraint ${key}`);
  }
  for (const key of ['allowedPeerIds', 'blockedPeerIds']) {
    const values = input.constraints[key];
    if (values !== undefined && (!Array.isArray(values) || !values.every(peerId))) throw new Error(`Invalid constraint ${key}`);
  }
}

export function validateRoutingResponse(contract: string, input: unknown, request: unknown): Array<{ model: string; peer: string }> {
  validateRoutingRequest(contract, request);
  if (!object(input) || input.v !== 1 || input.error !== undefined || input.renewalDue !== undefined
    || typeof input.router !== 'string' || !input.router || !Array.isArray(input.ranked) || !input.ranked.length || input.ranked.length > 512) {
    throw new Error('Invalid Levanto routing response; per-response backend required');
  }
  const constraints = request.constraints as Record<string, unknown>;
  const accepted: Array<{ model: string; peer: string }> = [];
  for (const entry of input.ranked) {
    if (!object(entry) || typeof entry.model !== 'string' || !entry.model || !peerId(entry.peer) || entry.inference !== undefined
      || !object(entry.estimate) || !object(entry.price)
      || !['costUsd', 'inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => nonnegative(entry.estimate && (entry.estimate as Record<string, unknown>)[key]))
      || !['inUsdPerM', 'outUsdPerM', 'cachedInUsdPerM'].every(key => nonnegative(entry.price && (entry.price as Record<string, unknown>)[key]))) {
      continue;
    }
    if ((Array.isArray(constraints.allowedPeerIds) && constraints.allowedPeerIds.length > 0 && !constraints.allowedPeerIds.includes(entry.peer))
      || (Array.isArray(constraints.blockedPeerIds) && constraints.blockedPeerIds.includes(entry.peer))
      || (typeof constraints.maxInputUsdPerMillion === 'number' && (entry.price.inUsdPerM as number) > constraints.maxInputUsdPerMillion)) {
      continue;
    }
    accepted.push({ model: entry.model as string, peer: entry.peer as string });
  }
  if (!accepted.length) throw new Error('No valid recommendations satisfy routing constraints');
  return accepted;
}
