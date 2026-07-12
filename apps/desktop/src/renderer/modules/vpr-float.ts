import type { RendererUiState } from '../core/state';
import { formatCompactTokens } from '../core/format';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge, DesktopPaymentChannelSummary, SystemProxyProfileSummary, VprFloatData, VprFloatModel } from '../types/bridge';
import { chooseBestVprRoute } from './vpr-routing';
import { routesForSelectedModel } from './vpr-view-models';
import { activeProfilesFromRuntimeState } from './vpr-tools';

const FLOAT_UPDATE_INTERVAL_MS = 3_000;
const FLOAT_MODEL_LIMIT = 50;
/** How long after the last traffic log line the pulse stays considered live. */
const TRAFFIC_HOLD_MS = 1_500;
/** Coalesce burst of completion lines into one forced usage refresh. */
const COMPLETION_REFRESH_DEBOUNCE_MS = 400;

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

  function floatModels(): VprFloatModel[] {
    const selection = uiState.vprRouteSelection.model;
    const byPopularity = [...uiState.vprModelCatalog].sort((a, b) => b.peerCount - a.peerCount);
    const models = byPopularity.slice(0, FLOAT_MODEL_LIMIT);
    if (
      selection &&
      !models.some((entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId)
    ) {
      const selected = byPopularity.find(
        (entry) => entry.provider === selection.provider && entry.serviceId === selection.serviceId,
      );
      if (selected) models.unshift(selected);
    }
    return models.map((entry) => ({
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
    }));
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
   * well as system-proxy forwards): the control-plane request total grew
   * since the previous tick. Backstops buyer daemons whose logs don't
   * stream into the desktop.
   */
  async function buyerProxyTrafficActive(): Promise<boolean> {
    try {
      const result = await bridge?.paymentsGetBuyerUsage?.();
      const total = result?.ok ? result.data?.totalRequests ?? null : null;
      if (total === null) return false;
      const previous = lastBuyerRequestTotal;
      lastBuyerRequestTotal = total;
      return previous !== null && total > previous;
    } catch {
      return false;
    }
  }

  // Set while a buyer request-total delta keeps the pulse alive between the
  // event-driven log signal's holds (detached daemons without log streaming).
  let buyerDeltaActive = false;

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

    return {
      apps: connected.map((profile) => ({ name: profile.name, displayName: profile.displayName })),
      selectedApp,
      models: floatModels(),
      selectedModel: selection ? { provider: selection.provider, serviceId: selection.serviceId } : null,
      usageLabel: usageLabel(),
      trafficActive: logTrafficActive() || buyerDeltaActive,
    };
  }

  async function tick(): Promise<void> {
    const responseCompleted = await buyerProxyTrafficActive();
    buyerDeltaActive = responseCompleted;
    bridge?.vprFloatUpdate?.(await buildData());

    if (responseCompleted) {
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
    if (
      typeof action === 'object' && action !== null &&
      (action as { type?: unknown }).type === 'select-model'
    ) {
      const { provider, serviceId } = action as { provider?: unknown; serviceId?: unknown };
      if (typeof provider === 'string' && typeof serviceId === 'string') {
        onSelectModel(provider, serviceId);
        // Push the new selection immediately instead of waiting for the tick.
        void buildData().then((data) => bridge?.vprFloatUpdate?.(data));
      }
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
