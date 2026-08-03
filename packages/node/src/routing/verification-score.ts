import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  serviceHash,
  type AttestationSubmittedEvent,
} from '../payments/evm/verifier-client.js';
import type { PeerInfo, PeerModelVerification, PeerVerificationLifecycle } from '../types/peer.js';

export const MODEL_VERIFICATION_MAX_AGE_MS = 30 * 60_000;

function lifecycleFor(consecutiveDiffCount: number, sawSame: boolean): PeerVerificationLifecycle {
  if (consecutiveDiffCount >= 2) return 'suspended';
  if (consecutiveDiffCount === 1) return 'flagged';
  if (sawSame) return 'verified';
  return 'provisional';
}

export function derivePeerModelVerification(
  expectedServiceHash: string,
  attestations: AttestationSubmittedEvent[],
): PeerModelVerification {
  const ordered = attestations
    .filter((event) => event.serviceHash.toLowerCase() === expectedServiceHash.toLowerCase())
    .slice()
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);

  let sameCount = 0;
  let diffCount = 0;
  let undeterminedCount = 0;
  let consecutiveDiffCount = 0;
  let sawSame = false;
  let lastConclusiveVerdict = 0;
  let currentModelShareBps = 0;

  for (const event of ordered) {
    if (event.verdict === VERIFIER_VERDICT_SAME) {
      sameCount += 1;
      consecutiveDiffCount = 0;
      sawSame = true;
      lastConclusiveVerdict = VERIFIER_VERDICT_SAME;
      currentModelShareBps = 0;
    } else if (event.verdict === VERIFIER_VERDICT_DIFF) {
      diffCount += 1;
      consecutiveDiffCount += 1;
      lastConclusiveVerdict = VERIFIER_VERDICT_DIFF;
      currentModelShareBps = event.modelShareBps;
    } else if (event.verdict === VERIFIER_VERDICT_UNDETERMINED) {
      undeterminedCount += 1;
    }
  }

  const latest = ordered.at(-1);
  return {
    serviceHash: expectedServiceHash,
    lifecycle: lifecycleFor(consecutiveDiffCount, sawSame),
    sameCount,
    diffCount,
    undeterminedCount,
    consecutiveDiffCount,
    lastVerdict: latest?.verdict ?? 0,
    lastConclusiveVerdict,
    latestAuditId: latest?.auditId ?? `0x${'0'.repeat(64)}`,
    latestEvidenceHash: latest?.evidenceHash ?? `0x${'0'.repeat(64)}`,
    latestVerifier: latest?.verifier ?? `0x${'0'.repeat(40)}`,
    latestBlockNumber: latest?.blockNumber ?? 0,
    modelShareBps: currentModelShareBps,
  };
}

export function hasModelSubstitutionFlag(verification: PeerModelVerification | undefined): boolean {
  return verification?.lifecycle === 'suspended';
}

export function hasModelVerificationWarning(verification: PeerModelVerification | undefined): boolean {
  return verification?.lifecycle === 'flagged';
}

function serviceVerification(peer: PeerInfo, requestedService: string | null): PeerModelVerification | undefined {
  if (!requestedService || !peer.modelVerification) return undefined;
  return peer.modelVerification[requestedService.trim().toLowerCase()];
}

function hasFreshVerification(peer: PeerInfo, nowMs: number): boolean {
  const fetchedAt = peer.modelVerificationFetchedAt;
  return !(typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)
    && nowMs - fetchedAt >= MODEL_VERIFICATION_MAX_AGE_MS);
}

export function peerHasActiveSubstitutionFlag(
  peer: PeerInfo,
  requestedService: string | null,
  nowMs: number = Date.now(),
): boolean {
  return hasFreshVerification(peer, nowMs)
    && hasModelSubstitutionFlag(serviceVerification(peer, requestedService));
}

export function peerHasModelVerificationWarning(
  peer: PeerInfo,
  requestedService: string | null,
  nowMs: number = Date.now(),
): boolean {
  return hasFreshVerification(peer, nowMs)
    && hasModelVerificationWarning(serviceVerification(peer, requestedService));
}

export function normalizedServiceHash(service: string): string {
  return serviceHash(service);
}
