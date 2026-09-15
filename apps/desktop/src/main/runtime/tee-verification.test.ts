import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teeControlFileName } from '@antseed/node/tee-status';
import type { TeeMode, TeeSnapshot } from '@antseed/node/tee-status';
import { requestTeeSnapshot, TeeSettings, type TeeSettingsDeps } from './tee-verification.js';
import { ProcessManager } from './process-manager.js';

function fixture() {
  let mode: TeeMode = 'optional';
  let running = true;
  let shared = false;
  let fail = false;
  let blocked = false;
  let session = 'old';
  const events: string[] = [];
  const snapshot = (): TeeSnapshot => ({ sessionId: session, mode, verificationEnabled: true, evidence: [] });
  const deps: TeeSettingsDeps = {
    readMode: async () => mode,
    writeMode: async (next) => { events.push(`save:${next}`); mode = next; },
    snapshot: async () => { if (!running) throw new Error('Offline'); return snapshot(); },
    resume: async () => { events.push('resume'); return snapshot(); },
    running: () => running,
    shared: () => shared,
    blocked: () => blocked,
    listening: async () => false,
    restart: async (prepare, validate) => {
      events.push('stop'); running = false;
      await prepare();
      if (fail) { blocked = true; throw new Error('Verifier unavailable'); }
      events.push('start'); running = true; session = 'new';
      await validate();
      blocked = false;
    },
  };
  return { deps, events, settings: new TeeSettings(deps), offline: () => { running = false; }, share: () => { shared = true; }, fail: () => { fail = true; }, recover: () => { fail = false; } };
}

test('policy restart stops first, preserves config on failure, and resumes only a confirmed new session', async () => {
  const good = fixture();
  const status = await good.settings.setMode('required');
  assert.deepEqual(good.events, ['stop', 'save:required', 'start', 'resume']);
  assert.equal(status.snapshot?.mode, 'required');
  const failure = fixture();
  failure.fail();
  const failed = await failure.settings.setMode('required');
  assert.equal(failed.configuredMode, 'required');
  assert.equal(failed.snapshot, null);
  assert.match(failed.error!, /Verifier unavailable/);
  assert.deepEqual(failure.events, ['stop', 'save:required']);
  failure.recover();
  assert.equal((await failure.settings.setMode('required')).snapshot?.mode, 'required');
});

test('offline settings are pending and shared/external buyers cannot be changed', async () => {
  const offline = fixture(); offline.offline();
  assert.equal((await offline.settings.setMode('required')).snapshot, null);
  assert.deepEqual(offline.events, ['save:required']);
  const shared = fixture(); shared.share();
  await assert.rejects(shared.settings.setMode('required'), /shared/);
  assert.deepEqual(shared.events, []);
  const external = fixture(); external.offline(); external.deps.listening = async () => true;
  assert.match((await external.settings.setMode('required')).error!, /external buyer/);
  assert.deepEqual(external.events, []);
});

test('checks accept only seller IDs and never accept arbitrary targets', async () => {
  const { settings } = fixture();
  await assert.rejects(settings.check('https://evil.test'), /Invalid seller/);
  await assert.rejects(settings.setMode('unsafe' as TeeMode), /Invalid verification mode/);
});

test('restart failure blocks automatic starts until a successful explicit retry', async () => {
  const manager = new ProcessManager(() => {});
  const mutable = manager as unknown as { startProcess: () => Promise<unknown> };
  mutable.startProcess = async () => ({});
  await assert.rejects(manager.restartConnect({ mode: 'connect' }, async () => {}, async () => { throw new Error('Mismatch'); }), /Mismatch/);
  assert.equal(manager.isConnectRestartBlocked(), true);
  await assert.rejects(manager.start({ mode: 'connect' }), /Reapply/);
  await manager.restartConnect({ mode: 'connect' }, async () => {}, async () => {});
  assert.equal(manager.isConnectRestartBlocked(), false);
});

test('main-process requests keep credentials private and bind resume to the expected session', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-tee-client-'));
  const token = 'b'.repeat(64);
  let sessionId = 'current';
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.origin, undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessionId, mode: 'required', verificationEnabled: true, evidence: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, teeControlFileName(port));
  await writeFile(file, JSON.stringify({ token, sessionId, port }), { mode: 0o600 });
  const snapshot = await requestTeeSnapshot(directory, port);
  assert.equal(snapshot.mode, 'required');
  assert.ok(!JSON.stringify(snapshot).includes(token));
  await assert.rejects(requestTeeSnapshot(directory, port, undefined, 'old'), /changed before resuming/);
  assert.equal(requests, 1);
  sessionId = 'unexpected';
  await assert.rejects(requestTeeSnapshot(directory, port), /session changed/);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(requestTeeSnapshot(directory, port), /permissions/);
  }
});

test('concurrent policy changes and automatic starts cannot race a controlled restart', async () => {
  const manager = new ProcessManager(() => {});
  const mutable = manager as unknown as { startProcess: () => Promise<unknown> };
  mutable.startProcess = async () => ({});
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const restart = manager.restartConnect({ mode: 'connect' }, () => barrier, async () => {});
  await assert.rejects(manager.start({ mode: 'connect' }), /Reapply/);
  await assert.rejects(manager.restartConnect({ mode: 'connect' }, async () => {}, async () => {}), /cannot be restarted/);
  release();
  await restart;
});
