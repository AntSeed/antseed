import { useDeferredValue, useMemo, useState } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  AiBrain01Icon,
  AlphabetGreekIcon,
  ChartUpIcon,
  CodeIcon,
  Dollar01Icon,
  EyeIcon,
  Globe02Icon,
  HeadphonesIcon,
  HierarchyIcon,
  Image01Icon,
  PaintBrush01Icon,
  Shield01Icon,
  Sorting01Icon,
  SourceCodeIcon,
  Tag01Icon,
  TextIcon,
  TheaterIcon,
  ZapIcon,
} from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry, VprModelKind } from '../../../core/state';
import {
  filterVprCatalog,
  pinnedSellerLabels,
  sortVprCatalog,
  type VprCatalogSort,
} from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { availableModelFamilies } from '../../../modules/catalog/model-families';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import { availableModelTags } from '../../../modules/catalog/model-metadata';
import { setVprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { selectFavoriteVprCatalog } from '../../../modules/catalog/recommended';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useEverFunded } from '../../hooks/useEverFunded';
import { useRetainedState } from '../../hooks/useRetainedState';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { VprFilterDropdown, VprMultiFilterDropdown, type VprFilterOption } from '../vpr/VprFilterDropdown';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprPage, VprSearch } from '../vpr/VprKit';
import styles from './VprExploreView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/* Lead rows marked "Recommended" at the top of the list. */
const RECOMMENDED_COUNT = 3;

function FilterIconView({ icon }: { icon: IconSvgElement }) {
  return <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} />;
}

const TAG_ICONS: Readonly<Record<string, IconSvgElement>> = {
  Anime: PaintBrush01Icon,
  'Audio input': HeadphonesIcon,
  Coding: CodeIcon,
  Fast: ZapIcon,
  'Open weights': SourceCodeIcon,
  Reasoning: AiBrain01Icon,
  Roleplay: TheaterIcon,
  Uncensored: Shield01Icon,
  Vision: EyeIcon,
  'Web search': Globe02Icon,
};

// Renderer-lifetime cache: search/filter/sort survive drilling into a model
// page and back (ViewHost unmounts inactive views).
const exploreViewCache = {
  search: '',
  types: [] as string[],
  families: [] as string[],
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
  const everFunded = useEverFunded();
  const [search, setSearch] = useRetainedState(exploreViewCache, 'search');
  const [types, setTypes] = useRetainedState(exploreViewCache, 'types');
  const [families, setFamilies] = useRetainedState(exploreViewCache, 'families');
  const [sort, setSort] = useRetainedState(exploreViewCache, 'sort');
  // Filter/search changes re-render the full model list — hundreds of rows.
  // Deriving the list from deferred values keeps the tapped control
  // responsive: the pill paints its new state in the urgent render and the
  // list catches up in an interruptible background render.
  const listInputs = useDeferredValue(useMemo(
    () => ({ search, types, families, sort }),
    [families, search, sort, types],
  ));
  // Starred on the model pages; fresh on every visit (the view remounts).
  const [favorites] = useState(loadFavoriteModels);

  const availableFamilies = useMemo(() => availableModelFamilies(snap.catalog), [snap.catalog]);
  const tags = useMemo(
    () => availableModelTags(snap.catalog.map((entry) => entry.serviceId)),
    [snap.catalog],
  );
  const typeOptions = useMemo<readonly VprFilterOption<string>[]>(() => [
    { value: 'kind:text', label: 'Text', description: 'Chat and language models', icon: <FilterIconView icon={TextIcon} /> },
    { value: 'kind:image', label: 'Image', description: 'Image generation models', icon: <FilterIconView icon={Image01Icon} /> },
    { value: 'free', label: 'Free', description: 'Models with a free offer', icon: <FilterIconView icon={Dollar01Icon} /> },
    ...tags.map((modelTag) => ({
      value: `tag:${modelTag}`,
      label: modelTag,
      description: `Models tagged ${modelTag}`,
      icon: <FilterIconView icon={TAG_ICONS[modelTag] ?? Tag01Icon} />,
    })),
  ], [tags]);
  const familyOptions = useMemo<readonly VprFilterOption<string>[]>(() => [
    ...availableFamilies.map((modelFamily) => ({
      value: modelFamily,
      label: modelFamily,
      description: `${modelFamily} models`,
      icon: <BrandIcon name={modelFamily} hints={[modelFamily]} size={16} />,
    })),
  ], [availableFamilies]);
  const sortOptions = useMemo<readonly VprFilterOption<VprCatalogSort>[]>(() => [
    { value: 'Popular', label: 'Popular', description: 'Most available sellers first', icon: <FilterIconView icon={Sorting01Icon} /> },
    { value: 'Price', label: 'Price', description: 'Lowest price first', icon: <FilterIconView icon={Dollar01Icon} /> },
    { value: 'Savings', label: 'Savings', description: 'Largest savings first', icon: <FilterIconView icon={ChartUpIcon} /> },
    { value: 'Name', label: 'Name', description: 'Alphabetical order', icon: <FilterIconView icon={AlphabetGreekIcon} /> },
  ], []);
  const entries = useMemo(() => sortVprCatalog(
    filterVprCatalog(snap.catalog, {
      search: listInputs.search,
      kinds: listInputs.types
        .filter((value) => value.startsWith('kind:'))
        .map((value) => value.slice(5) as VprModelKind),
      tags: listInputs.types
        .filter((value) => value.startsWith('tag:'))
        .map((value) => value.slice(4)),
      families: listInputs.families,
      freeOnly: listInputs.types.includes('free'),
    }),
    listInputs.sort,
  ), [listInputs, snap.catalog]);

  const selectedModel = snap.selection.model;
  const selectedEntry = selectedModel
    ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId)
    : null;

  // The default view leads with three "Recommended" rows: the selected model
  // first, then the user's favorites, then — until the first deposit ever
  // lands — the most available free models (paid rows would just 402 for an
  // unfunded user), or the popular lineup once funded. Searching or filtering
  // drops the lead marking: the user is navigating the full list.
  const filtersActive = listInputs.search.trim().length > 0
    || listInputs.types.length > 0
    || listInputs.families.length > 0;
  const recommendedEntries = useMemo(() => {
    if (filtersActive) return [];
    const picked: VprModelCatalogEntry[] = [];
    const add = (entry: VprModelCatalogEntry): void => {
      if (picked.length < RECOMMENDED_COUNT && !picked.includes(entry)) picked.push(entry);
    };
    if (selectedEntry) add(selectedEntry);
    for (const entry of selectFavoriteVprCatalog(snap.catalog, favorites)) add(entry);
    const pool = everFunded
      ? sortVprCatalog(snap.catalog, 'Popular')
      : sortVprCatalog(filterVprCatalog(snap.catalog, { freeOnly: true }), 'Popular');
    for (const entry of pool) add(entry);
    return picked;
  }, [everFunded, favorites, filtersActive, selectedEntry, snap.catalog]);

  // One flat list, no duplicate rows: the recommended trio leads (framed by
  // the row list), the rest of the catalog follows in the current sort order.
  const listEntries = useMemo(
    () => [...recommendedEntries, ...entries.filter((entry) => !recommendedEntries.includes(entry))],
    [entries, recommendedEntries],
  );

  // Any listed model that remembers a pin names its seller in place of the
  // peer count — pins are per model and survive switching between them.
  const listedPins = useMemo(
    () => pinnedSellerLabels(snap.discoverRows, snap.modelPins, listEntries),
    [listEntries, snap.discoverRows, snap.modelPins],
  );

  const openModelPage = (provider: string, serviceId: string): void => {
    // Drilling into a model only browses it — the model page's "Use" button
    // is what makes it the active route.
    setVprModelPageTarget(provider, serviceId);
    onSelectView?.('model');
  };

  return (
    <section className={`view view-vpr-explore view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage
        title="Models"
        backFallback="home"
        header={(
          <VprSearch
            value={search}
            onChange={setSearch}
            placeholder="Search models"
          />
        )}
      >
      <div className={styles.stack}>
        <div className={styles.filterRow}>
          <VprMultiFilterDropdown
            label="Type"
            values={types}
            options={typeOptions}
            onChange={setTypes}
          />
          <VprMultiFilterDropdown
            label="Family"
            values={families}
            options={familyOptions}
            onChange={setFamilies}
            emptyIcon={<FilterIconView icon={HierarchyIcon} />}
          />
          <div className={styles.filterEnd}>
            <VprFilterDropdown
              label="Sort models"
              value={sort}
              options={sortOptions}
              onChange={setSort}
              align="end"
            />
          </div>
        </div>

        {listEntries.length > 0 ? (
          <VprModelRowList
            entries={listEntries}
            selectedProvider={selectedModel?.provider}
            selectedServiceId={selectedModel?.serviceId}
            favoriteKeys={favorites}
            recommendedCount={recommendedEntries.length}
            pinnedPeerLabels={listedPins}
            onSelect={openModelPage}
            emptyLabel="No matching models"
          />
        ) : (
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
