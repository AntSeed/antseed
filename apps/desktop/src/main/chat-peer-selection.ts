export const ANTSEED_PEER_CUSTOM_TYPE = 'antseed:peer';

export type ChatPeerSelectionRequest = {
  conversationId?: string | null;
  peerId?: string | null;
};

export type NormalizedChatPeerSelectionRequest = {
  conversationId: string | null;
  peerId: string | null;
};

export type PersistedPeerBinding = {
  peerId: string;
  peerLabel?: string;
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
    };
  }

  return {
    conversationId: normalizeOptionalString(input.conversationId),
    peerId: normalizeOptionalString(input.peerId),
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
    return peerLabel ? { peerId, peerLabel } : { peerId };
  }

  return null;
}
