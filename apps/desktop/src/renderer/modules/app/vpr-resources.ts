import type {
  BuyerConversationSummary,
  InstalledAppEntry,
  RouterPluginInfo,
  RuntimeProcessState,
  SystemProxyProfileSummary,
} from '../../types/bridge';
import type { RoutingDecisionRow } from '@antseed/node';
import { createCachedResource } from './cached-resource';

const POLL_MS = 3_000;

export const buyerConversationsResource = createCachedResource<BuyerConversationSummary[]>({
  pollMs: POLL_MS,
  async load() {
    const conversations = await window.antseedDesktop?.buyerConversationsList?.();
    if (conversations === null || conversations === undefined) throw new Error('Buyer unavailable');
    return conversations;
  },
});

export type SystemProxySnapshot = {
  profiles: SystemProxyProfileSummary[];
  state: RuntimeProcessState | null;
};

export const systemProxyResource = createCachedResource<SystemProxySnapshot>({
  pollMs: POLL_MS,
  async load() {
    const bridge = window.antseedDesktop;
    const [profiles, state] = await Promise.all([
      bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
      bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
    ]);
    return { profiles, state };
  },
});

/**
 * routing_decisions local ledger, for VPR's savings dashboard -- shared by
 * VprHomeView and VprActivityView, same reasoning as the other resources
 * above. Empty (not an error) when the active router doesn't implement
 * getRoutingDecisions (e.g. the default router-local) or the buyer runtime
 * isn't up yet -- see chat:ai-list-routing-decisions in apps/desktop/src/main/chat/engine.ts.
 */
export const routingDecisionsResource = createCachedResource<RoutingDecisionRow[]>({
  pollMs: POLL_MS,
  async load() {
    const result = await window.antseedDesktop?.chatAiListRoutingDecisions?.();
    return (result?.data ?? []) as RoutingDecisionRow[];
  },
});

/**
 * The baseline model last chosen in the savings dashboard's dropdown
 * (apps/cli's `/_antseed/routing-decisions/baseline`), so the Profile view's
 * "Auto-routing savings" text stays in sync with that choice instead of
 * silently falling back to its own default. `null` when nothing has been
 * explicitly chosen there yet.
 */
export const savingsBaselineModelResource = createCachedResource<string | null>({
  pollMs: POLL_MS,
  async load() {
    const result = await window.antseedDesktop?.chatAiGetRoutingSavingsBaseline?.();
    return result?.data ?? null;
  },
});

/**
 * Router-type plugins installed on disk (packages/node's AntseedRouterPlugin
 * metadata), for Preferences' "Select model router" dropdown -- driven by
 * whatever's actually installed rather than a hardcoded option list. Not
 * polled as aggressively as live runtime state since installed plugins
 * change only on an explicit install/reinstall.
 */
export const installedRouterPluginsResource = createCachedResource<RouterPluginInfo[]>({
  pollMs: 30_000,
  async load() {
    const result = await window.antseedDesktop?.pluginsListRouters?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list router plugins');
    return result.routers ?? [];
  },
});

export const installedAppsResource = createCachedResource<InstalledAppEntry[]>({
  async load() {
    const result = await window.antseedDesktop?.listInstalledApps?.();
    if (!result?.ok) throw new Error(result?.error ?? 'Could not list applications');
    return result.apps ?? [];
  },
});
