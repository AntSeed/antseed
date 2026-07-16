import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
  PowerIcon,
} from '@hugeicons/core-free-icons';
import type { RuntimeProcessState, SystemProxyProfileSummary } from '../../../types/bridge';
import type { VprModelCatalogEntry } from '../../../core/state';
import { getUiStateRef } from '../../../core/store';
import { activeProfilesFromRuntimeState } from '../../../modules/vpr-tools';
import { connectVprProfile } from '../../../modules/vpr-proxy-sync';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { formatCompactTokens, VprBadge, VprStatRow, VprStatTile } from '../vpr/VprKit';
import styles from './VprHomeView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const PROXY_STATE_POLL_MS = 3_000;
const ADD_BALANCE_DISMISSED_KEY = 'antseed.desktop.vpr.addBalanceDismissed';

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
    processes: state.processes,
    connectBadge: state.connectBadge,
    usage: state.creditsBuyerUsage,
    floatOpen: state.vprFloatOpen,
  }), shallowEqual);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [proxyState, setProxyState] = useState<RuntimeProcessState | null>(null);
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
    () => snap.catalog.find((e) => e.provider === selectedModel?.provider && e.serviceId === selectedModel?.serviceId),
    [snap.catalog, selectedModel?.provider, selectedModel?.serviceId],
  );
  const modelIsFree = isFreeEntry(selectedEntry);

  useEffect(() => {
    let cancelled = false;
    async function refreshTools(): Promise<void> {
      const bridge = window.antseedDesktop;
      try {
        const [nextProfiles, nextState] = await Promise.all([
          bridge?.systemProxyListProfiles?.() ?? Promise.resolve([]),
          bridge?.systemProxyGetState?.() ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setProfiles(nextProfiles);
        setProxyState(nextState);
      } catch {
        if (!cancelled) setProxyState(null);
      }
    }
    void refreshTools();
    const timer = window.setInterval(() => { void refreshTools(); }, PROXY_STATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

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

  // One-click connect from the app buttons; falls back to the Apps page when
  // the profile can't be connected automatically (e.g. no route yet).
  async function connectApp(profileName: string): Promise<void> {
    if (connectingProfile !== null) return;
    setConnectingProfile(profileName);
    try {
      const result = await connectVprProfile(window.antseedDesktop, getUiStateRef(), profileName);
      if (result.ok) {
        if (result.state !== undefined) setProxyState(result.state);
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

  function submitDraft(): void {
    const text = draft.trim();
    if (!text) return;
    actions.sendMessage(text);
    setDraft('');
    onSelectView?.('chat');
  }

  return (
    <section className={`view view-vpr-home ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        {/* Power / status hero over the brand gradient banner */}
        <div className={styles.hero}>
          <div
            className={`${styles.heroBanner}${connected ? ` ${styles.heroBannerLive}` : ''}`}
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
            className={`${styles.power}${runtimeOn ? ` ${styles.powerOn}` : ''}`}
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

          <button
            type="button"
            className={styles.modelCard}
            onClick={() => onSelectView?.('model')}
            title="Change default model"
          >
            <span className={styles.modelCardBody}>
              <span className={styles.modelCardCaption}>Default model</span>
              <span className={styles.modelCardTitle}>
                <span className={styles.modelName}>{selectedModel?.label ?? 'None selected'}</span>
                {modelIsFree && <span className={styles.freeTag}>Free</span>}
              </span>
            </span>
            <HugeiconsIcon icon={ArrowDown01Icon} size={24} strokeWidth={2} className={styles.modelCardChevron} />
          </button>
        </div>

        {hasConnectedApps ? (
          /* Connected variant: per-app route cards instead of the ask input */
          <div className={styles.connectedGroup}>
            {connectedProfiles.map((profile) => (
              <div key={profile.name} className={styles.routeCard}>
                <button
                  type="button"
                  className={styles.routeMain}
                  onClick={() => onSelectView?.('tools')}
                  title={`Manage ${profile.displayName}`}
                >
                  <BrandIcon name={profile.name} hints={[profile.displayName]} size={22} />
                  <span className={styles.routeApp}>{profile.displayName}</span>
                  <VprBadge tone="green">Connected</VprBadge>
                </button>
                <HugeiconsIcon icon={ArrowRight01Icon} size={20} strokeWidth={2} className={styles.routeChevron} />
              </div>
            ))}

            <button type="button" className={styles.moreApps} onClick={() => onSelectView?.('tools')}>
              <span>Connect more apps</span>
              <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
            </button>

            {!addBalanceDismissed && (
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
                  value={expectedSavingsPct !== null
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

          <div className={styles.appsGroup}>
            <p className={styles.appsLabel}>Use it on your favorite app</p>

            {profiles.length > 0 && (
              <div className={styles.toolGrid}>
                {profiles.map((profile) => (
                  <button
                    key={profile.name}
                    type="button"
                    className={styles.toolButton}
                    disabled={connectingProfile !== null}
                    onClick={() => { void connectApp(profile.name); }}
                    title={`Connect ${profile.displayName}`}
                  >
                    <BrandIcon name={profile.name} hints={[profile.displayName]} size={20} />
                    <span className={styles.toolLabel}>
                      {connectingProfile === profile.name ? 'Connecting...' : profile.displayName}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <button type="button" className={styles.moreApps} onClick={() => onSelectView?.('tools')}>
              <span>More apps</span>
              <HugeiconsIcon icon={ArrowRight02Icon} size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
        )}
      </div>
    </section>
  );
}
