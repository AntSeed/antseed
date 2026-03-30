import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { toPeerId } from '../src/types/peer.js';
import { bytesToHex } from '../src/utils/hex.js';
import {
  NonceReplayGuard,
  buildConnectionAuthEnvelope,
  verifyConnectionAuthEnvelope,
} from '../src/p2p/connection-auth.js';
import type { Identity } from '../src/p2p/identity.js';

function createIdentity(): Identity {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

describe('connection-auth', () => {
  it('accepts valid signed intro auth', () => {
    const { peerId, wallet } = createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'intro',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(result.peerId).toBe(peerId);
  });

  it('rejects payload type mismatch', () => {
    const { peerId, wallet } = createIdentity();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('signature');
  });

  it('rejects stale auth timestamps', () => {
    const { peerId, wallet } = createIdentity();
    const auth = buildConnectionAuthEnvelope('hello', peerId, wallet, 1_000);

    const result = verifyConnectionAuthEnvelope({
      type: 'hello',
      auth,
      nowMs: 100_000,
      maxSkewMs: 30_000,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('timestamp');
  });

  it('rejects replayed nonces when replay guard is enabled', () => {
    const { peerId, wallet } = createIdentity();
    const guard = new NonceReplayGuard();
    const nowMs = 1_700_000_000_000;
    const auth = buildConnectionAuthEnvelope('intro', peerId, wallet, nowMs);

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
