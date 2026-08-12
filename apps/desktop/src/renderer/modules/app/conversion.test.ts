import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../core/state';
import { createInitialUiState } from '../../core/state';
import type { OpenRouterReferenceMap } from '../catalog/openrouter-baseline';
import {
  computeProspectiveUsd,
  computeRetrospectiveUsd,
  initConversionModule,
} from './conversion';

const INSTALL_DATE_KEY = 'antseed.desktop.conversion.installDate';
const INSTALLED_AT_KEY = 'antseed.desktop.conversion.installedAt';
const STATE_KEY = 'antseed.desktop.conversion.state';
const LEGACY_VARIANT_KEY = 'antseed.desktop.conversion.variant';
const COUNTERS_KEY = 'antseed.desktop.conversion.counters';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function catalogEntry(overrides: Partial<VprModelCatalogEntry> = {}): VprModelCatalogEntry {
  return {
    provider: 'openai',
    serviceId: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    peerCount: 1,
    categories: [],
    minInputUsdPerMillion: 5,
    maxInputUsdPerMillion: 5,
    minOutputUsdPerMillion: 15,
    maxOutputUsdPerMillion: 15,
    minCachedInputUsdPerMillion: null,
    maxCachedInputUsdPerMillion: null,
    expectedSavingsPct: null,
    bestPeerId: 'peer',
    ...overrides,
  };
}

const referenceMap: OpenRouterReferenceMap = {
  gpt56sol: { input: 10, output: 30 },
};

function makeEligibleState() {
  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conversation-1';
  uiState.chatConversationsLoaded = true;
  uiState.chatConversations = [
    { id: 'conversation-1', messageCount: 6 },
    { id: 'conversation-2', messageCount: 2 },
  ];
  uiState.chatMessages = [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'user', content: 'three' },
  ];
  uiState.vprModelCatalog = [catalogEntry()];
  return uiState;
}

function setLifetimeUsage(uiState: ReturnType<typeof createInitialUiState>, requests = 7): void {
  uiState.creditsBuyerUsage = {
    totalRequests: requests,
    totalInputTokens: '20000',
    totalOutputTokens: '20000',
    totalSettlements: 0,
    uniqueSellers: 1,
    activeChannels: 0,
    services: [{
      serviceIdHash: 'hash',
      serviceName: 'gpt-5.6-sol',
      amountUsdc: '0',
      inputTokens: '20000',
      cachedInputTokens: '0',
      outputTokens: '20000',
      requestCount: requests,
    }],
  };
}

function primeD1(storage: MemoryStorage, now: number): void {
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now - 31 * 60_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({
    lifetimeRequests: 14,
    summariesSeeded: true,
    days: {
      [localDay(now)]: {
        requests: 14,
        inputTokens: 14_000,
        outputTokens: 14_000,
        services: {},
      },
    },
  }));
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('prospective value uses median discount and guards weak offers', () => {
  const strong = computeProspectiveUsd([catalogEntry()], referenceMap);
  assert.ok(strong);
  assert.equal(strong.discount, 0.5);
  assert.equal(strong.prospectiveUsd, 20);

  const weak = computeProspectiveUsd([
    catalogEntry({ minInputUsdPerMillion: 9, minOutputUsdPerMillion: 27 }),
  ], referenceMap);
  assert.equal(weak, null);
});

test('retrospective value prices matched and unmatched usage', () => {
  const exact = computeRetrospectiveUsd({
    services: [{ serviceName: 'gpt-5.6-sol', inputTokens: 10_000, outputTokens: 20_000 }],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  const blended = computeRetrospectiveUsd({
    services: [],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  assert.equal(exact, 0.7);
  assert.equal(blended, 0.7);
});

test('prospective value rounds to the nearest fifty cents', () => {
  const result = computeProspectiveUsd([
    catalogEntry({ minInputUsdPerMillion: 7, minOutputUsdPerMillion: 21 }),
  ], referenceMap);
  assert.ok(result);
  assert.equal(result.prospectiveUsd, 14.5);
});

test('D1 publishes the Home offer directly after a qualifying response', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primeD1(storage, now);
  const uiState = makeEligibleState();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();

  assert.equal(uiState.conversionState, 'armed_d1');
  assert.equal(uiState.conversionOffer?.variant, 'd1');
  assert.equal(uiState.conversionOffer?.requestsCount, 15);

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.conversionOffer?.requestsCount, 15);
});

test('D1 remains hidden until every eligibility gate passes', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now));
  const uiState = makeEligibleState();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', {
    inputTokens: 500_000,
    outputTokens: 500_000,
    service: 'gpt-5.6-sol',
  });
  await flushPromises();
  assert.equal(uiState.conversionOffer, null);
});

test('day rollover lazily arms D2 and uses the lower lifetime threshold', async () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now - 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - 86_400_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState);
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.conversionState, 'armed_d2');
  assert.equal(uiState.conversionOffer?.variant, 'd2');
});

test('day 5 and day 15 reminders wait for activity at their milestones', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  for (const item of [
    { state: 'armed_d5', variant: 'd5', ageDays: 4 },
    { state: 'armed_d15', variant: 'd15', ageDays: 14 },
  ] as const) {
    const storage = new MemoryStorage();
    storage.setItem(INSTALL_DATE_KEY, localDay(now - item.ageDays * 86_400_000));
    storage.setItem(INSTALLED_AT_KEY, String(now - item.ageDays * 86_400_000));
    storage.setItem(STATE_KEY, item.state);
    storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
    const uiState = makeEligibleState();
    setLifetimeUsage(uiState);
    const module = initConversionModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(uiState.conversionOffer?.variant, item.variant);
  }
});

test('day 5 reminder does not show early', async () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now));
  storage.setItem(STATE_KEY, 'armed_d5');
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 20, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  setLifetimeUsage(uiState, 20);
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.conversionOffer, null);
  assert.equal(uiState.conversionState, 'armed_d5');
});

test('dismissing each offer advances to the next reminder', async () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  for (const item of [
    { state: 'armed_d2', variant: 'd2', ageDays: 1, expected: 'armed_d5' },
    { state: 'armed_d5', variant: 'd5', ageDays: 4, expected: 'armed_d15' },
    { state: 'armed_d15', variant: 'd15', ageDays: 14, expected: 'done' },
  ] as const) {
    const storage = new MemoryStorage();
    storage.setItem(INSTALL_DATE_KEY, localDay(now - item.ageDays * 86_400_000));
    storage.setItem(INSTALLED_AT_KEY, String(now - item.ageDays * 86_400_000));
    storage.setItem(STATE_KEY, item.state);
    storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
    const uiState = makeEligibleState();
    setLifetimeUsage(uiState);
    const module = initConversionModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });

    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(uiState.conversionOffer?.variant, item.variant);
    module.dismissHome();
    assert.equal(uiState.conversionState, item.expected);
    assert.equal(uiState.conversionOffer, null);
  }
});

test('payer detection retires the feature and storage failures hide it', async () => {
  const payerState = createInitialUiState();
  payerState.creditsTotalOwnedUsdc = '1';
  const payerModule = initConversionModule({
    uiState: payerState,
    dependencies: { storage: new MemoryStorage(), notifyChanged: () => {} },
  });
  await payerModule.reconcilePayer();
  assert.equal(payerState.conversionState, 'done');

  const failedState = createInitialUiState();
  initConversionModule({
    uiState: failedState,
    dependencies: {
      storage: {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
      },
      notifyChanged: () => {},
    },
  });
  assert.equal(failedState.conversionOffer, null);
});

test('fresh installs start at D1 while existing profiles are grandfathered to D2', () => {
  const freshState = createInitialUiState();
  initConversionModule({
    uiState: freshState,
    dependencies: { storage: new MemoryStorage(), notifyChanged: () => {} },
  });
  assert.equal(freshState.conversionState, 'armed_d1');

  const existingStorage = new MemoryStorage();
  existingStorage.setItem('antseed.desktop.vpr.hasChats', '1');
  const existingState = createInitialUiState();
  initConversionModule({
    uiState: existingState,
    dependencies: { storage: existingStorage, notifyChanged: () => {} },
  });
  assert.equal(existingState.conversionState, 'armed_d2');
});

test('legacy shown reminders migrate back into the milestone lifecycle', () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now - 14 * 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - 14 * 86_400_000));
  storage.setItem(STATE_KEY, 'shown');
  storage.setItem(LEGACY_VARIANT_KEY, 'd5');
  const uiState = createInitialUiState();
  initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  assert.equal(uiState.conversionState, 'armed_d15');
});
