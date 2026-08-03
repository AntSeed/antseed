/**
 * Where the system-proxy runtime keeps its files.
 *
 * All under the CLI's connect data dir, because the CLI child writes most of
 * them; see `state.ts` for which side owns which file.
 */
import path from 'node:path';
import { resolveConnectDataDir } from '../runtime/process-manager.js';

export function systemProxyDataDir(): string {
  return path.join(resolveConnectDataDir(), 'system-proxy');
}

export function systemProxyCaPath(): string {
  return path.join(systemProxyDataDir(), 'ca.crt');
}

export function systemProxyPidPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.pid');
}

export function systemProxyStatePath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.state.json');
}

/**
 * Desktop-owned copy of the connection state. The CLI child owns
 * system-proxy.state.json — it rewrites it on boot and deletes it in its
 * graceful-shutdown handler — so the desktop's reconnect-at-launch memory
 * must live in a file the child never touches, or every clean quit forgets
 * which apps were connected.
 */
export function systemProxyDesktopStatePath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.desktop.json');
}

export function systemProxySnapshotPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.snapshot.json');
}
