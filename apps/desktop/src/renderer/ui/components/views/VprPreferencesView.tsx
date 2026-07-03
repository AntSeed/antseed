import { useMemo } from 'react';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import styles from './VprPreferencesView.module.scss';

type Props = { onSelectView?: (view: import('../../types').ViewName) => void };

export function VprPreferencesView(_props: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    preferences: state.vprRoutingPreferences,
    selection: state.vprRouteSelection,
    discoverRows: state.discoverRows,
  }), shallowEqual);
  const routes = useMemo(() => routesForSelectedModel(snap.discoverRows, snap.selection.model), [snap.discoverRows, snap.selection.model]);
  const bestRoute = useMemo(() => chooseBestVprRoute(routes, snap.preferences), [routes, snap.preferences]);

  return (
    <section className={`view view-vpr-preferences ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.header}>
          <span>Preferences</span>
          <h2 className={styles.title}>Routing</h2>
        </div>

        <label className={`${styles.control} ${styles.inline}`}>
          <span>Auto-routing</span>
          <input
            type="checkbox"
            checked={snap.preferences.autoRouting}
            onChange={(event) => actions.updateVprRoutingPreferences({ autoRouting: event.currentTarget.checked })}
          />
        </label>
        <label className={`${styles.control} ${styles.inline}`}>
          <span>Prefer free peers</span>
          <input
            type="checkbox"
            checked={snap.preferences.preferFreePeers}
            onChange={(event) => actions.updateVprRoutingPreferences({ preferFreePeers: event.currentTarget.checked })}
          />
        </label>
        <label className={styles.control}>
          <span>Max input price / M tokens</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={snap.preferences.maxInputUsdPerMillion}
            onChange={(event) => actions.updateVprRoutingPreferences({ maxInputUsdPerMillion: Math.max(0, Number(event.currentTarget.value) || 0) })}
          />
        </label>
        <label className={styles.control}>
          <span>Minimum trust score</span>
          <input
            type="number"
            min="0"
            step="1"
            value={snap.preferences.minTrustScore}
            onChange={(event) => actions.updateVprRoutingPreferences({ minTrustScore: Math.max(0, Number(event.currentTarget.value) || 0) })}
          />
        </label>

        <div className={styles.preview}>
          {snap.selection.model && bestRoute
            ? `Best current route: ${bestRoute.peerDisplayName || bestRoute.peerLabel || bestRoute.peerId}`
            : 'No selected model route to preview'}
        </div>
      </div>
    </section>
  );
}
