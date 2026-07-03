import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowRight01Icon,
  ArrowUp02Icon,
  ConnectIcon,
  PowerIcon,
} from '@hugeicons/core-free-icons';
import type { SystemProxyProfileSummary } from '../../../types/bridge';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { formatCompactUsd } from '../../../core/format';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprHomeView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

function formatRange(min: number | null, max: number | null): string | null {
  if (min === null) return null;
  if (min <= 0 && (max === null || max <= 0)) return 'Free';
  const low = formatCompactUsd(min);
  if (max === null || max === min) return low;
  return `${low}-${formatCompactUsd(max)}`;
}

/**
 * Baseline (retail) price shown struck-through — sourced from the OpenRouter
 * catalog. Uses the input dimension so it lines up with the live input-price
 * range next to it; falls back to output when input is unpriced.
 */
function baselineInput(entry: VprModelCatalogEntry): number | null {
  return entry.baselineInputUsdPerMillion ?? entry.baselineOutputUsdPerMillion ?? null;
}

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
  }), shallowEqual);
  const [profiles, setProfiles] = useState<SystemProxyProfileSummary[]>([]);
  const [draft, setDraft] = useState('');

  const runtimeOn = snap.processes.some((process) => process.mode === 'connect' && process.running === true);

  const selectedModel = snap.selection.model;
  const selectedEntry = useMemo(
    () => snap.catalog.find((e) => e.provider === selectedModel?.provider && e.serviceId === selectedModel?.serviceId),
    [snap.catalog, selectedModel?.provider, selectedModel?.serviceId],
  );
  const modelIsFree = isFreeEntry(selectedEntry);

  const popular = useMemo(() => snap.catalog.slice(0, 3), [snap.catalog]);
  const maxSavings = useMemo(() => {
    const values = snap.catalog.map((e) => e.expectedSavingsPct).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.max(...values) : null;
  }, [snap.catalog]);

  useEffect(() => {
    let cancelled = false;
    async function refreshTools(): Promise<void> {
      const bridge = window.antseedDesktop;
      try {
        const nextProfiles = (await bridge?.systemProxyListProfiles?.()) ?? [];
        if (!cancelled) setProfiles(nextProfiles);
      } catch {
        if (!cancelled) setProfiles([]);
      }
    }
    void refreshTools();
    return () => { cancelled = true; };
  }, []);

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
        {/* Power / status hero */}
        <div className={styles.hero}>
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
            <span className={styles.statusDot} aria-hidden="true" />
            <span>{snap.connectBadge.label}</span>
          </div>

          <button
            type="button"
            className={styles.modelCard}
            onClick={() => onSelectView?.('model')}
            title="Change default model"
          >
            <span className={styles.modelCardBody}>
              <span className={styles.modelCardTitle}>
                <span className={styles.modelName}>{selectedModel?.label ?? 'None selected'}</span>
                {modelIsFree && <span className={styles.freeTag}>Free</span>}
              </span>
              <span className={styles.modelCardCaption}>Default Model</span>
            </span>
            <HugeiconsIcon icon={ArrowRight01Icon} size={24} strokeWidth={2} className={styles.modelCardChevron} />
          </button>
        </div>

        {/* Ask + connect tools */}
        <div className={styles.connectGroup}>
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

          <h2 className={styles.connectHeading}>Connect to your existing tools or start chatting</h2>

          {profiles.length > 0 && (
            <div className={styles.toolGrid}>
              {profiles.map((profile) => (
                <button
                  key={profile.name}
                  type="button"
                  className={styles.toolButton}
                  onClick={() => onSelectView?.('tools')}
                  title={profile.displayName}
                >
                  <BrandIcon name={profile.name} hints={[profile.displayName]} size={20} />
                  <span className={styles.toolLabel}>{profile.displayName}</span>
                </button>
              ))}
            </div>
          )}

          <div className={styles.ctaGroup}>
            <button type="button" className={styles.connectMore} onClick={() => onSelectView?.('tools')}>
              <HugeiconsIcon icon={ConnectIcon} size={20} strokeWidth={2} />
              <span>Connect more Tools</span>
            </button>
            <p className={styles.internalChat}>
              Or use internal{' '}
              <button type="button" className={styles.chatLink} onClick={() => onSelectView?.('chat')}>
                Chat
              </button>
            </p>
          </div>
        </div>

        {/* Popular on Antseed */}
        <div className={styles.popularSection}>
          <div className={styles.popularHeader}>
            <span className={styles.popularTitle}>Popular on Antseed</span>
            {maxSavings !== null && (
              <span className={styles.savingHint}>
                Expected Saving <span className={styles.savingPct}>up to {maxSavings}%</span>
              </span>
            )}
          </div>

          {popular.length > 0 ? (
            <div className={styles.popularList}>
              {popular.map((entry) => {
                const baseline = baselineInput(entry);
                const liveRange = formatRange(entry.minInputUsdPerMillion, entry.maxInputUsdPerMillion) ?? 'Free';
                const categories = entry.categories.map(formatCategoryLabel).join(', ');
                return (
                  <button
                    key={`${entry.provider}:${entry.serviceId}`}
                    type="button"
                    className={styles.popularRow}
                    onClick={() => actions.selectVprModel(entry.provider, entry.serviceId)}
                    title={`Route ${entry.label}`}
                  >
                    <span className={styles.popularMark}>
                      <BrandIcon name={entry.provider} hints={[entry.label]} size={24} />
                    </span>
                    <span className={styles.popularBody}>
                      <span className={styles.popularName}>{entry.label}</span>
                      <span className={styles.popularMeta}>
                        {entry.peerCount} {entry.peerCount === 1 ? 'peer' : 'peers'}
                        {categories && ` | ${categories}`}
                      </span>
                    </span>
                    <span className={styles.popularPricing}>
                      <span className={styles.priceRow}>
                        {baseline !== null && (
                          <span className={styles.priceBaseline}>{formatCompactUsd(baseline)}</span>
                        )}
                        <span className={styles.priceLive}>{liveRange}</span>
                      </span>
                      <span className={styles.priceUnit}>/m tok</span>
                    </span>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={24} strokeWidth={2} className={styles.popularChevron} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className={styles.popularEmpty}>No services discovered yet</div>
          )}
        </div>
      </div>
    </section>
  );
}
