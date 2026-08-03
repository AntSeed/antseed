import { describe, expect, it } from 'vitest';
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  serviceHash,
  type AttestationSubmittedEvent,
} from '../src/payments/evm/verifier-client.js';
import {
  derivePeerModelVerification,
  hasModelSubstitutionFlag,
  hasModelVerificationWarning,
  peerHasActiveSubstitutionFlag,
  peerHasModelVerificationWarning,
} from '../src/routing/verification-score.js';
import type { PeerInfo } from '../src/types/peer.js';

const SERVICE = 'gpt-5.6-sol';
const SERVICE_HASH = serviceHash(SERVICE);

function event(
  verdict: number,
  blockNumber: number,
  overrides: Partial<AttestationSubmittedEvent> = {},
): AttestationSubmittedEvent {
  return {
    auditId: `0x${blockNumber.toString(16).padStart(64, '0')}`,
    verifier: '0x' + '11'.repeat(20),
    agentId: 7n,
    serviceHash: SERVICE_HASH,
    verdict: verdict as AttestationSubmittedEvent['verdict'],
    modelShareBps: verdict === VERIFIER_VERDICT_DIFF ? 2500 : 0,
    evidenceHash: '0x' + '22'.repeat(32),
    relayClaimCount: 3,
    relayPayoutUsdc: 3_000n,
    blockNumber,
    logIndex: 0,
    transactionHash: '0x' + '33'.repeat(32),
    ...overrides,
  };
}

function peerWith(events: AttestationSubmittedEvent[], fetchedAt = Date.now()): PeerInfo {
  return {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'],
    providers: [],
    lastSeen: Date.now(),
    modelVerification: {
      [SERVICE]: derivePeerModelVerification(SERVICE_HASH, events),
    },
    modelVerificationFetchedAt: fetchedAt,
  };
}

describe('derivePeerModelVerification', () => {
  it('starts provisional when there is no matching evidence', () => {
    expect(derivePeerModelVerification(SERVICE_HASH, [])).toMatchObject({
      serviceHash: SERVICE_HASH,
      lifecycle: 'provisional',
      sameCount: 0,
      diffCount: 0,
      undeterminedCount: 0,
      consecutiveDiffCount: 0,
      lastVerdict: 0,
      lastConclusiveVerdict: 0,
      modelShareBps: 0,
    });
  });

  it('flags the first conclusive DIFF and suspends on the second consecutive DIFF', () => {
    const flagged = derivePeerModelVerification(SERVICE_HASH, [event(VERIFIER_VERDICT_DIFF, 10)]);
    expect(flagged.lifecycle).toBe('flagged');
    expect(flagged.consecutiveDiffCount).toBe(1);
    expect(flagged.modelShareBps).toBe(2500);

    const suspended = derivePeerModelVerification(SERVICE_HASH, [
      event(VERIFIER_VERDICT_DIFF, 10),
      event(VERIFIER_VERDICT_DIFF, 11, { modelShareBps: 4000 }),
    ]);
    expect(suspended.lifecycle).toBe('suspended');
    expect(suspended.consecutiveDiffCount).toBe(2);
    expect(suspended.modelShareBps).toBe(4000);
  });

  it('SAME clears the service penalty and routing exclusion', () => {
    const result = derivePeerModelVerification(SERVICE_HASH, [
      event(VERIFIER_VERDICT_DIFF, 10),
      event(VERIFIER_VERDICT_DIFF, 11),
      event(VERIFIER_VERDICT_SAME, 12),
    ]);
    expect(result.lifecycle).toBe('verified');
    expect(result.consecutiveDiffCount).toBe(0);
    expect(result.lastConclusiveVerdict).toBe(VERIFIER_VERDICT_SAME);
    expect(result.modelShareBps).toBe(0);
  });

  it('UNDETERMINED records availability without changing lifecycle or penalty', () => {
    const result = derivePeerModelVerification(SERVICE_HASH, [
      event(VERIFIER_VERDICT_DIFF, 10),
      event(VERIFIER_VERDICT_UNDETERMINED, 12),
    ]);
    expect(result.lifecycle).toBe('flagged');
    expect(result.undeterminedCount).toBe(1);
    expect(result.lastVerdict).toBe(VERIFIER_VERDICT_UNDETERMINED);
    expect(result.lastConclusiveVerdict).toBe(VERIFIER_VERDICT_DIFF);
    expect(result.modelShareBps).toBe(2500);
  });

  it('sorts events by chain position and ignores other services', () => {
    const otherService = event(VERIFIER_VERDICT_DIFF, 99, { serviceHash: serviceHash('other') });
    const result = derivePeerModelVerification(SERVICE_HASH, [
      event(VERIFIER_VERDICT_SAME, 12),
      otherService,
      event(VERIFIER_VERDICT_DIFF, 10),
      event(VERIFIER_VERDICT_UNDETERMINED, 12, { logIndex: 1 }),
    ]);
    expect(result.lifecycle).toBe('verified');
    expect(result.diffCount).toBe(1);
    expect(result.sameCount).toBe(1);
    expect(result.latestBlockNumber).toBe(12);
    expect(result.lastVerdict).toBe(VERIFIER_VERDICT_UNDETERMINED);
  });
});

describe('verification routing state', () => {
  it('distinguishes deprioritized flagged peers from excluded suspended peers', () => {
    const flagged = derivePeerModelVerification(SERVICE_HASH, [event(VERIFIER_VERDICT_DIFF, 1)]);
    const suspended = derivePeerModelVerification(SERVICE_HASH, [
      event(VERIFIER_VERDICT_DIFF, 1),
      event(VERIFIER_VERDICT_DIFF, 2),
    ]);
    expect(hasModelVerificationWarning(flagged)).toBe(true);
    expect(hasModelSubstitutionFlag(flagged)).toBe(false);
    expect(hasModelVerificationWarning(suspended)).toBe(false);
    expect(hasModelSubstitutionFlag(suspended)).toBe(true);
  });

  it('honors fresh service-specific state and ignores stale state', () => {
    const now = 1_800_000_000_000;
    const suspendedEvents = [event(VERIFIER_VERDICT_DIFF, 1), event(VERIFIER_VERDICT_DIFF, 2)];
    const fresh = peerWith(suspendedEvents, now - 1_000);
    const stale = peerWith(suspendedEvents, now - 31 * 60_000);
    expect(peerHasActiveSubstitutionFlag(fresh, SERVICE, now)).toBe(true);
    expect(peerHasActiveSubstitutionFlag(stale, SERVICE, now)).toBe(false);
  });

  it('does not apply one service lifecycle to another service', () => {
    const flagged = peerWith([event(VERIFIER_VERDICT_DIFF, 1)]);
    expect(peerHasModelVerificationWarning(flagged, SERVICE)).toBe(true);
    expect(peerHasModelVerificationWarning(flagged, 'other-model')).toBe(false);
  });
});
