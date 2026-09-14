import type { PeerInfo, RouteCandidate } from '@antseed/node';

/**
 * The new-user-message gate and the pinned decision it gates on, plus the
 * cached-token estimator's per-(model,peer) state -- both keyed per
 * conversation.
 */

export interface PinnedDecision {
  peer: PeerInfo;
  peerId: string;
  serviceId: string;
  reputation: number;
  hasCachedInputPricing: boolean;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
  /**
   * Carried over from the real decision that produced this candidate (null
   * for a synthesized allowedPeerIds fallback with no real Sage prediction)
   * -- a later pinned/reused tool-loop continuation reuses these exact
   * fields to write its own ledger row, rather than requiring a full
   * independent prediction it has no network call to derive one from.
   */
  predictedCostUsd: number | null;
  predictedInputTokens: number | null;
  predictedCachedInputTokens: number | null;
  predictedOutputTokens: number | null;
  /** The CQT dial value in effect when this decision was made -- always known, even for a fallback. */
  cqt: number;
  /** Same value across every candidate from one response, reused as-is by a later pinned dispatch. */
  baselinePrices: Record<string, { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null }>;
}

interface CacheObservation {
  /** cachedInputTokens / promptTokens from the last turn against this (model, peer), EMA'd. */
  observedRatio: number;
  previousPromptTokens: number;
  lastObservedAtMs: number;
}

interface ConversationEntry {
  pinned: PinnedDecision | null;
  /** (model, peer) key -> cache observation, for the per-candidate expectedCachedTokens estimator below. */
  cacheByModelPeer: Map<string, CacheObservation>;
}

/** Flat timeout -- not per-provider, not learned. */
const CACHE_DECAY_MS = 3 * 60 * 1000;

/** EMA smoothing for the observed cache ratio. */
const CACHE_RATIO_EMA_ALPHA = 0.5;

/** Flat cap on distinct conversations retained at once -- least-recently-routed is evicted first. */
const MAX_CONVERSATIONS = 500;

function modelPeerKey(model: string, peerId: string): string {
  return `${model}::${peerId}`;
}

export class ConversationState {
  private readonly entries = new Map<string, ConversationEntry>();

  private getOrCreate(key: string): ConversationEntry {
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    if (this.entries.size >= MAX_CONVERSATIONS) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    entry = { pinned: null, cacheByModelPeer: new Map() };
    this.entries.set(key, entry);
    return entry;
  }

  /** Read the pinned decision from the last routing call, for a tool-loop continuation. */
  getPinned(key: string): PinnedDecision | null {
    return this.entries.get(key)?.pinned ?? null;
  }

  /** Record a fresh routing decision -- called after a real (non-gated) selectRoute call. */
  recordDecision(key: string, pinned: PinnedDecision): void {
    const entry = this.getOrCreate(key);
    entry.pinned = pinned;
  }

  /**
   * Observed cache ratio for a candidate that's been used in this
   * conversation before -- the "warmth" estimator. Call after a response
   * completes.
   */
  recordObservedCache(key: string, model: string, peerId: string, promptTokens: number, cachedInputTokens: number, now = Date.now()): void {
    if (promptTokens <= 0) return;
    const entry = this.getOrCreate(key);
    const ratio = Math.max(0, Math.min(1, cachedInputTokens / promptTokens));
    const mpKey = modelPeerKey(model, peerId);
    const prev = entry.cacheByModelPeer.get(mpKey);
    const smoothed = prev ? prev.observedRatio * (1 - CACHE_RATIO_EMA_ALPHA) + ratio * CACHE_RATIO_EMA_ALPHA : ratio;
    entry.cacheByModelPeer.set(mpKey, { observedRatio: smoothed, previousPromptTokens: promptTokens, lastObservedAtMs: now });
  }

  /**
   * Expected cached tokens for one candidate: zero for a candidate never
   * used in this conversation (correct, not a limitation -- it holds none
   * of the prefix), decayed to zero after CACHE_DECAY_MS.
   */
  expectedCachedTokens(key: string, model: string, peerId: string, currentPromptTokens: number, now = Date.now()): number {
    const entry = this.entries.get(key);
    const obs = entry?.cacheByModelPeer.get(modelPeerKey(model, peerId));
    if (!obs) return 0;
    if (now - obs.lastObservedAtMs > CACHE_DECAY_MS) return 0;
    return Math.min(obs.previousPromptTokens * obs.observedRatio, currentPromptTokens);
  }

  /** All (model, peerId) pairs this conversation has observed cache data for -- for building expectedCachedTokens. */
  observedModelPeers(key: string): Array<{ model: string; peerId: string }> {
    const entry = this.entries.get(key);
    if (!entry) return [];
    return [...entry.cacheByModelPeer.keys()].map((mpKey) => {
      const [model, peerId] = mpKey.split('::');
      return { model: model ?? '', peerId: peerId ?? '' };
    });
  }
}

export function pinnedToRouteCandidate(pinned: PinnedDecision, request: RouteCandidate['request']): RouteCandidate {
  return {
    peer: pinned.peer,
    peerId: pinned.peerId,
    serviceId: pinned.serviceId,
    request,
    reputation: pinned.reputation,
    hasCachedInputPricing: pinned.hasCachedInputPricing,
    inputUsdPerMillion: pinned.inputUsdPerMillion,
    outputUsdPerMillion: pinned.outputUsdPerMillion,
    minImageUsdPerImage: pinned.minImageUsdPerImage,
  };
}
