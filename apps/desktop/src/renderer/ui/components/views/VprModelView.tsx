import { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { PreferenceHorizontalIcon, StarIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { chooseBestVprRoute } from '../../../modules/routing/select';
import { routesForSelectedModel } from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { favoriteModelKey, loadFavoriteModels, toggleFavoriteModel } from '../../../modules/catalog/favorites';
import { isFreeRoute, sellerMetaLabel, sellerReputationLabel } from '../../../modules/catalog/seller-format';
import type { DiscoverRow } from '../../../core/state';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { formatUsdShort, VprBadge, VprCard, VprPage, VprSettingRow, VprStatRow, VprStatTile, VprToggle } from '../vpr/VprKit';
import styles from './VprModelView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/* Category badges shown before collapsing into a "+N" chip — the full list
   easily runs past twenty tags and would swamp the page head. */
const MAX_VISIBLE_CATEGORIES = 5;

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
    discoverRows: state.vprRoutableRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
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
  // The active route (auto-chosen or pinned) leads the list with a checkmark.
  const activePeerId = autoSelect ? bestRoute?.peerId : snap.selection.peerId;
  const sortedRoutes = useMemo(() => {
    const active = routes.filter((route) => route.peerId === activePeerId);
    return [...active, ...routes.filter((route) => !active.includes(route))];
  }, [activePeerId, routes]);

  if (!model || !entry) {
    return (
      <section className={`view view-vpr-model ${styles.view}`} role="tabpanel">
        <div className={styles.empty}>
          <button type="button" onClick={() => onSelectView?.('explore')}>Choose a model</button>
        </div>
      </section>
    );
  }

  const favorite = favorites.has(favoriteModelKey(model.provider, model.serviceId));
  const priceValue = priceTile(entry);

  return (
    <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Models" backFallback="explore">
      <div className={styles.stack}>

        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.titleLine}>
              <BrandIcon name={model.provider} hints={[entry.label]} size={20} />
              <h2 className={styles.title}>{entry.label}</h2>
            </div>
            {entry.categories.length > 0 && (
              <div className={styles.badgeRow}>
                {entry.categories.slice(0, MAX_VISIBLE_CATEGORIES).map((category) => (
                  <VprBadge key={category} tone="type">{formatCategoryLabel(category)}</VprBadge>
                ))}
                {entry.categories.length > MAX_VISIBLE_CATEGORIES && (
                  <span className={styles.badgeMore} tabIndex={0}>
                    <VprBadge tone="type">+{entry.categories.length - MAX_VISIBLE_CATEGORIES}</VprBadge>
                    <span className={styles.badgeMoreTip} role="tooltip">
                      {entry.categories.slice(MAX_VISIBLE_CATEGORIES).map(formatCategoryLabel).join(' · ')}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
          <div className={styles.headActions}>
            <button
              type="button"
              className={`${styles.star}${favorite ? ` ${styles.starActive}` : ''}`}
              aria-pressed={favorite}
              title={favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => setFavorites(new Set(toggleFavoriteModel(model.provider, model.serviceId)))}
            >
              <HugeiconsIcon icon={StarIcon} size={20} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={styles.apply}
              onClick={() => {
                actions.selectVprModel(model.provider, model.serviceId, autoSelect ? null : snap.selection.peerId);
                onSelectView?.('home');
              }}
            >
              Apply
            </button>
          </div>
        </div>

        <VprStatRow>
          <VprStatTile
            label={priceValue === 'Free' || priceValue === '-' ? 'Price' : 'Price · /m tok'}
            value={priceValue}
            tone={priceValue === '-' ? undefined : 'success'}
            outlined
          />
          <VprStatTile
            label="Saving"
            value={entry.expectedSavingsPct !== null ? `${entry.expectedSavingsPct}%` : '-'}
            tone={entry.expectedSavingsPct !== null ? 'success' : undefined}
            strong
            outlined
          />
          <VprStatTile label="Sellers" value={entry.peerCount} outlined />
        </VprStatRow>

        <div className={styles.autoRow}>
          <VprSettingRow
            title="Auto select seller"
            hint="Price + Trust preference"
            control={(
              <div className={styles.autoControls}>
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
                <button
                  type="button"
                  className={styles.prefsLink}
                  title="Routing preferences"
                  onClick={() => onSelectView?.('preferences')}
                >
                  <HugeiconsIcon icon={PreferenceHorizontalIcon} size={24} strokeWidth={1.8} />
                </button>
              </div>
            )}
          />
        </div>

        <div className={styles.divider} aria-hidden="true" />

        <div className={styles.sellerSection}>
          <div className={styles.sellerHead}>
            <span className={styles.sellerHeadTitle}>Sellers</span>
            <span className={styles.sellerHeadAside}>Reputation</span>
          </div>
          {sortedRoutes.length === 0 ? (
            <div className={styles.empty}>No sellers available for this model</div>
          ) : (
            <VprCard className={styles.sellerCard}>
              {sortedRoutes.map((route) => {
                const active = route.peerId === activePeerId;
                return (
                  <SellerRow
                    key={route.rowKey}
                    route={route}
                    active={active}
                    auto={autoSelect}
                    onClick={() => {
                      // Clicking the pinned seller unpins it; anyone else pins them.
                      if (active && !autoSelect) {
                        actions.clearVprPinnedPeer();
                      } else {
                        actions.selectVprModel(model.provider, model.serviceId, route.peerId);
                      }
                    }}
                  />
                );
              })}
            </VprCard>
          )}
        </div>
      </div>
      </VprPage>
    </section>
  );
}

function SellerRow({ route, active, auto, onClick }: {
  route: DiscoverRow;
  /** This seller currently serves the model (auto-chosen or pinned). */
  active: boolean;
  /** Whether the page-level seller routing is in auto mode. */
  auto: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.sellerRow}${active ? ` ${styles.sellerRowActive}` : ''}`}
      onClick={onClick}
      title={active && !auto ? 'Unpin this seller' : 'Pin this seller'}
    >
      {active && (
        <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.sellerCheck} />
      )}
      <span className={styles.sellerText}>
        <span className={styles.sellerName}>
          {route.peerDisplayName || route.peerLabel || route.peerId}
          {active && <VprBadge tone="primary">{auto ? '• Auto' : 'Pinned'}</VprBadge>}
          {isFreeRoute(route) && <VprBadge tone="green">Free</VprBadge>}
        </span>
        <span className={styles.sellerMeta}>{sellerMetaLabel(route)}</span>
      </span>
      <span className={styles.sellerScore}>{sellerReputationLabel(route)}</span>
    </button>
  );
}
