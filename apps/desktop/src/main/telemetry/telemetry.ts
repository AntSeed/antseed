/**
 * Privacy-first product telemetry for the desktop app (design: the PostHog
 * activation-funnel issue).
 *
 * What this service guarantees:
 * - A random anonymous install ID, generated once and persisted; never
 *   derived from a wallet, machine, hostname, account, or OS identifier.
 * - A fresh random session ID per launch.
 * - Only events from ./events.ts's typed catalog are sent, and every
 *   property passes through ./sanitize.ts's allowlist — unknown properties
 *   are dropped, strings truncated, numbers bounded.
 * - Disabled in development builds, when the TELEMETRY_ENABLED kill switch
 *   is falsy, when PostHog config is missing, or when the user opts out in
 *   Settings.
 * - Fire-and-forget transport: telemetry failures never affect the app.
 * - First-open and first-chat events fire exactly once per installation.
 */
import { randomUUID } from 'node:crypto';
import {
  TELEMETRY_SCHEMA_VERSION,
  countBucket,
  daysSinceFirstOpenBucket,
  depositAmountBucket,
  durationBucket,
  sessionDurationBucket,
  type FirstChatDepositSnapshot,
  type TelemetryEventName,
  type TelemetryEventProperties,
} from './events.js';
import { sanitizeTelemetryProperties } from './sanitize.js';
import { createPostHogTransport, type PostHogTransport } from './posthog.js';
import {
  loadTelemetryState,
  saveTelemetryState,
  type TelemetryState,
} from './state.js';
import {
  BAKED_POSTHOG_HOST,
  BAKED_POSTHOG_PROJECT_API_KEY,
} from '../generated/baked-defaults.js';

export const TELEMETRY_ENABLED_ENV = 'TELEMETRY_ENABLED';
export const POSTHOG_HOST_ENV = 'POSTHOG_HOST';
export const POSTHOG_PROJECT_API_KEY_ENV = 'POSTHOG_PROJECT_API_KEY';
export const INSTALL_SOURCE_ENV = 'INSTALL_SOURCE';

const USDC_BASE_UNITS = 1_000_000n;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'false' || normalized === '0' || normalized === 'no';
}

function configValue(env: NodeJS.ProcessEnv, key: string, baked: string | null): string {
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    return (env[key] ?? '').trim();
  }
  return baked?.trim() ?? '';
}

function normalizeInstallSource(value: string | undefined, platform: string, env: NodeJS.ProcessEnv): string {
  if (!value) {
    if (platform === 'darwin') return 'dmg';
    if (platform === 'win32') return 'nsis';
    if (platform === 'linux') return env['APPIMAGE'] ? 'appimage' : 'deb';
    return 'unknown';
  }
  const normalized = value.trim().toLowerCase();
  return ['dmg', 'nsis', 'appimage', 'deb'].includes(normalized) ? normalized : 'unknown';
}

function isValidHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

export type TelemetryContext = {
  platform: string;
  arch: string;
  appVersion: string;
  installSource: string;
};

export type TelemetryService = {
  readonly enabled: boolean;
  context: () => TelemetryContext;
  /** Emits app_first_opened (once) and app_started; handles crash recovery. */
  recordAppStarted: (nowMs?: number) => Promise<void>;
  recordNetworkRuntimeStarted: (nowMs?: number) => Promise<void>;
  recordDhtStarted: (routingNodeCount: number, nowMs?: number) => Promise<void>;
  recordPeersDiscovered: (peerCount: number, serviceCount: number, nowMs?: number) => Promise<void>;
  /** Arms the setup-duration clock. Call when first-run setup begins. */
  recordSetupStarted: (nowMs?: number) => Promise<void>;
  recordSetupCompleted: (nowMs?: number) => Promise<void>;
  /** Deposit observed credited; amount never leaves the device, only a bucket. */
  recordDepositCredited: (amountBaseUnits: string, nowMs?: number) => Promise<void>;
  recordDepositFailed: (input: {
    failureCode: TelemetryEventProperties['deposit_failed']['failure_code'];
    failureStage: TelemetryEventProperties['deposit_failed']['failure_stage'];
    retryable: boolean;
  }, nowMs?: number) => Promise<void>;
  /** Fires at most once per installation. */
  recordFirstChatStarted: (input: {
    serviceCategory: TelemetryEventProperties['first_chat_started']['service_category'];
    hasAttachments: boolean;
  } & FirstChatDepositSnapshot, nowMs?: number) => Promise<void>;
  recordModelSelected: (
    input: TelemetryEventProperties['model_selected'],
    nowMs?: number,
  ) => Promise<void>;
  recordChatRequestStarted: (
    input: TelemetryEventProperties['chat_request_started'],
    nowMs?: number,
  ) => Promise<void>;
  recordChatRequestFinished: (
    input: TelemetryEventProperties['chat_request_finished'],
    nowMs?: number,
  ) => Promise<void>;
  recordDiscoveryCompleted: (
    input: TelemetryEventProperties['discovery_completed'],
    nowMs?: number,
  ) => Promise<void>;
  /** Clean shutdown: emits app_closed and clears the crash flag. */
  recordCleanShutdown: (nowMs?: number) => Promise<void>;
  isUserOptedOut: () => boolean;
  setUserOptedOut: (disabled: boolean) => Promise<void>;
};

export type CreateTelemetryServiceOptions = {
  userDataDir: string;
  isDev: boolean;
  appVersion: string;
  platform: string;
  arch: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  transport?: PostHogTransport;
  heartbeatIntervalMs?: number | null;
};

export async function createTelemetryService(
  options: CreateTelemetryServiceOptions,
): Promise<TelemetryService> {
  const env = options.env ?? process.env;
  const now = options.nowMs ?? (() => Date.now());

  const envDisabled = isFalsyEnv(env[TELEMETRY_ENABLED_ENV]);
  const host = configValue(env, POSTHOG_HOST_ENV, BAKED_POSTHOG_HOST);
  const apiKey = configValue(env, POSTHOG_PROJECT_API_KEY_ENV, BAKED_POSTHOG_PROJECT_API_KEY);
  const configMissing = host.length === 0 || apiKey.length === 0 || !isValidHttpsUrl(host);
  const staticDisabled = options.isDev || envDisabled || configMissing;

  const context: TelemetryContext = {
    platform: options.platform,
    arch: options.arch,
    appVersion: options.appVersion,
    installSource: normalizeInstallSource(env[INSTALL_SOURCE_ENV], options.platform, env),
  };

  // State loads even when statically disabled so the in-app toggle answers
  // correctly and nothing crashes in dev.
  const state: TelemetryState = await loadTelemetryState(options.userDataDir);

  const transport: PostHogTransport = options.transport
    ?? createPostHogTransport({ host: host || 'https://localhost', projectApiKey: apiKey || 'disabled' });

  const sessionId = randomUUID();
  let saveQueue = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = { ...state };
    const pending = saveQueue.then(() => saveTelemetryState(options.userDataDir, snapshot));
    saveQueue = pending.catch(() => {});
    return pending;
  };
  const heartbeatIntervalMs = options.heartbeatIntervalMs === undefined
    ? DEFAULT_HEARTBEAT_INTERVAL_MS
    : options.heartbeatIntervalMs;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let hasEmittedNetworkRuntimeStarted = false;
  let hasEmittedDhtStarted = false;
  let hasEmittedPeersDiscovered = false;

  const isEnabled = () => !staticDisabled && !state.telemetryDisabled;

  const track = <K extends TelemetryEventName>(
    event: K,
    properties: TelemetryEventProperties[K],
    eventTsMs = now(),
    captureSessionId: string = sessionId,
  ): boolean => {
    if (!isEnabled()) return false;
    const payload = {
      event,
      distinct_id: state.installId,
      timestamp: new Date(eventTsMs).toISOString(),
      properties: {
        distinct_id: state.installId,
        $geoip_disable: true,
        $process_person_profile: false,
        schema_version: TELEMETRY_SCHEMA_VERSION,
        event_ts_ms: eventTsMs,
        session_id: captureSessionId,
        install_id: state.installId,
        app_version: context.appVersion,
        platform: context.platform,
        arch: context.arch,
        install_source: context.installSource,
        ...sanitizeTelemetryProperties(event, properties),
      },
    };
    void transport(payload).catch(() => {});
    return true;
  };

  const daysSinceFirstOpen = (nowMs: number): number => {
    if (state.firstOpenedAtMs === null) return 0;
    return Math.max(0, Math.floor((nowMs - state.firstOpenedAtMs) / MS_PER_DAY));
  };

  const durationSinceSessionStart = (nowMs: number): number => (
    state.lastSessionStartedAtMs !== null ? Math.max(0, nowMs - state.lastSessionStartedAtMs) : 0
  );

  const startHeartbeat = (): void => {
    if (heartbeatTimer || heartbeatIntervalMs === null || heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      if (!state.sessionActive) return;
      state.lastSessionHeartbeatAtMs = now();
      void save();
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  };

  const stopHeartbeat = (): void => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  return {
    get enabled() {
      return isEnabled();
    },

    context: () => ({ ...context }),

    async recordAppStarted(nowMs = now()) {
      // Crash recovery: a previous session left its flag behind.
      const wasCrash = state.sessionActive;
      const previousSessionId = state.lastSessionId;
      const previousSessionStartedAtMs = state.lastSessionStartedAtMs;
      const previousSessionHeartbeatAtMs = state.lastSessionHeartbeatAtMs;
      // Clear before awaiting anything so a crash during this launch still
      // reads as a crash next time (flag re-armed below).
      if (wasCrash) {
        const recoveredAtMs = previousSessionHeartbeatAtMs ?? previousSessionStartedAtMs ?? nowMs;
        track('app_closed', {
          was_crash: true,
          session_duration_bucket: sessionDurationBucket(
            previousSessionStartedAtMs !== null ? Math.max(0, recoveredAtMs - previousSessionStartedAtMs) : 0,
          ),
        }, recoveredAtMs, previousSessionId ?? sessionId);
      }

      const isFirstLaunch = !state.hasEmittedFirstOpen;
      if (isFirstLaunch) {
        state.hasEmittedFirstOpen = true;
        state.firstOpenedAtMs = nowMs;
        state.firstOpenDate = new Date(nowMs).toISOString().slice(0, 10);
        track('app_first_opened', { first_open_date: state.firstOpenDate }, nowMs);
      }

      state.sessionActive = true;
      state.lastSessionId = sessionId;
      state.lastSessionStartedAtMs = nowMs;
      state.lastSessionHeartbeatAtMs = nowMs;
      track('app_started', { is_first_launch: isFirstLaunch }, nowMs);
      await save();
      startHeartbeat();
    },

    async recordNetworkRuntimeStarted(nowMs = now()) {
      if (hasEmittedNetworkRuntimeStarted) return;
      hasEmittedNetworkRuntimeStarted = track('network_runtime_started', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
      }, nowMs);
    },

    async recordDhtStarted(routingNodeCount, nowMs = now()) {
      if (hasEmittedDhtStarted || routingNodeCount <= 0) return;
      hasEmittedDhtStarted = track('dht_started', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
        routing_node_count_bucket: countBucket(routingNodeCount),
      }, nowMs);
    },

    async recordPeersDiscovered(peerCount, serviceCount, nowMs = now()) {
      if (hasEmittedPeersDiscovered || peerCount <= 0) return;
      hasEmittedPeersDiscovered = track('peers_discovered', {
        duration_bucket: durationBucket(durationSinceSessionStart(nowMs)),
        peer_count_bucket: countBucket(peerCount),
        service_count_bucket: countBucket(serviceCount),
      }, nowMs);
    },

    async recordSetupStarted(nowMs = now()) {
      if (state.hasCompletedSetup || state.setupStartedAtMs !== null) return;
      state.setupStartedAtMs = nowMs;
      await save();
    },

    async recordSetupCompleted(nowMs = now()) {
      if (state.hasCompletedSetup || state.setupStartedAtMs === null) return;
      const startedAt = state.setupStartedAtMs;
      state.hasCompletedSetup = true;
      state.setupStartedAtMs = null;
      track('setup_completed', {
        duration_bucket: durationBucket(startedAt !== null ? Math.max(0, nowMs - startedAt) : 0),
      }, nowMs);
      await save();
    },

    async recordDepositCredited(amountBaseUnits: string, nowMs = now()) {
      let amountUsdc = 0;
      try {
        amountUsdc = Number(BigInt(amountBaseUnits)) / Number(USDC_BASE_UNITS);
      } catch {
        // Malformed amount: still record the deposit, bucket as unknown-low.
      }
      const bucket = depositAmountBucket(amountUsdc);
      const isFirstDeposit = !state.hasCompletedDeposit;
      state.hasCompletedDeposit = true;
      track('deposit_completed', {
        method_category: 'usdc',
        amount_bucket: bucket,
        is_first_deposit: isFirstDeposit,
        days_since_first_open: daysSinceFirstOpenBucket(daysSinceFirstOpen(nowMs)),
      }, nowMs);
      await save();
    },

    async recordDepositFailed(input, nowMs = now()) {
      track('deposit_failed', {
        method_category: 'usdc',
        failure_code: input.failureCode,
        failure_stage: input.failureStage,
        retryable: input.retryable,
      }, nowMs);
    },

    async recordFirstChatStarted(input, nowMs = now()) {
      if (state.hasEmittedFirstChat) return;
      state.hasEmittedFirstChat = true;
      track('first_chat_started', {
        had_deposit: input.hadDeposit,
        deposit_bucket: input.depositBucket,
        days_since_first_open: daysSinceFirstOpenBucket(daysSinceFirstOpen(nowMs)),
        service_category: input.serviceCategory,
        has_attachments: input.hasAttachments,
      }, nowMs);
      await save();
    },

    async recordModelSelected(input, nowMs = now()) {
      track('model_selected', input, nowMs);
    },

    async recordChatRequestStarted(input, nowMs = now()) {
      track('chat_request_started', input, nowMs);
    },

    async recordChatRequestFinished(input, nowMs = now()) {
      track('chat_request_finished', input, nowMs);
    },

    async recordDiscoveryCompleted(input, nowMs = now()) {
      track('discovery_completed', input, nowMs);
    },

    async recordCleanShutdown(nowMs = now()) {
      if (!state.sessionActive) return;
      stopHeartbeat();
      track('app_closed', {
        was_crash: false,
        session_duration_bucket: sessionDurationBucket(
          state.lastSessionStartedAtMs !== null ? Math.max(0, nowMs - state.lastSessionStartedAtMs) : 0,
        ),
      }, nowMs);
      state.sessionActive = false;
      state.lastSessionId = null;
      state.lastSessionStartedAtMs = null;
      state.lastSessionHeartbeatAtMs = null;
      await save();
    },

    isUserOptedOut: () => state.telemetryDisabled,

    async setUserOptedOut(disabled: boolean) {
      state.telemetryDisabled = Boolean(disabled);
      await save();
    },
  };
}
