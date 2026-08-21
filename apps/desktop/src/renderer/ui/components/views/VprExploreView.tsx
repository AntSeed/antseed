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
import { availableModelTags } from '../../../modules/catalog/model-metadata';
import { setVprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useEverFunded } from '../../hooks/useEverFunded';
import { useRetainedState } from '../../hooks/useRetainedState';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { VprFilterDropdown, VprMultiFilterDropdown, type VprFilterOption } from '../vpr/VprFilterDropdown';
import { VprModelRowList, VprSelectedModelCard } from '../vpr/VprModelRows';
import { VprPage, VprSearch } from '../vpr/VprKit';
import styles from './VprExploreView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/* Rows in the unfunded "Top free models" lead-in section. */
const TOP_FREE_COUNT = 5;

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

  // Non-auto routing: the selected model's rows name the pinned seller.
  const pinnedSeller = useMemo(
    () => pinnedSellerLabel(snap.discoverRows, snap.selection),
    [snap.discoverRows, snap.selection],
  );

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

  // Until the first deposit ever lands, the default page leads with the top
  // free models — paid rows would just 402 for an unfunded user. Searching or
  // filtering dismisses the lead-in (the user is navigating the full list),
  // and the first deposit removes it for good.
  const filtersActive = listInputs.search.trim().length > 0
    || listInputs.types.length > 0
    || listInputs.families.length > 0;
  const topFreeEntries = useMemo(() => {
    if (everFunded || filtersActive) return [];
    return sortVprCatalog(filterVprCatalog(snap.catalog, { freeOnly: true }), 'Popular')
      .slice(0, TOP_FREE_COUNT);
  }, [everFunded, filtersActive, snap.catalog]);

  // Any listed model that remembers a pin names its seller in place of the
  // peer count — pins are per model and survive switching between them.
  const listedPins = useMemo(
    () => pinnedSellerLabels(snap.discoverRows, snap.modelPins, [...topFreeEntries, ...entries]),
    [entries, topFreeEntries, snap.discoverRows, snap.modelPins],
  );

  const selectedModel = snap.selection.model;
  const selectedEntry = selectedModel
    ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId)
    : null;

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
        {selectedEntry && (
          <VprSelectedModelCard
            entry={selectedEntry}
            auto={snap.selection.mode === 'auto'}
            pinnedPeerLabel={pinnedSeller}
            onClick={() => openModelPage(selectedEntry.provider, selectedEntry.serviceId)}
          />
        )}

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

        {topFreeEntries.length > 0 && (
          <>
            <div className={styles.sectionTitle}>Top free models</div>
            <VprModelRowList
              entries={topFreeEntries}
              selectedProvider={selectedModel?.provider}
              selectedServiceId={selectedModel?.serviceId}
              favoriteKeys={favorites}
              pinnedPeerLabels={listedPins}
              onSelect={openModelPage}
              emptyLabel="No matching models"
            />
          </>
        )}

        {entries.length > 0 ? (
          <>
            {topFreeEntries.length > 0 && (
              <div className={styles.sectionTitle}>All models ({entries.length})</div>
            )}
            <VprModelRowList
              entries={entries}
              selectedProvider={selectedModel?.provider}
              selectedServiceId={selectedModel?.serviceId}
              favoriteKeys={favorites}
              pinnedPeerLabels={listedPins}
              onSelect={openModelPage}
              emptyLabel="No matching models"
            />
          </>
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
