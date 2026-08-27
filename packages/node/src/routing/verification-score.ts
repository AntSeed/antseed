import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  serviceHash,
  type AttestationSubmittedEvent,
} from '../payments/evm/verifier-client.js';
import type { PeerInfo, PeerModelVerification, PeerVerificationLifecycle } from '../types/peer.js';

export const MODEL_VERIFICATION_MAX_AGE_MS = 30 * 60_000;

export interface VerificationDerivationOptions {
  activeDiffVerifierCount?: number;
  minDistinctDiffVerifiers?: number;
  enforcementActive?: boolean;
}

function lifecycleFor(
  activeDiffVerifierCount: number,
  minDistinctDiffVerifiers: number,
  sawSame: boolean,
): PeerVerificationLifecycle {
  if (activeDiffVerifierCount >= minDistinctDiffVerifiers) return 'suspended';
  if (activeDiffVerifierCount > 0) return 'flagged';
  if (sawSame) return 'verified';
  return 'provisional';
}

export function derivePeerModelVerification(
  expectedServiceHash: string,
  attestations: AttestationSubmittedEvent[],
  options: VerificationDerivationOptions = {},
): PeerModelVerification {
  const ordered = attestations
    .filter((event) => event.serviceHash.toLowerCase() === expectedServiceHash.toLowerCase())
    .slice()
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);

  let sameCount = 0;
  let diffCount = 0;
  let undeterminedCount = 0;
  let sawSame = false;
  let lastConclusiveVerdict = 0;
  const latestByVerifier = new Map<string, AttestationSubmittedEvent>();

  for (const event of ordered) {
    latestByVerifier.set(event.verifier.toLowerCase(), event);
    if (event.verdict === VERIFIER_VERDICT_SAME) {
      sameCount += 1;
      sawSame = true;
      lastConclusiveVerdict = VERIFIER_VERDICT_SAME;
    } else if (event.verdict === VERIFIER_VERDICT_DIFF) {
      diffCount += 1;
      lastConclusiveVerdict = VERIFIER_VERDICT_DIFF;
    } else if (event.verdict === VERIFIER_VERDICT_UNDETERMINED) {
      undeterminedCount += 1;
    }
  }

  const activeDiffEvents = [...latestByVerifier.values()]
    .filter((event) => event.verdict === VERIFIER_VERDICT_DIFF)
    .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
  const activeDiffVerifierCount = Math.max(
    0,
    options.activeDiffVerifierCount ?? activeDiffEvents.length,
  );
  const requiredDiffVerifierCount = Math.max(2, options.minDistinctDiffVerifiers ?? 2);
  const latestActiveDiff = activeDiffEvents.at(-1);
  const latest = ordered.at(-1);
  return {
    serviceHash: expectedServiceHash,
    lifecycle: lifecycleFor(activeDiffVerifierCount, requiredDiffVerifierCount, sawSame),
    sameCount,
    diffCount,
    undeterminedCount,
    activeDiffVerifierCount,
    requiredDiffVerifierCount,
    enforcementActive: options.enforcementActive === true,
    consecutiveDiffCount: activeDiffVerifierCount,
    lastVerdict: latest?.verdict ?? 0,
    lastConclusiveVerdict,
    latestAuditId: latest?.auditId ?? `0x${'0'.repeat(64)}`,
    latestEvidenceHash: latest?.evidenceHash ?? `0x${'0'.repeat(64)}`,
    latestVerifier: latest?.verifier ?? `0x${'0'.repeat(40)}`,
    latestBlockNumber: latest?.blockNumber ?? 0,
    modelShareBps: latestActiveDiff?.modelShareBps ?? 0,
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
  const verification = serviceVerification(peer, requestedService);
  return verification?.enforcementActive === true
    && hasFreshVerification(peer, nowMs)
    && hasModelSubstitutionFlag(verification);
}

export function peerHasModelVerificationWarning(
  peer: PeerInfo,
  requestedService: string | null,
  nowMs: number = Date.now(),
): boolean {
  const verification = serviceVerification(peer, requestedService);
  return verification?.enforcementActive === true
    && hasFreshVerification(peer, nowMs)
    && hasModelVerificationWarning(verification);
}

export function normalizedServiceHash(service: string): string {
  return serviceHash(service);
}
