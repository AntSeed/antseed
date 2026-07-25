import { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  PowerIcon,
} from '@hugeicons/core-free-icons';
import type { BuyerConversationSummary, RuntimeProcessState, SystemProxyProfileSummary } from '../../../types/bridge';
import type { VprModelCatalogEntry } from '../../../core/state';
import { getUiStateRef } from '../../../core/store';
import { activeProfilesFromRuntimeState } from '../../../modules/vpr-tools';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { findCatalogEntry } from '../../../modules/vpr-model-catalog';
import { displayModelLabel } from '../../../modules/model-identity';
import { loadFavoriteModels } from '../../../modules/vpr-favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/vpr-recommended-models';
import { connectVprProfile } from '../../../modules/vpr-proxy-sync';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { BrandIcon } from '../brand/BrandIcon';
import { VprModelRowList } from '../vpr/VprModelRows';
import { hasSeenChats, rememberSeenChats, VprRecentChatsCard } from '../vpr/VprRecentChats';
import { formatCompactTokens, VprStatRow, VprStatTile } from '../vpr/VprKit';
import styles from './VprHomeView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const PROXY_STATE_POLL_MS = 3_000;
const ADD_BALANCE_DISMISSED_KEY = 'antseed.desktop.vpr.addBalanceDismissed';
/* Rows in the model dropdown (Figma) — the full catalog lives on Models. */
const DROPDOWN_MODEL_COUNT = 3;

function isFreeEntry(entry: VprModelCatalogEntry | undefined): boolean {
  if (!entry) return false;
  const { minInputUsdPerMillion: i, minOutputUsdPerMillion: o } = entry;
  return i !== null && o !== null && i <= 0 && o <= 0;
}

export function VprHomeView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    discoverRows: state.vprRoutableRows,
    processes: state.processes,
    connectBadge: state.connectBadge,
    usage: state.creditsBuyerUsage,
    floatOpen: state.vprFloatOpen,
    creditsAvailable: state.creditsAvailableUsdc,
  }), shallowEqual);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [proxyState, setProxyState] = useState<RuntimeProcessState | null>(null);
  // null = the buyer hasn't answered the first conversations query yet (it
  // boots alongside the app) — the Recent chats card shows a skeleton then,
  // but only when a previous session actually saw chats (expectChats).
  const [conversations, setConversations] = useState<BuyerConversationSummary[] | null>(null);
  const [expectChats] = useState(hasSeenChats);
  const [draft, setDraft] = useState('');
  const [addBalanceDismissed, setAddBalanceDismissed] = useState(() => {
    try {
      return localStorage.getItem(ADD_BALANCE_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const runtimeOn = snap.processes.some((process) => process.mode === 'connect' && process.running === true);

  const selectedModel = snap.selection.model;
  const selectedEntry = useMemo(
    () => (selectedModel
      ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId) ?? undefined
      : undefined),
    [snap.catalog, selectedModel],
  );
  const modelIsFree = isFreeEntry(selectedEntry);
  // Lifetime buyer usage of the selected model ("1.7m tokens" in the Figma
  // model card) — summed across every seller serving it.
  const modelTokensLabel = useMemo(() => {
    const routes = routesForSelectedModel(snap.discoverRows, selectedModel);
    let input = 0;
    let output = 0;
    for (const route of routes) {
      input += route.lifetimeInputTokens;
      output += route.lifetimeOutputTokens;
    }
    if (input + output <= 0) return null;
    return `${formatCompactTokens(String(input), String(output))} tokens`;
  }, [selectedModel, snap.discoverRows]);

  useEffect(() => {
    let cancelled = false;
    async function refreshTools(): Promise<void> {
      const bridge = window.antseedDesktop;
      try {
        const [nextProfiles, nextState, nextConversations] = await Promise.all([
          bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
          bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
          bridge?.buyerConversationsList?.() ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setProfiles(nextProfiles);
        setProxyState(nextState);
        // null = buyer unreachable; keep whatever list we last had.
        if (nextConversations) {
          setConversations(nextConversations);
          rememberSeenChats(nextConversations.length);
        }
      } catch {
        if (!cancelled) setProxyState(null);
      }
      // Usage tiles: the module throttle absorbs this to one real fetch per
      // window once data has loaded, but while the payments backend is still
      // booting (startup) every tick retries, so the tiles fill in as soon
      // as it's up instead of showing zeros.
      void actions.refreshPaymentSummary();
    }
    void refreshTools();
    const timer = window.setInterval(() => { void refreshTools(); }, PROXY_STATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [actions]);

  const activeProfiles = useMemo(() => activeProfilesFromRuntimeState(proxyState), [proxyState]);
  const connectedProfiles = useMemo(
    () => profiles.filter((profile) => activeProfiles?.has(profile.name) ?? false),
    [activeProfiles, profiles],
  );
  const expectedSavingsPct = useMemo(() => {
    const values = snap.catalog
      .map((entry) => entry.expectedSavingsPct)
      .filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }, [snap.catalog]);

  // The usage tiles come from the payments summary; nudge a refresh when the
  // connected variant becomes visible (module-level throttle absorbs bursts).
  const hasConnectedApps = connectedProfiles.length > 0;
  useEffect(() => {
    if (hasConnectedApps) actions.refreshPaymentSummary();
  }, [actions, hasConnectedApps]);

  const [connectingProfile, setConnectingProfile] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Favorites are starred on the model pages (localStorage); re-read on each
  // open so stars toggled elsewhere show up without a remount.
  useEffect(() => {
    if (modelMenuOpen) setFavorites(loadFavoriteModels());
  }, [modelMenuOpen]);

  // Close the model dropdown on any outside click.
  useEffect(() => {
    if (!modelMenuOpen) return;
    function handleClick(event: MouseEvent): void {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelMenuOpen]);

  // The dropdown lists starred favorites first (marked with a star), then the
  // curated recommended lineup, with the current selection always present.
  const dropdownEntries = useMemo(() => {
    const favoriteEntries = selectFavoriteVprCatalog(snap.catalog, favorites);
    const recommended = selectRecommendedVprCatalog(snap.catalog)
      .filter((entry) => !favorites.has(catalogEntryKey(entry)))
      .slice(0, DROPDOWN_MODEL_COUNT);
    const top = [...favoriteEntries, ...recommended];
    if (selectedEntry && !top.includes(selectedEntry)) {
      return [selectedEntry, ...top];
    }
    return top;
  }, [favorites, selectedEntry, snap.catalog]);

  // One-click connect from the app buttons; falls back to the Apps page when
  // the profile can't be connected automatically (e.g. no route yet).
  async function connectApp(profileName: string): Promise<void> {
    if (connectingProfile !== null) return;
    setConnectingProfile(profileName);
    try {
      const result = await connectVprProfile(window.antseedDesktop, getUiStateRef(), profileName);
      if (result.ok) {
        if (result.state !== undefined) setProxyState(result.state);
        // Surface the pill right away, dropdown open, so the "start a new
        // session" guidance is in view while the user switches to the tool.
        void actions.openVprFloat?.(profileName, { openMenu: true });
        return;
      }
      onSelectView?.('tools');
    } finally {
      setConnectingProfile(null);
    }
  }

  function dismissAddBalance(): void {
    setAddBalanceDismissed(true);
    try {
      localStorage.setItem(ADD_BALANCE_DISMISSED_KEY, '1');
    } catch { /* private mode */ }
  }

  const connected = snap.connectBadge.tone === 'active' || runtimeOn;

  // The Add Balance banner is a nudge for low balances only — with more than
  // $5 available it's just noise.
  const creditsAvailableNum = Number(snap.creditsAvailable);
  const showAddBalance = !addBalanceDismissed
    && !(Number.isFinite(creditsAvailableNum) && creditsAvailableNum > 5);

  function submitDraft(): void {
    const text = draft.trim();
    if (!text) return;
    actions.sendMessage(text);
    setDraft('');
    onSelectView?.('chat');
  }

  const defaultModelLabel = selectedEntry?.label
    ?? (selectedModel ? displayModelLabel(selectedModel.serviceId, selectedModel.label) : 'No model');

  /* Recent chats sample — full width, same rows as the floating pill; every
     interaction leads to the dedicated Chats page where chats are managed. */
  const recentChats = (
    <VprRecentChatsCard
      conversations={conversations ?? []}
      catalog={snap.catalog}
      defaultModelLabel={defaultModelLabel}
      loading={conversations === null && expectChats}
      onOpen={() => onSelectView?.('chats')}
    />
  );

  return (
    <section className={`view view-vpr-home ${styles.view}`} role="tabpanel">
      {/* The hero is pinned outside the scroller — only the content below it
          scrolls, like a fixed app header. */}
      <div className={styles.heroPane}>
      <div className={styles.stack}>
        {/* Power / status hero over the brand gradient banner */}
        <div className={styles.hero}>
          <div
            className={`${styles.heroBanner}${connected ? ` ${styles.heroBannerLive}` : ` ${styles.heroBannerOff}`}`}
            aria-hidden="true"
          />
          <button
            type="button"
            className={styles.heroPop}
            onClick={() => { void actions.openVprFloat?.(); }}
            disabled={snap.floatOpen}
            aria-label="Pop out floating window"
            title={snap.floatOpen ? 'Floating window is open' : 'Pop out floating window'}
          >
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className={`${styles.power}${runtimeOn ? ` ${styles.powerOn}` : ` ${styles.powerOff}`}`}
            onClick={() => { void (runtimeOn ? actions.stopAll() : actions.startAll()); }}
            aria-pressed={runtimeOn}
            aria-label={runtimeOn ? 'Stop routing' : 'Start routing'}
            title={runtimeOn ? 'Stop routing' : 'Start routing'}
          >
            <HugeiconsIcon icon={PowerIcon} size={48} strokeWidth={2} />
          </button>

          <div className={`${styles.statusLine}${connected ? ` ${styles.statusOnline}` : ''}`}>
            {snap.connectBadge.label}
          </div>

          <div className={styles.modelDropdown} ref={modelMenuRef}>
            <button
              type="button"
              className={styles.modelCard}
              onClick={() => setModelMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              title="Change default model"
            >
              <span className={styles.modelCardBody}>
                <span className={styles.modelCardTitle}>
                  {selectedModel && (
                    <BrandIcon name={selectedModel.provider} hints={[selectedModel.label]} size={20} />
                  )}
                  <span className={styles.modelName}>
                    {selectedEntry?.label
                      ?? (selectedModel ? displayModelLabel(selectedModel.serviceId, selectedModel.label) : 'None selected')}
                  </span>
                  {modelIsFree && <span className={styles.freeTag}>Free</span>}
                </span>
                <span className={styles.modelCardCaption}>
                  <span>Default model</span>
                  {modelTokensLabel && <span className={styles.modelCardTokens}>{modelTokensLabel}</span>}
                </span>
              </span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={24} strokeWidth={2} className={styles.modelCardChevron} />
            </button>
            {modelMenuOpen && (
              <div className={styles.modelMenu} role="listbox">
                <VprModelRowList
                  entries={dropdownEntries}
                  selectedProvider={selectedModel?.provider}
                  selectedServiceId={selectedModel?.serviceId}
                  favoriteKeys={favorites}
                  onSelect={(provider, serviceId) => {
                    setModelMenuOpen(false);
                    actions.selectVprModel(provider, serviceId);
                  }}
                  emptyLabel="No models discovered yet"
                  frameless
                />
                <button
                  type="button"
                  className={styles.modelMenuFooter}
                  onClick={() => {
                    setModelMenuOpen(false);
                    onSelectView?.('explore');
                  }}
                >
                  <span>All models</span>
                  <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      <OverlayScrollArea
        className={styles.scroller}
        viewportClassName={styles.scrollerViewport}
        dataViewScroll
      >
      <div className={styles.stack}>
        {hasConnectedApps ? (
          /* Connected variant: recent chats instead of the ask input */
          <div className={styles.connectedGroup}>
            {/* Connected apps live on the Apps page — home leads with the
                chats themselves. */}
            {recentChats}

            <button type="button" className={styles.moreApps} onClick={() => onSelectView?.('tools')}>
              <span>Connect more apps</span>
              <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
            </button>

            {showAddBalance && (
              <div className={styles.balanceBanner}>
                <button
                  type="button"
                  className={styles.balanceBody}
                  onClick={() => onSelectView?.('deposit')}
                >
                  <span className={styles.balanceTitle}>Add Balance</span>
                  <span className={styles.balanceText}>
                    Pay only for what you use - no subscriptions, no lock-in. Card or USDC, your choice.
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.balanceClose}
                  onClick={dismissAddBalance}
                  aria-label="Dismiss add balance"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
                </button>
              </div>
            )}

            <div className={styles.usageGroup}>
              <p className={styles.usageLabel}>Usage</p>
              <VprStatRow>
                <VprStatTile label="Requests" value={(snap.usage?.totalRequests ?? 0).toLocaleString('en-US')} />
                <VprStatTile
                  label="Tokens"
                  value={formatCompactTokens(snap.usage?.totalInputTokens, snap.usage?.totalOutputTokens)}
                />
                <VprStatTile
                  label="Saving"
                  value={expectedSavingsPct !== null && (snap.usage?.totalRequests ?? 0) > 0
                    ? <span className={styles.savingValue}>{expectedSavingsPct}%</span>
                    : '-'}
                />
              </VprStatRow>
            </div>
          </div>
        ) : (
        /* Ask + routed apps */
        <div className={styles.connectGroup}>
          <h2 className={styles.connectHeading}>Routing to your existing apps or start chatting here</h2>

          <form
            className={styles.askForm}
            onSubmit={(event) => { event.preventDefault(); submitDraft(); }}
          >
            <input
              className={styles.askInput}
              type="text"
              value={draft}
              placeholder="Ask anything. On any model..."
              aria-label="Ask anything. On any model"
              onChange={(event) => setDraft(event.target.value)}
            />
            <button
              type="submit"
              className={styles.askSend}
              aria-label="Send message"
              title="Send message"
              disabled={draft.trim().length === 0}
            >
              <HugeiconsIcon icon={ArrowUp02Icon} size={24} strokeWidth={2} />
            </button>
          </form>

          {/* The connect pitch is for first-timers — once chats exist the
              user knows the flow, so only the "More apps" link (below the
              chats) remains. */}
          {(conversations === null ? !expectChats : conversations.length === 0) && (
          <div className={styles.appsGroup}>
            <p className={styles.appsLabel}>Use it on your favorite app</p>

            {profiles.length > 0 && (
              <div className={styles.toolList}>
                {/* Top of the catalog only — the full list lives on the Apps
                    page behind "More apps". */}
                {profiles.slice(0, 3).map((profile) => (
                  <button
                    key={profile.name}
                    type="button"
                    className={styles.toolRow}
                    disabled={connectingProfile !== null}
                    onClick={() => { void connectApp(profile.name); }}
                    title={`Connect ${profile.displayName}`}
                  >
                    <span className={styles.toolIdentity}>
                      {profile.iconDataUri
                        ? <img src={profile.iconDataUri} alt="" className={styles.appIcon} />
                        : <BrandIcon name={profile.name} hints={[profile.displayName]} size={20} />}
                      <span className={styles.toolLabel}>{profile.displayName}</span>
                    </span>
                    <span className={styles.toolConnect}>
                      {connectingProfile === profile.name ? 'Connecting...' : 'Connect'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {recentChats}

          <button type="button" className={styles.moreApps} onClick={() => onSelectView?.('tools')}>
            <span>More apps</span>
            <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
          </button>
        </div>
        )}
      </div>
      </OverlayScrollArea>
    </section>
  );
}
