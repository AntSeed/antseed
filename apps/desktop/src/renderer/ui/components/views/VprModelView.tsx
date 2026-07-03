import { useMemo } from 'react';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { findCatalogEntry } from '../../../modules/vpr-model-catalog';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import styles from './VprViews.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

function priceLabel(input: number | null, output: number | null): string {
  const parts = [
    input === null ? null : `${formatPerMillionPrice(input)} in`,
    output === null ? null : `${formatPerMillionPrice(output)} out`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : 'Price unknown';
}

export function VprModelView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    discoverRows: state.discoverRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  const model = snap.selection.model;
  const entry = model ? findCatalogEntry(snap.catalog, model.provider, model.serviceId) : null;
  const routes = useMemo(() => routesForSelectedModel(snap.discoverRows, model), [model, snap.discoverRows]);
  const bestRoute = useMemo(() => chooseBestVprRoute(routes, snap.preferences), [routes, snap.preferences]);

  if (!model || !entry) {
    return (
      <section className={`view view-vpr-model ${styles.view}`} role="tabpanel">
        <div className={styles.empty}>
          <button type="button" onClick={() => onSelectView?.('explore')}>Choose a model</button>
        </div>
      </section>
    );
  }

  return (
    <section className={`view view-vpr-model ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.header}>
          <span className={styles.eyebrow}>{model.provider}</span>
          <h2 className={styles.title}>{model.label}</h2>
          <p className={styles.subtle}>{entry.peerCount} {entry.peerCount === 1 ? 'peer' : 'peers'}</p>
        </div>

        <div className={styles.chipRow}>
          {entry.categories.map((category) => <span key={category} className={styles.chip}>{category}</span>)}
        </div>

        <label className={styles.chip}>
          <input
            type="checkbox"
            checked={snap.selection.mode === 'auto'}
            onChange={(event) => {
              if (event.currentTarget.checked) {
                actions.clearVprPinnedPeer();
              } else {
                actions.selectVprModel(model.provider, model.serviceId, bestRoute?.peerId ?? entry.bestPeerId);
              }
            }}
          />
          Auto-routing
        </label>

        {snap.selection.mode === 'auto' && bestRoute ? (
          <p className={styles.subtle}>Active auto route: {bestRoute.peerDisplayName || bestRoute.peerLabel || bestRoute.peerId}</p>
        ) : null}

        <div className={styles.routeList}>
          {routes.length === 0 ? (
            <div className={styles.empty}>No routes available for this model</div>
          ) : routes.map((route) => {
            const selected = snap.selection.peerId === route.peerId;
            return (
              <div key={`${route.provider}:${route.serviceId}:${route.peerId}`} className={styles.routeRow}>
                <div>
                  <div className={styles.routeTitle}>{route.peerDisplayName || route.peerLabel || route.peerId}</div>
                  <div className={styles.routeMeta}>
                    {priceLabel(route.inputUsdPerMillion, route.outputUsdPerMillion)} · Trust {route.onChainTrustScore ?? 'n/a'} · Active {route.onChainActiveChannelCount}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => actions.selectVprModel(model.provider, model.serviceId, route.peerId)}
                  aria-pressed={selected}
                >
                  {selected ? 'Pinned' : 'Use this route'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
