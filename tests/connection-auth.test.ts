import { describe, expect, it } from 'vitest';
import * as ed from '@noble/ed25519';
import { toPeerId } from '../src/types/peer.js';
import { bytesToHex } from '../src/utils/hex.js';
import {
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  verifyConnectionAuthEnvelope,
} from '../src/p2p/connection-auth.js';

async function createIdentity(): Promise<{ peerId: string; privateKey: Uint8Array }> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));
  return { peerId, privateKey };
}

describe('connection-auth', () => {
  it('accepts valid signed intro auth', async () => {
    const { peerId, privateKey } = await createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, privateKey, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(result.peerId).toBe(peerId);
  });

  it('rejects payload type mismatch', async () => {
    const { peerId, privateKey } = await createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, privateKey, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('signature');
  });

  it('rejects stale auth timestamps', async () => {
    const { peerId, privateKey } = await createIdentity();
    const auth = buildConnectionAuthEnvelope('hello', peerId, privateKey, 1_000);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs: 100_000,
      maxSkewMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('timestamp');
  });

  it('rejects replayed nonces when replay guard is enabled', async () => {
    const { peerId, privateKey } = await createIdentity();
    const guard = new NonceReplayGuard();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, privateKey, nowMs);

    const first = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
      replayGuard: guard,
    });
    const second = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
      replayGuard: guard,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toContain('replayed');
  });
});
