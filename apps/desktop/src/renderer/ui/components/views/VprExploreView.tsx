import { useMemo, useState } from 'react';
import { filterVprCatalog, sortVprCatalog, type VprCatalogSort } from '../../../modules/vpr-view-models';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { VprModelRowList } from '../vpr/VprModelRows';
import styles from './VprViews.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

export function VprExploreView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
  }), shallowEqual);
  const [tab, setTab] = useState<'Recommended' | 'All'>('Recommended');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<VprCatalogSort>('Popular');

  const categories = useMemo(
    () => Array.from(new Set(snap.catalog.flatMap((entry) => entry.categories))).sort((a, b) => a.localeCompare(b)),
    [snap.catalog],
  );
  const entries = useMemo(() => {
    const source = tab === 'Recommended' ? snap.catalog.slice(0, 12) : snap.catalog;
    return sortVprCatalog(filterVprCatalog(source, { search, category: category || null }), sort);
  }, [category, search, snap.catalog, sort, tab]);

  return (
    <section className={`view view-vpr-explore ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.header}>
          <span className={styles.eyebrow}>Explore</span>
          <h2 className={styles.title}>Models</h2>
        </div>

        <div className={styles.tabs}>
          <button type="button" onClick={() => setTab('Recommended')} aria-pressed={tab === 'Recommended'}>Recommended</button>
          <button type="button" onClick={() => setTab('All')} aria-pressed={tab === 'All'}>All</button>
        </div>

        <div className={styles.toolbar}>
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search models"
            aria-label="Search models"
          />
          <select value={sort} onChange={(event) => setSort(event.currentTarget.value as VprCatalogSort)} aria-label="Sort models">
            <option>Popular</option>
            <option>Price</option>
            <option>Savings</option>
            <option>Name</option>
          </select>
        </div>
        <select value={category} onChange={(event) => setCategory(event.currentTarget.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>

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
      </div>
    </section>
  );
}
