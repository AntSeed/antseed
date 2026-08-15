import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, PreferenceHorizontalIcon, StarIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import { chooseBestVprRoute } from '../../../modules/routing/select';
import { compareModelRoutesByReputation, routesForSelectedModel } from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { modelCapabilitySummary, peerCapabilitySummary } from '../../../modules/catalog/model-capabilities';
import { buildImageModelSkillPrompt } from '../../../modules/chat/image-model-instructions';
import { favoriteModelKey, loadFavoriteModels, toggleFavoriteModel } from '../../../modules/catalog/favorites';
import { vprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { modelPinKey, vprModelPinFor } from '../../../modules/routing/model-pins';
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

function priceRange(min: number | null, max: number | null): string {
  if (min === null) return '-';
  if (min <= 0 && (max === null || max <= 0)) return 'Free';
  if (max !== null && max !== min) return `${formatUsdShort(min)}-${formatUsdShort(max)}`;
  return formatUsdShort(min);
}

function priceTile(entry: { minInputUsdPerMillion: number | null; maxInputUsdPerMillion: number | null }): string {
  const min = entry.minInputUsdPerMillion;
  const max = entry.maxInputUsdPerMillion;
  return priceRange(min, max);
}

export function VprModelView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    discoverRows: state.vprRoutableRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
    pins: state.vprModelPins,
    proxyPort: state.chatProxyPort,
  }), shallowEqual);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  // The page shows the model the user drilled into, which may not be the
  // applied route — browsing must not change routing until "Use" is pressed.
  const selectionModel = snap.selection.model;
  const model = useMemo(() => vprModelPageTarget()
    ?? (selectionModel ? { provider: selectionModel.provider, serviceId: selectionModel.serviceId } : null),
  [selectionModel]);
  const applied = Boolean(model && selectionModel
    && modelPinKey(selectionModel.provider, selectionModel.serviceId) === modelPinKey(model.provider, model.serviceId));
  const entry = model ? findCatalogEntry(snap.catalog, model.provider, model.serviceId) : null;
  const routes = useMemo(() => {
    const list = routesForSelectedModel(snap.discoverRows, model);
    return [...list].sort(compareModelRoutesByReputation);
  }, [model, snap.discoverRows]);
  const bestRoute = useMemo(() => chooseBestVprRoute(routes, snap.preferences), [routes, snap.preferences]);

  // An unapplied model previews its remembered pin (if that seller still
  // serves it); the applied model reflects the live selection.
  const pinnedPeerId = useMemo(() => {
    if (applied) return snap.selection.mode === 'pinned-peer' ? snap.selection.peerId : null;
    if (!model) return null;
    const pin = vprModelPinFor(snap.pins, model.provider, model.serviceId);
    return pin && routes.some((route) => route.peerId === pin) ? pin : null;
  }, [applied, model, routes, snap.pins, snap.selection]);

  const autoSelect = pinnedPeerId === null;
  // The active route (auto-chosen or pinned) leads the list with a checkmark.
  const activePeerId = autoSelect ? bestRoute?.peerId : pinnedPeerId;
  const selectedRoute = routes.find((route) => route.peerId === activePeerId) ?? bestRoute;

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
  const imageOnly = entry.kind === 'image';
  const priceValue = imageOnly
    ? priceRange(entry.minImageUsdPerImage, entry.maxImageUsdPerImage)
    : priceTile(entry);
  const capabilitySummary = modelCapabilitySummary(entry);

  const viewedModel = model;
  /** Make the browsed text model (and its previewed pin) the active route. */
  function applyModel(): void {
    actions.selectVprModel(viewedModel.provider, viewedModel.serviceId, pinnedPeerId);
  }

  async function copyImageInstructions(): Promise<void> {
    if (!imageOnly || !entry) return;
    try {
      await navigator.clipboard.writeText(buildImageModelSkillPrompt(entry, snap.proxyPort));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    }
  }

  function useImageInChat(): void {
    if (!selectedRoute) return;
    actions.startNewChat();
    actions.selectVprModel(viewedModel.provider, viewedModel.serviceId, pinnedPeerId);
    onSelectView?.('chat');
  }

  return (
    <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Models" backFallback="explore">
      <div className={styles.stack}>

        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.titleLine}>
              <BrandIcon name={model.provider} hints={[entry.label]} size={20} />
              <h2 className={styles.title}>{entry.label}</h2>
              {applied && (
                <span className={styles.titleCheck} title="Currently selected model">
                  <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={2} />
                </span>
              )}
            </div>
            {(entry.categories.length > 0 || imageOnly) && (
              <CategoryBadges categories={imageOnly ? ['image-generation', ...entry.categories] : entry.categories} />
            )}
          </div>
          <div className={styles.headActions}>
            <div className={styles.headActionsRow}>
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
                className={styles.use}
                disabled={imageOnly && !selectedRoute}
                onClick={() => {
                  if (imageOnly) {
                    useImageInChat();
                    return;
                  }
                  applyModel();
                  onSelectView?.('home');
                }}
              >
                {imageOnly ? 'Use in chat' : 'Use'}
              </button>
            </div>
            {imageOnly ? (
              <button
                type="button"
                className={styles.startChat}
                onClick={() => { void copyImageInstructions(); }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
                {copyState === 'copied' ? 'Copied instructions' : copyState === 'error' ? 'Copy failed' : 'Copy instructions'}
              </button>
            ) : (
              <button
                type="button"
                className={styles.startChat}
                onClick={() => {
                  // New chat first: applying the model while a conversation is
                  // open would rebind that conversation instead of a fresh one.
                  actions.startNewChat();
                  applyModel();
                  onSelectView?.('chat');
                }}
              >
                Start chat
              </button>
            )}
          </div>
        </div>

        {imageOnly && (
          <div className={styles.capabilityNotice} role="note">
            <strong>Image generation only</strong>
            <span>Use it in the internal chat, or copy model-only instructions for a normal text agent. It cannot become the main text or connected-app route.</span>
          </div>
        )}

        {capabilitySummary.length > 0 && !imageOnly && (
          <div className={styles.capabilityList} aria-label="Model type">
            {capabilitySummary.map((capability) => <span key={capability}>{capability}</span>)}
          </div>
        )}

        <VprStatRow>
          <VprStatTile
            label={imageOnly
              ? 'Price · /image'
              : priceValue === 'Free' || priceValue === '-' ? 'Price' : 'Price · /m tok'}
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
                    // Only the applied model touches the live route; browsing
                    // stages the choice in the per-model pin memory.
                    if (next) {
                      if (applied) actions.clearVprPinnedPeer();
                      else actions.setVprModelSellerPin(model.provider, model.serviceId, null);
                    } else {
                      const peerId = bestRoute?.peerId ?? entry.bestPeerId ?? null;
                      if (applied) actions.selectVprModel(model.provider, model.serviceId, peerId ?? undefined);
                      else if (peerId) actions.setVprModelSellerPin(model.provider, model.serviceId, peerId);
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
          {routes.length === 0 ? (
            <div className={styles.empty}>No sellers available for this model</div>
          ) : (
            <VprCard className={styles.sellerCard}>
              {routes.map((route) => {
                const active = route.peerId === activePeerId;
                return (
                  <SellerRow
                    key={route.rowKey}
                    route={route}
                    active={active}
                    auto={autoSelect}
                    onClick={() => {
                      // Clicking the pinned seller unpins it; anyone else pins
                      // them. Only the applied model touches the live route.
                      if (active && !autoSelect) {
                        if (applied) actions.clearVprPinnedPeer();
                        else actions.setVprModelSellerPin(model.provider, model.serviceId, null);
                      } else if (applied) {
                        actions.selectVprModel(model.provider, model.serviceId, route.peerId);
                      } else {
                        actions.setVprModelSellerPin(model.provider, model.serviceId, route.peerId);
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

/* Gap between badges — must match .badgeRow's gap in the stylesheet. */
const BADGE_GAP = 2;

/**
 * Category tags on a single line, always. The row measures itself before
 * paint and shows only as many tags as actually fit, collapsing the rest into
 * a "+N" chip whose title lists them — no wrapping, no clipped chips.
 */
function CategoryBadges({ categories }: { categories: string[] }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // null = measuring pass: render every tag (plus a worst-case "+N" chip) so
  // their widths can be read; the fitted count replaces it before paint.
  const [visibleCount, setVisibleCount] = useState<number | null>(null);

  useLayoutEffect(() => {
    setVisibleCount(null);
  }, [categories]);

  // Refit when the row's width changes (window resize, layout shifts).
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const observer = new ResizeObserver(() => setVisibleCount(null));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (visibleCount !== null) return;
    const row = rowRef.current;
    if (!row) return;
    const children = Array.from(row.children) as HTMLElement[];
    if (children.length < 2) return;
    const chip = children[children.length - 1];
    const badges = children.slice(0, -1);
    const fitted = (budget: number): number => {
      let width = 0;
      let count = 0;
      for (const badge of badges) {
        width += (count > 0 ? BADGE_GAP : 0) + badge.offsetWidth;
        if (width > budget) break;
        count += 1;
      }
      return count;
    };
    const max = row.clientWidth;
    setVisibleCount(fitted(max) === badges.length
      ? badges.length
      : fitted(max - BADGE_GAP - chip.offsetWidth));
  }, [visibleCount]);

  const visible = visibleCount ?? categories.length;
  const hiddenCategories = categories.slice(visible);

  return (
    <div className={styles.badgeRow} ref={rowRef}>
      {categories.slice(0, visible).map((category) => (
        <VprBadge key={category} tone="type">{formatCategoryLabel(category)}</VprBadge>
      ))}
      {(visibleCount === null || hiddenCategories.length > 0) && (
        <span
          className={styles.badgeMore}
          title={hiddenCategories.map(formatCategoryLabel).join(' · ')}
        >
          <VprBadge tone="type">+{hiddenCategories.length || categories.length}</VprBadge>
        </span>
      )}
    </div>
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
  const capabilities = peerCapabilitySummary(route);
  const parameters = route.capabilities?.supportedParameters ?? [];
  const capabilityLabel = [...capabilities, ...parameters.map((parameter) => parameter.replaceAll('_', ' '))].join(' · ');
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
        <span className={styles.sellerMeta}>
          {sellerMetaLabel(route)}
          {capabilityLabel ? ` · ${capabilityLabel}` : ''}
        </span>
      </span>
      <span className={styles.sellerScore}>{sellerReputationLabel(route)}</span>
    </button>
  );
}
