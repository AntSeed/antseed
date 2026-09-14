import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { GlobalIcon, Moon02Icon, Sun02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { routesForSelectedModel } from '../../../modules/catalog/view-models';
import { peerAccessSummaryLabel } from '../../../modules/routing/peer-access';
import { buildVprPeerOptions } from '../../../modules/routing/tools';
import { reputationScaleLabel, sellerMetaLabel, sellerReputationLabel } from '../../../modules/catalog/seller-format';
import { RouterSettings } from '../chat/RouterSettings';
import { AUTO_DAY_PASS_MIN_TRUST_SCORE } from '../../../modules/routing/auto-router';
import { useCachedResource } from '../../../modules/app/cached-resource';
import { dayPassPriceIncreaseResource, installedRouterPluginsResource } from '../../../modules/app/vpr-resources';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { activeThemeMode, applyThemeMode, type ThemeMode } from '../../lib/theme';
import type { TelemetryStatus } from '../../../../shared/telemetry';
import { formatUsdShort, VprBadge, VprCard, VprPage, VprSettingRow, VprSlider, VprToggle } from '../vpr/VprKit';
import { VprPeerAccessDialog } from './VprPeerAccessDialog';
import { RouterInfoDialog } from '../chat/RouterInfoDialog';
import type { RouterPluginInfo } from '../../../types/bridge';
import { usePublicEndpointModal } from '../tunnels/PublicEndpointModal';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

const TELEMETRY_DOC_URL = 'https://github.com/AntSeed/antseed/blob/main/docs/telemetry.md';

const GENERIC_ROUTER_DESCRIPTION = 'Select an auto model router to optimise your spend and performance.';

export function VprPreferencesView({ onSelectView }: Props) {
  const actions = useActions();
  const { status: tunnelStatus, openPublicEndpointModal } = usePublicEndpointModal();
  const snap = useUiSelector((state) => ({
    preferences: state.vprRoutingPreferences,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
    lastPeers: state.lastPeers,
    floatAutoOpen: state.vprFloatAutoOpen,
    floatShowRoutedPeer: state.vprFloatShowRoutedPeer,
  }), shallowEqual);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => activeThemeMode());
  const [accessOpen, setAccessOpen] = useState(false);
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.antseedDesktop?.getTelemetryStatus?.()
      .then((status) => {
        if (!cancelled && status) setTelemetryStatus(status);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const toggleTelemetry = (next: boolean) => {
    const setTelemetryEnabled = window.antseedDesktop?.setTelemetryEnabled;
    if (!telemetryStatus || !setTelemetryEnabled) return;

    const previousStatus = telemetryStatus;
    setTelemetryStatus({
      ...previousStatus,
      enabled: next,
      userDisabled: !next,
    });
    void setTelemetryEnabled(next)
      .then((result) => {
        if (result?.ok) setTelemetryStatus(result);
        else setTelemetryStatus(previousStatus);
      })
      .catch(() => setTelemetryStatus(previousStatus));
  };
  const [pendingRouterPlugin, setPendingRouterPlugin] = useState<RouterPluginInfo | null>(null);
  const { data: routerPlugins } = useCachedResource(installedRouterPluginsResource);
  const availableRouters = routerPlugins ?? [];

  // Reopens the router info dialog on its own once the connect daemon
  // reports it's capping the active seller's day-pass signing below what
  // it's actually advertising (day-pass-signing.ts's onPriceCappedChange) --
  // so re-confirming a price increase doesn't require the buyer to notice a
  // failed chat request first. Trusts that a currently-active notice is
  // about whichever router is actually selected, since only one router/
  // seller relationship is ever active at a time in this app; doesn't
  // reopen while some other pick is already pending confirmation.
  const { data: priceIncreaseNotice } = useCachedResource(dayPassPriceIncreaseResource);
  useEffect(() => {
    if (!priceIncreaseNotice || pendingRouterPlugin) return;
    if (!snap.preferences.dayPassOnDemandEnabled || !snap.preferences.selectedRouterPackage) return;
    const activePlugin = availableRouters.find((r) => r.package === snap.preferences.selectedRouterPackage);
    if (activePlugin) setPendingRouterPlugin(activePlugin);
  }, [
    priceIncreaseNotice,
    pendingRouterPlugin,
    snap.preferences.dayPassOnDemandEnabled,
    snap.preferences.selectedRouterPackage,
    availableRouters,
  ]);

  const peerOptions = useMemo(
    () => buildVprPeerOptions(snap.lastPeers, snap.discoverRows),
    [snap.lastPeers, snap.discoverRows],
  );
  const { allowedPeerIds, blockedPeerIds } = snap.preferences;
  const accessSummary = peerAccessSummaryLabel(allowedPeerIds.length, blockedPeerIds.length);
  // Real gate on the daily day pass and the CQT dial -- a standing,
  // explicit toggle, not a proxy for whatever model happens to be selected
  // at this moment.
  const dayPassOnDemandEnabled = snap.preferences.dayPassOnDemandEnabled ?? false;
  const routerEnabled = snap.preferences.routerEnabled ?? dayPassOnDemandEnabled;

  const selectTheme = (mode: ThemeMode) => {
    applyThemeMode(mode);
    setThemeMode(mode);
  };

  const selectedRouterPackage = routerEnabled ? (snap.preferences.selectedRouterPackage ?? null) : null;
  const routerDescription = useMemo(() => {
    if (!selectedRouterPackage) return GENERIC_ROUTER_DESCRIPTION;
    const plugin = availableRouters.find((router) => router.package === selectedRouterPackage);
    return plugin?.preferencesSummary ?? plugin?.autoRouteInfo?.body ?? plugin?.description ?? GENERIC_ROUTER_DESCRIPTION;
  }, [selectedRouterPackage, availableRouters]);

  const pinnedRoute = useMemo(() => {
    if (snap.selection.mode !== 'pinned-peer' || !snap.selection.peerId) return null;
    const routes = routesForSelectedModel(snap.discoverRows, snap.selection.model);
    return routes.find((route) => route.peerId === snap.selection.peerId) ?? null;
  }, [snap.discoverRows, snap.selection]);

  return (
    <section className={`view view-vpr-preferences view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Preferences" backFallback="home">
      <div className={styles.stack}>
        <p className={styles.lede}>These preferences apply to every model with Auto select turned on</p>

        <div className={styles.settings}>
          <VprSettingRow
            title="Auto select seller"
            caption="(Price + Trust preference)"
            hint="Applies to every model set to Auto. Off pauses routing everywhere - providers stay on their last pick, and also stops the daily router charge below."
            control={(
              <VprToggle
                checked={snap.preferences.autoRouting}
                onChange={(next) => actions.updateVprRoutingPreferences({ autoRouting: next })}
                ariaLabel="Auto select seller"
              />
            )}
          />

          <div className={styles.routerGroup}>
            <div className={styles.routerHead}>
              <span className={styles.routerTitle}>Select model router</span>
              {routerEnabled ? <VprBadge tone="green">Router enabled</VprBadge> : null}
            </div>
            <select
              className={styles.routerSelect}
              value={routerEnabled ? (snap.preferences.selectedRouterPackage ?? 'none') : 'none'}
              onChange={(event) => {
                const nextPackage = event.target.value;
                if (nextPackage === 'none') {
                  actions.updateVprRoutingPreferences({ routerEnabled: false, dayPassOnDemandEnabled: false, selectedRouterPackage: null });
                  return;
                }
                const plugin = availableRouters.find((router) => router.package === nextPackage);
                if (!plugin) return;
                // Enabling costs real, recurring money -- explain and
                // confirm before it takes effect. The <select> itself
                // reverts to "None" on the next render if the user
                // cancels, since dayPassOnDemandEnabled never changed.
                setPendingRouterPlugin(plugin);
              }}
              aria-label="Select model router"
            >
              <option value="none">None</option>
              {availableRouters.filter((router) => router.autoRouteServiceId).map((router) => (
                <option key={router.package} value={router.package}>{router.displayName}</option>
              ))}
            </select>
            <div className={styles.routerDescription}>{routerDescription}</div>
          </div>

          {selectedRouterPackage ? <RouterSettings
            schema={availableRouters.find((router) => router.package === selectedRouterPackage)?.routingSettingsSchema ?? []}
            values={snap.preferences.routerSettings?.[`plugin:${selectedRouterPackage}`] ?? {}}
            onChange={(values) => actions.updateVprRoutingPreferences({ routerSettings: {
              ...snap.preferences.routerSettings, [`plugin:${selectedRouterPackage}`]: values,
            } })}
          /> : null}

          <VprSettingRow
            title="Prefer free peers when available"
            hint="Adds a strong routing bonus to zero-cost offers."
            control={(
              <VprToggle
                checked={snap.preferences.preferFreePeers}
                onChange={(next) => actions.updateVprRoutingPreferences({ preferFreePeers: next })}
                ariaLabel="Prefer free peers when available"
              />
            )}
          />

          <div className={styles.sliderGroup}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderTitle}>Minimum trust score</span>
              <span className={styles.sliderReading}>
                <span className={styles.sliderReadingLabel}>Reputation</span>
                <span className={styles.sliderReadingValue}>{reputationScaleLabel(snap.preferences.minTrustScore)}</span>
              </span>
            </div>
            <VprSlider
              min={dayPassOnDemandEnabled ? AUTO_DAY_PASS_MIN_TRUST_SCORE : 0}
              max={100}
              step={5}
              value={snap.preferences.minTrustScore}
              onChange={(next) => actions.updateVprRoutingPreferences({ minTrustScore: next })}
              ariaLabel="Minimum trust score"
            />
            <div className={styles.sliderHint}>
              Providers rated below this are never used
              {dayPassOnDemandEnabled ? ' — locked to 7.0+ while a model router is selected' : ''}
            </div>
          </div>

          <div className={styles.sliderGroup}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderTitle}>Price preference</span>
              <span className={styles.sliderReadingSmall}>
                {formatUsdShort(snap.preferences.maxInputUsdPerMillion)}/m tok
              </span>
            </div>
            <VprSlider
              min={0}
              max={25}
              step={0.5}
              value={snap.preferences.maxInputUsdPerMillion}
              onChange={(next) => actions.updateVprRoutingPreferences({ maxInputUsdPerMillion: next })}
              ariaLabel="Price preference"
            />
            <div className={styles.sliderHint}>Sellers above this input price receive a strong ranking penalty</div>
          </div>

          <VprSettingRow
            title="Seller access"
            caption={`(${accessSummary})`}
            hint="Block sellers you never want used, or allow a few to use only those."
            control={(
              <button
                type="button"
                className={styles.accessManage}
                onClick={() => setAccessOpen(true)}
              >
                Manage sellers
              </button>
            )}
          />
        </div>

        {pinnedRoute ? (
          <div className={styles.pinnedSection}>
            <span className={styles.pinnedLabel}>Automatically select this seller</span>
            <VprCard>
              <button
                type="button"
                className={styles.pinnedRow}
                onClick={() => actions.clearVprPinnedPeer()}
                title="Unpin this seller"
              >
                <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.pinnedCheck} />
                <span className={styles.pinnedText}>
                  <span className={styles.pinnedName}>
                    {pinnedRoute.peerDisplayName || pinnedRoute.peerLabel || pinnedRoute.peerId}
                  </span>
                  <span className={styles.pinnedMeta}>
                    {sellerMetaLabel(pinnedRoute)}
                    {snap.selection.model?.label ? ` · ${snap.selection.model.label}` : ''}
                  </span>
                </span>
                <span className={styles.pinnedScore}>{sellerReputationLabel(pinnedRoute)}</span>
              </button>
            </VprCard>
          </div>
        ) : null}

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Floating window</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Show on traffic"
              hint="Show the floating window on its own when a connected app starts sending requests."
              control={(
                <VprToggle
                  checked={snap.floatAutoOpen}
                  onChange={(next) => actions.setVprFloatAutoOpen?.(next)}
                  ariaLabel="Show floating window on traffic"
                />
              )}
            />
            <VprSettingRow
              title="Show routed peer"
              hint="Show the seller each chat's requests actually went through in chat lists and next to its model."
              control={(
                <VprToggle
                  checked={snap.floatShowRoutedPeer}
                  onChange={(next) => actions.setVprFloatShowRoutedPeer?.(next)}
                  ariaLabel="Show routed peer"
                />
              )}
            />
          </VprCard>
        </div>

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Connectivity</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Internet-accessible endpoint"
              hint={tunnelStatus?.running ? 'Running and ready for Cursor, agents, and hosted clients.' : 'Configure an authenticated public URL for remote apps and agents.'}
              control={(
                <button type="button" className={styles.accessManage} onClick={openPublicEndpointModal}>
                  <HugeiconsIcon icon={GlobalIcon} size={13} strokeWidth={1.8} />
                  {tunnelStatus?.running ? 'Manage' : 'Set up'}
                </button>
              )}
            />
          </VprCard>
        </div>

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Privacy</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Product telemetry"
              hint={telemetryStatus?.available === false
                ? 'Telemetry is unavailable in this build or has been disabled by configuration.'
                : 'Help improve VPR by sharing coarse feature usage and reliability information linked to your public on-chain address. Prompts, messages, files, and exact financial values are never collected.'}
              control={(
                <VprToggle
                  checked={telemetryStatus?.enabled ?? false}
                  onChange={toggleTelemetry}
                  ariaLabel="Product telemetry"
                  disabled={!telemetryStatus?.available}
                />
              )}
            />
            <button
              type="button"
              className={styles.telemetryDetails}
              onClick={() => { void window.antseedDesktop?.openExternalUrl?.(TELEMETRY_DOC_URL); }}
            >
              Review every event and privacy control
            </button>
          </VprCard>
        </div>

        <div className={styles.appearanceSection}>
          <span className={styles.sectionLabel}>Appearance</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Theme"
              hint="Applies to every VPR window."
              control={(
                <div className={styles.themeSegment} role="radiogroup" aria-label="Theme">
                  {([
                    { mode: 'light' as const, label: 'Light', icon: Sun02Icon },
                    { mode: 'dark' as const, label: 'Dark', icon: Moon02Icon },
                  ]).map(({ mode, label, icon }) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={themeMode === mode}
                      className={`${styles.themeSegmentButton}${themeMode === mode ? ` ${styles.themeSegmentActive}` : ''}`}
                      onClick={() => selectTheme(mode)}
                    >
                      <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            />
          </VprCard>
        </div>
      </div>
      </VprPage>

      <VprPeerAccessDialog
        isOpen={accessOpen}
        onClose={() => setAccessOpen(false)}
        preferences={snap.preferences}
        peerOptions={peerOptions}
        onSetListing={actions.setVprPeerListing}
        onClearAllowlist={() => actions.updateVprRoutingPreferences({ allowedPeerIds: [] })}
      />

      <RouterInfoDialog
        isOpen={pendingRouterPlugin !== null}
        plugin={pendingRouterPlugin}
        onClose={() => setPendingRouterPlugin(null)}
        onConfirm={(offer) => {
          if (!pendingRouterPlugin) return;
          actions.updateVprRoutingPreferences({
            routerEnabled: true,
            dayPassOnDemandEnabled: !!pendingRouterPlugin.dailyPassServiceId && offer !== null,
            selectedRouterPackage: pendingRouterPlugin.package,
            ...(snap.preferences.minTrustScore < AUTO_DAY_PASS_MIN_TRUST_SCORE
              ? { minTrustScore: AUTO_DAY_PASS_MIN_TRUST_SCORE }
              : {}),
            // Records this as the buyer's agreed price for this seller --
            // day-pass signing must never exceed it until explicitly
            // re-confirmed here again. No peerId/price means the routing
            // peer isn't currently advertising one; nothing to record yet,
            // day-pass-signing.ts's own first-signature bootstrap will
            // record whatever the live price turns out to be instead.
            ...(offer?.peerId && typeof offer.flatUsdPrice === 'number'
              ? {
                agreedDayPassPricesUsdc: {
                  ...snap.preferences.agreedDayPassPricesUsdc,
                  [offer.peerId]: offer.flatUsdPrice,
                },
              }
              : {}),
          });
          setPendingRouterPlugin(null);
        }}
      />
    </section>
  );
}
