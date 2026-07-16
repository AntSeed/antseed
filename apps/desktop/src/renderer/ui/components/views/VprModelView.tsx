import { useMemo } from 'react';
import { chooseBestVprRoute } from '../../../modules/vpr-routing';
import { routesForSelectedModel } from '../../../modules/vpr-view-models';
import { findCatalogEntry } from '../../../modules/vpr-model-catalog';
import type { DiscoverRow } from '../../../core/state';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { formatUsdShort, VprBadge, VprCard, VprPage, VprSettingRow, VprStatRow, VprStatTile, VprToggle } from '../vpr/VprKit';
import styles from './VprModelView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/** Trust scores are 0-100 internally; the UI shows them on the 5-point reputation scale. */
function reputationLabel(route: DiscoverRow): string {
  const score = route.onChainTrustScore ?? route.onChainReputationScore;
  if (score === null) return '-';
  return (Math.min(score, 100) / 20).toFixed(1);
}

function routePriceLabel(route: DiscoverRow): string {
  if (route.inputUsdPerMillion === null) return 'Price unknown';
  if (route.inputUsdPerMillion <= 0) return 'Free';
  return `${formatUsdShort(route.inputUsdPerMillion)}/m tok`;
}

function priceTile(entry: { minInputUsdPerMillion: number | null; maxInputUsdPerMillion: number | null }): string {
  const min = entry.minInputUsdPerMillion;
  const max = entry.maxInputUsdPerMillion;
  if (min === null) return '-';
  if (min <= 0 && (max === null || max <= 0)) return 'Free';
  if (max !== null && max !== min) return `${formatUsdShort(min)}-${formatUsdShort(max)}`;
  return formatUsdShort(min);
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
  const routes = useMemo(() => {
    const list = routesForSelectedModel(snap.discoverRows, model);
    return [...list].sort((a, b) => {
      const scoreA = a.onChainTrustScore ?? a.onChainReputationScore ?? -1;
      const scoreB = b.onChainTrustScore ?? b.onChainReputationScore ?? -1;
      return scoreB - scoreA;
    });
  }, [model, snap.discoverRows]);
  const bestRoute = useMemo(() => chooseBestVprRoute(routes, snap.preferences), [routes, snap.preferences]);

  const autoSelect = snap.selection.mode === 'auto';
  const pinnedRoutes = autoSelect ? [] : routes.filter((route) => route.peerId === snap.selection.peerId);
  const listedRoutes = routes.filter((route) => !pinnedRoutes.includes(route));

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
    <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Models" onBack={() => onSelectView?.('explore')}>
      <div className={styles.stack}>

        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.titleLine}>
              <BrandIcon name={model.provider} hints={[model.label]} size={20} />
              <h2 className={styles.title}>{model.label}</h2>
            </div>
            {entry.categories.length > 0 && (
              <div className={styles.badgeRow}>
                {entry.categories.map((category) => (
                  <VprBadge key={category} tone="type">{formatCategoryLabel(category)}</VprBadge>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={styles.apply}
            onClick={() => {
              actions.selectVprModel(model.provider, model.serviceId);
              onSelectView?.('home');
            }}
          >
            Apply
          </button>
        </div>

        <VprStatRow>
          <VprStatTile label="Price" value={priceTile(entry)} suffix={priceTile(entry) === 'Free' || priceTile(entry) === '-' ? undefined : '/m tok'} />
          <VprStatTile label="Saving" value={entry.expectedSavingsPct !== null ? `${entry.expectedSavingsPct}%` : '-'} />
          <VprStatTile label="Sellers" value={entry.peerCount} />
        </VprStatRow>

        <div className={styles.autoRow}>
          <VprSettingRow
            title="Auto select seller"
            hint="Price + Trust preference"
            control={(
              <VprToggle
                checked={autoSelect}
                onChange={(next) => {
                  if (next) {
                    actions.clearVprPinnedPeer();
                  } else {
                    actions.selectVprModel(model.provider, model.serviceId, bestRoute?.peerId ?? entry.bestPeerId ?? undefined);
                  }
                }}
                ariaLabel="Auto select seller"
              />
            )}
          />
        </div>

        <div className={styles.divider} aria-hidden="true" />

        {pinnedRoutes.length > 0 && (
          <div className={styles.sellerSection}>
            <div className={styles.sellerHead}>
              <span className={styles.sellerHeadTitle}>Pinned sellers</span>
            </div>
            <VprCard>
              {pinnedRoutes.map((route) => (
                <SellerRow
                  key={route.rowKey}
                  route={route}
                  pinned
                  onClick={() => actions.clearVprPinnedPeer()}
                />
              ))}
            </VprCard>
          </div>
        )}

        <div className={styles.sellerSection}>
          <div className={styles.sellerHead}>
            <span className={styles.sellerHeadTitle}>Sellers</span>
            <span className={styles.sellerHeadAside}>Reputation</span>
          </div>
          {listedRoutes.length === 0 ? (
            <div className={styles.empty}>No sellers available for this model</div>
          ) : (
            <VprCard>
              {listedRoutes.map((route) => (
                <SellerRow
                  key={route.rowKey}
                  route={route}
                  active={autoSelect && bestRoute?.peerId === route.peerId}
                  onClick={() => actions.selectVprModel(model.provider, model.serviceId, route.peerId)}
                />
              ))}
            </VprCard>
          )}
        </div>
      </div>
      </VprPage>
    </section>
  );
}

function SellerRow({ route, pinned, active, onClick }: {
  route: DiscoverRow;
  pinned?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.sellerRow}${pinned || active ? ` ${styles.sellerRowSelected}` : ''}`}
      onClick={onClick}
      title={pinned ? 'Unpin this seller' : 'Pin this seller'}
    >
      <span className={styles.sellerText}>
        <span className={styles.sellerName}>
          {route.peerDisplayName || route.peerLabel || route.peerId}
          {pinned && <VprBadge tone="primary">Pinned</VprBadge>}
          {active && <VprBadge tone="green">Auto</VprBadge>}
        </span>
        <span className={styles.sellerMeta}>{routePriceLabel(route)}</span>
      </span>
      <span className={styles.sellerScore}>{reputationLabel(route)}</span>
    </button>
  );
}
