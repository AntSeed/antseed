import { normalizeModelKey } from '../../../shared/model-key.js';
import type {
  DesktopBuyerServiceUsage,
  DesktopBridge,
} from '../../types/bridge.js';
import type {
  ConversionOffer,
  ConversionState,
  ConversionVariant,
  RendererUiState,
  VprModelCatalogEntry,
} from '../../core/state.js';
import { notifyUiStateChanged } from '../../core/store.js';
import {
  ensureOpenRouterPrices,
  type OpenRouterReferenceMap,
} from '../catalog/openrouter-baseline.js';
import { selectRecommendedVprCatalog, isFreeCatalogEntry } from '../catalog/recommended.js';
import {
  COUNTER_RETENTION_DAYS,
  D1_MIN_CONVERSATIONS,
  D1_MIN_OUTPUT_TOKENS,
  D1_MIN_REQUESTS,
  D1_MIN_TURNS,
  D1_WARMUP_MS,
  D2_MIN_LIFETIME_REQUESTS,
  DEPOSIT_SUGGESTED_USD,
  IDLE_MS,
  MIN_AMMO_USD,
  MIN_NETWORK_DISCOUNT,
} from './conversion-constants.js';

const INSTALL_DATE_KEY = 'antseed.desktop.conversion.installDate';
const INSTALLED_AT_KEY = 'antseed.desktop.conversion.installedAt';
const STATE_KEY = 'antseed.desktop.conversion.state';
const VARIANT_KEY = 'antseed.desktop.conversion.variant';
const SHOWN_AT_KEY = 'antseed.desktop.conversion.shownAt';
const COUNTERS_KEY = 'antseed.desktop.conversion.counters';
const HOME_DISMISSED_KEY = 'antseed.desktop.conversion.homeDismissed';
const LEGACY_PROFILE_KEYS = [
  'antseed.desktop.vpr.hasChats',
  'antseed.desktop.vpr.preferences',
  'antseed.desktop.vpr.routeSelection',
  'antseed.desktop.vpr.modelPins',
  'antseed.desktop.vpr.favoriteModels',
  'antseed.desktop.vpr.floatAutoOpen',
  'antseed.desktop.vpr.floatShowRoutedPeer',
  'antseed.desktop.vpr.addBalanceDismissed',
] as const;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type ServiceCounter = { inputTokens: number; outputTokens: number };
export type ConversionDayCounter = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  services: Record<string, ServiceCounter>;
};
type ConversionCounters = {
  lifetimeRequests: number;
  summariesSeeded: boolean;
  days: Record<string, ConversionDayCounter>;
};

export type ConversionCompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  service: string | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ConversionModuleApi = {
  onResponseCompleted: (conversationId: string, usage: ConversionCompletionUsage) => void;
  onRequestStarted: () => void;
  onComposerActivity: () => void;
  dismissPrompt: () => void;
  acceptPrompt: () => void;
  dismissHome: () => void;
  reconcilePayer: () => Promise<void>;
  refreshOffer: () => Promise<ConversionOffer | null>;
  preview: (variant: ConversionVariant) => void;
  clearPreview: () => void;
  setFloatPresenter: (present: (() => Promise<boolean>) | null) => void;
  setFloatRefresh: (refresh: (() => Promise<void>) | null) => void;
};

type ConversionDependencies = {
  storage?: StorageLike | null;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  hasFocus?: () => boolean;
  isVisible?: () => boolean;
  loadReferencePrices?: () => Promise<OpenRouterReferenceMap | null>;
  notifyNative?: (offer: ConversionOffer) => Promise<unknown> | void;
  presentFloat?: () => Promise<boolean>;
  notifyChanged?: () => void;
};

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function localCalendarDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? null : (left + right) / 2;
}

function referenceForEntry(
  entry: VprModelCatalogEntry,
  referenceMap: OpenRouterReferenceMap,
) {
  return referenceMap[normalizeModelKey(entry.label)]
    ?? referenceMap[normalizeModelKey(entry.serviceId)]
    ?? null;
}

function paidFrontierEntries(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  return selectRecommendedVprCatalog(catalog).filter((entry) => !isFreeCatalogEntry(entry));
}

export type ConversionModelProof = {
  provider: string;
  serviceId: string;
  label: string;
  discountPct: number;
};

function modelDiscount(
  entry: VprModelCatalogEntry,
  referenceMap: OpenRouterReferenceMap,
): number | null {
  const networkInput = entry.minInputUsdPerMillion;
  const networkOutput = entry.minOutputUsdPerMillion;
  const reference = referenceForEntry(entry, referenceMap);
  if (
    networkInput === null || networkOutput === null
    || !Number.isFinite(networkInput) || !Number.isFinite(networkOutput)
    || networkInput < 0 || networkOutput < 0
    || reference?.input === null || reference?.output === null
    || reference?.input === undefined || reference?.output === undefined
  ) return null;

  const retail = (reference.input + 3 * reference.output) / 4;
  const network = (networkInput + 3 * networkOutput) / 4;
  if (!(retail > 0) || network >= retail) return null;
  return 1 - network / retail;
}

export function selectConversionModelProof(
  catalog: VprModelCatalogEntry[],
  referenceMap: OpenRouterReferenceMap | null,
  limit = 3,
): ConversionModelProof[] {
  if (!referenceMap || limit <= 0) return [];
  return paidFrontierEntries(catalog)
    .map((entry) => ({ entry, discount: modelDiscount(entry, referenceMap) }))
    .filter((result): result is { entry: VprModelCatalogEntry; discount: number } =>
      result.discount !== null && result.discount >= MIN_NETWORK_DISCOUNT)
    .slice(0, limit)
    .map(({ entry, discount }) => ({
      provider: entry.provider,
      serviceId: entry.serviceId,
      label: entry.label,
      discountPct: Math.round(discount * 100),
    }));
}

export function computeProspectiveUsd(
  catalog: VprModelCatalogEntry[],
  referenceMap: OpenRouterReferenceMap | null,
  depositUsd = DEPOSIT_SUGGESTED_USD,
): { prospectiveUsd: number; discount: number } | null {
  if (!referenceMap) return null;
  const discounts: number[] = [];

  for (const entry of paidFrontierEntries(catalog)) {
    const networkInput = entry.minInputUsdPerMillion;
    const networkOutput = entry.minOutputUsdPerMillion;
    const reference = referenceForEntry(entry, referenceMap);
    if (
      networkInput === null || networkOutput === null
      || !Number.isFinite(networkInput) || !Number.isFinite(networkOutput)
      || networkInput < 0 || networkOutput < 0
      || reference?.input === null || reference?.output === null
      || reference?.input === undefined || reference?.output === undefined
    ) continue;

    const official = (reference.input + 3 * reference.output) / 4;
    const network = (networkInput + 3 * networkOutput) / 4;
    if (!(official > 0)) continue;
    discounts.push(1 - network / official);
  }

  const discount = median(discounts);
  if (discount === null || discount < MIN_NETWORK_DISCOUNT || discount >= 1) return null;
  const rawProspective = depositUsd / (1 - discount);
  return {
    discount,
    prospectiveUsd: Math.round(rawProspective * 2) / 2,
  };
}

function frontierReferenceMedians(
  catalog: VprModelCatalogEntry[],
  referenceMap: OpenRouterReferenceMap,
): { input: number; output: number } | null {
  const input: number[] = [];
  const output: number[] = [];
  for (const entry of paidFrontierEntries(catalog)) {
    const reference = referenceForEntry(entry, referenceMap);
    if (reference?.input !== null && reference?.input !== undefined && reference.input >= 0) {
      input.push(reference.input);
    }
    if (reference?.output !== null && reference?.output !== undefined && reference.output >= 0) {
      output.push(reference.output);
    }
  }
  const inputMedian = median(input);
  const outputMedian = median(output);
  if (inputMedian === null || outputMedian === null || inputMedian + outputMedian <= 0) return null;
  return { input: inputMedian, output: outputMedian };
}

type UsageService = {
  serviceName: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
};

export function computeRetrospectiveUsd({
  services,
  totalInputTokens,
  totalOutputTokens,
  catalog,
  referenceMap,
}: {
  services: UsageService[];
  totalInputTokens: number;
  totalOutputTokens: number;
  catalog: VprModelCatalogEntry[];
  referenceMap: OpenRouterReferenceMap | null;
}): number | null {
  if (!referenceMap) return null;
  let baselineUsd = 0;
  let matchedInput = 0;
  let matchedOutput = 0;

  for (const service of services) {
    if (!service.serviceName) continue;
    const reference = referenceMap[normalizeModelKey(service.serviceName)];
    if (!reference || (reference.input === null && reference.output === null)) continue;
    const inputTokens = finiteNonNegative(service.inputTokens);
    const outputTokens = finiteNonNegative(service.outputTokens);
    const cachedInput = Math.min(finiteNonNegative(service.cachedInputTokens), inputTokens);
    const freshInput = inputTokens - cachedInput;
    const inputPrice = reference.input ?? 0;
    const cachedPrice = reference.cachedInput ?? inputPrice;
    const outputPrice = reference.output ?? 0;
    if (reference.input !== null) {
      baselineUsd += (freshInput * inputPrice + cachedInput * cachedPrice) / 1_000_000;
      matchedInput += inputTokens;
    }
    if (reference.output !== null) {
      baselineUsd += outputTokens * outputPrice / 1_000_000;
      matchedOutput += outputTokens;
    }
  }

  const unmatchedInput = Math.max(0, finiteNonNegative(totalInputTokens) - matchedInput);
  const unmatchedOutput = Math.max(0, finiteNonNegative(totalOutputTokens) - matchedOutput);
  if (unmatchedInput > 0 || unmatchedOutput > 0) {
    const medians = frontierReferenceMedians(catalog, referenceMap);
    if (medians) {
      baselineUsd += (
        unmatchedInput * medians.input
        + unmatchedOutput * medians.output
      ) / 1_000_000;
    }
  }

  return baselineUsd > 0 ? baselineUsd : null;
}

function emptyCounter(): ConversionDayCounter {
  return { requests: 0, inputTokens: 0, outputTokens: 0, services: {} };
}

function parseCounters(raw: string | null): ConversionCounters {
  if (!raw) return { lifetimeRequests: 0, summariesSeeded: false, days: {} };
  const parsed = JSON.parse(raw) as Partial<ConversionCounters>;
  const days = parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
  return {
    lifetimeRequests: Math.max(0, Math.floor(Number(parsed.lifetimeRequests) || 0)),
    summariesSeeded: parsed.summariesSeeded === true,
    days,
  };
}

function validState(value: string | null): ConversionState | null {
  return value === 'armed_d1'
    || value === 'armed_d2'
    || value === 'armed_d5'
    || value === 'armed_d15'
    || value === 'shown'
    || value === 'done'
    ? value
    : null;
}

function validVariant(value: string | null): ConversionVariant | null {
  return value === 'd1' || value === 'd2' || value === 'd5' || value === 'd15'
    ? value
    : null;
}

function nextReminderState(shownVariant: ConversionVariant | null): ConversionState {
  if (shownVariant === 'd15') return 'done';
  if (shownVariant === 'd5') return 'armed_d15';
  return 'armed_d5';
}

function reminderExpired(shownVariant: ConversionVariant | null, ageDays: number): boolean {
  return ((shownVariant === 'd1' || shownVariant === 'd2') && ageDays >= 4)
    || (shownVariant === 'd5' && ageDays >= 14);
}

function calendarDayOrdinal(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(date)) return null;
  return Math.floor(Date.UTC(year, month - 1, date) / 86_400_000);
}

export function initConversionModule({
  bridge,
  uiState,
  dependencies = {},
}: {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  dependencies?: ConversionDependencies;
}): ConversionModuleApi {
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
  const hasFocus = dependencies.hasFocus ?? (() => typeof document !== 'undefined' && document.hasFocus());
  const isVisible = dependencies.isVisible ?? (() => typeof document !== 'undefined' && document.visibilityState === 'visible');
  const loadReferencePrices = dependencies.loadReferencePrices ?? ensureOpenRouterPrices;
  const notifyChanged = dependencies.notifyChanged ?? notifyUiStateChanged;
  const notifyNative = dependencies.notifyNative ?? ((offer) => bridge?.conversionNotify?.({
    variant: offer.variant,
    retrospectiveUsd: offer.retrospectiveUsd,
    prospectiveUsd: offer.prospectiveUsd,
  }));
  let storage: StorageLike | null = dependencies.storage === undefined
    ? (() => {
      try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
    })()
    : dependencies.storage;
  let enabled = storage !== null;
  let installDate = '';
  let installedAt = 0;
  let state: ConversionState = 'armed_d1';
  let variant: ConversionVariant | null = null;
  let shownAt = 0;
  let counters: ConversionCounters = { lifetimeRequests: 0, summariesSeeded: false, days: {} };
  let idleTimer: TimerHandle | null = null;
  let idleGeneration = 0;
  let eligibleForIdle = false;
  let hasChannel = false;
  let floatPresenter = dependencies.presentFloat ?? null;
  let floatRefresh: (() => Promise<void>) | null = null;

  function disable(): void {
    enabled = false;
    storage = null;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    eligibleForIdle = false;
    uiState.conversionOffer = null;
    uiState.conversionSurface = null;
    uiState.conversionEnabled = false;
  }

  function write(key: string, value: string): boolean {
    if (!enabled || !storage) return false;
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      disable();
      return false;
    }
  }

  function initialize(): void {
    if (!storage) {
      disable();
      return;
    }
    try {
      const currentNow = now();
      const hasConversionState = storage.getItem(STATE_KEY) !== null;
      const existingProfile = !hasConversionState
        && LEGACY_PROFILE_KEYS.some((key) => storage?.getItem(key) !== null);
      installDate = storage.getItem(INSTALL_DATE_KEY) ?? localCalendarDay(currentNow);
      installedAt = Math.max(0, Number(storage.getItem(INSTALLED_AT_KEY)) || currentNow);
      state = validState(storage.getItem(STATE_KEY)) ?? (existingProfile ? 'armed_d2' : 'armed_d1');
      variant = validVariant(storage.getItem(VARIANT_KEY));
      shownAt = Math.max(0, Number(storage.getItem(SHOWN_AT_KEY)) || 0);
      if (state.startsWith('armed_')) {
        variant = null;
        shownAt = 0;
      }
      counters = parseCounters(storage.getItem(COUNTERS_KEY));
      uiState.conversionHomeDismissed = storage.getItem(HOME_DISMISSED_KEY) === '1';

      const currentDay = calendarDayOrdinal(localCalendarDay(currentNow));
      const firstDay = calendarDayOrdinal(installDate);
      const ageDays = currentDay === null || firstDay === null ? 0 : Math.max(0, currentDay - firstDay);
      const staleShownState = state === 'shown' && reminderExpired(variant, ageDays);
      if (state === 'shown' && (uiState.conversionHomeDismissed || staleShownState)) {
        state = nextReminderState(variant);
        variant = null;
        shownAt = 0;
        uiState.conversionHomeDismissed = false;
        storage.setItem(VARIANT_KEY, '');
        storage.setItem(SHOWN_AT_KEY, '0');
        storage.setItem(HOME_DISMISSED_KEY, '0');
      }

      storage.setItem(INSTALL_DATE_KEY, installDate);
      storage.setItem(INSTALLED_AT_KEY, String(installedAt));
      storage.setItem(STATE_KEY, state);
      storage.setItem(COUNTERS_KEY, JSON.stringify(counters));
    } catch {
      disable();
      return;
    }
    uiState.conversionEnabled = true;
    uiState.conversionState = state;
    uiState.conversionVariant = variant;
    uiState.conversionShownAt = shownAt;
  }

  function persistCounters(): boolean {
    return write(COUNTERS_KEY, JSON.stringify(counters));
  }

  function persistState(next: ConversionState): boolean {
    if (!write(STATE_KEY, next)) return false;
    state = next;
    uiState.conversionState = next;
    return true;
  }

  function seedSummaries(): void {
    if (counters.summariesSeeded || !uiState.chatConversationsLoaded) return;
    const summaries = Array.isArray(uiState.chatConversations) ? uiState.chatConversations : [];
    const estimatedRequests = summaries.reduce<number>((sum, item) => {
      if (!item || typeof item !== 'object') return sum;
      const messageCount = Math.max(0, Math.floor(Number((item as { messageCount?: unknown }).messageCount) || 0));
      return sum + Math.floor(messageCount / 2);
    }, 0);
    counters.lifetimeRequests = Math.max(counters.lifetimeRequests, estimatedRequests);
    counters.summariesSeeded = true;
    persistCounters();
  }

  function pruneCounters(currentDay: string): void {
    const current = new Date(`${currentDay}T12:00:00`).getTime();
    for (const day of Object.keys(counters.days)) {
      const timestamp = new Date(`${day}T12:00:00`).getTime();
      const ageDays = Math.floor((current - timestamp) / 86_400_000);
      if (!Number.isFinite(timestamp) || ageDays >= COUNTER_RETENTION_DAYS) delete counters.days[day];
    }
  }

  function recordCompletion(usage: ConversionCompletionUsage): void {
    seedSummaries();
    const day = localCalendarDay(now());
    pruneCounters(day);
    const counter = counters.days[day] ?? emptyCounter();
    counter.requests += 1;
    counter.inputTokens += finiteNonNegative(usage.inputTokens);
    counter.outputTokens += finiteNonNegative(usage.outputTokens);
    if (usage.service) {
      const serviceKey = normalizeModelKey(usage.service);
      if (serviceKey) {
        const service = counter.services[serviceKey] ?? { inputTokens: 0, outputTokens: 0 };
        service.inputTokens += finiteNonNegative(usage.inputTokens);
        service.outputTokens += finiteNonNegative(usage.outputTokens);
        counter.services[serviceKey] = service;
      }
    }
    counters.days[day] = counter;
    counters.lifetimeRequests += 1;
    persistCounters();
  }

  function lifetimeRequests(): number {
    seedSummaries();
    return Math.max(
      counters.lifetimeRequests,
      Math.max(0, Math.floor(Number(uiState.creditsBuyerUsage?.totalRequests) || 0)),
    );
  }

  function visibleUserTurns(conversationId: string): number {
    if (conversationId !== uiState.chatActiveConversation || !Array.isArray(uiState.chatMessages)) return 0;
    return uiState.chatMessages.filter((message) => (
      message && typeof message === 'object' && (message as { role?: unknown }).role === 'user'
    )).length;
  }

  function hasDepositInState(): boolean {
    return finiteNonNegative(uiState.creditsTotalOwnedUsdc) > 0
      || uiState.creditsChannels.length > 0
      || hasChannel;
  }

  async function payerDetected(): Promise<boolean | null> {
    if (hasDepositInState()) return true;
    if (bridge?.paymentsGetChannels) {
      try {
        const result = await bridge.paymentsGetChannels();
        if (!result?.ok || !Array.isArray(result.data)) return null;
        hasChannel ||= result.data.length > 0;
      } catch {
        return null;
      }
    }
    return hasDepositInState();
  }

  function dailyServices(counter: ConversionDayCounter): UsageService[] {
    return Object.entries(counter.services).map(([serviceName, totals]) => ({
      serviceName,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
    }));
  }

  function lifetimeServices(): UsageService[] {
    return (uiState.creditsBuyerUsage?.services ?? []).map((service: DesktopBuyerServiceUsage) => ({
      serviceName: service.serviceName,
      inputTokens: finiteNonNegative(service.inputTokens),
      outputTokens: finiteNonNegative(service.outputTokens),
      cachedInputTokens: finiteNonNegative(service.cachedInputTokens),
    }));
  }

  async function buildOffer(nextVariant: ConversionVariant): Promise<ConversionOffer | null> {
    const referenceMap = await loadReferencePrices();
    const prospective = computeProspectiveUsd(uiState.vprModelCatalog, referenceMap);
    if (!prospective) return null;
    const today = counters.days[localCalendarDay(now())] ?? emptyCounter();
    const isD1 = nextVariant === 'd1';
    const requestsCount = isD1 ? today.requests : lifetimeRequests();
    const retrospective = isD1
      ? computeRetrospectiveUsd({
        services: dailyServices(today),
        totalInputTokens: today.inputTokens,
        totalOutputTokens: today.outputTokens,
        catalog: uiState.vprModelCatalog,
        referenceMap,
      })
      : computeRetrospectiveUsd({
        services: lifetimeServices(),
        totalInputTokens: finiteNonNegative(uiState.creditsBuyerUsage?.totalInputTokens),
        totalOutputTokens: finiteNonNegative(uiState.creditsBuyerUsage?.totalOutputTokens),
        catalog: uiState.vprModelCatalog,
        referenceMap,
      });
    if (retrospective !== null && retrospective < MIN_AMMO_USD) return null;
    const runRate = isD1 && retrospective !== null ? Math.round(retrospective * 30) : null;
    return {
      variant: nextVariant,
      requestsCount,
      retrospectiveUsd: retrospective === null ? '' : retrospective.toFixed(2),
      prospectiveUsd: prospective.prospectiveUsd.toFixed(2),
      runRateUsdMonthly: runRate !== null && runRate >= DEPOSIT_SUGGESTED_USD ? String(runRate) : null,
    };
  }

  function noCompetingPrompt(): boolean {
    return !uiState.chatPaymentApprovalVisible && uiState.chatToolApprovalRequests.length === 0;
  }

  function noRequestInFlight(): boolean {
    return !uiState.chatSending
      && uiState.chatSendingConversationIds.length === 0
      && uiState.chatStreamingMessage === null;
  }

  function installAgeDays(): number {
    const current = calendarDayOrdinal(localCalendarDay(now()));
    const installed = calendarDayOrdinal(installDate);
    if (current === null || installed === null) return 0;
    return Math.max(0, current - installed);
  }

  function transitionForDay(): void {
    const ageDays = installAgeDays();
    if ((state === 'armed_d1' || state === 'armed_d2' || state === 'armed_d5') && ageDays >= 14) {
      persistState('armed_d15');
      return;
    }
    if ((state === 'armed_d1' || state === 'armed_d2') && ageDays >= 4) {
      persistState('armed_d5');
      return;
    }
    if (state === 'armed_d1' && ageDays >= 1) persistState('armed_d2');
  }

  async function eligibleOffer(conversationId: string): Promise<ConversionOffer | null> {
    if (!enabled || state === 'shown' || state === 'done') return null;
    const payer = await payerDetected();
    if (payer === null) return null;
    if (payer) {
      finish();
      return null;
    }
    transitionForDay();
    if (!noCompetingPrompt() || !noRequestInFlight()) return null;
    const currentDay = localCalendarDay(now());
    const today = counters.days[currentDay] ?? emptyCounter();

    if (state === 'armed_d1') {
      if (currentDay !== installDate) return null;
      if (now() - installedAt < D1_WARMUP_MS) return null;
      if (uiState.chatConversations.length < D1_MIN_CONVERSATIONS) return null;
      if (today.requests < D1_MIN_REQUESTS && today.outputTokens < D1_MIN_OUTPUT_TOKENS) return null;
      if (visibleUserTurns(conversationId) < D1_MIN_TURNS) return null;
      return buildOffer('d1');
    }

    const ageDays = installAgeDays();
    if (state === 'armed_d5' && ageDays < 4) return null;
    if (state === 'armed_d15' && ageDays < 14) return null;
    if (today.requests < 1 || lifetimeRequests() < D2_MIN_LIFETIME_REQUESTS) return null;
    if (state === 'armed_d15') return buildOffer('d15');
    if (state === 'armed_d5') return buildOffer('d5');
    return buildOffer('d2');
  }

  async function showAfterIdle(conversationId: string, generation: number): Promise<void> {
    if (generation !== idleGeneration) return;
    idleTimer = null;
    if (!eligibleForIdle) return;
    const offer = await eligibleOffer(conversationId);
    if (!offer || !enabled || !eligibleForIdle || generation !== idleGeneration) return;
    const shownTimestamp = now();
    if (!write(VARIANT_KEY, offer.variant)) return;
    if (!write(SHOWN_AT_KEY, String(shownTimestamp))) return;
    if (!persistState('shown')) return;
    variant = offer.variant;
    shownAt = shownTimestamp;
    uiState.conversionVariant = variant;
    uiState.conversionShownAt = shownAt;
    uiState.conversionOffer = offer;
    uiState.conversionHomeDismissed = false;
    write(HOME_DISMISSED_KEY, '0');
    eligibleForIdle = false;

    if (isVisible() && hasFocus() && uiState.activeView === 'chat') {
      uiState.conversionSurface = 'chat';
      notifyChanged();
      return;
    }

    if (floatPresenter) {
      uiState.conversionSurface = 'float';
      notifyChanged();
      try {
        if (await floatPresenter()) return;
      } catch {
        // Fall through to the native-notification surface.
      }
      if (!enabled || state === 'done' || hasDepositInState()) return;
    }

    uiState.conversionSurface = 'home';
    notifyChanged();
    void notifyNative(offer);
  }

  function scheduleIdle(conversationId: string): void {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleGeneration += 1;
    const generation = idleGeneration;
    idleTimer = setTimer(() => { void showAfterIdle(conversationId, generation); }, IDLE_MS);
  }

  async function evaluate(conversationId: string): Promise<void> {
    const offer = await eligibleOffer(conversationId);
    if (!offer || !enabled) {
      eligibleForIdle = false;
      return;
    }
    eligibleForIdle = true;
    scheduleIdle(conversationId);
  }

  function cancelIdle(keepEligible = false): void {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    idleGeneration += 1;
    if (!keepEligible) eligibleForIdle = false;
  }

  function finish(): void {
    cancelIdle();
    persistState('done');
    uiState.conversionSurface = null;
    notifyChanged();
    void floatRefresh?.();
  }

  function advanceReminder(): void {
    if (uiState.conversionPreview) {
      uiState.conversionHomeDismissed = true;
      uiState.conversionSurface = null;
      notifyChanged();
      void floatRefresh?.();
      return;
    }
    cancelIdle();
    const shownVariant = variant ?? uiState.conversionOffer?.variant ?? null;
    const nextState = nextReminderState(shownVariant);
    persistState(nextState);
    variant = null;
    shownAt = 0;
    uiState.conversionVariant = null;
    uiState.conversionShownAt = 0;
    uiState.conversionOffer = null;
    uiState.conversionSurface = null;
    uiState.conversionHomeDismissed = false;
    write(VARIANT_KEY, '');
    write(SHOWN_AT_KEY, '0');
    write(HOME_DISMISSED_KEY, '0');
    notifyChanged();
    void floatRefresh?.();
  }

  function advanceExpiredReminder(): boolean {
    if (state !== 'shown' || !reminderExpired(variant, installAgeDays())) return false;
    const nextState = nextReminderState(variant);
    persistState(nextState);
    variant = null;
    shownAt = 0;
    uiState.conversionVariant = null;
    uiState.conversionShownAt = 0;
    uiState.conversionOffer = null;
    uiState.conversionSurface = null;
    uiState.conversionHomeDismissed = false;
    write(VARIANT_KEY, '');
    write(SHOWN_AT_KEY, '0');
    write(HOME_DISMISSED_KEY, '0');
    return true;
  }

  async function refreshOffer(): Promise<ConversionOffer | null> {
    if (uiState.conversionPreview) return uiState.conversionOffer;
    if (!enabled || !variant || hasDepositInState()) {
      if (hasDepositInState()) uiState.conversionOffer = null;
      return null;
    }
    const offer = await buildOffer(variant);
    if (offer) {
      uiState.conversionOffer = offer;
      notifyChanged();
      void floatRefresh?.();
    }
    return offer;
  }

  initialize();
  if (enabled && variant) void refreshOffer();

  return {
    onResponseCompleted(conversationId, usage) {
      if (!enabled) return;
      recordCompletion(usage);
      if (advanceExpiredReminder()) {
        void evaluate(conversationId);
        return;
      }
      if (state === 'shown' || state === 'done') {
        if (variant) void refreshOffer();
        return;
      }
      void evaluate(conversationId);
    },
    onRequestStarted() {
      cancelIdle();
    },
    onComposerActivity() {
      if (!eligibleForIdle) return;
      scheduleIdle(uiState.chatActiveConversation ?? '');
    },
    dismissPrompt: advanceReminder,
    acceptPrompt: advanceReminder,
    dismissHome: advanceReminder,
    async reconcilePayer() {
      if (uiState.conversionPreview) return;
      if (!enabled || (await payerDetected()) !== true) return;
      uiState.conversionOffer = null;
      finish();
    },
    refreshOffer,
    preview(nextVariant) {
      const isD1 = nextVariant === 'd1';
      const isD5 = nextVariant === 'd5';
      const isD15 = nextVariant === 'd15';
      uiState.conversionPreview = true;
      uiState.conversionEnabled = true;
      uiState.conversionVariant = nextVariant;
      uiState.conversionOffer = {
        variant: nextVariant,
        requestsCount: isD1 ? 23 : isD5 ? 41 : isD15 ? 96 : 13,
        retrospectiveUsd: isD1 ? '2.10' : isD5 ? '4.85' : isD15 ? '11.40' : '1.27',
        prospectiveUsd: '16.00',
        runRateUsdMonthly: isD1 ? '63' : null,
      };
      uiState.conversionSurface = 'home';
      uiState.conversionHomeDismissed = false;
      notifyChanged();
    },
    clearPreview() {
      uiState.conversionPreview = false;
      uiState.conversionOffer = null;
      uiState.conversionSurface = null;
      uiState.conversionVariant = variant;
      notifyChanged();
      if (variant) void refreshOffer();
    },
    setFloatPresenter(present) {
      floatPresenter = present;
    },
    setFloatRefresh(refresh) {
      floatRefresh = refresh;
    },
  };
}
