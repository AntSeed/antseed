import { createHash } from 'node:crypto';
import type { ConversationIdentity } from './conversation-identity.js';
import type { SerializedHttpRequest } from '../types/http.js';
import type { RouteRecommendation } from '../interfaces/buyer-router.js';

export type RoutingTrigger = 'request' | 'new-session' | 'new-turn' | 'route-unavailable' | 'continuation';
export type RouteReference = RouteRecommendation;
export type RoutingRequestContext = {
  trigger: RoutingTrigger;
  shouldRoute: boolean;
  previousRoute: RouteReference | null;
  previousRoutes?: RouteRecommendation[];
};

type Snapshot = {
  requestId: string;
  userTextHash: string;
  routes: RouteRecommendation[];
  atMs: number;
};

function latestUserText(body: Record<string, unknown>): string | null {
  if (typeof body.input === 'string') return body.input;
  const messages: unknown[] | null = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : null;
  if (!messages) return null;
  for (const value of [...messages].reverse()) {
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content) || message.content.length === 0) return null;
    const text = message.content.filter((part: unknown): part is { text: string } => !!part && typeof part === 'object'
      && ['text', 'input_text'].includes((part as Record<string, unknown>).type as string)
      && typeof (part as Record<string, unknown>).text === 'string').map((part) => part.text);
    if (text.length) return text.join('\n');
    if (!message.content.every((part: unknown) => !!part && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'tool_result')) return null;
  }
  return null;
}

export class RoutingContextTracker {
  private readonly sessions = new Map<string, Snapshot>();

  constructor(private readonly now = Date.now, private readonly ttlMs = 30 * 60_000, private readonly capacity = 500) {}

  private key(conversation: ConversationIdentity): string {
    return JSON.stringify([conversation.tool, conversation.sessionKey, conversation.parentSessionKey]);
  }

  observe(request: SerializedHttpRequest, conversation: ConversationIdentity | null, options: {
    isRouteAvailable?: (route: RouteReference) => boolean;
  } = {}): RoutingRequestContext {
    const base: RoutingRequestContext = { trigger: 'request', shouldRoute: true, previousRoute: null };
    if (!conversation) return base;
    const untracked = () => { this.sessions.delete(this.key(conversation)); return base; };
    let body: Record<string, unknown>;
    try { body = JSON.parse(new TextDecoder().decode(request.body)); } catch { return untracked(); }
    if (!body || typeof body !== 'object') return untracked();
    const userText = latestUserText(body);
    if (userText === null) return untracked();
    const now = this.now();
    for (const [key, entry] of this.sessions) if (now - entry.atMs >= this.ttlMs) this.sessions.delete(key);
    const key = this.key(conversation);
    const previous = this.sessions.get(key);
    const snapshot: Snapshot = { requestId: request.requestId,
      userTextHash: createHash('sha256').update(userText).digest('hex'), routes: previous?.routes ?? [], atMs: now };
    snapshot.routes = snapshot.routes.filter((route) => options.isRouteAvailable?.(route) ?? true);
    const available = snapshot.routes.length > 0;
    const trigger: RoutingTrigger = !previous ? 'new-session'
      : !available ? 'route-unavailable'
      : snapshot.userTextHash !== previous.userTextHash ? 'new-turn'
      : 'continuation';
    this.sessions.delete(key);
    this.sessions.set(key, snapshot);
    while (this.sessions.size > this.capacity) this.sessions.delete(this.sessions.keys().next().value!);
    const shouldRoute = trigger !== 'continuation';
    const previousRoutes = snapshot.routes.map((route) => ({ ...route }));
    const previousRoute = previousRoutes[0] ?? null;
    if (shouldRoute) snapshot.routes = [];
    return { trigger, shouldRoute, previousRoute, previousRoutes };
  }

  recordRoute(conversation: ConversationIdentity | null, requestId: string, route: RouteReference | null): void {
    this.recordRoutes(conversation, requestId, route ? [route] : []);
  }

  recordRoutes(conversation: ConversationIdentity | null, requestId: string, routes: readonly RouteRecommendation[]): void {
    if (!conversation) return;
    const entry = this.sessions.get(this.key(conversation));
    if (entry?.requestId === requestId) {
      entry.routes = routes.map((route) => ({ serviceId: route.serviceId,
        ...(route.peerId === undefined ? {} : { peerId: route.peerId }) }));
    }
  }

  forgetConversation(tool: string, sessionKey: string): void {
    for (const key of this.sessions.keys()) {
      const [storedTool, storedSession, storedParent] = JSON.parse(key) as Array<string | null>;
      if (storedTool === tool && (storedSession === sessionKey || storedParent === sessionKey)) this.sessions.delete(key);
    }
  }
}
