import assert from 'node:assert/strict';
import test from 'node:test';
import { TEE_BADGE_MAX_AGE_MS, TEE_MAX_AGE_MS } from '@antseed/node/tee-status';
import type { VerifyOutcome } from '../plugins/verifier.js';
import { TeeVerification } from './tee-verification.js';

const peer = { peerId: 'a'.repeat(40), capabilities: ['verifier.antseed-verifier'] };
const strict = { require: true, requireSellerNode: true, prefer: ['antseed-verifier'] };
const pass: VerifyOutcome = { ok: true, verified: true, sellerNodeVerified: true, sdk: 'antseed-verifier' };

test('display checks reuse successful evidence for 24 hours without extending it on reads', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  const run = async () => { runs += 1; return pass; };
  await service.verifyForDisplay(peer, run);
  const evidence = service.snapshot([peer]).evidence[0]!;
  assert.equal(evidence.checkedAt, 100);
  assert.equal(evidence.expiresAt, 100 + TEE_BADGE_MAX_AGE_MS);
  now += TEE_MAX_AGE_MS;
  await service.verifyForDisplay(peer, run);
  now = evidence.expiresAt - 1;
  await service.verifyForDisplay(peer, run);
  assert.equal(runs, 1);
  assert.deepEqual(service.snapshot([peer]).evidence[0], evidence);
  now = evidence.expiresAt;
  await service.verifyForDisplay(peer, run);
  assert.equal(runs, 2);
});

test('a day-long badge never authorizes routing after the five-minute routing expiry', async () => {
  let now = 100;
  const service = new TeeVerification(strict, () => now);
  let runs = 0;
  await service.verifyForDisplay(peer, async () => pass);
  now += TEE_MAX_AGE_MS;
  assert.ok(service.snapshot([peer]).evidence[0]!.expiresAt > now);
  const outcome = await service.verify(peer, strict, async () => {
    runs += 1;
    return { ok: false, verified: false, sellerNodeVerified: false };
  });
  assert.equal(runs, 1);
  assert.equal(outcome.ok, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.expiresAt, now + TEE_MAX_AGE_MS);
});

test('routing and display share in-flight checks and revoke badges on unavailable results', async () => {
  let now = 100;
  const service = new TeeVerification(strict, () => now);
  let finish!: (outcome: VerifyOutcome) => void;
  const display = service.verifyForDisplay(peer, () => new Promise<VerifyOutcome>((resolve) => { finish = resolve; }));
  const routed = service.verify(peer, strict, async () => { assert.fail('duplicate attestation'); });
  await Promise.resolve();
  finish(pass);
  assert.ok((await display).sellerNodeVerified);
  assert.ok((await routed).ok);
  now += TEE_MAX_AGE_MS;
  await service.verify(peer, strict, async () => ({ ok: false, verified: false, transient: true }));
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, true);
  assert.ok((await service.verifyForDisplay(peer, async () => pass)).sellerNodeVerified);
});

test('display failures keep the short TTL and capability changes discard day-long successes', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  await service.verifyForDisplay(peer, async () => ({ ok: false, verified: false }));
  assert.equal(service.snapshot([peer]).evidence[0]?.expiresAt, now + TEE_MAX_AGE_MS);
  now += TEE_MAX_AGE_MS;
  const run = async () => { runs += 1; return pass; };
  await service.verifyForDisplay(peer, run);
  const changed = { ...peer, capabilities: [...peer.capabilities, 'verifier.other'] };
  service.observePeers([changed]);
  assert.deepEqual(service.snapshot([changed]).evidence, []);
  await service.verifyForDisplay(changed, run);
  assert.equal(runs, 2);
  service.close();
  assert.deepEqual(service.snapshot([changed]).evidence, []);
  assert.equal((await service.verifyForDisplay(changed, run)).ok, false);
});

test('evidence cache never reuses an optional routing allowance as required verification', async () => {
  const service = new TeeVerification(strict);
  const fail = { ok: true, verified: false, reason: 'Failed' };
  assert.equal((await service.verify(peer, { require: false }, async () => fail)).ok, true);
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, false);
});

test('expiry, forced failed recheck, transient retries and daemon restart revoke success', async () => {
  let now = 100;
  let runs = 0;
  const service = new TeeVerification(strict, () => now);
  const run = async () => { runs += 1; return pass; };
  await service.verify(peer, strict, run);
  await service.verify(peer, strict, run);
  assert.equal(runs, 1);
  now += TEE_MAX_AGE_MS;
  await service.verify(peer, strict, run);
  assert.equal(runs, 2);
  await service.verify(peer, strict, async () => ({ ok: false, verified: false, transient: true }), true);
  assert.equal(service.snapshot([peer]).evidence[0]?.sellerNodeVerified, false);
  assert.equal(service.snapshot([peer]).evidence[0]?.unavailable, true);
  await service.verify(peer, strict, run);
  assert.equal(runs, 3);
  const restarted = new TeeVerification(strict);
  assert.notEqual(service.sessionId, restarted.sessionId);
  assert.deepEqual(restarted.snapshot([peer]).evidence, []);
});

test('concurrent checks deduplicate; superseded advertisements cannot restore old evidence', async () => {
  const service = new TeeVerification(strict);
  let finish!: (outcome: VerifyOutcome) => void;
  let runs = 0;
  const run = () => { runs += 1; return new Promise<VerifyOutcome>((resolve) => { finish = resolve; }); };
  const first = service.verify(peer, strict, run);
  const second = service.verify(peer, strict, run, true);
  await Promise.resolve();
  assert.equal(runs, 1);
  assert.equal(service.snapshot([peer]).evidence[0]?.checking, true);
  const changed = { ...peer, capabilities: [...peer.capabilities, 'verifier.other'] };
  await service.verify(changed, strict, async () => ({ ok: false, verified: false }));
  finish(pass);
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false);
  assert.equal(service.snapshot([changed]).evidence[0]?.sellerNodeVerified, false);
  assert.deepEqual(service.snapshot([{ ...peer, capabilities: [] }]).evidence, []);
  assert.deepEqual(service.snapshot([peer]).evidence, []);
});

test('discovery updates revoke evidence even without a status reader', async () => {
  const service = new TeeVerification(strict);
  await service.verify(peer, strict, async () => pass);
  service.observePeers([{ ...peer, capabilities: [] }]);
  service.observePeers([peer]);
  assert.deepEqual(service.snapshot([peer]).evidence, []);
});

test('stopped sessions and exhausted concurrency fail closed', async () => {
  const service = new TeeVerification(strict);
  const finishers: Array<(outcome: VerifyOutcome) => void> = [];
  const pending = Array.from({ length: 8 }, (_, index) => service.verify({ ...peer, peerId: String(index) }, strict,
    () => new Promise<VerifyOutcome>((resolve) => finishers.push(resolve))));
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
  await Promise.resolve();
  service.close();
  finishers.forEach((finish) => finish(pass));
  assert.ok((await Promise.all(pending)).every((outcome) => !outcome.ok));
  assert.equal((await service.verify(peer, strict, async () => pass)).ok, false);
});
