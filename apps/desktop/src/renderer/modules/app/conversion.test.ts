import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { VprModelCatalogEntry } from '../../core/state';
import { createInitialUiState } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import type { OpenRouterReferenceMap } from '../catalog/openrouter-baseline';
import {
  computeProspectiveUsd,
  computeRetrospectiveUsd,
  initConversionModule,
  selectConversionModelProof,
} from './conversion';

const INSTALL_DATE_KEY = 'antseed.desktop.conversion.installDate';
const INSTALLED_AT_KEY = 'antseed.desktop.conversion.installedAt';
const STATE_KEY = 'antseed.desktop.conversion.state';
const VARIANT_KEY = 'antseed.desktop.conversion.variant';
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
  uiState.activeView = 'chat';
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

function timerHarness() {
  let nextId = 0;
  const timers = new Map<number, () => void>();
  return {
    timers,
    setTimer(callback: () => void) {
      nextId += 1;
      timers.set(nextId, callback);
      return nextId as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle as unknown as number);
    },
    runAll() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function primePendingD1(storage: MemoryStorage, now: number): void {
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now - 31 * 60_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({
    lifetimeRequests: 14,
    summariesSeeded: true,
    days: {
      [localDay(now)]: { requests: 14, inputTokens: 14_000, outputTokens: 14_000, services: {} },
    },
  }));
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

test('model proof uses curated live models and omits weak discounts', () => {
  const proof = selectConversionModelProof([
    catalogEntry({
      provider: 'openai',
      serviceId: 'gpt-5.6-sol',
      label: 'GPT 5.6 Sol',
    }),
    catalogEntry({
      provider: 'anthropic',
      serviceId: 'claude-opus-5',
      label: 'Claude Opus 5',
      minInputUsdPerMillion: 4,
      minOutputUsdPerMillion: 12,
    }),
    catalogEntry({
      provider: 'anthropic',
      serviceId: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      minInputUsdPerMillion: 9,
      minOutputUsdPerMillion: 27,
    }),
  ], {
    gpt56sol: { input: 10, output: 30 },
    claudeopus5: { input: 10, output: 30 },
    claudesonnet5: { input: 10, output: 30 },
  });

  assert.deepEqual(proof.map(({ label, discountPct }) => ({ label, discountPct })), [
    { label: 'Claude Opus 5', discountPct: 60 },
    { label: 'GPT 5.6 Sol', discountPct: 50 },
  ]);
});

test('retrospective value prices matched services and blends unmatched tokens', () => {
  const exact = computeRetrospectiveUsd({
    services: [{ serviceName: 'gpt-5.6-sol', inputTokens: 10_000, outputTokens: 20_000 }],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  assert.equal(exact, 0.7);

  const blended = computeRetrospectiveUsd({
    services: [],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [catalogEntry()],
    referenceMap,
  });
  assert.equal(blended, 0.7);

  const partial = computeRetrospectiveUsd({
    services: [{ serviceName: 'gpt-5.6-sol', inputTokens: 10_000, outputTokens: 20_000 }],
    totalInputTokens: 10_000,
    totalOutputTokens: 20_000,
    catalog: [
      catalogEntry(),
      catalogEntry({
        provider: 'anthropic',
        serviceId: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
      }),
    ],
    referenceMap: {
      gpt56sol: { input: 10, output: null },
      claudesonnet5: { input: 10, output: 30 },
    },
  });
  assert.equal(partial, 0.7);
});

test('prospective value rounds to the nearest fifty cents', () => {
  const result = computeProspectiveUsd([
    catalogEntry({ minInputUsdPerMillion: 7, minOutputUsdPerMillion: 21 }),
  ], referenceMap);
  assert.ok(result);
  assert.equal(result.prospectiveUsd, 14.5);
});

test('D1 shows once after all gates and the idle timer pass', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now - 31 * 60_000));
  const uiState = makeEligibleState();
  const timers = timerHarness();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      hasFocus: () => true,
      isVisible: () => true,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });

  for (let index = 0; index < 15; index += 1) {
    module.onResponseCompleted('conversation-1', {
      inputTokens: 1_000,
      outputTokens: 1_000,
      service: 'gpt-5.6-sol',
    });
  }
  await flushPromises();
  assert.equal(timers.timers.size, 1);
  assert.equal(uiState.conversionState, 'armed_d1');

  timers.runAll();
  await flushPromises();
  assert.equal(uiState.conversionState, 'shown');
  assert.equal(uiState.conversionSurface, 'chat');
  assert.equal(uiState.conversionOffer?.retrospectiveUsd, '0.60');
  assert.equal(storage.getItem(STATE_KEY), 'shown');

  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: 'gpt-5.6-sol' });
  await flushPromises();
  assert.equal(timers.timers.size, 0);
});

test('request start cancels a pending idle prompt', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primePendingD1(storage, now);
  const timers = timerHarness();
  const module = initConversionModule({
    uiState: makeEligibleState(),
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  assert.equal(timers.timers.size, 1);
  module.onRequestStarted();
  assert.equal(timers.timers.size, 0);
});

test('composer activity resets idle and the callback rechecks approval gates', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primePendingD1(storage, now);
  const uiState = makeEligibleState();
  const timers = timerHarness();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  const firstTimer = [...timers.timers.keys()][0];
  module.onComposerActivity();
  assert.equal(timers.timers.size, 1);
  assert.notEqual([...timers.timers.keys()][0], firstTimer);

  uiState.chatPaymentApprovalVisible = true;
  timers.runAll();
  await flushPromises();
  assert.equal(uiState.conversionState, 'armed_d1');
  assert.equal(uiState.conversionSurface, null);
});

test('composer activity invalidates an idle callback already awaiting prices', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primePendingD1(storage, now);
  const uiState = makeEligibleState();
  const timers = timerHarness();
  let resolvePrices: ((prices: OpenRouterReferenceMap) => void) | null = null;
  const prices = new Promise<OpenRouterReferenceMap>((resolve) => { resolvePrices = resolve; });
  let priceLoads = 0;
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: () => {
        priceLoads += 1;
        return priceLoads === 1 ? Promise.resolve(referenceMap) : prices;
      },
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  assert.equal(timers.timers.size, 1);
  timers.runAll();
  await flushPromises();
  module.onComposerActivity();
  resolvePrices?.(referenceMap);
  await flushPromises();
  assert.equal(uiState.conversionState, 'armed_d1');
  assert.equal(timers.timers.size, 1);

  timers.runAll();
  await flushPromises();
  assert.equal(uiState.conversionState, 'shown');
});

test('surface priority opens Float before falling back to a notification', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primePendingD1(storage, now);
  const uiState = makeEligibleState();
  uiState.activeView = 'home';
  const timers = timerHarness();
  let floatCalls = 0;
  let nativeCalls = 0;
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      hasFocus: () => true,
      isVisible: () => true,
      loadReferencePrices: async () => referenceMap,
      presentFloat: async () => {
        floatCalls += 1;
        assert.equal(storage.getItem(STATE_KEY), 'shown');
        assert.equal(storage.getItem(VARIANT_KEY), 'd1');
        return true;
      },
      notifyNative: () => { nativeCalls += 1; },
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  timers.runAll();
  await flushPromises();
  assert.equal(floatCalls, 1);
  assert.equal(nativeCalls, 0);
  assert.equal(uiState.conversionSurface, 'float');

  const fallbackStorage = new MemoryStorage();
  primePendingD1(fallbackStorage, now);
  const fallbackState = makeEligibleState();
  fallbackState.activeView = 'home';
  const fallbackTimers = timerHarness();
  const fallbackModule = initConversionModule({
    uiState: fallbackState,
    dependencies: {
      storage: fallbackStorage,
      now: () => now,
      setTimer: fallbackTimers.setTimer,
      clearTimer: fallbackTimers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      presentFloat: async () => false,
      notifyNative: () => { nativeCalls += 1; },
      notifyChanged: () => {},
    },
  });
  fallbackModule.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  fallbackTimers.runAll();
  await flushPromises();
  assert.equal(nativeCalls, 1);
  assert.equal(fallbackState.conversionSurface, 'home');
});

test('idle callback rechecks channels and retires when one appears', async () => {
  const now = new Date(2026, 7, 11, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  primePendingD1(storage, now);
  const uiState = makeEligibleState();
  const timers = timerHarness();
  let channelChecks = 0;
  const bridge = {
    paymentsGetChannels: async () => {
      channelChecks += 1;
      return { ok: true, data: channelChecks === 1 ? [] : [{}] };
    },
  } as unknown as DesktopBridge;
  const module = initConversionModule({
    bridge,
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1_000, outputTokens: 1_000, service: null });
  await flushPromises();
  assert.equal(timers.timers.size, 1);
  timers.runAll();
  await flushPromises();
  assert.equal(channelChecks, 2);
  assert.equal(uiState.conversionState, 'done');
  assert.equal(uiState.conversionSurface, null);
});

test('armed state ignores a partially persisted shown variant', () => {
  const storage = new MemoryStorage();
  storage.setItem(STATE_KEY, 'armed_d1');
  storage.setItem(VARIANT_KEY, 'd1');
  const uiState = createInitialUiState();
  initConversionModule({
    uiState,
    dependencies: { storage, notifyChanged: () => {} },
  });
  assert.equal(uiState.conversionState, 'armed_d1');
  assert.equal(uiState.conversionVariant, null);
});

test('dev preview displays an offer even for an existing payer', async () => {
  const uiState = createInitialUiState();
  uiState.creditsTotalOwnedUsdc = '10';
  const module = initConversionModule({
    uiState,
    dependencies: { storage: new MemoryStorage(), notifyChanged: () => {} },
  });
  module.preview('d1');
  await module.reconcilePayer();
  assert.equal(uiState.conversionPreview, true);
  assert.equal(uiState.conversionSurface, 'home');
  assert.equal(uiState.conversionOffer?.prospectiveUsd, '16.00');

  module.clearPreview();
  assert.equal(uiState.conversionPreview, false);
  assert.equal(uiState.conversionOffer, null);
});

test('day rollover lazily arms D2 and uses the lower lifetime threshold', async () => {
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now - 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - 86_400_000));
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 7, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  uiState.creditsBuyerUsage = {
    totalRequests: 7,
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
      requestCount: 7,
    }],
  };
  const timers = timerHarness();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(uiState.conversionState, 'armed_d2');
  assert.equal(timers.timers.size, 1);
  timers.runAll();
  await flushPromises();
  assert.equal(uiState.conversionVariant, 'd2');
});

test('payer detection retires the feature and storage failures disable it', async () => {
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
  assert.equal(failedState.conversionEnabled, false);
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

test('dismissing reminders advances to day 5, day 15, then done', () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  const cases = [
    { variant: 'd1', expected: 'armed_d5' },
    { variant: 'd2', expected: 'armed_d5' },
    { variant: 'd5', expected: 'armed_d15' },
    { variant: 'd15', expected: 'done' },
  ] as const;

  for (const item of cases) {
    const storage = new MemoryStorage();
    storage.setItem(INSTALL_DATE_KEY, localDay(now));
    storage.setItem(INSTALLED_AT_KEY, String(now));
    storage.setItem(STATE_KEY, 'shown');
    storage.setItem(VARIANT_KEY, item.variant);
    const uiState = createInitialUiState();
    const module = initConversionModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });
    module.dismissHome();
    assert.equal(uiState.conversionState, item.expected);
    assert.equal(uiState.conversionOffer, null);
    assert.equal(uiState.conversionSurface, null);
  }
});

test('day 5 and day 15 reminders wait for their milestones', async () => {
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
    const timers = timerHarness();
    const module = initConversionModule({
      uiState,
      dependencies: {
        storage,
        now: () => now,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        loadReferencePrices: async () => referenceMap,
        notifyChanged: () => {},
      },
    });
    module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
    await flushPromises();
    assert.equal(timers.timers.size, 1);
    timers.runAll();
    await flushPromises();
    assert.equal(uiState.conversionVariant, item.variant);
  }
});

test('day 5 reminder does not show early', async () => {
  const storage = new MemoryStorage();
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();
  storage.setItem(INSTALL_DATE_KEY, localDay(now));
  storage.setItem(INSTALLED_AT_KEY, String(now));
  storage.setItem(STATE_KEY, 'armed_d5');
  storage.setItem(COUNTERS_KEY, JSON.stringify({ lifetimeRequests: 20, summariesSeeded: true, days: {} }));
  const uiState = makeEligibleState();
  const timers = timerHarness();
  const module = initConversionModule({
    uiState,
    dependencies: {
      storage,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      loadReferencePrices: async () => referenceMap,
      notifyChanged: () => {},
    },
  });
  module.onResponseCompleted('conversation-1', { inputTokens: 1, outputTokens: 1, service: null });
  await flushPromises();
  assert.equal(timers.timers.size, 0);
  assert.equal(uiState.conversionState, 'armed_d5');
});

test('an ignored day 5 offer rolls forward to day 15 on restart', () => {
  const now = new Date(2026, 7, 15, 12, 0, 0).getTime();
  const storage = new MemoryStorage();
  storage.setItem(INSTALL_DATE_KEY, localDay(now - 14 * 86_400_000));
  storage.setItem(INSTALLED_AT_KEY, String(now - 14 * 86_400_000));
  storage.setItem(STATE_KEY, 'shown');
  storage.setItem(VARIANT_KEY, 'd5');
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
  assert.equal(uiState.conversionVariant, null);
});
