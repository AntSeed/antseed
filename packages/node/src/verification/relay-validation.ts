import { ZeroHash, getAddress, recoverAddress } from 'ethers';
import type { AuditRelayJobPayload } from '../types/protocol.js';
import type { SerializedHttpRequest } from '../types/http.js';
import { decodeHttpRequest } from '../proxy/request-codec.js';
import { RelayTreasuryClient } from '../payments/evm/relay-treasury-client.js';
import {
  VerifierRegistryClient,
  serviceHash,
  type AuditJob,
} from '../payments/evm/verifier-client.js';
import { hashRequest } from './response-auth.js';

export interface RelayJobValidatorConfig {
  chainId: string;
  registryAddress: string;
  treasuryAddress: string;
  relayBuyerAddress: string;
  minimumPayoutPerJobUsdc: bigint;
  verifierRegistryClient: VerifierRegistryClient;
  relayTreasuryClient: RelayTreasuryClient;
  now?: () => number;
}

export interface ValidatedRelayJob {
  request: SerializedHttpRequest;
  job: AuditJob;
}

export class RelayJobValidator {
  constructor(private readonly _config: RelayJobValidatorConfig) {}

  async validate(offer: AuditRelayJobPayload): Promise<ValidatedRelayJob> {
    if (offer.chainId !== this._config.chainId) throw new Error('relay offer chain mismatch');
    if (!sameAddress(offer.registryAddress, this._config.registryAddress)) throw new Error('relay offer registry mismatch');
    if (!sameAddress(offer.treasuryAddress, this._config.treasuryAddress)) throw new Error('relay offer treasury mismatch');
    if (offer.assignment.attempt < 0 || offer.assignment.attempt >= 3) throw new Error('relay assignment attempt is invalid');
    if (!sameAddress(offer.assignment.relayBuyer, this._config.relayBuyerAddress)) {
      throw new Error('assigned relay buyer does not match local identity');
    }
    if (!sameAddress(offer.job.sellerPeerId, offer.targetPeerId)) throw new Error('target seller mismatch');
    if (offer.job.serviceHash.toLowerCase() !== serviceHash(offer.service).toLowerCase()) {
      throw new Error('target service hash mismatch');
    }
    const payout = BigInt(offer.payoutPerJobUsdc);
    if (payout < this._config.minimumPayoutPerJobUsdc) throw new Error('relay payout below configured minimum');
    const requestBytes = Buffer.from(offer.requestBytesBase64, 'base64');
    const request = decodeHttpRequest(requestBytes);
    if (hashRequest(request).toLowerCase() !== offer.job.requestHash.toLowerCase()) {
      throw new Error('relay request hash mismatch');
    }

    const now = Math.floor((this._config.now?.() ?? Date.now()) / 1000);
    if (now < offer.assignment.executeAfter || now >= offer.assignment.executeBefore) throw new Error('relay job window is closed');
    const job: AuditJob = { ...offer.job, sellerPeerId: getAddress(offer.job.sellerPeerId) };
    const [audit, reservation, leaf, paid, requestPaymentKey] = await Promise.all([
      this._config.verifierRegistryClient.getAudit(job.auditId),
      this._config.relayTreasuryClient.getReservation(job.auditId),
      this._config.verifierRegistryClient.hashAuditJob(job),
      this._config.verifierRegistryClient.isRelayJobPaid(job.auditId, job.jobIndex),
      this._config.verifierRegistryClient.paidRequestHash(job.requestHash),
    ]);
    if (audit.committer === getAddress('0x0000000000000000000000000000000000000000')) throw new Error('audit not found');
    if (!sameAddress(audit.committer, offer.auditSnapshot.committer)) throw new Error('audit snapshot committer mismatch');
    if (audit.attested) throw new Error('audit already attested');
    if (offer.auditSnapshot.attested) throw new Error('audit snapshot is already attested');
    if (audit.auditJobRoot.toLowerCase() !== offer.auditSnapshot.auditJobRoot.toLowerCase()) {
      throw new Error('audit snapshot root mismatch');
    }
    if (audit.jobCount !== offer.auditSnapshot.jobCount || audit.jobCount !== reservation.jobCount) {
      throw new Error('audit job count mismatch');
    }
    if (audit.payoutPerJobUsdc !== payout || reservation.payoutPerJobUsdc !== payout) {
      throw new Error('frozen relay payout mismatch');
    }
    if (BigInt(offer.auditSnapshot.payoutPerJobUsdc) !== payout
      || BigInt(offer.auditSnapshot.reservedRelayBudgetUsdc) !== audit.reservedRelayBudgetUsdc) {
      throw new Error('audit snapshot payout mismatch');
    }
    if (reservation.totalBudgetUsdc !== audit.reservedRelayBudgetUsdc || reservation.released) {
      throw new Error('relay reservation is not funded');
    }
    if (reservation.remainingBudgetUsdc < payout) throw new Error('relay reservation is exhausted');
    if (audit.executeAfter !== offer.auditSnapshot.executeAfter
      || audit.executeBefore !== offer.auditSnapshot.executeBefore
      || audit.forceClaimAvailableAt !== offer.auditSnapshot.forceClaimAvailableAt
      || audit.forceClaimDeadline !== offer.auditSnapshot.forceClaimDeadline) {
      throw new Error('audit snapshot window mismatch');
    }
    if (job.executeAfter < audit.executeAfter || job.executeBefore > audit.executeBefore) {
      throw new Error('job window falls outside audit window');
    }
    const assignment = {
      ...offer.assignment,
      relayBuyer: getAddress(offer.assignment.relayBuyer),
      payoutPerJobUsdc: BigInt(offer.assignment.payoutPerJobUsdc),
    };
    if (assignment.auditId !== job.auditId || assignment.jobIndex !== job.jobIndex) {
      throw new Error('assignment does not match job');
    }
    if (assignment.payoutPerJobUsdc !== audit.payoutPerJobUsdc) throw new Error('assignment payout mismatch');
    if (assignment.executeAfter < job.executeAfter || assignment.executeBefore > job.executeBefore) {
      throw new Error('assignment window falls outside job window');
    }
    const assignmentDigest = await this._config.verifierRegistryClient.hashRelayAssignment(assignment);
    if (!sameAddress(recoverAddress(assignmentDigest, offer.verifierSignature), audit.committer)) {
      throw new Error('invalid verifier assignment signature');
    }
    const proofValid = await this._config.verifierRegistryClient.verifyAuditJobProof(
      audit.auditJobRoot,
      leaf,
      job.jobIndex,
      audit.jobCount,
      offer.jobProof,
    );
    if (!proofValid) throw new Error('invalid positional job proof');
    if (paid) throw new Error('relay job is already paid');
    if (requestPaymentKey.toLowerCase() !== ZeroHash.toLowerCase()) throw new Error('request hash was already paid');
    return { request, job };
  }
}

export function estimateFrozenRelayPayout(
  worstCaseSellerQuotesUsdc: readonly bigint[],
  flatRelayFeeUsdc: bigint,
): bigint {
  if (worstCaseSellerQuotesUsdc.length === 0) throw new Error('at least one seller quote is required');
  if (flatRelayFeeUsdc < 0n || worstCaseSellerQuotesUsdc.some((quote) => quote < 0n)) {
    throw new Error('relay payout inputs must be non-negative');
  }
  return worstCaseSellerQuotesUsdc.reduce((maximum, quote) => quote > maximum ? quote : maximum, 0n)
    + flatRelayFeeUsdc;
}

export async function preflightRelayBudget(input: {
  treasury: RelayTreasuryClient;
  epoch: bigint;
  jobCount: number;
  payoutPerJobUsdc: bigint;
}): Promise<{ requiredBudgetUsdc: bigint }> {
  if (!Number.isInteger(input.jobCount) || input.jobCount <= 0) throw new Error('jobCount must be positive');
  const requiredBudgetUsdc = input.payoutPerJobUsdc * BigInt(input.jobCount);
  const [maxPerJob, maxPerAudit, maxPerEpoch, committed, available] = await Promise.all([
    input.treasury.maxPayoutPerJob(),
    input.treasury.maxPayoutPerAudit(),
    input.treasury.maxCommittedBudgetPerEpoch(),
    input.treasury.committedBudgetByEpoch(input.epoch),
    input.treasury.availableBalance(),
  ]);
  if (input.payoutPerJobUsdc <= 0n || input.payoutPerJobUsdc > maxPerJob) throw new Error('relay payout exceeds per-job cap');
  if (requiredBudgetUsdc > maxPerAudit) throw new Error('relay budget exceeds per-audit cap');
  if (committed + requiredBudgetUsdc > maxPerEpoch) throw new Error('relay budget exceeds epoch cap');
  if (available < requiredBudgetUsdc) throw new Error('relay treasury is underfunded');
  return { requiredBudgetUsdc };
}

function sameAddress(left: string, right: string): boolean {
  const normalize = (value: string): string => getAddress(value.startsWith('0x') ? value : `0x${value}`);
  return normalize(left) === normalize(right);
}
