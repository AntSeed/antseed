import { useDeferredValue, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { StarIcon } from '@hugeicons/core-free-icons';
import type { VprModelKind } from '../../../core/state';
import {
  filterVprCatalog,
  pinnedSellerLabel,
  pinnedSellerLabels,
  sortVprCatalog,
  type VprCatalogSort,
} from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { availableModelFamilies } from '../../../modules/catalog/model-families';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import { setVprModelPageTarget } from '../../../modules/catalog/model-page-target';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/catalog/recommended';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import type { ViewName } from '../../types';
import { VprModelRowList, VprSelectedModelCard } from '../vpr/VprModelRows';
import { VprPage, VprSearch } from '../vpr/VprKit';
import styles from './VprExploreView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const RECOMMENDED_LIMIT = 18;

// Renderer-lifetime cache: tab/search/filter/sort survive drilling into a
// model page and back (ViewHost unmounts inactive views).
const exploreViewCache = {
  tab: 'Recommended' as 'Recommended' | 'All',
  search: '',
  kind: '' as VprModelKind | '',
  family: '',
  sort: 'Popular' as VprCatalogSort,
};

export function VprExploreView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    modelPins: state.vprModelPins,
    discoverRows: state.vprRoutableRows,
    discoverRowsLoaded: state.chatDiscoverRowsLoaded,
  }), shallowEqual);
  const [tab, setTab] = useRetainedState(exploreViewCache, 'tab');
  const [search, setSearch] = useRetainedState(exploreViewCache, 'search');
  const [kind, setKind] = useRetainedState(exploreViewCache, 'kind');
  const [family, setFamily] = useRetainedState(exploreViewCache, 'family');
  const [sort, setSort] = useRetainedState(exploreViewCache, 'sort');
  // Tab/filter/search changes re-render the full model list — hundreds of
  // rows. Deriving the list from deferred values keeps the tapped control
  // responsive: the tab/pill paints its new state in the urgent render and
  // the list catches up in an interruptible background render.
  const listInputs = useDeferredValue(useMemo(
    () => ({ tab, search, kind, family, sort }),
    [family, kind, search, sort, tab],
  ));
  // Starred on the model pages; fresh on every visit (the view remounts).
  const [favorites] = useState(loadFavoriteModels);

  // Non-auto routing: the selected model's rows name the pinned seller.
  const pinnedSeller = useMemo(
    () => pinnedSellerLabel(snap.discoverRows, snap.selection),
    [snap.discoverRows, snap.selection],
  );

  const families = useMemo(() => availableModelFamilies(snap.catalog), [snap.catalog]);
  const favoriteEntries = useMemo(
    () => (listInputs.tab === 'Recommended'
      ? filterVprCatalog(selectFavoriteVprCatalog(snap.catalog, favorites), { search: listInputs.search })
      : []),
    [favorites, listInputs, snap.catalog],
  );
  const entries = useMemo(() => {
    if (listInputs.tab === 'Recommended') {
      // Curated lineup order (frontier + free) — the sort control only
      // exists on the All tab. Favorites get their own section above.
      const curated = selectRecommendedVprCatalog(snap.catalog)
        .filter((entry) => !favorites.has(catalogEntryKey(entry)))
        .slice(0, RECOMMENDED_LIMIT);
      return filterVprCatalog(curated, { search: listInputs.search });
    }
    return sortVprCatalog(
      filterVprCatalog(snap.catalog, {
        search: listInputs.search,
        kind: listInputs.kind || null,
        family: listInputs.family || null,
      }),
      listInputs.sort,
    );
  }, [favorites, listInputs, snap.catalog]);

  // Any listed model that remembers a pin names its seller in place of the
  // peer count — pins are per model and survive switching between them.
  const listedPins = useMemo(
    () => pinnedSellerLabels(snap.discoverRows, snap.modelPins, [...favoriteEntries, ...entries]),
    [entries, favoriteEntries, snap.discoverRows, snap.modelPins],
  );

  const selectedModel = snap.selection.model;
  const selectedEntry = selectedModel
    ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId)
    : null;

  return (
    <section className={`view view-vpr-explore view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage
        title="Models"
        backFallback="home"
        header={(
          <>
            <VprSearch
              value={search}
              onChange={(value) => {
                setSearch(value);
                // Recommended is a short curated slice — searching implies
                // the user wants the full catalog, so hop to All Models.
                if (value.trim().length > 0 && tab === 'Recommended') setTab('All');
              }}
              placeholder="Search models"
            />

            <div className={styles.tabs} role="tablist" aria-label="Model list scope">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'Recommended'}
                className={`${styles.tab}${tab === 'Recommended' ? ` ${styles.tabActive}` : ''}`}
                onClick={() => setTab('Recommended')}
              >
                Recommended
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'All'}
                className={`${styles.tab}${tab === 'All' ? ` ${styles.tabActive}` : ''}`}
                onClick={() => setTab('All')}
              >
                All Models ({snap.catalog.length})
              </button>
            </div>
          </>
        )}
      >
      <div className={styles.stack}>
        {selectedEntry && (
          <VprSelectedModelCard
            entry={selectedEntry}
            auto={snap.selection.mode === 'auto'}
            pinnedPeerLabel={pinnedSeller}
            onClick={() => {
              setVprModelPageTarget(selectedEntry.provider, selectedEntry.serviceId);
              onSelectView?.('model');
            }}
          />
        )}

        {tab === 'All' && (
          <div className={styles.filterRow}>
            <label className={styles.filterPill}>
              <select
                value={kind}
                onChange={(event) => setKind(event.currentTarget.value as VprModelKind | '')}
                aria-label="Filter by model type"
              >
                <option value="">Model type</option>
                <option value="image">Image</option>
                <option value="text">Text</option>
              </select>
            </label>
            <label className={styles.filterPill}>
              <select
                value={family}
                onChange={(event) => setFamily(event.currentTarget.value)}
                aria-label="Filter by model family"
              >
                <option value="">Model family</option>
                {families.map((entry) => (
                  <option key={entry} value={entry}>{entry}</option>
                ))}
              </select>
            </label>
            <label className={`${styles.filterPill} ${styles.filterPillEnd}`}>
              <select
                value={sort}
                onChange={(event) => setSort(event.currentTarget.value as VprCatalogSort)}
                aria-label="Sort models"
              >
                <option value="Popular">Popular</option>
                <option value="Price">Price</option>
                <option value="Savings">Savings</option>
                <option value="Name">Name</option>
              </select>
            </label>
          </div>
        )}

        {favoriteEntries.length > 0 && (
          <>
            <div className={styles.sectionTitle}>
              <HugeiconsIcon icon={StarIcon} size={13} strokeWidth={2} className={styles.sectionStar} />
              Favorites
            </div>
            <VprModelRowList
              entries={favoriteEntries}
              selectedProvider={selectedModel?.provider}
              selectedServiceId={selectedModel?.serviceId}
              favoriteKeys={favorites}
              pinnedPeerLabels={listedPins}
              onSelect={(provider, serviceId) => {
                // Drilling into a model only browses it — the model page's
                // "Use" button is what makes it the active route.
                setVprModelPageTarget(provider, serviceId);
                onSelectView?.('model');
              }}
              emptyLabel="No matching models"
            />
          </>
        )}

        {entries.length > 0 ? (
          <>
            {favoriteEntries.length > 0 && (
              <div className={styles.sectionTitle}>Recommended</div>
            )}
            <VprModelRowList
              entries={entries}
              selectedProvider={selectedModel?.provider}
              selectedServiceId={selectedModel?.serviceId}
              pinnedPeerLabels={listedPins}
              onSelect={(provider, serviceId) => {
                // Drilling into a model only browses it — the model page's
                // "Use" button is what makes it the active route.
                setVprModelPageTarget(provider, serviceId);
                onSelectView?.('model');
              }}
              emptyLabel="No matching models"
            />
          </>
        ) : favoriteEntries.length === 0 && (
          snap.discoverRowsLoaded ? (
            <div className={styles.empty} role="status">
              <div>No models match the current filters.</div>
              <button type="button" onClick={() => { void actions.refreshAll(); }}>
                Refresh models
              </button>
            </div>
          ) : (
            /* Discovery still fetching the first snapshot — a spinner, not a
               dead-end empty state; rows stream in as soon as the poll lands. */
            <div className={styles.empty} role="status" aria-live="polite" aria-label="Loading models">
              <span className="route-loading-spinner" aria-hidden="true" />
              <div>Loading models…</div>
            </div>
          )
        )}
      </div>
      </VprPage>
    </section>
  );
}
