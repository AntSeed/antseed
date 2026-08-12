export const ANTSEED_PEER_CUSTOM_TYPE = 'antseed:peer';

export type ChatPeerSelectionRequest = {
  conversationId?: string | null;
  peerId?: string | null;
  /** When the selection also switches the model, the new binding is persisted
      on the conversation so list refreshes don't revert it. */
  service?: string | null;
  provider?: string | null;
  routeMode?: ChatRouteMode | null;
};

export type NormalizedChatPeerSelectionRequest = {
  conversationId: string | null;
  peerId: string | null;
  service: string | null;
  provider: string | null;
  routeMode: ChatRouteMode | null;
};

/**
 * How a conversation's peer was chosen.
 *
 * `pinned` means the user picked this peer explicitly and it must never be
 * changed for them. `auto` means routing chose it, so it may be re-resolved if
 * the peer stops responding. Threads written before this field existed resolve
 * to `undefined` and are treated as `auto` by callers: pinning is an explicit
 * act, and failover only ever runs after a failure, where moving beats erroring.
 */
export type ChatRouteMode = 'auto' | 'pinned';

export type PersistedPeerBinding = {
  peerId: string;
  peerLabel?: string;
  routeMode?: ChatRouteMode;
};

type PersistedPeerSelectionEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeChatPeerSelectionRequest(
  input: ChatPeerSelectionRequest | string | null,
): NormalizedChatPeerSelectionRequest {
  if (typeof input === 'string' || input === null) {
    return {
      conversationId: null,
      peerId: normalizeOptionalString(input),
      service: null,
      provider: null,
      routeMode: null,
    };
  }

  return {
    conversationId: normalizeOptionalString(input.conversationId),
    peerId: normalizeOptionalString(input.peerId),
    service: normalizeOptionalString(input.service),
    provider: normalizeOptionalString(input.provider),
    routeMode: input.routeMode === 'auto' || input.routeMode === 'pinned' ? input.routeMode : null,
  };
}

export function resolveLatestPeerBinding(
  entries: PersistedPeerSelectionEntry[],
): PersistedPeerBinding | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.type !== 'custom' || entry.customType !== ANTSEED_PEER_CUSTOM_TYPE) {
      continue;
    }

    const data = entry.data as Record<string, unknown> | undefined;
    const peerId = normalizeOptionalString(data?.peerId);
    if (!peerId) {
      return null;
    }

    const peerLabel = normalizeOptionalString(data?.peerLabel) ?? undefined;
    const rawMode = data?.routeMode;
    const routeMode: ChatRouteMode | undefined =
      rawMode === 'auto' || rawMode === 'pinned' ? rawMode : undefined;
    return {
      peerId,
      ...(peerLabel ? { peerLabel } : {}),
      ...(routeMode ? { routeMode } : {}),
    };
  }

  return null;
}
