import type { VprModelCatalogEntry, VprRoutingPreferences } from '../../core/state';
import type { RouterPluginInfo } from '../../types/bridge';

/**
 * "Auto" model-picker entry, resolved from whichever router plugin the
 * user has actually selected (Preferences' "Select model router" dropdown,
 * `VprRoutingPreferences.selectedRouterPackage`).
 * `provider`/`serviceId` must match the sentinel a router's own
 * `selectRoute` checks the requested model against
 * (e.g. a router plugin's own selectRoute: checks the requested model
 * against its own auto-sentinel serviceId) -- sourced from that plugin's
 * own declared `AntseedRouterPlugin.name`/
 * `autoRouteServiceId` (packages/node/src/interfaces/plugin.ts) instead of a
 * second, hand-duplicated copy of the same strings.
 *
 * Kept as a small module-level cache updated by `withAutoRouterCatalogEntry`
 * (the one function that already recomputes on every routing-state change,
 * in modules/chat/controller.ts) rather than threading the active plugin
 * through every call site below -- `isAutoRouterEntry`/`isAutoRouterSelected`
 * are read from several UI components that only need "is this the Auto
 * entry", not "which plugin is active".
 */
export type ActiveAutoRouterPlugin = {
  provider: string;
  serviceId: string;
  label: string;
  savingsBaselineModel?: string;
};

/**
 * Pure display fallbacks for when no router plugin is actually resolved --
 * NOT a plugin identity, so nothing here is ever compared against a catalog
 * entry's `provider`/`serviceId` (see `isAutoRouterEntry`, which returns
 * `false` whenever `active` is `null`). A deployment with no router plugin
 * installed at all must never show a pickable "Auto" option that can't
 * actually route through anything.
 */
const DEFAULT_AUTO_ROUTER_LABEL = 'Auto Router';
const DEFAULT_SAVINGS_BASELINE_MODEL = 'claude-opus-5';

let active: ActiveAutoRouterPlugin | null = null;

export let AUTO_ROUTER_LABEL: string = DEFAULT_AUTO_ROUTER_LABEL;

/**
 * Resolves the Auto entry's *identity* -- independent of whether
 * `routerEnabled` is currently on. `isAutoRouterEntry`/
 * `isAutoRouterSelected` need to keep recognizing an already-selected Auto
 * conversation/model even after the user flips the toggle off (e.g. so a
 * discover refresh doesn't silently rebind it to a concrete model) -- only
 * `withAutoRouterCatalogEntry`'s decision to *offer* the entry as pickable
 * is gated on the toggle.
 */
function resolveActiveAutoRouterPlugin(
  preferences: Pick<VprRoutingPreferences, 'selectedRouterPackage'>,
  availableRouters: RouterPluginInfo[],
): ActiveAutoRouterPlugin | null {
  const selectedPackage = preferences.selectedRouterPackage;
  const match = availableRouters.find(
    (router) => router.package === selectedPackage && router.autoRouteServiceId,
  );
  if (match) {
    return {
      provider: match.name,
      serviceId: match.autoRouteServiceId!,
      label: match.displayName,
      savingsBaselineModel: match.savingsBaselineModel,
    };
  }
  // Router list not loaded yet, or the selected package isn't actually
  // installed -- no Auto identity, period. A deployment with no router
  // plugin installed at all must never get a pickable Auto entry that could
  // never actually route (the buyer daemon has no such plugin to load).
  // installedRouterPluginsResource resolves from a local disk scan (no
  // network), so the "not loaded yet" window is a sub-frame flash of no
  // Auto entry on boot, not a user-visible gap.
  return null;
}

export function isAutoRouterEntry(entry: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'>): boolean {
  return active !== null && entry.provider === active.provider && entry.serviceId === active.serviceId;
}

/**
 * Null-safe wrapper around `isAutoRouterEntry` for `vprRouteSelection.model`
 * (which is `null` before any model is chosen). The CQT dial's visibility
 * gates on a dedicated Preferences toggle instead
 * (`VprRoutingPreferences.routerEnabled`) -- a momentary model
 * selection is not a real substitute for explicit,
 * standing consent to a real-money day-pass charge. Kept for any other
 * "is Auto the current selection" check that isn't a consent gate.
 */
export function isAutoRouterSelected(model: Pick<VprModelCatalogEntry, 'provider' | 'serviceId'> | null): boolean {
  return model !== null && isAutoRouterEntry(model);
}

/**
 * The active plugin's declared savings-comparison baseline model, or a
 * plugin-agnostic generic default when no plugin is active/declares one --
 * the savings dashboard (router-savings.ts) always needs *some* default
 * even while Auto is off, since it summarizes past `routing_decisions`
 * history. Not tied to any specific plugin's identity -- just a reasonable
 * flagship reference price, same reasoning as `recommended.ts`'s own
 * flagship-tier slot.
 */
export function activeAutoRouterSavingsBaselineModel(): string {
  return active?.savingsBaselineModel ?? DEFAULT_SAVINGS_BASELINE_MODEL;
}

/**
 * Builds a full catalog entry for the currently-resolved Auto identity, or
 * `null` when none is currently active (no router plugin resolved) -- a
 * stable, directly-usable fixture for callers/tests that need a concrete
 * entry object, since it's otherwise only ever constructed inline inside
 * `withAutoRouterCatalogEntry`.
 */
export function currentAutoRouteEntry(): VprModelCatalogEntry | null {
  if (!active) return null;
  const source = active;
  return {
    provider: source.provider,
    serviceId: source.serviceId,
    label: source.label,
    peerCount: 0,
    categories: [],
    kind: 'text',
    protocols: [],
    minInputUsdPerMillion: null,
    maxInputUsdPerMillion: null,
    minOutputUsdPerMillion: null,
    maxOutputUsdPerMillion: null,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    minImageUsdPerImage: null,
    maxImageUsdPerImage: null,
    expectedSavingsPct: null,
    hasEligibleFreeSeller: false,
    bestPeerId: null,
  };
}

/**
 * Idempotently prepends the Auto entry to a freshly-derived catalog, but only
 * when `preferences.routerEnabled` is true -- the entry starts a
 * real daily USDC charge, so it must not be offered as a pickable model until
 * the buyer has explicitly consented via the Preferences toggle (decisions
 * doc SS14 item 29). Also refreshes the shared "active router" cache that
 * `isAutoRouterEntry`/`isAutoRouterSelected`/`AUTO_ROUTER_LABEL` read --
 * this is the one place routing state is recomputed on every relevant
 * change (modules/chat/controller.ts), so it doubles as that cache's sync
 * point instead of requiring a separate bootstrap call.
 *
 * Safe to call on every catalog recompute when enabled -- `projectRowsToVprModelCatalog`
 * never produces a matching (provider, serviceId) pair from real network
 * discovery (no seller advertises an auto-route serviceId), so there is
 * nothing to deduplicate against beyond a previous call of this same function.
 */
export function withAutoRouterCatalogEntry(
  catalog: VprModelCatalogEntry[],
  preferences: Pick<VprRoutingPreferences, 'routerEnabled' | 'selectedRouterPackage'>,
  availableRouters: RouterPluginInfo[],
): VprModelCatalogEntry[] {
  active = resolveActiveAutoRouterPlugin(preferences, availableRouters);
  AUTO_ROUTER_LABEL = active?.label ?? DEFAULT_AUTO_ROUTER_LABEL;

  if (!(preferences.routerEnabled ?? false) || !active) {
    return catalog.some(isAutoRouterEntry) ? catalog.filter((entry) => !isAutoRouterEntry(entry)) : catalog;
  }
  if (catalog.some(isAutoRouterEntry)) return catalog;
  const entry = currentAutoRouteEntry();
  return entry ? [entry, ...catalog] : catalog;
}
