import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TELEMETRY_ENABLED_ENV,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_API_KEY_ENV,
  INSTALL_SOURCE_ENV,
  createTelemetryService,
  type TelemetryService,
} from './telemetry.js';
import { sanitizeTelemetryProperties } from './sanitize.js';
import { loadTelemetryState, saveTelemetryState, defaultTelemetryState } from './state.js';
import {
  classifyServiceCategory,
  countBucket,
  depositAmountBucket,
  durationBucket,
  daysSinceFirstOpenBucket,
  firstChatDepositSnapshot,
  httpStatusBucket,
  modelPricingSnapshot,
  offersAvailableBucket,
  publicModelId,
  sessionDurationBucket,
} from './events.js';
import { classifyChatRequestFailure, classifyDepositFailure } from './classify.js';
import type { PostHogCapturePayload } from './posthog.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

async function makeTempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-telemetry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type Captured = { payloads: PostHogCapturePayload[] };

function captureTransport(captured: Captured) {
  return async (payload: PostHogCapturePayload) => {
    captured.payloads.push(payload);
  };
}

function baseOptions(dir: string, captured: Captured, overrides: Record<string, unknown> = {}) {
  return {
    userDataDir: dir,
    isDev: false,
    appVersion: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
    } as NodeJS.ProcessEnv,
    transport: captureTransport(captured),
    heartbeatIntervalMs: null,
    ...overrides,
  };
}

// ── Enablement ──

test('disabled in development builds', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, { isDev: true }));
  assert.equal(service.enabled, false);
  await service.recordAppStarted();
  assert.equal(captured.payloads.length, 0);
});

test('disabled when TELEMETRY_ENABLED is false/0/no', async (t) => {
  for (const value of ['false', '0', 'no']) {
    const dir = await makeTempDir(t);
    const captured: Captured = { payloads: [] };
    const service = await createTelemetryService(baseOptions(dir, captured, {
      env: {
        [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
        [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
        [TELEMETRY_ENABLED_ENV]: value,
      } as NodeJS.ProcessEnv,
    }));
    assert.equal(service.enabled, false, `expected disabled for ${value}`);
    await service.recordAppStarted();
    assert.equal(captured.payloads.length, 0);
  }
});

test('disabled when PostHog host or key is missing', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, { env: {} as NodeJS.ProcessEnv }));
  assert.equal(service.enabled, false);
  await service.recordAppStarted();
  assert.equal(captured.payloads.length, 0);
});

test('disabled when PostHog host is invalid or not HTTPS', async (t) => {
  for (const host of ['not a url', 'http://posthog.example.com']) {
    const dir = await makeTempDir(t);
    const captured: Captured = { payloads: [] };
    const service = await createTelemetryService(baseOptions(dir, captured, {
      env: {
        [POSTHOG_HOST_ENV]: host,
        [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      } as NodeJS.ProcessEnv,
    }));
    assert.equal(service.enabled, false, `expected disabled for ${host}`);
  }
});

test('enabled in production with valid config', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(service.enabled, true);
});

// ── First-open / app-started ──

test('first launch emits app_first_opened and app_started with is_first_launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted();

  assert.equal(captured.payloads.length, 2);
  assert.equal(captured.payloads[0]?.event, 'app_first_opened');
  assert.match(String(captured.payloads[0]?.properties['first_open_date']), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(captured.payloads[1]?.event, 'app_started');
  assert.equal(captured.payloads[1]?.properties['is_first_launch'], true);
});

test('app_first_opened fires exactly once per installation', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted();
  await first.recordCleanShutdown();

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();

  const firstOpenEvents = captured.payloads.filter((p) => p.event === 'app_first_opened');
  assert.equal(firstOpenEvents.length, 1);
  const startedEvents = captured.payloads.filter((p) => p.event === 'app_started');
  assert.equal(startedEvents.length, 2);
  assert.equal(startedEvents[1]?.properties['is_first_launch'], false);
});

test('install_id is a stable random UUID across restarts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted();
  await first.recordCleanShutdown();
  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();

  const ids = new Set(captured.payloads.map((p) => p.distinct_id));
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(captured.payloads.every((p) => p.properties['install_id'] === id), true);
});

test('envelope includes schema/platform/arch/version/install_source', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [INSTALL_SOURCE_ENV]: 'dmg',
    } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  const props = captured.payloads[0]?.properties ?? {};
  assert.equal(props['schema_version'], 1);
  assert.equal(props['platform'], 'darwin');
  assert.equal(props['arch'], 'arm64');
  assert.equal(props['app_version'], '1.2.3');
  assert.equal(props['install_source'], 'dmg');
  assert.equal(typeof props['session_id'], 'string');
  assert.equal(typeof props['event_ts_ms'], 'number');
  assert.equal(props['$geoip_disable'], true);
  assert.equal(props['$process_person_profile'], false);
  assert.equal(props['distinct_id'], captured.payloads[0]?.distinct_id);
});

test('unknown INSTALL_SOURCE falls back to unknown', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured, {
    env: {
      [POSTHOG_HOST_ENV]: 'https://posthog.example.com',
      [POSTHOG_PROJECT_API_KEY_ENV]: 'phc_test',
      [INSTALL_SOURCE_ENV]: 'sneaky-value',
    } as NodeJS.ProcessEnv,
  }));
  await service.recordAppStarted();
  assert.equal(captured.payloads[0]?.properties['install_source'], 'unknown');
});

// ── Crash recovery ──

test('unclean previous session emits recovered app_closed with was_crash on next launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(1_000);
  // No recordCleanShutdown — simulate crash.

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted(1_000 + 60_000);

  const recovered = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(recovered);
  assert.equal(recovered.properties['was_crash'], true);
  assert.equal(recovered.properties['session_duration_bucket'], 'under_30s');
  assert.equal(recovered.properties['event_ts_ms'], 1_000);
  const started = captured.payloads.filter((payload) => payload.event === 'app_started');
  assert.equal(recovered.properties['session_id'], started[0]?.properties['session_id']);
  assert.notEqual(recovered.properties['session_id'], started[1]?.properties['session_id']);
});

test('crash recovery uses the last heartbeat instead of time spent offline', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(1_000);
  const state = await loadTelemetryState(dir);
  state.lastSessionHeartbeatAtMs = 91_000;
  await saveTelemetryState(dir, state);

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted(10 * DAY_MS);

  const recovered = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(recovered);
  assert.equal(recovered.properties['session_duration_bucket'], '30s_2m');
  assert.equal(recovered.properties['event_ts_ms'], 91_000);
});

test('clean shutdown emits app_closed with was_crash false and no crash event next launch', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(0);
  await first.recordCleanShutdown(40 * 60_000);

  const closed = captured.payloads.find((p) => p.event === 'app_closed');
  assert.ok(closed);
  assert.equal(closed.properties['was_crash'], false);
  assert.equal(closed.properties['session_duration_bucket'], 'over_30m');

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordAppStarted();
  const closedEvents = captured.payloads.filter((p) => p.event === 'app_closed');
  assert.equal(closedEvents.length, 1);
});

// ── Setup / deposit / chat events ──

test('setup duration is bucketed', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordSetupStarted(1_000);
  await service.recordSetupCompleted(1_000 + 90_000);

  const setup = captured.payloads.find((p) => p.event === 'setup_completed');
  assert.ok(setup);
  assert.equal(setup.properties['duration_bucket'], '30s_2m');
});

test('runtime, DHT, and first peers emit once per launch with coarse counts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordNetworkRuntimeStarted(10_000);
  await service.recordNetworkRuntimeStarted(20_000);
  await service.recordDhtStarted(0, 20_000);
  await service.recordDhtStarted(4, 40_000);
  await service.recordDhtStarted(8, 50_000);
  await service.recordPeersDiscovered(0, 0, 60_000);
  await service.recordPeersDiscovered(7, 12, 3 * 60_000);
  await service.recordPeersDiscovered(20, 30, 4 * 60_000);

  const runtime = captured.payloads.filter((payload) => payload.event === 'network_runtime_started');
  const dht = captured.payloads.filter((payload) => payload.event === 'dht_started');
  const peers = captured.payloads.filter((payload) => payload.event === 'peers_discovered');
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0]?.properties['duration_bucket'], 'under_30s');
  assert.equal(dht.length, 1);
  assert.equal(dht[0]?.properties['routing_node_count_bucket'], '2_5');
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.properties['duration_bucket'], '2m_5m');
  assert.equal(peers[0]?.properties['peer_count_bucket'], '6_20');
  assert.equal(peers[0]?.properties['service_count_bucket'], '6_20');
});

test('setup completion requires a started transition and emits once across restarts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  await first.recordAppStarted(0);
  await first.recordSetupCompleted(5_000);
  assert.equal(captured.payloads.some((p) => p.event === 'setup_completed'), false);

  await first.recordSetupStarted(10_000);
  await first.recordSetupCompleted(50_000);
  await first.recordSetupCompleted(60_000);

  const second = await createTelemetryService(baseOptions(dir, captured));
  await second.recordSetupStarted(70_000);
  await second.recordSetupCompleted(80_000);
  assert.equal(captured.payloads.filter((p) => p.event === 'setup_completed').length, 1);
});

test('deposit_completed sends buckets only, never exact amounts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('12345678', 0); // $12.345678

  const deposit = captured.payloads.find((p) => p.event === 'deposit_completed');
  assert.ok(deposit);
  assert.equal(deposit.properties['amount_bucket'], '5_25');
  assert.equal(deposit.properties['is_first_deposit'], true);
  assert.equal(deposit.properties['days_since_first_open'], '0');
  // The exact amount must appear nowhere in the payload.
  const serialized = JSON.stringify(deposit);
  assert.equal(serialized.includes('12345678'), false);
  assert.equal(serialized.includes('12.345678'), false);
});

test('deposit_completed is_first_deposit flips after the first deposit', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('1000000', 0);
  await service.recordDepositCredited('200000000', 0);

  const deposits = captured.payloads.filter((p) => p.event === 'deposit_completed');
  assert.equal(deposits.length, 2);
  assert.equal(deposits[0]?.properties['is_first_deposit'], true);
  assert.equal(deposits[1]?.properties['is_first_deposit'], false);
});

test('deposit_failed sends only a fixed failure taxonomy', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  const rawError = 'No deposit relayers are reachable for peer 12D3KooSecret at 0xabc123';
  await service.recordDepositFailed(classifyDepositFailure(rawError), 0);

  const failed = captured.payloads.find((payload) => payload.event === 'deposit_failed');
  assert.ok(failed);
  assert.equal(failed.properties['method_category'], 'usdc');
  assert.equal(failed.properties['failure_code'], 'relayer_unreachable');
  assert.equal(failed.properties['failure_stage'], 'dispatch');
  assert.equal(failed.properties['retryable'], true);
  assert.equal(JSON.stringify(failed).includes('12D3KooSecret'), false);
  assert.equal(JSON.stringify(failed).includes('0xabc123'), false);
});

test('chat_request_finished records model failures without raw peer errors', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  const rawError = 'Service "deepseek-v4-flash" is not served by this peer 12D3KooSecret.';
  const failure = classifyChatRequestFailure({
    kind: 'http_error',
    source: 'upstream',
    retryable: false,
    statusCode: 400,
  }, rawError);
  await service.recordChatRequestFinished({
    request_id: REQUEST_ID,
    outcome: 'failed',
    failure_code: failure.failureCode,
    failure_stage: failure.failureStage,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    offers_available_bucket: '2_3',
    http_status_bucket: '4xx',
    retryable: failure.retryable,
    automatic_retry_attempted: true,
    automatic_retry_succeeded: false,
    had_partial_output: false,
    duration_bucket: 'under_30s',
    has_attachments: false,
  }, 0);

  const finished = captured.payloads.find((payload) => payload.event === 'chat_request_finished');
  assert.ok(finished);
  assert.equal(finished.properties['failure_code'], 'model_not_served_by_peer');
  assert.equal(finished.properties['failure_stage'], 'request_validation');
  assert.equal(finished.properties['retryable'], true);
  assert.equal(JSON.stringify(finished).includes('12D3KooSecret'), false);
  assert.equal(JSON.stringify(finished).includes('not served'), false);
});

test('model selection and chat start share privacy-safe pricing context', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordModelSelected({
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    selection_scope: 'default',
    route_mode: 'auto',
    pricing_tier: 'mixed',
    has_free_eligible_offer: true,
    eligible_offer_count_bucket: '2_3',
  }, 0);
  await service.recordChatRequestStarted({
    request_id: REQUEST_ID,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'mixed',
    has_free_eligible_offer: true,
    offers_available_bucket: '2_3',
    has_attachments: false,
  }, 1);

  const selected = captured.payloads.find((payload) => payload.event === 'model_selected');
  const started = captured.payloads.find((payload) => payload.event === 'chat_request_started');
  assert.ok(selected);
  assert.ok(started);
  assert.equal(selected.properties['pricing_tier'], 'mixed');
  assert.equal(selected.properties['has_free_eligible_offer'], true);
  assert.equal(started.properties['request_id'], REQUEST_ID);
});

test('discovery_completed records coarse counts only', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordDiscoveryCompleted({
    outcome: 'success',
    duration_bucket: '30s_2m',
    service_count_bucket: '21_plus',
    peer_count_bucket: '6_20',
    result_count_bucket: '2_5',
    was_empty: false,
  }, 0);

  const discovery = captured.payloads.find((payload) => payload.event === 'discovery_completed');
  assert.ok(discovery);
  assert.equal(discovery.properties['service_count_bucket'], '21_plus');
  assert.equal(discovery.properties['peer_count_bucket'], '6_20');
  assert.equal(discovery.properties['result_count_bucket'], '2_5');
});

test('first_chat_started fires once and records the immediate deposit snapshot', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('10000000', 0);
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: false,
    hadDeposit: true,
    depositBucket: '5_25',
  }, DAY_MS);
  await service.recordFirstChatStarted({
    serviceCategory: 'image',
    hasAttachments: true,
    hadDeposit: true,
    depositBucket: '100_plus',
  }, DAY_MS);

  const chats = captured.payloads.filter((p) => p.event === 'first_chat_started');
  assert.equal(chats.length, 1);
  assert.equal(chats[0]?.properties['had_deposit'], true);
  assert.equal(chats[0]?.properties['deposit_bucket'], '5_25');
  assert.equal(chats[0]?.properties['days_since_first_open'], '1_7');
  assert.equal(chats[0]?.properties['service_category'], 'chat');
  assert.equal(chats[0]?.properties['has_attachments'], false);
});

test('first_chat_started without a deposit reports had_deposit false', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: true,
    hadDeposit: false,
    depositBucket: 'none',
  }, 0);

  const chat = captured.payloads.find((p) => p.event === 'first_chat_started');
  assert.ok(chat);
  assert.equal(chat.properties['had_deposit'], false);
  assert.equal(chat.properties['deposit_bucket'], 'none');
});

test('first_chat_started uses the immediate balance snapshot, not deposit event history', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.recordDepositCredited('10000000', 0);
  await service.recordFirstChatStarted({
    serviceCategory: 'chat',
    hasAttachments: false,
    hadDeposit: false,
    depositBucket: 'none',
  }, 0);

  const chat = captured.payloads.find((p) => p.event === 'first_chat_started');
  assert.ok(chat);
  assert.equal(chat.properties['had_deposit'], false);
  assert.equal(chat.properties['deposit_bucket'], 'none');
});

// ── Opt-out ──

test('user opt-out disables telemetry and persists across restarts', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const first = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(first.isUserOptedOut(), false);
  await first.recordAppStarted();
  const beforeOptOut = captured.payloads.length;

  await first.setUserOptedOut(true);
  assert.equal(first.enabled, false);
  await first.recordCleanShutdown();
  assert.equal(captured.payloads.length, beforeOptOut);

  const second = await createTelemetryService(baseOptions(dir, captured));
  assert.equal(second.isUserOptedOut(), true);
  assert.equal(second.enabled, false);
  await second.recordAppStarted();
  assert.equal(captured.payloads.length, beforeOptOut);
});

test('opt-in again re-enables telemetry', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.setUserOptedOut(true);
  await service.setUserOptedOut(false);
  assert.equal(service.enabled, true);
});

test('session milestones remain observable after opting in mid-session', async (t) => {
  const dir = await makeTempDir(t);
  const captured: Captured = { payloads: [] };
  const service = await createTelemetryService(baseOptions(dir, captured));
  await service.recordAppStarted(0);
  await service.setUserOptedOut(true);
  await service.recordNetworkRuntimeStarted(1_000);
  await service.recordDhtStarted(3, 2_000);
  await service.recordPeersDiscovered(2, 4, 3_000);
  await service.setUserOptedOut(false);
  await service.recordNetworkRuntimeStarted(4_000);
  await service.recordDhtStarted(3, 5_000);
  await service.recordPeersDiscovered(2, 4, 6_000);

  assert.equal(captured.payloads.filter((payload) => payload.event === 'network_runtime_started').length, 1);
  assert.equal(captured.payloads.filter((payload) => payload.event === 'dht_started').length, 1);
  assert.equal(captured.payloads.filter((payload) => payload.event === 'peers_discovered').length, 1);
});

// ── Sanitizer ──

test('sanitizer drops unknown properties and unsupported types', () => {
  const sanitized = sanitizeTelemetryProperties('app_started', {
    is_first_launch: true,
    ...({ wallet_address: '0xabc', nested: { a: 1 }, list: [1, 2] } as object),
  } as never);
  assert.deepEqual(sanitized, { is_first_launch: true });
});

test('sanitizer truncates long strings and bounds numbers', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_completed', {
    method_category: 'x'.repeat(500),
    amount_bucket: 'under_5',
    is_first_deposit: false,
    days_since_first_open: '0',
    ...({ huge: Number.POSITIVE_INFINITY } as object),
  } as never);
  assert.equal(String(sanitized['method_category']).length, 64);
  assert.equal('huge' in sanitized, false);
});

test('sanitizer drops invalid bucket values', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_completed', {
    method_category: 'usdc',
    amount_bucket: 'exactly_42_dollars',
    is_first_deposit: true,
    days_since_first_open: '0',
  } as never);
  assert.equal('amount_bucket' in sanitized, false);
});

test('sanitizer applies event-specific failure enums', () => {
  const sanitized = sanitizeTelemetryProperties('deposit_failed', {
    method_category: 'usdc',
    failure_code: 'model_not_served_by_peer',
    failure_stage: 'request_validation',
    retryable: true,
  } as never);
  assert.deepEqual(sanitized, { method_category: 'usdc', retryable: true });
});

test('sanitizer accepts only random UUID request correlation IDs', () => {
  const valid = sanitizeTelemetryProperties('chat_request_started', {
    request_id: REQUEST_ID,
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    offers_available_bucket: '1',
    has_attachments: false,
  });
  assert.equal(valid['request_id'], REQUEST_ID);

  const invalid = sanitizeTelemetryProperties('chat_request_started', {
    request_id: 'conversation-or-wallet-derived-id',
    public_model_id: 'deepseek-v4-flash',
    service_category: 'chat',
    route_mode: 'auto',
    pricing_tier: 'free',
    has_free_eligible_offer: true,
    offers_available_bucket: '1',
    has_attachments: false,
  });
  assert.equal('request_id' in invalid, false);
});

// ── State persistence ──

test('corrupt state file falls back to defaults with a fresh install id', async (t) => {
  const dir = await makeTempDir(t);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'telemetry-state.json'), 'not json at all', 'utf8');
  const state = await loadTelemetryState(dir);
  assert.equal(state.hasEmittedFirstOpen, false);
  assert.match(state.installId, /^[0-9a-f-]{36}$/i);
});

test('invalid install id is regenerated', async (t) => {
  const dir = await makeTempDir(t);
  const state = defaultTelemetryState();
  await saveTelemetryState(dir, { ...state, installId: 'machine-derived-not-ok' });
  const loaded = await loadTelemetryState(dir);
  assert.notEqual(loaded.installId, 'machine-derived-not-ok');
  assert.match(loaded.installId, /^[0-9a-f-]{36}$/i);
});

// ── Bucket helpers ──

test('bucket helpers classify correctly', () => {
  assert.equal(durationBucket(10_000), 'under_30s');
  assert.equal(durationBucket(60_000), '30s_2m');
  assert.equal(durationBucket(3 * 60_000), '2m_5m');
  assert.equal(durationBucket(6 * 60_000), 'over_5m');
  assert.equal(sessionDurationBucket(60 * 60_000), 'over_30m');
  assert.equal(depositAmountBucket(3), 'under_5');
  assert.equal(depositAmountBucket(10), '5_25');
  assert.equal(depositAmountBucket(50), '25_100');
  assert.equal(depositAmountBucket(500), '100_plus');
  assert.equal(daysSinceFirstOpenBucket(0), '0');
  assert.equal(daysSinceFirstOpenBucket(3), '1_7');
  assert.equal(daysSinceFirstOpenBucket(20), '8_30');
  assert.equal(daysSinceFirstOpenBucket(90), '31_plus');
  assert.equal(countBucket(0), '0');
  assert.equal(countBucket(4), '2_5');
  assert.equal(countBucket(21), '21_plus');
  assert.equal(offersAvailableBucket(3), '2_3');
  assert.equal(httpStatusBucket(400), '4xx');
  assert.equal(httpStatusBucket(503), '5xx');
  assert.equal(publicModelId('DeepSeek-V4-Flash', true), 'deepseek-v4-flash');
  assert.equal(publicModelId('private model name', true), 'custom_or_unknown');
  assert.equal(publicModelId('deepseek-v4-flash', false), 'custom_or_unknown');
  assert.deepEqual(modelPricingSnapshot([
    { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  ]), {
    pricingTier: 'mixed',
    hasFreeEligibleOffer: true,
    eligibleOfferCountBucket: '2_3',
  });
  assert.deepEqual(modelPricingSnapshot([]), {
    pricingTier: 'unknown',
    hasFreeEligibleOffer: false,
    eligibleOfferCountBucket: '0',
  });
  assert.deepEqual(modelPricingSnapshot([
    { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.5 },
  ]), {
    pricingTier: 'paid',
    hasFreeEligibleOffer: false,
    eligibleOfferCountBucket: '1',
  });
  assert.equal(classifyServiceCategory('claude-sonnet-4-5'), 'chat');
  assert.equal(classifyServiceCategory('dall-e-3'), 'image');
  assert.equal(classifyServiceCategory('flux-schnell'), 'image');
  assert.equal(classifyServiceCategory('whisper-large-v3'), 'other');
  assert.deepEqual(firstChatDepositSnapshot('0'), { hadDeposit: false, depositBucket: 'none' });
  assert.deepEqual(firstChatDepositSnapshot('12.5'), { hadDeposit: true, depositBucket: '5_25' });
  assert.equal(firstChatDepositSnapshot('not-a-number'), null);
});

test('failure classifiers cover deposit and chat failure modes', () => {
  assert.deepEqual(classifyDepositFailure('', 'payments-disabled'), {
    failureCode: 'payments_disabled',
    failureStage: 'preflight',
    retryable: false,
  });
  assert.deepEqual(classifyDepositFailure('USDC EIP-712 domain mismatch'), {
    failureCode: 'domain_mismatch',
    failureStage: 'signing',
    retryable: false,
  });
  assert.deepEqual(classifyChatRequestFailure({
    kind: 'http_error',
    source: 'upstream',
    retryable: false,
    statusCode: 400,
  }, 'data: {"error":{"code":"model_not_found"}}'), {
    failureCode: 'model_not_served_by_peer',
    failureStage: 'request_validation',
    retryable: true,
    statusCode: 400,
  });
  assert.deepEqual(classifyChatRequestFailure({
    kind: 'stream_error',
    source: 'upstream',
    retryable: false,
  }, 'The stream stopped before completion: 400 data: {"error":{"code":"model_not_found"}}'), {
    failureCode: 'model_not_served_by_peer',
    failureStage: 'request_validation',
    retryable: true,
    statusCode: 400,
  });
});

// ── Transport failure isolation ──

test('transport failures never reject or throw', async (t) => {
  const dir = await makeTempDir(t);
  const service: TelemetryService = await createTelemetryService({
    ...baseOptions(dir, { payloads: [] }),
    transport: async () => { throw new Error('PostHog down'); },
  });
  await service.recordAppStarted();
  await service.recordCleanShutdown();
});
