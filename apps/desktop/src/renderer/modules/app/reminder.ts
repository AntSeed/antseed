import { canonicalModelKey } from '@antseed/node/model-identity';
import type {
  DesktopBuyerServiceUsage,
  DesktopBridge,
} from '../../types/bridge.js';
import type {
  ReminderOffer,
  ReminderState,
  ReminderVariant,
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
  MIN_AMMO_USD,
  MIN_NETWORK_DISCOUNT,
} from './reminder-constants.js';

const INSTALL_DATE_KEY = 'antseed.desktop.reminder.installDate';
const INSTALLED_AT_KEY = 'antseed.desktop.reminder.installedAt';
const STATE_KEY = 'antseed.desktop.reminder.state';
const COUNTERS_KEY = 'antseed.desktop.reminder.counters';
const EXISTING_PROFILE_KEYS = [
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
export type ReminderDayCounter = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  services: Record<string, ServiceCounter>;
};
type ReminderCounters = {
  lifetimeRequests: number;
  summariesSeeded: boolean;
  days: Record<string, ReminderDayCounter>;
};

export type ReminderCompletionUsage = {
  inputTokens: number;
  outputTokens: number;
  service: string | null;
};

export type ReminderModuleApi = {
  onResponseCompleted: (conversationId: string, usage: ReminderCompletionUsage) => void;
  acceptHome: () => void;
  dismissHome: () => void;
  reconcilePayer: () => Promise<void>;
};

type ReminderDependencies = {
  storage?: StorageLike | null;
  now?: () => number;
  loadReferencePrices?: () => Promise<OpenRouterReferenceMap | null>;
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
  return referenceMap[canonicalModelKey(entry.label)]
    ?? referenceMap[canonicalModelKey(entry.serviceId)]
    ?? null;
}

function paidFrontierEntries(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  return selectRecommendedVprCatalog(catalog).filter((entry) => !isFreeCatalogEntry(entry));
}

export function computeProspectiveUsd(
  catalog: VprModelCatalogEntry[],
  referenceMap: OpenRouterReferenceMap | null,
  depositUsd = DEPOSIT_SUGGESTED_USD,
): { prospectiveUsd: number; discount: number } | null {
  if (!referenceMap) return null;
  const discounts: number[] = [];

  for (const entry of paidFrontierEntries(catalog)) {
    const reference = referenceForEntry(entry, referenceMap);
    if (!reference || reference.input === null || reference.output === null) continue;
    const networkInput = entry.minInputUsdPerMillion;
    const networkOutput = entry.minOutputUsdPerMillion;
    if (
      networkInput === null || networkOutput === null
      || !Number.isFinite(networkInput) || !Number.isFinite(networkOutput)
      || networkInput <= 0 || networkOutput <= 0
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
    if (!reference) continue;
    if (reference.input !== null && reference.input >= 0) input.push(reference.input);
    if (reference.output !== null && reference.output >= 0) output.push(reference.output);
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
    const reference = referenceMap[canonicalModelKey(service.serviceName)];
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

function emptyCounter(): ReminderDayCounter {
  return { requests: 0, inputTokens: 0, outputTokens: 0, services: {} };
}

function parseCounters(raw: string | null): ReminderCounters {
  if (!raw) return { lifetimeRequests: 0, summariesSeeded: false, days: {} };
  const parsed = JSON.parse(raw) as Partial<ReminderCounters>;
  const days = parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
  return {
    lifetimeRequests: Math.max(0, Math.floor(Number(parsed.lifetimeRequests) || 0)),
    summariesSeeded: parsed.summariesSeeded === true,
    days,
  };
}

/**
 * Merge two counter snapshots, keeping the higher totals per day. Counters
 * must only ever grow: a reload or a stale HMR module instance that still
 * holds lower in-memory counts must never clobber the persisted totals.
 */
export function mergeCounters(
  existing: ReminderCounters,
  incoming: ReminderCounters,
): ReminderCounters {
  const days: ReminderCounters['days'] = {};
  for (const day of new Set([...Object.keys(existing.days), ...Object.keys(incoming.days)])) {
    const prior = existing.days[day];
    const next = incoming.days[day];
    if (!prior) {
      days[day] = next;
      continue;
    }
    if (!next) {
      days[day] = prior;
      continue;
    }
    const services: ReminderDayCounter['services'] = {};
    for (const service of new Set([...Object.keys(prior.services), ...Object.keys(next.services)])) {
      const priorService = prior.services[service];
      const nextService = next.services[service];
      services[service] = priorService && nextService
        ? {
            inputTokens: Math.max(priorService.inputTokens, nextService.inputTokens),
            outputTokens: Math.max(priorService.outputTokens, nextService.outputTokens),
          }
        : priorService ?? nextService;
    }
    days[day] = {
      requests: Math.max(prior.requests, next.requests),
      inputTokens: Math.max(prior.inputTokens, next.inputTokens),
      outputTokens: Math.max(prior.outputTokens, next.outputTokens),
      services,
    };
  }
  return {
    lifetimeRequests: Math.max(existing.lifetimeRequests, incoming.lifetimeRequests),
    summariesSeeded: existing.summariesSeeded || incoming.summariesSeeded,
    days,
  };
}

function validState(value: string | null): ReminderState | null {
  return value === 'armed_d1'
    || value === 'armed_d2'
    || value === 'armed_d5'
    || value === 'armed_d15'
    || value === 'done'
    ? value
    : null;
}

function nextReminderState(shownVariant: ReminderVariant | null): ReminderState {
  if (shownVariant === 'd15') return 'done';
  if (shownVariant === 'd5') return 'armed_d15';
  return 'armed_d5';
}

function armedStateForVariant(variant: ReminderVariant): ReminderState {
  return `armed_${variant}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
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

export function initReminderModule({
  bridge,
  uiState,
  dependencies = {},
}: {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  dependencies?: ReminderDependencies;
}): ReminderModuleApi {
  const now = dependencies.now ?? Date.now;
  const loadReferencePrices = dependencies.loadReferencePrices ?? ensureOpenRouterPrices;
  const notifyChanged = dependencies.notifyChanged ?? notifyUiStateChanged;
  let storage: StorageLike | null = dependencies.storage === undefined
    ? defaultStorage()
    : dependencies.storage;
  let enabled = storage !== null;
  let installDate = '';
  let installedAt = 0;
  let state: ReminderState = 'armed_d1';
  let counters: ReminderCounters = { lifetimeRequests: 0, summariesSeeded: false, days: {} };
  let hasChannel = false;
  const turnsByConversation = new Map<string, number>();

  function disable(): void {
    enabled = false;
    storage = null;
    uiState.reminderOffer = null;
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
      const hasReminderState = storage.getItem(STATE_KEY) !== null;
      const existingProfile = !hasReminderState
        && EXISTING_PROFILE_KEYS.some((key) => storage?.getItem(key) !== null);
      installDate = storage.getItem(INSTALL_DATE_KEY) ?? localCalendarDay(currentNow);
      installedAt = Math.max(0, Number(storage.getItem(INSTALLED_AT_KEY)) || currentNow);
      counters = parseCounters(storage.getItem(COUNTERS_KEY));
      state = validState(storage.getItem(STATE_KEY)) ?? (existingProfile ? 'armed_d2' : 'armed_d1');

      storage.setItem(INSTALL_DATE_KEY, installDate);
      storage.setItem(INSTALLED_AT_KEY, String(installedAt));
      storage.setItem(STATE_KEY, state);
      storage.setItem(COUNTERS_KEY, JSON.stringify(counters));
    } catch {
      disable();
      return;
    }
    uiState.reminderState = state;
  }

  function persistCounters(): boolean {
    if (!enabled || !storage) return false;
    try {
      const merged = mergeCounters(parseCounters(storage.getItem(COUNTERS_KEY)), counters);
      counters = merged;
      return write(COUNTERS_KEY, JSON.stringify(merged));
    } catch {
      return write(COUNTERS_KEY, JSON.stringify(counters));
    }
  }

  function persistState(next: ReminderState): boolean {
    if (!write(STATE_KEY, next)) return false;
    state = next;
    uiState.reminderState = next;
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

  function recordCompletion(conversationId: string, usage: ReminderCompletionUsage): void {
    seedSummaries();
    turnsByConversation.set(conversationId, (turnsByConversation.get(conversationId) ?? 0) + 1);
    const day = localCalendarDay(now());
    pruneCounters(day);
    const counter = counters.days[day] ?? emptyCounter();
    counter.requests += 1;
    counter.inputTokens += finiteNonNegative(usage.inputTokens);
    counter.outputTokens += finiteNonNegative(usage.outputTokens);
    if (usage.service) {
      const serviceKey = canonicalModelKey(usage.service);
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
    let visible = 0;
    if (conversationId === uiState.chatActiveConversation && Array.isArray(uiState.chatMessages)) {
      visible = uiState.chatMessages.filter((message) => (
        message && typeof message === 'object' && (message as { role?: unknown }).role === 'user'
      )).length;
    }
    // codex-desktop and other tool conversations never open in the chat view,
    // so the renderer snapshot is empty for them. Count completions observed
    // in the completing conversation as user turns instead.
    return Math.max(visible, turnsByConversation.get(conversationId) ?? 0);
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

  function dailyServices(counter: ReminderDayCounter): UsageService[] {
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

  function lifetimeRetrospectiveUsd(referenceMap: OpenRouterReferenceMap | null): number | null {
    return computeRetrospectiveUsd({
      services: lifetimeServices(),
      totalInputTokens: finiteNonNegative(uiState.creditsBuyerUsage?.totalInputTokens),
      totalOutputTokens: finiteNonNegative(uiState.creditsBuyerUsage?.totalOutputTokens),
      catalog: uiState.vprModelCatalog,
      referenceMap,
    });
  }

  async function buildOffer(nextVariant: ReminderVariant): Promise<ReminderOffer | null> {
    const referenceMap = await loadReferencePrices();
    const prospective = computeProspectiveUsd(uiState.vprModelCatalog, referenceMap);
    if (!prospective) return null;
    const today = counters.days[localCalendarDay(now())] ?? emptyCounter();
    const isD1 = nextVariant === 'd1';
    const requestsCount = isD1 ? today.requests : lifetimeRequests();
    let retrospective: number | null;
    if (isD1) {
      retrospective = computeRetrospectiveUsd({
        services: dailyServices(today),
        totalInputTokens: today.inputTokens,
        totalOutputTokens: today.outputTokens,
        catalog: uiState.vprModelCatalog,
        referenceMap,
      });
      // Completions from tool conversations (codex-desktop etc.) record the
      // request count but often carry no per-response token metadata, so the
      // daily counter can be token-less even when real usage exists. Fall
      // back to the buyer daemon's lifetime totals rather than rendering an
      // empty "worth $".
      if (retrospective === null && today.inputTokens + today.outputTokens === 0) {
        retrospective = lifetimeRetrospectiveUsd(referenceMap);
      }
    } else {
      retrospective = lifetimeRetrospectiveUsd(referenceMap);
    }
    if (retrospective === null || retrospective < MIN_AMMO_USD) return null;
    return {
      variant: nextVariant,
      requestsCount,
      retrospectiveUsd: retrospective.toFixed(2),
      prospectiveUsd: prospective.prospectiveUsd.toFixed(2),
    };
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

  async function eligibleOffer(conversationId: string): Promise<ReminderOffer | null> {
    if (!enabled || state === 'done') return null;
    const payer = await payerDetected();
    if (payer === null) return null;
    if (payer) {
      finish();
      return null;
    }
    transitionForDay();
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

  async function evaluate(conversationId: string): Promise<void> {
    const offer = await eligibleOffer(conversationId);
    if (
      !offer
      || !enabled
      || uiState.reminderOffer !== null
      || state !== armedStateForVariant(offer.variant)
    ) return;
    uiState.reminderOffer = offer;
    notifyChanged();
  }

  function finish(): void {
    uiState.reminderOffer = null;
    persistState('done');
    notifyChanged();
  }

  function advanceReminder(): void {
    const shownVariant = uiState.reminderOffer?.variant ?? null;
    const nextState = nextReminderState(shownVariant);
    persistState(nextState);
    uiState.reminderOffer = null;
    notifyChanged();
  }

  initialize();

  return {
    onResponseCompleted(conversationId, usage) {
      if (!enabled) return;
      recordCompletion(conversationId, usage);
      if (state === 'done' || uiState.reminderOffer !== null) return;
      void evaluate(conversationId);
    },
    acceptHome: advanceReminder,
    dismissHome: advanceReminder,
    async reconcilePayer() {
      if (!enabled || (await payerDetected()) !== true) return;
      finish();
    },
  };
}
