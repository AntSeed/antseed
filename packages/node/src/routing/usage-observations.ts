import { createHmac, randomUUID } from 'node:crypto';
import { MAX_ROUTING_USAGE_CONTEXT_BYTES, MAX_ROUTING_USAGE_OBSERVATIONS, validateRoutingUsageContext, type RoutingUsageContext, type RoutingUsageObservation } from '@antseed/protocol';
import type { ConversationIdentity } from './conversation-identity.js';

type Entry = { observation: Omit<RoutingUsageObservation, 'ageMs'>; completedAt: number };
type History = { secret: string; entries: Entry[]; truncated: boolean; touchedAt: number };

export class RoutingObservationHistory {
  private readonly conversations = new Map<string, History>();

  constructor(private readonly now = Date.now, private readonly capacity = 500, private readonly ttlMs = 30 * 60_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid routing observation bounds');
  }

  private key(conversation: ConversationIdentity): string {
    return JSON.stringify([conversation.tool, conversation.sessionKey, conversation.parentSessionKey]);
  }

  private history(conversation: ConversationIdentity): History {
    const now = this.now();
    for (const [key, history] of this.conversations) {
      if (now - history.touchedAt >= this.ttlMs) this.conversations.delete(key);
    }
    const key = this.key(conversation);
    const history = this.conversations.get(key) ?? { secret: randomUUID(), entries: [], truncated: false, touchedAt: now };
    const retained = history.entries.filter((entry) => now - entry.completedAt < this.ttlMs);
    if (retained.length !== history.entries.length) history.truncated = true;
    history.entries = retained;
    history.touchedAt = now;
    this.conversations.delete(key);
    this.conversations.set(key, history);
    while (this.conversations.size > this.capacity) this.conversations.delete(this.conversations.keys().next().value!);
    return history;
  }

  record(conversation: ConversationIdentity | null, offer: RoutingUsageObservation['offer'], usage: Pick<RoutingUsageObservation, 'inputTokens' | 'cachedInputTokens'>, requestId?: string): void {
    if (!conversation) return;
    const observation: Omit<RoutingUsageObservation, 'ageMs'> = { id: randomUUID(), offer: { ...offer, peerId: offer.peerId.toLowerCase() }, ...usage };
    try {
      validateRoutingUsageContext({ conversationRef: 'validation', usageObservations: [{ ...observation, ageMs: 0 }], historyTruncated: false });
    } catch { return; }
    const history = this.history(conversation);
    if (requestId !== undefined) {
      observation.id = createHmac('sha256', history.secret).update(JSON.stringify([requestId, observation.offer])).digest('hex');
      if (history.entries.some((entry) => entry.observation.id === observation.id)) return;
    }
    history.entries.push({ observation, completedAt: this.now() });
    if (history.entries.length > MAX_ROUTING_USAGE_OBSERVATIONS) {
      history.entries.shift();
      history.truncated = true;
    }
  }

  snapshot(conversation: ConversationIdentity | null, routerScope: string, offers: readonly RoutingUsageObservation['offer'][]): RoutingUsageContext | undefined {
    if (!conversation) return undefined;
    const history = this.history(conversation);
    const scopedId = (value: string) => createHmac('sha256', history.secret).update(JSON.stringify([routerScope, value])).digest('hex');
    const eligible = new Set(offers.map((offer) => JSON.stringify([offer.peerId.toLowerCase(), offer.provider, offer.serviceId])));
    const now = this.now();
    const context: RoutingUsageContext = {
      conversationRef: scopedId('conversation'),
      usageObservations: history.entries.filter(({ observation }) => eligible.has(JSON.stringify([observation.offer.peerId, observation.offer.provider, observation.offer.serviceId])))
        .map(({ observation, completedAt }) => ({ ...observation, offer: { ...observation.offer }, id: scopedId(observation.id), ageMs: Math.max(0, now - completedAt) })),
      historyTruncated: history.truncated,
    };
    while (Buffer.byteLength(JSON.stringify(context)) > MAX_ROUTING_USAGE_CONTEXT_BYTES && context.usageObservations.length) {
      context.usageObservations.shift();
      context.historyTruncated = true;
    }
    return context;
  }

  clear(): void {
    this.conversations.clear();
  }
}
