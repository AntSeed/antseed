import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialUiState } from '../../../core/state';
import { initStore } from '../../../core/store';
import { normalizeDiscoverRow } from '../../../modules/catalog/discover-rows';
import { projectRowsToVprModelCatalog } from '../../../modules/catalog/model-catalog';
import { teeBrowseCache } from '../../../modules/catalog/tee-browse';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprExploreView } from './VprExploreView';
import { VprModelView } from './VprModelView';

const { action } = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('../../hooks/useActions', () => ({ useActions: () => new Proxy({}, { get: () => action }) }));

afterEach(() => {
  teeBrowseCache.filter = 'all';
  action.mockClear();
});

function initialize() {
  const state = createInitialUiState();
  const rows = [
    normalizeDiscoverRow({ peerId: 'standard', serviceId: 'gpt-test', provider: 'openai', protocol: 'openai-chat-completions', peerDisplayName: 'Standard Seller', inputUsdPerMillion: 0, outputUsdPerMillion: 0, effectiveReputationScore: 90 }),
    normalizeDiscoverRow({ peerId: 'tee', serviceId: 'gpt-test', provider: 'openai', protocol: 'openai-chat-completions', peerDisplayName: 'TEE Seller', advertisedVerifierIds: ['antseed-verifier'], inputUsdPerMillion: 2, outputUsdPerMillion: 4, effectiveReputationScore: 90 }),
  ];
  assert.ok(rows[0] && rows[1]);
  state.vprRoutableRows = [rows[0], rows[1]];
  state.vprModelCatalog = projectRowsToVprModelCatalog(state.vprRoutableRows);
  state.chatDiscoverRowsLoaded = true;
  state.vprRouteSelection = { model: { provider: 'openai', serviceId: 'gpt-test', label: 'GPT Test', categories: [] }, mode: 'pinned-peer', peerId: 'standard' };
  initStore(state);
  return state;
}

test('TEE model badges are opt-in and do not appear in Home/chat row lists', () => {
  const state = initialize();
  const props = { entries: state.vprModelCatalog, onSelect: action, emptyLabel: 'Empty' };
  assert.doesNotMatch(renderToStaticMarkup(<VprModelRowList {...props} />), /TEE available/);
  const markup = renderToStaticMarkup(<VprModelRowList {...props} showTeeAvailability />);
  assert.match(markup, /TEE available · 1 seller/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /not a verification verdict/);
});

test('Models overview omits TEE availability badges with either seller filter', () => {
  const state = initialize();
  const selection = structuredClone(state.vprRouteSelection);
  for (const filter of ['all', 'tee'] as const) {
    teeBrowseCache.filter = filter;
    const markup = renderToStaticMarkup(<VprExploreView />);
    assert.match(markup, /GPT Test/);
    assert.doesNotMatch(markup, /TEE available/);
    assert.match(markup, filter === 'tee' ? /automatic routing may use other sellers/ : /All sellers/);
  }
  assert.deepEqual(state.vprRouteSelection, selection);
  assert.equal(action.mock.calls.length, 0);
});

test('TEE detail filtering hides standard sellers without clearing the active pin', () => {
  const state = initialize();
  const selection = structuredClone(state.vprRouteSelection);
  teeBrowseCache.filter = 'tee';
  const markup = renderToStaticMarkup(<VprModelView />);
  assert.match(markup, /TEE Seller/);
  assert.doesNotMatch(markup, /Standard Seller/);
  assert.match(markup, /selected seller is hidden/);
  assert.match(markup, /Show all sellers/);
  assert.match(markup, /automatic routing may use other sellers/);
  assert.match(markup, /aria-label="Auto select seller" aria-checked="false"|aria-checked="false" aria-label="Auto select seller"/);
  assert.deepEqual(state.vprRouteSelection, selection);
  assert.equal(action.mock.calls.length, 0);
  teeBrowseCache.filter = 'all';
  assert.match(renderToStaticMarkup(<VprModelView />), /Standard Seller/);
});

test('TEE empty states preserve loading and offer a way to clear the browse filter', () => {
  const state = initialize();
  state.vprRoutableRows = state.vprRoutableRows.filter((row) => row.peerId === 'standard');
  state.vprModelCatalog = projectRowsToVprModelCatalog(state.vprRoutableRows);
  teeBrowseCache.filter = 'tee';
  assert.match(renderToStaticMarkup(<VprExploreView />), /No sellers advertising TEE support match these filters/);
  assert.match(renderToStaticMarkup(<VprExploreView />), /Clear filters/);
  assert.match(renderToStaticMarkup(<VprModelView />), /No sellers advertising TEE support match these filters/);
  state.chatDiscoverRowsLoaded = false;
  const loading = renderToStaticMarkup(<VprExploreView />);
  assert.match(loading, /Loading models/);
  assert.doesNotMatch(loading, /No sellers advertising TEE support/);
  assert.match(renderToStaticMarkup(<VprModelView />), /Loading sellers/);
  assert.equal(action.mock.calls.length, 0);
});
