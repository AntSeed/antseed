import { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Moon02Icon, Sun02Icon, Tick02Icon } from '@hugeicons/core-free-icons';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { reputationScaleLabel, sellerMetaLabel, sellerReputationLabel } from '../../../modules/vpr-seller-format';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { activeThemeMode, applyThemeMode, type ThemeMode } from '../../lib/theme';
import { formatUsdShort, VprCard, VprPage, VprSettingRow, VprSlider, VprToggle } from '../vpr/VprKit';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprPreferencesView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    preferences: state.vprRoutingPreferences,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
  }), shallowEqual);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => activeThemeMode());

  const selectTheme = (mode: ThemeMode) => {
    applyThemeMode(mode);
    setThemeMode(mode);
  };

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
                <span className={styles.sliderReadingValue}>{reputationScaleLabel(snap.preferences.minTrustScore)}</span>
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
            <div className={styles.sliderHint}>Sellers charging more than this per million input tokens are never used</div>
          </div>
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
          <span className={styles.sectionLabel}>Appearance</span>
          <VprCard className={styles.card}>
            <VprSettingRow
              title="Theme"
              hint="Applies to every AntStation window."
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
    </section>
  );
}
