export type VprMenuBarAction =
  | { type: 'dismiss' }
  | { type: 'open-main' }
  | { type: 'open-chats' }
  | { type: 'open-floating-window' }
  | { type: 'open-deposit' }
  | { type: 'select-model'; provider: string; serviceId: string }
  | { type: 'pin-chat-model'; conversationId: string; provider: string; serviceId: string }
  | { type: 'open-chat-app'; conversationId: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeVprMenuBarAction(raw: unknown): VprMenuBarAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = raw as Record<string, unknown>;
  if (
    action.type === 'dismiss'
    || action.type === 'open-main'
    || action.type === 'open-chats'
    || action.type === 'open-floating-window'
    || action.type === 'open-deposit'
  ) {
    return { type: action.type };
  }
  if (
    action.type === 'select-model'
    && nonEmptyString(action.provider)
    && nonEmptyString(action.serviceId)
  ) {
    return { type: action.type, provider: action.provider, serviceId: action.serviceId };
  }
  if (
    action.type === 'pin-chat-model'
    && nonEmptyString(action.conversationId)
    && nonEmptyString(action.provider)
    && nonEmptyString(action.serviceId)
  ) {
    return {
      type: action.type,
      conversationId: action.conversationId,
      provider: action.provider,
      serviceId: action.serviceId,
    };
  }
  if (action.type === 'open-chat-app' && nonEmptyString(action.conversationId)) {
    return { type: action.type, conversationId: action.conversationId };
  }
  return null;
}
