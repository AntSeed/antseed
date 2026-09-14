import { createHash } from 'node:crypto';
import type { ConversationIdentity } from './conversation-identity.js';
import type { SerializedHttpRequest } from '../types/http.js';

export type RoutingCadence = 'request' | 'turn' | 'session';
export type RoutingTrigger = 'request' | 'new-session' | 'new-turn' | 'context-rewrite' | 'explicit' | 'route-unavailable' | 'settings-changed' | 'continuation';
export type RouteReference = { peerId: string; serviceId: string };
export type RoutingRequestContext = {
  trigger: RoutingTrigger;
  shouldRoute: boolean;
  contextRewritten: boolean;
  cacheState: 'unknown';
  turnId: string | null;
  previousRoute: RouteReference | null;
};

type Snapshot = {
  requestId: string;
  count: number;
  users: number;
  prefix: string;
  system: string;
  settings: string;
  turnId: string | null;
  revision: string | null;
  route: RouteReference | null;
  atMs: number;
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function userMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.role !== 'user') return false;
  return !Array.isArray(message.content) || message.content.some((part: unknown) => !part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'tool_result');
}

export class RoutingContextTracker {
  private readonly sessions = new Map<string, Snapshot>();

  constructor(private readonly now = Date.now, private readonly ttlMs = 30 * 60_000, private readonly capacity = 500) {}

  private key(conversation: ConversationIdentity): string {
    return JSON.stringify([conversation.tool, conversation.sessionKey, conversation.parentSessionKey]);
  }

  observe(request: SerializedHttpRequest, conversation: ConversationIdentity | null, options: {
    cadence?: RoutingCadence;
    settings?: unknown;
    isRouteAvailable?: (route: RouteReference) => boolean;
  } = {}): RoutingRequestContext {
    const base: RoutingRequestContext = { trigger: 'request', shouldRoute: true, contextRewritten: false, cacheState: 'unknown', turnId: null, previousRoute: null };
    if (!conversation) return base;
    const untracked = () => { this.sessions.delete(this.key(conversation)); return base; };
    let body: Record<string, unknown>;
    try { body = JSON.parse(new TextDecoder().decode(request.body)); } catch { return untracked(); }
    if (!body || typeof body !== 'object' || body.previous_response_id) return untracked();
    const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
    if (!messages) return untracked();
    const now = this.now();
    for (const [key, entry] of this.sessions) if (now - entry.atMs >= this.ttlMs) this.sessions.delete(key);
    const key = this.key(conversation);
    const previous = this.sessions.get(key);
    const hint = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
    };
    const snapshot: Snapshot = { requestId: request.requestId, count: messages.length, users: messages.filter(userMessage).length,
      prefix: hash(messages), system: hash([body.system ?? null, body.instructions ?? null, body.tools ?? null]),
      settings: hash([body.model ?? null, options.settings ?? null]), turnId: hint('x-antseed-turn-id'),
      revision: hint('x-antseed-context-revision'), route: previous?.route ?? null, atMs: now };
    const rewritten = !!previous && (snapshot.count < previous.count || hash(messages.slice(0, previous.count)) !== previous.prefix
      || snapshot.system !== previous.system || snapshot.revision !== previous.revision);
    const available = snapshot.route && (options.isRouteAvailable?.(snapshot.route) ?? true);
    if (!available) snapshot.route = null;
    const trigger: RoutingTrigger = hint('x-antseed-route-refresh') === 'true' ? 'explicit'
      : !previous ? 'new-session'
      : snapshot.settings !== previous.settings ? 'settings-changed'
      : rewritten ? 'context-rewrite'
      : !available ? 'route-unavailable'
      : (snapshot.turnId !== previous.turnId || snapshot.users > previous.users) ? 'new-turn'
      : 'continuation';
    this.sessions.delete(key);
    this.sessions.set(key, snapshot);
    while (this.sessions.size > this.capacity) this.sessions.delete(this.sessions.keys().next().value!);
    const cadence = options.cadence ?? 'request';
    const shouldRoute = cadence === 'request' || !['continuation', 'new-turn'].includes(trigger)
      || (cadence === 'turn' && trigger === 'new-turn');
    const previousRoute = snapshot.route ? { ...snapshot.route } : null;
    if (shouldRoute) snapshot.route = null;
    return { trigger, shouldRoute, contextRewritten: rewritten, cacheState: 'unknown',
      turnId: snapshot.turnId, previousRoute };
  }

  recordRoute(conversation: ConversationIdentity | null, requestId: string, route: RouteReference | null): void {
    if (!conversation) return;
    const entry = this.sessions.get(this.key(conversation));
    if (entry?.requestId === requestId) entry.route = route ? { peerId: route.peerId, serviceId: route.serviceId } : null;
  }
}
