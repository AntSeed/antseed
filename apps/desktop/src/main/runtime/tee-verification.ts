import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { teeControlFileName, type DesktopTeeStatus, type TeeMode, type TeeSnapshot } from '@antseed/node/tee-status';

export async function buyerPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (listening: boolean): void => { socket.destroy(); resolve(listening); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(true));
  });
}

export async function requestTeeSnapshot(directory: string, port: number, peerId?: string, resumeSession?: string): Promise<TeeSnapshot> {
  const file = join(directory, teeControlFileName(port));
  const metadata = await stat(file);
  if (process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.())) {
    throw new Error('Unsafe buyer verification credential permissions');
  }
  const credential = JSON.parse(await readFile(file, 'utf8')) as { token?: string; sessionId?: string; port?: number };
  if (credential.port !== port || typeof credential.token !== 'string' || !/^[a-f0-9]{64}$/.test(credential.token)
    || typeof credential.sessionId !== 'string') throw new Error('Invalid buyer verification credential');
  if (resumeSession && resumeSession !== credential.sessionId) throw new Error('Buyer changed before resuming routing');
  const response = await fetch(`http://127.0.0.1:${port}/_antseed/verification${resumeSession ? '/resume' : peerId === undefined ? '' : '/check'}`, {
    method: peerId === undefined && !resumeSession ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json' },
    ...(peerId === undefined ? {} : { body: JSON.stringify({ peerId }) }),
    signal: AbortSignal.timeout(peerId === undefined ? 2500 : 35_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(error.error ?? `Buyer verification unavailable (${response.status})`);
  }
  const snapshot = await response.json() as TeeSnapshot;
  if (snapshot.sessionId !== credential.sessionId || !Array.isArray(snapshot.evidence)
    || !['optional', 'required'].includes(snapshot.mode)) throw new Error('Buyer verification session changed');
  return snapshot;
}

export interface TeeSettingsDeps {
  readMode(): Promise<TeeMode>;
  writeMode(mode: TeeMode): Promise<void>;
  snapshot(peerId?: string): Promise<TeeSnapshot>;
  resume(sessionId: string): Promise<TeeSnapshot>;
  listening(): Promise<boolean>;
  blocked(): boolean;
  running(): boolean;
  shared(): boolean;
  restart(prepare: () => Promise<void>, validate: () => Promise<void>): Promise<void>;
}

export class TeeSettings {
  private applying = false;
  private error: string | undefined;

  constructor(private readonly deps: TeeSettingsDeps) {}

  async status(): Promise<DesktopTeeStatus> {
    const configuredMode = await this.deps.readMode();
    if (this.applying) return { configuredMode, applying: true, snapshot: null };
    try {
      const snapshot = await this.deps.snapshot();
      return { configuredMode, snapshot, error: this.error };
    } catch {
      return { configuredMode, snapshot: null, error: this.error };
    }
  }

  async check(peerId: string): Promise<DesktopTeeStatus> {
    if (this.applying) throw new Error('Buyer verification settings are being applied');
    if (typeof peerId !== 'string' || !/^(?:0x)?[a-f0-9]{40}$/i.test(peerId)) throw new Error('Invalid seller peer ID');
    await this.deps.snapshot(peerId);
    return this.status();
  }

  async setMode(mode: TeeMode): Promise<DesktopTeeStatus> {
    if (mode !== 'optional' && mode !== 'required') throw new Error('Invalid verification mode');
    if (this.applying) throw new Error('A verification setting change is already in progress');
    if (this.deps.shared()) throw new Error('This buyer is shared. Change verification in the buyer owner, then reconnect.');
    this.applying = true;
    this.error = undefined;
    try {
      const previous = await this.deps.snapshot().catch(() => null);
      if (!this.deps.running() && await this.deps.listening()) throw new Error('An external buyer owns this port. Stop it before changing verification.');
      if (!this.deps.running() && !this.deps.blocked()) {
        await this.deps.writeMode(mode);
      } else {
        await this.deps.restart(() => this.deps.writeMode(mode), async () => {
          const deadline = Date.now() + 45_000;
          while (Date.now() < deadline) {
            const snapshot = await this.deps.snapshot().catch(() => null);
            if (snapshot && snapshot.sessionId !== previous?.sessionId && snapshot.mode === mode && snapshot.verificationEnabled) {
              const resumed = await this.deps.resume(snapshot.sessionId);
              if (resumed.sessionId !== snapshot.sessionId || resumed.mode !== mode || resumed.routingPaused) {
                throw new Error('Buyer could not safely resume routing');
              }
              return;
            }
            if (!this.deps.running()) throw new Error('Buyer failed to start with the requested verification policy');
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          throw new Error('Buyer did not confirm the requested verification policy');
        });
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Verification setting could not be applied';
    } finally {
      this.applying = false;
    }
    return this.status();
  }
}
