import { useMemo } from 'react';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { formatUsdShort, VprBackTitle, VprCard, VprSettingRow, VprSlider, VprToggle } from '../vpr/VprKit';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

/** Trust scores are 0-100 internally; the UI shows them on the 5-point reputation scale. */
function reputationLabel(score: number): string {
  return (score / 20).toFixed(1);
}

export function VprPreferencesView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    preferences: state.vprRoutingPreferences,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
  }), shallowEqual);

  const pinnedRoute = useMemo(() => {
    if (snap.selection.mode !== 'pinned-peer' || !snap.selection.peerId) return null;
    const routes = routesForSelectedModel(snap.discoverRows, snap.selection.model);
    return routes.find((route) => route.peerId === snap.selection.peerId) ?? null;
  }, [snap.discoverRows, snap.selection]);

  return (
    <section className={`view view-vpr-preferences ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <VprBackTitle title="Preferences" onBack={() => onSelectView?.('home')} />
        <p className={styles.lede}>These preferences apply to every model with Auto select turned on</p>

        <VprCard className={styles.card}>
          <VprSettingRow
            title="Auto select seller"
            caption="(Price + Trust preference)"
            hint="Applies to every model set to Auto. Off pauses routing everywhere - providers stay on their last pick."
            control={(
              <VprToggle
                checked={snap.preferences.autoRouting}
                onChange={(next) => actions.updateVprRoutingPreferences({ autoRouting: next })}
                ariaLabel="Auto select seller"
              />
            )}
          />

          <VprSettingRow
            title="Prefer free peers when available"
            hint="Free sellers win ties even when a paid seller scores higher."
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
                <span className={styles.sliderReadingValue}>{reputationLabel(snap.preferences.minTrustScore)}</span>
              </span>
            </div>
            <VprSlider
              min={0}
              max={100}
              step={5}
              value={snap.preferences.minTrustScore}
              onChange={(next) => actions.updateVprRoutingPreferences({ minTrustScore: next })}
              ariaLabel="Minimum trust score"
            />
            <div className={styles.sliderHint}>Providers rated below this are never used</div>
          </div>

          <div className={styles.sliderGroup}>
            <div className={styles.sliderHead}>
              <span className={styles.sliderTitle}>Price preference</span>
              <span className={styles.sliderReading}>
                <span className={styles.sliderReadingValue}>
                  {formatUsdShort(snap.preferences.maxInputUsdPerMillion)}
                </span>
                <span className={styles.sliderReadingLabel}>/m tok</span>
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
            <div className={styles.sliderHint}>Sellers charging more than this per million input tokens are never used</div>
          </div>
        </VprCard>

        {pinnedRoute ? (
          <div className={styles.pinnedSection}>
            <span className={styles.pinnedLabel}>Automatically select this seller</span>
            <VprCard className={styles.pinnedRow}>
              <div className={styles.pinnedText}>
                <span className={styles.pinnedName}>
                  {pinnedRoute.peerDisplayName || pinnedRoute.peerLabel || pinnedRoute.peerId}
                </span>
                <span className={styles.pinnedMeta}>
                  {pinnedRoute.inputUsdPerMillion !== null
                    ? `${formatUsdShort(pinnedRoute.inputUsdPerMillion)}/m tok`
                    : 'Price unknown'}
                  {snap.selection.model?.label ? ` · ${snap.selection.model.label}` : ''}
                </span>
              </div>
              <button
                type="button"
                className={styles.unpin}
                onClick={() => actions.clearVprPinnedPeer()}
              >
                Unpin
              </button>
            </VprCard>
          </div>
        ) : null}
      </div>
    </section>
  );
}
