// AntSeed Connect deep-link handler, macOS.
// Parsing, manifest fetch, and signing all happen in the main process.
// The renderer only shows the request and returns the approval.

import { app, shell, ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  parseRequestLink,
  resolveScopeValues,
  signConnectResponse,
  parseManifest,
  SCOPES,
  type ConnectRequest,
  type ScopeAccount,
  type AutoDepositState,
} from '@antseed/connect-core';
import type { Identity } from '@antseed/node';

export interface ConnectDeps {
  getMainWindow: () => BrowserWindow | null;
  ensureWindow: () => void;
  ensureIdentity: () => Promise<void>;
  getIdentity: () => Identity | null;
  getAutoDepositState?: (address: string) => Promise<AutoDepositState | undefined>;
  log?: (line: string) => void;
}

const MANIFEST_TIMEOUT_MS = 1500;

interface PendingConnect {
  request: ConnectRequest;
  values: Record<string, string>;
}

let ready = false;
let pendingUrl: string | null = null;
const pendingRequests = new Map<string, PendingConnect>();

/** Best-effort, display-only manifest fetch. Never a security input. */
async function fetchManifest(origin: string): Promise<{ name: string; icon?: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/.well-known/antseed-connect.json`, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) return null;
    const manifest = parseManifest(await res.text(), origin);
    return { name: manifest.name, ...(manifest.icon ? { icon: manifest.icon } : {}) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleConnectUrl(url: string, deps: ConnectDeps) {
  let request: ConnectRequest;
  try {
    request = parseRequestLink(url);
  } catch (err) {
    deps.log?.(`[connect] rejected request link: ${(err as Error).message}`);
    return;
  }

  deps.ensureWindow();
  const win = deps.getMainWindow();
  if (!win) {
    deps.log?.('[connect] no window available; cannot show consent prompt');
    return;
  }
  win.show();
  win.focus();

  await deps.ensureIdentity();
  const identity = deps.getIdentity();
  if (!identity) {
    deps.log?.('[connect] identity unavailable; cannot answer request');
    return;
  }

  let account: ScopeAccount = identity.wallet;
  if (request.scopes.includes('auto-deposit') && deps.getAutoDepositState) {
    const autoDeposit = await deps.getAutoDepositState(identity.wallet.address);
    if (autoDeposit) account = { address: identity.wallet.address, autoDeposit };
  }
  const values = resolveScopeValues(request, account);
  const manifest = await fetchManifest(request.origin);

  const id = randomUUID();
  pendingRequests.set(id, { request, values });
  // Don't leak the pending entry if the window goes away before the user decides.
  win.webContents.once('destroyed', () => pendingRequests.delete(id));

  win.webContents.send('connect:request', {
    id,
    origin: request.origin,
    appName: manifest?.name ?? null,
    appIcon: manifest?.icon ?? null,
    scopes: request.scopes.map((scope) => ({
      id: scope,
      label: SCOPES[scope].label,
      description: SCOPES[scope].description,
      value: values[scope],
    })),
  });
}

async function respondToConnect(
  payload: { id: string; approved: boolean },
  deps: ConnectDeps,
): Promise<{ ok: boolean; delivered: boolean; error?: string }> {
  const pending = pendingRequests.get(payload.id);
  if (!pending) {
    return { ok: false, delivered: false, error: 'unknown request' };
  }
  pendingRequests.delete(payload.id);

  if (!payload.approved) {
    return { ok: true, delivered: false };
  }

  const identity = deps.getIdentity();
  if (!identity) {
    return { ok: false, delivered: false, error: 'identity unavailable' };
  }

  try {
    const { fragmentUrl } = await signConnectResponse(identity.wallet, pending.request, pending.values);
    await shell.openExternal(fragmentUrl);
    return { ok: true, delivered: true };
  } catch (err) {
    deps.log?.(`[connect] failed to deliver response: ${(err as Error).message}`);
    return { ok: false, delivered: false, error: (err as Error).message };
  }
}

/**
 * Register the deep-link handler. Call at module init (before app ready) so the
 * `open-url` listener is in place to catch a cold-start launch. Links that
 * arrive before {@link markConnectReady} are buffered.
 */
export function initConnectDeepLink(deps: ConnectDeps): void {
  app.setAsDefaultProtocolClient('antseed');

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!ready) {
      // open-url can fire before the app is ready on macOS cold start; hold it.
      pendingUrl = url;
      return;
    }
    void handleConnectUrl(url, deps);
  });

  ipcMain.handle('connect:respond', (_event, payload: { id: string; approved: boolean }) =>
    respondToConnect(payload, deps),
  );
}

/** Flush any links that arrived before the window/identity were ready. */
export function markConnectReady(deps: ConnectDeps): void {
  ready = true;
  if (pendingUrl !== null) {
    const url = pendingUrl;
    pendingUrl = null;
    void handleConnectUrl(url, deps);
  }
}
