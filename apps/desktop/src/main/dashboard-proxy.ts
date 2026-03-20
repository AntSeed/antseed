import { readFile } from 'node:fs/promises';
import { createDashboardServer, type DashboardConfig, type DashboardServer } from '@antseed/dashboard';
import { DEFAULT_CONFIG_PATH, DEFAULT_BUYER_STATE_PATH, DEFAULT_DASHBOARD_PORT } from './constants.js';
import type { AppendLogFn } from './utils.js';
import { asRecord, asString, asNumber, asStringArray } from './utils.js';

export { DEFAULT_DASHBOARD_PORT };
export const DASHBOARD_FETCH_TIMEOUT_MS = 10_000;

export type DashboardEndpoint = 'status' | 'network' | 'peers' | 'sessions' | 'earnings' | 'config' | 'data-sources';

export type DashboardQueryValue = string | number | boolean;

export type DashboardApiResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

export type DashboardRuntimeState = {
  running: boolean;
  port: number;
  startedAt: number | null;
  lastError: string | null;
  lastExitCode: number | null;
};

export const DASHBOARD_ENDPOINTS: ReadonlySet<DashboardEndpoint> = new Set([
  'status',
  'network',
  'peers',
  'sessions',
  'earnings',
  'config',
  'data-sources',
]);

export type EmitRuntimeStateFn = () => void;

let _appendLog: AppendLogFn = () => {};
let _emitRuntimeState: EmitRuntimeStateFn = () => {};

export function setDashboardCallbacks(appendLog: AppendLogFn, emitRuntimeState: EmitRuntimeStateFn): void {
  _appendLog = appendLog;
  _emitRuntimeState = emitRuntimeState;
}

let dashboardServer: DashboardServer | null = null;
const dashboardRuntime: DashboardRuntimeState = {
  running: false,
  port: DEFAULT_DASHBOARD_PORT,
  startedAt: null,
  lastError: null,
  lastExitCode: null,
};
let dashboardStartPromise: Promise<void> | null = null;
let dashboardPortInUseUntilMs = 0;

/** Read-only snapshot of the dashboard runtime state. */
export function getDashboardRuntime(): Readonly<DashboardRuntimeState> {
  return dashboardRuntime;
}

/** Return the active dashboard port (running port or fallback). */
export function getActiveDashboardPort(fallback?: number): number {
  return dashboardRuntime.running ? dashboardRuntime.port : toSafeDashboardPort(fallback);
}
const DASHBOARD_PORT_IN_USE_RETRY_COOLDOWN_MS = 60_000;

export function toSafeDashboardPort(port?: number): number {
  const parsed = Number(port);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) {
    return Math.floor(parsed);
  }
  return DEFAULT_DASHBOARD_PORT;
}

export function isAddressInUseError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('eaddrinuse') || normalized.includes('address already in use');
}

export function defaultDashboardConfig(): DashboardConfig {
  return {
    identity: {
      displayName: 'AntSeed Node',
    },
    seller: {
      reserveFloor: 10,
      maxConcurrentBuyers: 5,
      enabledProviders: [],
      pricing: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      },
    },
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
      minPeerReputation: 50,
      proxyPort: 8377,
    },
    network: {
      bootstrapNodes: [],
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
    },
    providers: [],
    plugins: [],
  };
}

export async function loadDashboardConfig(configPath = DEFAULT_CONFIG_PATH): Promise<DashboardConfig> {
  const defaults = defaultDashboardConfig();

  let parsed: unknown;
  try {
    const raw = await readFile(configPath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }

  const root = asRecord(parsed);
  const identity = asRecord(root.identity);
  const seller = asRecord(root.seller);
  const buyer = asRecord(root.buyer);
  const sellerPricing = asRecord(seller.pricing);
  const sellerPricingDefaults = asRecord(sellerPricing.defaults);
  const buyerMaxPricing = asRecord(buyer.maxPricing);
  const buyerMaxPricingDefaults = asRecord(buyerMaxPricing.defaults);
  const network = asRecord(root.network);
  const payments = asRecord(root.payments);

  const plugins = Array.isArray(root.plugins)
    ? root.plugins
      .map((item) => asRecord(item))
      .map((item) => ({
        name: asString(item.name, 'unknown'),
        package: asString(item.package, 'unknown'),
        installedAt: asString(item.installedAt, new Date(0).toISOString()),
      }))
    : [];

  return {
    identity: {
      displayName: asString(identity.displayName, defaults.identity.displayName),
      walletAddress: typeof identity.walletAddress === 'string' ? identity.walletAddress : undefined,
    },
    seller: {
      reserveFloor: asNumber(seller.reserveFloor, defaults.seller.reserveFloor),
      maxConcurrentBuyers: asNumber(seller.maxConcurrentBuyers, defaults.seller.maxConcurrentBuyers),
      enabledProviders: asStringArray(seller.enabledProviders, defaults.seller.enabledProviders),
      pricing: {
        defaults: {
          inputUsdPerMillion: asNumber(
            sellerPricingDefaults.inputUsdPerMillion,
            defaults.seller.pricing.defaults.inputUsdPerMillion
          ),
          outputUsdPerMillion: asNumber(
            sellerPricingDefaults.outputUsdPerMillion,
            defaults.seller.pricing.defaults.outputUsdPerMillion
          ),
        },
        providers: sellerPricing.providers && typeof sellerPricing.providers === 'object'
          ? sellerPricing.providers as DashboardConfig['seller']['pricing']['providers']
          : defaults.seller.pricing.providers,
      },
    },
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: asNumber(
            buyerMaxPricingDefaults.inputUsdPerMillion,
            defaults.buyer.maxPricing.defaults.inputUsdPerMillion
          ),
          outputUsdPerMillion: asNumber(
            buyerMaxPricingDefaults.outputUsdPerMillion,
            defaults.buyer.maxPricing.defaults.outputUsdPerMillion
          ),
        },
        providers: buyerMaxPricing.providers && typeof buyerMaxPricing.providers === 'object'
          ? buyerMaxPricing.providers as DashboardConfig['buyer']['maxPricing']['providers']
          : defaults.buyer.maxPricing.providers,
      },
      minPeerReputation: asNumber(buyer.minPeerReputation, defaults.buyer.minPeerReputation),
      proxyPort: asNumber(buyer.proxyPort, defaults.buyer.proxyPort),
    },
    network: {
      bootstrapNodes: asStringArray(network.bootstrapNodes, defaults.network.bootstrapNodes),
    },
    payments: {
      preferredMethod: asString(payments.preferredMethod, defaults.payments.preferredMethod),
      platformFeeRate: asNumber(payments.platformFeeRate, defaults.payments.platformFeeRate),
    },
    providers: Array.isArray(root.providers) ? root.providers : defaults.providers,
    plugins,
  };
}

export async function startDashboardRuntime(configPath: string, port?: number): Promise<void> {
  const targetPort = toSafeDashboardPort(port ?? dashboardRuntime.port);

  if (dashboardRuntime.running && dashboardRuntime.port === targetPort) {
    return;
  }
  if (dashboardStartPromise) {
    await dashboardStartPromise;
    if (dashboardRuntime.running && dashboardRuntime.port === targetPort) {
      return;
    }
  }

  const startAttempt = (async () => {
    if (dashboardRuntime.running) {
      await stopDashboardRuntime('restart');
    }

    dashboardRuntime.port = targetPort;
    dashboardRuntime.lastError = null;

    try {
      const config = await loadDashboardConfig(configPath);
      dashboardServer = await createDashboardServer(config, targetPort, {
        configPath,
        buyerStateFile: DEFAULT_BUYER_STATE_PATH,
      });
      await dashboardServer.start();

      dashboardRuntime.running = true;
      dashboardRuntime.startedAt = Date.now();
      dashboardRuntime.lastExitCode = null;
      dashboardRuntime.lastError = null;
      dashboardPortInUseUntilMs = 0;

      _appendLog('dashboard', 'system', `Embedded dashboard engine running on http://127.0.0.1:${targetPort}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dashboardRuntime.running = false;
      dashboardRuntime.startedAt = null;
      dashboardRuntime.lastExitCode = 1;
      dashboardRuntime.lastError = message;
      dashboardServer = null;

      if (isAddressInUseError(message)) {
        // Avoid startup log storms from parallel callers while still allowing a near-term retry.
        dashboardPortInUseUntilMs = Date.now() + DASHBOARD_PORT_IN_USE_RETRY_COOLDOWN_MS;
      }

      _appendLog('dashboard', 'system', `Embedded dashboard engine failed to start: ${message}`);
      throw err;
    }
  })();

  dashboardStartPromise = startAttempt;
  try {
    await startAttempt;
  } finally {
    if (dashboardStartPromise === startAttempt) {
      dashboardStartPromise = null;
    }
  }
}

export async function stopDashboardRuntime(reason: string): Promise<void> {
  if (!dashboardServer) {
    dashboardRuntime.running = false;
    dashboardRuntime.startedAt = null;
    _emitRuntimeState();
    return;
  }

  try {
    await dashboardServer.stop();
    dashboardRuntime.lastExitCode = 0;
    _appendLog('dashboard', 'system', `Embedded dashboard engine stopped (${reason}).`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dashboardRuntime.lastExitCode = 1;
    dashboardRuntime.lastError = message;
    _appendLog('dashboard', 'system', `Embedded dashboard engine stop failed: ${message}`);
  } finally {
    dashboardServer = null;
    dashboardRuntime.running = false;
    dashboardRuntime.startedAt = null;
    _emitRuntimeState();
  }
}

export async function ensureDashboardRuntime(configPath: string, targetPort?: number): Promise<void> {
  if (dashboardRuntime.running) {
    return;
  }

  const desiredPort = toSafeDashboardPort(targetPort ?? dashboardRuntime.port);
  const now = Date.now();
  if (dashboardPortInUseUntilMs > now && dashboardRuntime.port === desiredPort) {
    return;
  }

  try {
    await startDashboardRuntime(configPath, desiredPort);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAddressInUseError(message)) {
      _appendLog('dashboard', 'system', `Dashboard port ${desiredPort} already in use; using existing local data service.`);
      return;
    }
    throw err;
  }
}

export function toSafeDashboardEndpoint(endpoint: string): DashboardEndpoint | null {
  if (DASHBOARD_ENDPOINTS.has(endpoint as DashboardEndpoint)) {
    return endpoint as DashboardEndpoint;
  }
  return null;
}

export function sanitizeDashboardQuery(query: unknown): Record<string, DashboardQueryValue> {
  if (!query || typeof query !== 'object') {
    return {};
  }

  const safe: Record<string, DashboardQueryValue> = {};
  for (const [rawKey, rawValue] of Object.entries(query)) {
    const key = rawKey.trim();
    if (key.length === 0) {
      continue;
    }
    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      safe[key] = rawValue;
    }
  }
  return safe;
}

export function buildDashboardUrl(endpoint: DashboardEndpoint, port: number, query: Record<string, DashboardQueryValue>): string {
  const url = new URL(`http://127.0.0.1:${port}/api/${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function errorMessageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = (payload as { error?: unknown }).error;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate;
  }
  return null;
}

export async function fetchDashboardData(
  endpoint: DashboardEndpoint,
  port?: number,
  query: Record<string, DashboardQueryValue> = {},
): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = buildDashboardUrl(endpoint, safePort, query);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DASHBOARD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
    });

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      return {
        ok: false,
        data: payload,
        error: errorMessageFromPayload(payload) ?? `dashboard api returned ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      data: payload,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const error = normalized.includes('abort')
      ? `dashboard ${endpoint} request timed out after ${String(DASHBOARD_FETCH_TIMEOUT_MS)}ms`
      : message;
    return {
      ok: false,
      data: null,
      error,
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateDashboardConfig(
  config: Record<string, unknown>,
  port?: number,
): Promise<DashboardApiResult> {
  const safePort = toSafeDashboardPort(port);
  const url = `http://127.0.0.1:${safePort}/api/config`;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, DASHBOARD_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
      signal: controller.signal,
    });

    let payload: unknown = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }

    if (!response.ok) {
      return {
        ok: false,
        data: payload,
        error: errorMessageFromPayload(payload) ?? `dashboard api returned ${response.status}`,
        status: response.status,
      };
    }

    return {
      ok: true,
      data: payload,
      error: null,
      status: response.status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const error = normalized.includes('abort')
      ? `dashboard config update timed out after ${String(DASHBOARD_FETCH_TIMEOUT_MS)}ms`
      : message;
    return {
      ok: false,
      data: null,
      error,
      status: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
