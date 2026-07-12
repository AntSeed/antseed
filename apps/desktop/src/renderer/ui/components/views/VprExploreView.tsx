import { useMemo } from 'react';
import { filterVprCatalog, sortVprCatalog, type VprCatalogSort } from '../../../modules/vpr-view-models';
import { formatCategoryLabel } from '../chat/discover-filter-util';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useRetainedState } from '../../hooks/useRetainedState';
import type { ViewName } from '../../types';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprBackTitle, VprSearch } from '../vpr/VprKit';
import styles from './VprExploreView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

const RECOMMENDED_LIMIT = 12;

// Renderer-lifetime cache: tab/search/filter/sort survive drilling into a
// model page and back (ViewHost unmounts inactive views).
const exploreViewCache = {
  tab: 'Recommended' as 'Recommended' | 'All',
  search: '',
  category: '',
  sort: 'Popular' as VprCatalogSort,
};

export function VprExploreView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    discoverRowsLoaded: state.chatDiscoverRowsLoaded,
    connectBadge: state.connectBadge,
  }), shallowEqual);
  const [tab, setTab] = useRetainedState(exploreViewCache, 'tab');
  const [search, setSearch] = useRetainedState(exploreViewCache, 'search');
  const [category, setCategory] = useRetainedState(exploreViewCache, 'category');
  const [sort, setSort] = useRetainedState(exploreViewCache, 'sort');

  const categories = useMemo(
    () => Array.from(new Set(snap.catalog.flatMap((entry) => entry.categories))).sort((a, b) => a.localeCompare(b)),
    [snap.catalog],
  );
  const entries = useMemo(() => {
    const source = tab === 'Recommended' ? snap.catalog.slice(0, RECOMMENDED_LIMIT) : snap.catalog;
    return sortVprCatalog(
      filterVprCatalog(source, { search, category: tab === 'All' && category ? category : null }),
      sort,
    );
  }, [category, search, snap.catalog, sort, tab]);

  const maxSavings = useMemo(
    () => entries.reduce((best, entry) => Math.max(best, entry.expectedSavingsPct ?? 0), 0),
    [entries],
  );

  return (
    <section className={`view view-vpr-explore ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <VprBackTitle title="Models" onBack={() => onSelectView?.('home')} />

        <VprSearch value={search} onChange={setSearch} placeholder="Search models" />

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

        {tab === 'All' ? (
          <div className={styles.filterRow}>
            <label className={styles.filterPill}>
              <select
                value={category}
                onChange={(event) => setCategory(event.currentTarget.value)}
                aria-label="Filter by category"
              >
                <option value="">Category</option>
                {categories.map((entry) => (
                  <option key={entry} value={entry}>{formatCategoryLabel(entry)}</option>
                ))}
              </select>
            </label>
            <label className={`${styles.filterPill} ${styles.filterPillEnd}`}>
              <select
                value={sort}
                onChange={(event) => setSort(event.currentTarget.value as VprCatalogSort)}
                aria-label="Sort models"
              >
                <option value="Popular">Sort: Popular</option>
                <option value="Price">Sort: Price</option>
                <option value="Savings">Sort: Savings</option>
                <option value="Name">Sort: Name</option>
              </select>
            </label>
          </div>
        ) : (
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Top models</span>
            {maxSavings > 0 && (
              <span className={styles.sectionAside}>
                Expected Saving up to <strong>{maxSavings}%</strong>
              </span>
            )}
          </div>
        )}

        {entries.length > 0 ? (
          <VprModelRowList
            entries={entries}
            selectedProvider={snap.selection.model?.provider}
            selectedServiceId={snap.selection.model?.serviceId}
            onSelect={(provider, serviceId) => {
              actions.selectVprModel(provider, serviceId);
              onSelectView?.('model');
            }}
            emptyLabel="No matching models"
          />
        ) : (
          <div className={styles.empty} role="status">
            <div>
              {snap.discoverRowsLoaded ? 'No models match the current filters.' : `Model discovery is ${snap.connectBadge.label.toLowerCase()}.`}
            </div>
            <button type="button" onClick={() => { void actions.refreshAll(); }}>
              Refresh models
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
