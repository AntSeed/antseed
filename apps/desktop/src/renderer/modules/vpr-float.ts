import type { RendererUiState } from '../core/state';
import { formatCompactTokens } from '../core/format';
import { notifyUiStateChanged } from '../core/store';
import type {
  BuyerConversationSummary,
  DesktopBridge,
  DesktopPaymentChannelSummary,
  SystemProxyProfileSummary,
  VprFloatConversation,
  VprFloatData,
  VprFloatModel,
} from '../types/bridge';
import { loadFavoriteModels } from './vpr-favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from './vpr-recommended-models';
import { chooseBestVprRoute } from './vpr-routing';
import { routesForSelectedModel } from './vpr-view-models';
import { activeProfilesFromRuntimeState } from './vpr-tools';

const FLOAT_UPDATE_INTERVAL_MS = 3_000;
/** Chat rows the pill's dropdown shows (buyer stores more). */
const FLOAT_CONVERSATION_LIMIT = 8;
/** How long after the last traffic log line the pulse stays considered live. */
const TRAFFIC_HOLD_MS = 1_500;
/** How long after the buyer's last-activity timestamp traffic reads as live.
    Longer than the poll interval so a stream that pauses briefly between
    frames (or finishes mid-interval) doesn't flicker the pill dark. */
const BUYER_ACTIVITY_HOLD_MS = 4_000;
/** Coalesce burst of completion lines into one forced usage refresh. */
const COMPLETION_REFRESH_DEBOUNCE_MS = 400;
/** How long after a chat's last request its row keeps the green pulse. The
    buyer stamps lastActiveAt per dispatched request, so this must outlast
    the gap between an agent tool's consecutive calls (and the 3s payload
    cadence) or the pulse would flicker mid-conversation. */
const CONVERSATION_ACTIVE_HOLD_MS = 10_000;

export type VprFloatModule = {
  openFloat: (profileName?: string) => Promise<void>;
  closeFloat: () => Promise<void>;
};

/**
 * Main-window side of the detachable pill window: builds the display payload
 * (connected apps, model catalog, buyer usage) and keeps the pill fed while
 * it's open. Model changes made in the pill come back as 'select-model'
 * actions.
 */
export function initVprFloatModule({ bridge, uiState, onSelectModel, refreshUsage }: {
  bridge: DesktopBridge | undefined;
  uiState: RendererUiState;
  onSelectModel: (provider: string, serviceId: string) => void;
  /** Refresh the payments summary; force bypasses its self-throttle. */
  refreshUsage: (force?: boolean) => Promise<void>;
}): VprFloatModule {
  let timer: number | null = null;
  let profiles: SystemProxyProfileSummary[] = [];
  let selectedApp = '';
  let lastBuyerRequestTotal: number | null = null;

  async function ensureProfiles(): Promise<void> {
    if (profiles.length > 0) return;
    try {
      profiles = (await bridge?.systemProxyListProfiles?.()) ?? [];
    } catch {
      profiles = [];
    }
  }

  /** The same curated list as the Home model dropdown: starred favorites
      first, then the recommended lineup (frontier + free models), with the
      current selection always present so the active model never disappears
      from its own switcher. */
  function floatModels(): { models: VprFloatModel[]; favoriteKeys: string[] } {
    const selection = uiState.vprRouteSelection.model;
    const favorites = loadFavoriteModels();
    const favoriteEntries = selectFavoriteVprCatalog(uiState.vprModelCatalog, favorites);
    const recommended = selectRecommendedVprCatalog(uiState.vprModelCatalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)));
    const models = [...favoriteEntries, ...recommended];
    if (
      selection &&
      !models.some((entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId)
    ) {
      const selected = uiState.vprModelCatalog.find(
        (entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId,
      );
      if (selected) models.unshift(selected);
    }
    return { models, favoriteKeys: [...favorites] };
  }

  function formatMicroUsdc(spentMicroUsdc: bigint): string {
    const dollars = Number(spentMicroUsdc) / 1e6;
    return dollars > 0 && dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
  }

  /** The payment channel currently carrying the selected model's route. */
  function routeChannel(): DesktopPaymentChannelSummary | null {
    const selection = uiState.vprRouteSelection;
    if (!selection.model) return null;
    const routes = routesForSelectedModel(uiState.discoverRows, selection.model);
    const peerId = selection.mode === 'pinned-peer' && selection.peerId
      ? selection.peerId
      : chooseBestVprRoute(routes, uiState.vprRoutingPreferences)?.peerId ?? null;
    if (!peerId) return null;
    const candidates = uiState.creditsChannels.filter((channel) => channel.peerId === peerId);
    if (candidates.length === 0) return null;
    const active = candidates.filter((channel) => channel.status === 'active');
    const pool = active.length > 0 ? active : candidates;
    return pool.reduce((latest, channel) => (channel.reservedAt > latest.reservedAt ? channel : latest));
  }

  /**
   * Usage line: the selected model's current route channel when one exists,
   * otherwise buyer-wide totals.
   */
  function usageLabel(): string {
    const channel = routeChannel();
    if (channel) {
      const parts = [`${formatCompactTokens(channel.inputTokens, channel.outputTokens)} tok`];
      try {
        const spent = BigInt(channel.cumulativeSigned);
        if (spent > 0n) parts.push(formatMicroUsdc(spent));
      } catch { /* malformed row — token count only */ }
      return parts.join(' · ');
    }

    const usage = uiState.creditsBuyerUsage;
    const parts: string[] = [];
    if (usage) {
      parts.push(`${formatCompactTokens(usage.totalInputTokens, usage.totalOutputTokens)} tok`);
    }
    let spentMicroUsdc = 0n;
    for (const row of uiState.creditsChannels) {
      try {
        spentMicroUsdc += BigInt(row.cumulativeSigned);
      } catch { /* malformed row — skip */ }
    }
    if (spentMicroUsdc > 0n) {
      parts.push(formatMicroUsdc(spentMicroUsdc));
    }
    return parts.join(' · ');
  }

  /** Log markers for a model request actually being transferred.
      `[ProxyMux] send/recv` frame lines are the ground truth — they fire per
      DataChannel frame including streaming chunks — but are only emitted
      with debug logging on, so the buyer dispatch/response markers and the
      system proxy's `| source:` forwards back them up. Deliberately narrow:
      control-plane polls (`GET /_antseed/...`, `GET /v1/models`) and CONNECT
      tunnels (any app HTTPS traffic — telemetry, update checks) must not
      pulse. */
  const TRAFFIC_LINE_PATTERN = /\[ProxyMux\] (?:send|recv) |POST \/v1\/|Routing to peer |Response: \d{3} \(|\| source:/;

  /** Markers for a response finishing — trigger an immediate usage refresh. */
  const COMPLETION_LINE_PATTERN = /Response: \d{3} \(|\[ProxyMux\] recv response|from buyer proxy/;

  // Event-driven traffic signal (same pattern as the chat walking ant):
  // every log line is inspected as it arrives via bridge.onLog, so the pulse
  // lights the moment traffic moves instead of waiting for a poll tick.
  let lastTrafficLineAt = 0;
  let completionRefreshTimer: number | null = null;

  function logTrafficActive(): boolean {
    return Date.now() - lastTrafficLineAt < TRAFFIC_HOLD_MS;
  }

  function scheduleCompletionRefresh(): void {
    if (completionRefreshTimer !== null) return;
    completionRefreshTimer = window.setTimeout(() => {
      completionRefreshTimer = null;
      void refreshUsage(true)
        .then(() => buildData())
        .then((data) => bridge?.vprFloatUpdate?.(data));
    }, COMPLETION_REFRESH_DEBOUNCE_MS);
  }

  bridge?.onLog?.((event) => {
    if (!uiState.vprFloatOpen) return;
    if (event.mode !== 'connect' && event.mode !== 'system-proxy') return;
    const line = event.line.replace(/\x1b\[[0-9;]*m/g, '');
    if (line.includes('cors preflight') || !TRAFFIC_LINE_PATTERN.test(line)) return;

    const wasActive = logTrafficActive();
    lastTrafficLineAt = Date.now();
    if (!wasActive) {
      // Idle -> active transition: light the pulse right away.
      void buildData().then((data) => bridge?.vprFloatUpdate?.(data));
    }
    if (COMPLETION_LINE_PATTERN.test(line)) {
      scheduleCompletionRefresh();
    }
  });

  /**
   * Live traffic through the buyer proxy (chat and direct API clients as
   * well as system-proxy forwards). Primary signal is the buyer's
   * `lastActivityAt` timestamp — stamped per dispatch and per streamed frame,
   * independent of debug logging — so config-patch tools (Codex, OpenCode,
   * pi) that talk straight to the buyer light up even with logs off, and
   * stay lit mid-stream. Falls back to the request-total delta for older
   * buyers that don't report the timestamp.
   */
  async function buyerProxyTraffic(): Promise<{ active: boolean; completed: boolean }> {
    try {
      const result = await bridge?.paymentsGetBuyerUsage?.();
      if (!result?.ok) return { active: false, completed: false };

      // A metered request finished since the last tick — drives the forced
      // usage refresh (kept infrequent: only on completion, not per frame).
      const total = result.data?.totalRequests ?? null;
      let completed = false;
      if (total !== null) {
        const previous = lastBuyerRequestTotal;
        lastBuyerRequestTotal = total;
        completed = previous !== null && total > previous;
      }

      // Green signal: recent per-frame activity when the buyer reports it,
      // otherwise fall back to the completion delta for older buyers.
      const lastActivityAt = result.lastActivityAt ?? null;
      const active = lastActivityAt !== null
        ? Date.now() - lastActivityAt < BUYER_ACTIVITY_HOLD_MS
        : completed;

      return { active, completed };
    } catch {
      return { active: false, completed: false };
    }
  }

  // Set while recent buyer activity keeps the pulse alive between the
  // event-driven log signal's holds (detached daemons without log streaming).
  let buyerDeltaActive = false;

  function floatConversation(record: BuyerConversationSummary): VprFloatConversation {
    const pinnedServiceId = record.pinnedModel?.split('@').slice(1).join('@') || null;
    return {
      id: record.id,
      tool: record.tool,
      title: record.label || record.snippet || record.sessionKey.slice(0, 12),
      pinnedServiceId,
      lastActiveAt: record.lastActiveAt,
      active: Date.now() - record.lastActiveAt < CONVERSATION_ACTIVE_HOLD_MS,
    };
  }

  async function loadConversations(): Promise<VprFloatConversation[]> {
    try {
      const records = (await bridge?.buyerConversationsList?.()) ?? [];
      return records.slice(0, FLOAT_CONVERSATION_LIMIT).map(floatConversation);
    } catch {
      return [];
    }
  }

  /** Best route peer for a model, mirroring how the global selection routes. */
  function resolvePinRoute(provider: string, serviceId: string): string | null {
    const routes = routesForSelectedModel(uiState.discoverRows, { provider, serviceId });
    const peerId = chooseBestVprRoute(routes, uiState.vprRoutingPreferences)?.peerId ?? null;
    return peerId ? `${peerId}@${serviceId}` : null;
  }

  async function buildData(): Promise<VprFloatData> {
    await ensureProfiles();
    let connected: SystemProxyProfileSummary[] = [];
    try {
      const state = (await bridge?.systemProxyGetState?.()) ?? null;
      const active = activeProfilesFromRuntimeState(state);
      connected = profiles.filter((profile) => active?.has(profile.name) ?? false);
    } catch {
      connected = [];
    }
    if (!connected.some((profile) => profile.name === selectedApp)) {
      selectedApp = connected[0]?.name ?? '';
    }
    const selection = uiState.vprRouteSelection.model;
    const { models, favoriteKeys } = floatModels();

    return {
      apps: connected.map((profile) => ({ name: profile.name, displayName: profile.displayName })),
      selectedApp,
      models,
      favoriteKeys,
      selectedModel: selection ? { provider: selection.provider, serviceId: selection.serviceId } : null,
      conversations: await loadConversations(),
      usageLabel: usageLabel(),
      trafficActive: logTrafficActive() || buyerDeltaActive,
    };
  }

  async function tick(): Promise<void> {
    const { active, completed } = await buyerProxyTraffic();
    buyerDeltaActive = active;
    bridge?.vprFloatUpdate?.(await buildData());

    if (completed) {
      // A response was metered since the last tick — pull fresh channel
      // totals now instead of waiting out the summary throttle, then push
      // the updated token/cost numbers straight to the pill.
      await refreshUsage(true);
      bridge?.vprFloatUpdate?.(await buildData());
    } else {
      // Ambient keep-warm; the credits module's self-throttle absorbs it.
      void refreshUsage(false);
    }
  }

  function stopUpdater(): void {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function startUpdater(): void {
    if (timer !== null) return;
    timer = window.setInterval(() => { void tick(); }, FLOAT_UPDATE_INTERVAL_MS);
  }

  bridge?.onVprFloatClosed?.(() => {
    stopUpdater();
    if (uiState.vprFloatOpen) {
      uiState.vprFloatOpen = false;
      notifyUiStateChanged();
    }
  });

  bridge?.onVprFloatAction?.((action) => {
    if (typeof action !== 'object' || action === null) return;
    const type = (action as { type?: unknown }).type;
    if (type === 'select-model') {
      const { provider, serviceId } = action as { provider?: unknown; serviceId?: unknown };
      if (typeof provider === 'string' && typeof serviceId === 'string') {
        onSelectModel(provider, serviceId);
        // Push the new selection immediately instead of waiting for the tick.
        void buildData().then((data) => bridge?.vprFloatUpdate?.(data));
      }
      return;
    }
    // Pin one chat to a model: resolve the best peer for that model the same
    // way the global selection does, then hand the pin to the buyer.
    if (type === 'pin-chat-model') {
      const { conversationId, provider, serviceId } = action as { conversationId?: unknown; provider?: unknown; serviceId?: unknown };
      if (typeof conversationId !== 'string' || typeof provider !== 'string' || typeof serviceId !== 'string') return;
      const pin = resolvePinRoute(provider, serviceId);
      if (!pin) return;
      void bridge?.buyerConversationsUpdate?.({ id: conversationId, pinnedModel: pin })
        .then(() => buildData())
        .then((data) => bridge?.vprFloatUpdate?.(data));
      return;
    }
    if (type === 'clear-chat-pin') {
      const { conversationId } = action as { conversationId?: unknown };
      if (typeof conversationId !== 'string') return;
      void bridge?.buyerConversationsUpdate?.({ id: conversationId, pinnedModel: '' })
        .then(() => buildData())
        .then((data) => bridge?.vprFloatUpdate?.(data));
    }
  });

  // Survive a main-window reload while the pill is open (dev HMR, cmd+R).
  void bridge?.vprFloatIsOpen?.().then((open) => {
    if (!open) return;
    uiState.vprFloatOpen = true;
    notifyUiStateChanged();
    startUpdater();
  });

  return {
    async openFloat(profileName?: string) {
      if (profileName) selectedApp = profileName;
      // Fresh numbers on open — don't show a minute-old summary.
      await refreshUsage(true);
      const data = await buildData();
      await bridge?.vprFloatOpen?.(data);
      uiState.vprFloatOpen = true;
      notifyUiStateChanged();
      startUpdater();
    },
    async closeFloat() {
      await bridge?.vprFloatClose?.();
    },
  };
}
