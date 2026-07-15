import {
  Contract,
  hexlify,
  keccak256,
  toUtf8Bytes,
  type AbstractSigner,
  type BytesLike,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { computeBatchRoot, type ExchangeRecord } from '../../verification/exchange-batch.js';

export interface VerifierRegistryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface VerifierRewardsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

/**
 * On-chain verdict codes. FROZEN mapping shared with
 * AntseedVerifierRegistry.sol and @antseed/fingerprints.
 */
export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

export interface VerifierAttestation {
  verifier: string;
  attestedAt: number;
  verdict: number;
  probeCount: number;
  cohortSize: number;
  evidenceHash: string;
  probeCommitment: string;
  /** Root of the on-chain-anchored exchange batch the verdict references. */
  batchRoot: string;
}

/**
 * Anchor state per (verifier, batchRoot), mirroring the contract's
 * `batchAnchors` struct mapping. `anchoredAt === 0` means never anchored.
 */
export interface BatchAnchor {
  /** Unix seconds when the batch was anchored (0 = never anchored). */
  anchoredAt: number;
  /** Number of ExchangeRecords anchored — one per signed stealth request. */
  recordCount: number;
  /**
   * Verifier-declared total probes bundled across the batch's records,
   * fixed at anchor time. Caps the probeCount any attestation referencing
   * the batch may claim.
   */
  probeCount: number;
  /** Probe-set commitment the batch was anchored under. */
  commitment: string;
}

/** Per-(agentId, service) or per-agent verification accumulators. */
export interface ServiceVerificationStats {
  sameCount: number;
  diffCount: number;
  undeterminedCount: number;
  distinctVerifierCount: number;
  lastVerdict: number;
  lastVerifier: string;
  /**
   * Distinct verifiers whose LATEST verdict is DIFF — a standing, retractable
   * accusation, unlike the monotonic historical `diffCount`. The on-chain
   * points penalty gates on this reaching `minDistinctDiffVerifiers`.
   */
  activeDiffVerifierCount: number;
}

const VERIFIER_REGISTRY_ABI = [
  // Writes
  'function commitProbeSet(bytes32 commitment) external',
  'function anchorExchangeBatch(bytes32 probeCommitment, (uint256,bytes32,bytes32,bytes)[] records, bytes[] signingPayloads, uint32[] recordProbeCounts) external returns (bytes32)',
  'function submitAttestation(uint256 agentId, bytes32 serviceHash, uint8 verdict, bytes32 evidenceHash, bytes32 probeCommitment, bytes32 batchRoot, uint32 probeCount, uint32 cohortSize) external',
  'function revealProbeSet(bytes32 probeCommitment, bytes probeSetJson, string packUri) external',
  'function claimDelegateCredits(address verifier, bytes32 probeCommitment, address buyer) external',
  // Reads
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function probeCommittedAt(address verifier, bytes32 commitment) external view returns (uint64)',
  'function batchAnchors(address verifier, bytes32 batchRoot) external view returns (uint64 anchoredAt, uint32 recordCount, uint32 probeCount, bytes32 commitment)',
  'function probeRevealedAt(address verifier, bytes32 commitment) external view returns (uint64)',
  'function lastAuditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function lastCreditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function latestAttestation(uint256 agentId, bytes32 serviceHash) external view returns (tuple(address verifier, uint64 attestedAt, uint8 verdict, uint32 probeCount, uint32 cohortSize, bytes32 evidenceHash, bytes32 probeCommitment, bytes32 batchRoot))',
  'function verificationStats(uint256 agentId, bytes32 serviceHash) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function agentVerificationStats(uint256 agentId) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function epochCredits(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function auditCooldown() external view returns (uint64)',
  'function maxCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function minProbeCount() external view returns (uint32)',
  'function delegateShareBps() external view returns (uint16)',
  'function maxDelegateCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function registry() external view returns (address)',
  'function epochDelegateCredits(uint256 epoch, address delegate) external view returns (uint256)',
  'function epochTotalDelegateCredits(uint256 epoch) external view returns (uint256)',
  'function epochDelegateCreditsGrantedBy(uint256 epoch, address verifier) external view returns (uint256)',
  'function commitmentDelegateAccrued(address verifier, bytes32 commitment, address buyer) external view returns (uint32)',
  'function commitmentDelegateClaimed(address verifier, bytes32 commitment, address buyer) external view returns (uint32)',
  'function commitmentDelegateBudget(address verifier, bytes32 commitment) external view returns (uint256)',
  'function commitmentDelegateCredits(address verifier, bytes32 commitment) external view returns (uint256)',
  'function responseAuthDigest(bytes signingPayload) external pure returns (bytes32)',
  'function parseResponseAuthPayload(bytes payload) external pure returns (address buyer, bytes32 advertisedServiceHash, bytes32 requestHash, bytes32 responseHash)',
  // Events
  'event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri)',
  'event ExchangeBatchAnchored(address indexed verifier, bytes32 indexed probeCommitment, bytes32 indexed batchRoot, uint32 recordCount, uint32 probeCount)',
  'event DelegateCreditsAccrued(address indexed verifier, bytes32 indexed probeCommitment, address indexed buyer, uint32 credits)',
] as const;

const VERIFIER_REWARDS_ABI = [
  // Writes
  'function claimVerifierReward(uint256 epoch) external',
  'function claimDelegateReward(uint256 epoch) external',
  'function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount)',
  // Reads
  'function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256)',
  'function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256)',
  'function verifierEpochBudget(uint256 epoch) external view returns (uint256)',
  'function delegateEpochPool(uint256 epoch) external view returns (uint256)',
  'function epochRewardClaimed(uint256 epoch, address verifier) external view returns (bool)',
  'function epochDelegateRewardClaimed(uint256 epoch, address delegate) external view returns (bool)',
  'function gate() external view returns (address)',
] as const;

const EMISSIONS_GATE_MINI_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function effectiveEpoch() external view returns (uint256)',
] as const;

// =========================================================================
// Points-policy exclusion threshold (minDistinctDiffVerifiers)
// =========================================================================

/**
 * Offline default for `AntseedVerifierPointsPolicy.minDistinctDiffVerifiers`
 * (the contract's constructor default is 2). Used whenever the on-chain value
 * cannot be read — no chain config, RPC failure, or a chain where the
 * recognized-usage stack is not (fully) deployed. The live value is read via
 * {@link VerifierRegistryClient.getMinDistinctDiffVerifiers}.
 */
export const DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS = 2;

/**
 * Refresh interval for the cached on-chain `minDistinctDiffVerifiers`. The
 * value is an owner-tuned policy knob that changes rarely, so a generous TTL
 * keeps the read off the per-request path. Failures are cached for one TTL
 * too, so a dead RPC is not re-probed on every routing decision.
 */
const MIN_DISTINCT_DIFF_VERIFIERS_TTL_MS = 10 * 60_000;

/**
 * Minter id of the recognized-usage emissions bucket
 * (`keccak256("antseed.emissions.usage.v1")` in AntseedEmissionsGate). Its
 * controller is AntseedUsageRewards, the hop that leads to the points policy.
 */
const USAGE_MINTER_ID = keccak256(toUtf8Bytes('antseed.emissions.usage.v1'));

// One-function mini ABIs for the address-resolution hops from the verifier
// registry to the points policy. The full path (all owner-settable links are
// re-walked every TTL so a re-pointed contract is picked up):
//   VerifierRegistry.registry()             -> AntseedRegistry(V2)
//   AntseedRegistry.emissions()             -> AntseedEmissionsGate
//   Gate.minters(USAGE_MINTER_ID).controller-> AntseedUsageRewards
//   UsageRewards.usageAccounting()          -> AntseedUsageAccounting
//   UsageAccounting.pointsPolicy()          -> AntseedVerifierPointsPolicy
//   PointsPolicy.minDistinctDiffVerifiers() -> the value
const CENTRAL_REGISTRY_MINI_ABI = [
  'function emissions() external view returns (address)',
] as const;
const EMISSIONS_GATE_MINTERS_MINI_ABI = [
  'function minters(bytes32 id) external view returns (address controller, uint32 shareBps, bool editable)',
] as const;
const USAGE_REWARDS_MINI_ABI = [
  'function usageAccounting() external view returns (address)',
] as const;
const USAGE_ACCOUNTING_MINI_ABI = [
  'function pointsPolicy() external view returns (address)',
] as const;
const POINTS_POLICY_MINI_ABI = [
  'function minDistinctDiffVerifiers() external view returns (uint16)',
] as const;

/** True for a well-formed, non-zero EVM address (a usable hop target). */
function isNonZeroAddress(value: unknown): value is string {
  return typeof value === 'string'
    && /^0x[0-9a-fA-F]{40}$/.test(value)
    && !/^0x0{40}$/.test(value);
}

/**
 * Hash an advertised service name into the bytes32 key used on-chain.
 * Normalization (lowercase + trim) is part of the protocol: every verifier
 * must derive the same key for the same advertised service string.
 */
export function serviceHash(service: string): string {
  return keccak256(toUtf8Bytes(service.trim().toLowerCase()));
}

/**
 * One anchor-time delegate-credit accrual, discovered from a
 * `DelegateCreditsAccrued` log. The buyer's deposits operator claims it with
 * {@link VerifierRegistryClient.claimDelegateCredits} — the (verifier,
 * probeCommitment, buyer) triple is the claim's entire input, so this replaces
 * the former off-chain DelegateVoucher.
 */
export interface DelegateCreditsAccrual {
  /** Verifier that anchored the batch crediting this buyer. */
  verifier: string;
  /** Probe-set commitment the accrual is keyed to. */
  probeCommitment: string;
  /** Buyer (carrier) the credits accrued to. */
  buyer: string;
  /** Credits accrued in this one anchor call (a batch may accrue more later). */
  credits: number;
  /** Block the accrual log was emitted in — a cursor for incremental scans. */
  blockNumber: number;
}

function decodeStats(raw: Record<string | number, unknown> & unknown[]): ServiceVerificationStats {
  return {
    sameCount: Number(raw.sameCount ?? raw[0]),
    diffCount: Number(raw.diffCount ?? raw[1]),
    undeterminedCount: Number(raw.undeterminedCount ?? raw[2]),
    distinctVerifierCount: Number(raw.distinctVerifierCount ?? raw[3]),
    lastVerdict: Number(raw.lastVerdict ?? raw[4]),
    lastVerifier: String(raw.lastVerifier ?? raw[5]),
    // The trailing `?? 0` is defensive only, not a compatibility path: a
    // registry deployment without `activeDiffVerifierCount` returns a
    // 6-field tuple that fails ABI decode before reaching this function
    // (the caller sees a throw, not degraded stats), so the fallback can
    // only fire if a decoded result somehow omits the field.
    activeDiffVerifierCount: Number(raw.activeDiffVerifierCount ?? raw[6] ?? 0),
  };
}

/** Client for AntseedVerifierRegistry (whitelist, commitments, attestations). */
export class VerifierRegistryClient extends BaseEvmClient {
  private _minDistinctDiffVerifiersCache: { value: number; fetchedAt: number } | null = null;

  constructor(config: VerifierRegistryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    return new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, this._provider);
  }

  /**
   * Effective `AntseedVerifierPointsPolicy.minDistinctDiffVerifiers` — the
   * owner-tunable number of distinct standing-DIFF verifiers at which the
   * on-chain economic penalty (zeroed seller emissions) triggers. Buyer-side
   * routing exclusion must fire at the same bar, so callers stamp this onto
   * enrichment results instead of hardcoding the contract's default.
   *
   * Cached for {@link MIN_DISTINCT_DIFF_VERIFIERS_TTL_MS}; never throws.
   * Falls back to {@link DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS} when any hop of
   * the on-chain resolution fails (RPC error, unset link, partial deployment)
   * — the fallback is cached for one TTL as well, so a dead RPC costs at most
   * one resolution attempt per TTL.
   */
  async getMinDistinctDiffVerifiers(): Promise<number> {
    const now = Date.now();
    const cached = this._minDistinctDiffVerifiersCache;
    if (cached && now - cached.fetchedAt < MIN_DISTINCT_DIFF_VERIFIERS_TTL_MS) {
      return cached.value;
    }
    let value = DEFAULT_MIN_DISTINCT_DIFF_VERIFIERS;
    try {
      const chainValue = await this._readMinDistinctDiffVerifiersFromChain();
      if (chainValue !== null) value = chainValue;
    } catch {
      // Keep the offline default; retry after the TTL.
    }
    this._minDistinctDiffVerifiersCache = { value, fetchedAt: now };
    return value;
  }

  /**
   * Walk the on-chain address links from this verifier registry to the points
   * policy and read `minDistinctDiffVerifiers`. Returns null when any link is
   * unset/zero or the final value is not a positive integer (the contract's
   * setter rejects 0, so anything else is a decode anomaly); throws on RPC
   * failure. Every owner-settable link is re-walked per call so a re-pointed
   * policy (or usage-accounting/gate swap) is picked up on the next refresh.
   */
  protected async _readMinDistinctDiffVerifiersFromChain(): Promise<number | null> {
    const registryAddr: unknown = await this._contract().getFunction('registry')();
    if (!isNonZeroAddress(registryAddr)) return null;

    const central = new Contract(registryAddr, CENTRAL_REGISTRY_MINI_ABI, this._provider);
    const gateAddr: unknown = await central.getFunction('emissions')();
    if (!isNonZeroAddress(gateAddr)) return null;

    const gate = new Contract(gateAddr, EMISSIONS_GATE_MINTERS_MINI_ABI, this._provider);
    const minter = await gate.getFunction('minters')(USAGE_MINTER_ID);
    const controller: unknown = minter.controller ?? minter[0];
    if (!isNonZeroAddress(controller)) return null;

    const usageRewards = new Contract(controller, USAGE_REWARDS_MINI_ABI, this._provider);
    const accountingAddr: unknown = await usageRewards.getFunction('usageAccounting')();
    if (!isNonZeroAddress(accountingAddr)) return null;

    const accounting = new Contract(accountingAddr, USAGE_ACCOUNTING_MINI_ABI, this._provider);
    const policyAddr: unknown = await accounting.getFunction('pointsPolicy')();
    if (!isNonZeroAddress(policyAddr)) return null;

    const policy = new Contract(policyAddr, POINTS_POLICY_MINI_ABI, this._provider);
    const value = Number(await policy.getFunction('minDistinctDiffVerifiers')());
    return Number.isInteger(value) && value >= 1 ? value : null;
  }

  async commitProbeSet(signer: AbstractSigner, commitment: string): Promise<string> {
    return this._execWrite(signer, VERIFIER_REGISTRY_ABI, 'commitProbeSet', commitment);
  }

  /**
   * Anchor an audit round's full exchange batch on-chain as calldata. The
   * batch root is computed locally with the TS mirror of the contract's
   * Merkle derivation and returned alongside the tx hash — the contract
   * recomputes the same root from calldata, so a divergence surfaces as an
   * attestation that later fails its BatchNotAnchored check rather than a
   * silently wrong binding.
   *
   * Per record `i`, `signingPayloads[i]` is the EXACT ResponseAuth signing
   * preimage (the length-prefixed 13-field encoding produced by
   * `buildResponseAuthSigningBytes`) for `records[i]`. The contract computes
   * the EIP-191 digest of `"antseed-data-v1:" || payload`, ecrecovers
   * `records[i].responseAuthSig`, and reverts unless the signer is the
   * ERC-8004 owner of the record's agentId AND the payload's embedded
   * request/response hashes match the record — so ONLY exchanges whose
   * ResponseAuth is genuine may be anchored.
   *
   * `recordProbeCounts[i]` (1..3) declares the probes bundled in record `i`;
   * the anchored batch's probeCount is their checked sum. The buyer named in
   * each verified payload accrues those credits (unless it is the verifier or
   * the seller). This method mirrors the contract's length + `>= 1` checks
   * locally so a malformed batch fails before any gas is spent.
   */
  async anchorExchangeBatch(
    signer: AbstractSigner,
    input: {
      probeCommitment: string;
      records: ExchangeRecord[];
      /** Per-record ResponseAuth signing preimage (buildResponseAuthSigningBytes output). */
      signingPayloads: BytesLike[];
      /** Per-record probe-bundle size, each in the protocol range 1..3. */
      recordProbeCounts: number[];
    },
  ): Promise<{ txHash: string; batchRoot: string }> {
    const { records, signingPayloads, recordProbeCounts } = input;
    if (records.length === 0) {
      throw new Error('anchorExchangeBatch: cannot anchor an empty exchange batch');
    }
    if (signingPayloads.length !== records.length || recordProbeCounts.length !== records.length) {
      throw new Error(
        `anchorExchangeBatch: array length mismatch — records ${records.length}, `
        + `signingPayloads ${signingPayloads.length}, recordProbeCounts ${recordProbeCounts.length}`,
      );
    }
    for (let i = 0; i < recordProbeCounts.length; i++) {
      const count = recordProbeCounts[i]!;
      if (!Number.isInteger(count) || count < 1 || count > 3) {
        throw new Error(
          `anchorExchangeBatch: recordProbeCounts[${i}] (${count}) must be an integer in [1, 3]`,
        );
      }
    }
    const batchRoot = computeBatchRoot(records);
    const txHash = await this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'anchorExchangeBatch',
      input.probeCommitment,
      records.map((record) => [
        record.agentId,
        record.requestHash,
        record.responseHash,
        record.responseAuthSig,
      ]),
      signingPayloads.map((payload) => hexlify(payload)),
      recordProbeCounts,
    );
    return { txHash, batchRoot };
  }

  async submitAttestation(
    signer: AbstractSigner,
    input: {
      agentId: number | bigint;
      serviceHash: string;
      verdict: number;
      evidenceHash: string;
      probeCommitment: string;
      batchRoot: string;
      probeCount: number;
      cohortSize: number;
    },
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'submitAttestation',
      input.agentId,
      input.serviceHash,
      input.verdict,
      input.evidenceHash,
      input.probeCommitment,
      input.batchRoot,
      input.probeCount,
      input.cohortSize,
    );
  }

  /**
   * On-chain-verified commitment opening: posts the exact canonical probe-set
   * JSON bytes (utf8) and the contract checks their sha256 against the
   * commitment. Only valid after at least one attestation referenced the
   * commitment's batch. `packUri` locates the off-chain response pack (whose
   * hashes are already anchored); it is emitted in ProbeSetRevealed so an
   * auditor can fetch the pack without an out-of-band lookup. Pass an empty
   * string when no pack has been published.
   */
  async revealProbeSet(
    signer: AbstractSigner,
    input: {
      probeCommitment: string;
      probeSetJson: string;
      packUri: string;
    },
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'revealProbeSet',
      input.probeCommitment,
      toUtf8Bytes(input.probeSetJson),
      input.packUri,
    );
  }

  /**
   * Claim `buyer`'s anchor-time delegate-credit accrual on
   * `(verifier, probeCommitment)`. Must be sent by the operator registered
   * for `buyer` in AntseedDeposits — the contract credits that operator and
   * rejects any other caller. The claimable amount is the buyer's unclaimed
   * accrual, clamped to the commitment's remaining delegate budget and the
   * verifier's remaining per-epoch allowance; a clamped remainder stays
   * claimable later. Reverts with NothingToClaim when nothing is claimable.
   */
  async claimDelegateCredits(
    signer: AbstractSigner,
    input: { verifier: string; probeCommitment: string; buyer: string },
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'claimDelegateCredits',
      input.verifier,
      input.probeCommitment,
      input.buyer,
    );
  }

  /**
   * Delegate credits `buyer` has ACCRUED at anchor time on
   * `(verifier, commitment)`, and how much of that has already been claimed by
   * its operator. The claimable remainder is `accrued - claimed` (further
   * clamped on-chain to budget + per-epoch cap at claim time).
   */
  async commitmentDelegateAccrued(verifier: string, commitment: string, buyer: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateAccrued')(verifier, commitment, buyer);
    return Number(v);
  }

  async commitmentDelegateClaimed(verifier: string, commitment: string, buyer: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateClaimed')(verifier, commitment, buyer);
    return Number(v);
  }

  /**
   * Delegate-credit budget earned by `verifier`'s credited attestations on
   * `commitment`, and how much of it claims have already drawn.
   */
  async commitmentDelegateBudget(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateBudget')(verifier, commitment);
    return Number(v);
  }

  async commitmentDelegateCredits(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('commitmentDelegateCredits')(verifier, commitment);
    return Number(v);
  }

  /**
   * EIP-191 digest the contract signs a ResponseAuth payload under
   * (`keccak256("\x19Ethereum Signed Message:\n" || len || "antseed-data-v1:"
   * || payload)`), read from the contract's pure `responseAuthDigest`. Lets an
   * off-chain caller cross-check `buildResponseAuthSigningBytes` against the
   * on-chain mirror before anchoring.
   */
  async responseAuthDigest(signingPayload: BytesLike): Promise<string> {
    return this._contract().getFunction('responseAuthDigest')(hexlify(signingPayload));
  }

  /**
   * Parse a ResponseAuth signing payload via the contract's pure
   * `parseResponseAuthPayload`, returning the buyer, normalized advertised
   * service hash, request hash, and response hash the contract binds on-chain.
   * Reverts (MalformedSigningPayload) on a
   * payload the contract would reject at anchor time.
   */
  async parseResponseAuthPayload(
    payload: BytesLike,
  ): Promise<{ buyer: string; advertisedServiceHash: string; requestHash: string; responseHash: string }> {
    const raw = await this._contract().getFunction('parseResponseAuthPayload')(hexlify(payload));
    return {
      buyer: String(raw.buyer ?? raw[0]),
      advertisedServiceHash: String(raw.advertisedServiceHash ?? raw[1]),
      requestHash: String(raw.requestHash ?? raw[2]),
      responseHash: String(raw.responseHash ?? raw[3]),
    };
  }

  /**
   * Discover delegate-credit accruals for `buyer` from `DelegateCreditsAccrued`
   * logs. The buyer is an indexed topic, so the node filters server-side; scan
   * from a persisted block cursor (`fromBlock`) to avoid re-reading history.
   * Each entry names the (verifier, probeCommitment) pair the buyer's operator
   * claims with {@link claimDelegateCredits}.
   */
  async queryDelegateCreditsAccrued(
    buyer: string,
    fromBlock: number | 'earliest' = 'earliest',
    toBlock: number | 'latest' = 'latest',
  ): Promise<DelegateCreditsAccrual[]> {
    const contract = this._contract();
    const filter = contract.filters.DelegateCreditsAccrued!(null, null, buyer);
    const logs = await contract.queryFilter(filter, fromBlock, toBlock);
    const accruals: DelegateCreditsAccrual[] = [];
    for (const log of logs) {
      if (!('args' in log)) continue;
      accruals.push({
        verifier: String(log.args?.verifier ?? log.args?.[0]),
        probeCommitment: String(log.args?.probeCommitment ?? log.args?.[1]),
        buyer: String(log.args?.buyer ?? log.args?.[2]),
        credits: Number(log.args?.credits ?? log.args?.[3]),
        blockNumber: log.blockNumber,
      });
    }
    return accruals;
  }

  async isApprovedVerifier(verifier: string): Promise<boolean> {
    return this._contract().getFunction('approvedVerifiers')(verifier);
  }

  async epochDelegateCredits(epoch: number, delegate: string): Promise<number> {
    const v = await this._contract().getFunction('epochDelegateCredits')(epoch, delegate);
    return Number(v);
  }

  async epochTotalDelegateCredits(epoch: number): Promise<number> {
    const v = await this._contract().getFunction('epochTotalDelegateCredits')(epoch);
    return Number(v);
  }

  async epochDelegateCreditsGrantedBy(epoch: number, verifier: string): Promise<number> {
    const v = await this._contract().getFunction('epochDelegateCreditsGrantedBy')(epoch, verifier);
    return Number(v);
  }

  async getDelegatePolicy(): Promise<{ delegateShareBps: number; maxDelegateCreditsPerVerifierPerEpoch: number }> {
    const contract = this._contract();
    const [shareBps, maxCredits] = await Promise.all([
      contract.getFunction('delegateShareBps')(),
      contract.getFunction('maxDelegateCreditsPerVerifierPerEpoch')(),
    ]);
    return {
      delegateShareBps: Number(shareBps),
      maxDelegateCreditsPerVerifierPerEpoch: Number(maxCredits),
    };
  }

  async probeCommittedAt(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('probeCommittedAt')(verifier, commitment);
    return Number(v);
  }

  /**
   * Full anchor state for `(verifier, batchRoot)` from the contract's
   * `batchAnchors` struct mapping. `anchoredAt === 0` means never anchored
   * (the other fields are then zero too).
   */
  async getBatchAnchor(verifier: string, batchRoot: string): Promise<BatchAnchor> {
    const raw = await this._contract().getFunction('batchAnchors')(verifier, batchRoot);
    return {
      anchoredAt: Number(raw.anchoredAt ?? raw[0]),
      recordCount: Number(raw.recordCount ?? raw[1]),
      probeCount: Number(raw.probeCount ?? raw[2]),
      commitment: String(raw.commitment ?? raw[3]),
    };
  }

  /** Unix seconds when `verifier` anchored `batchRoot` (0 = never anchored). */
  async batchAnchoredAt(verifier: string, batchRoot: string): Promise<number> {
    const anchor = await this.getBatchAnchor(verifier, batchRoot);
    return anchor.anchoredAt;
  }

  /** Unix seconds when `verifier` revealed `commitment`'s probe set (0 = unrevealed). */
  async probeRevealedAt(verifier: string, commitment: string): Promise<number> {
    const v = await this._contract().getFunction('probeRevealedAt')(verifier, commitment);
    return Number(v);
  }

  /**
   * Off-chain pack URI a `verifier` emitted when it revealed `commitment`,
   * read from the `ProbeSetRevealed` event. Returns null when no matching
   * reveal is found in the scanned range, or an empty string when the reveal
   * carried no pack URI. The CLI `audit verify` uses this to locate the pack
   * when the user does not pass `--pack`.
   *
   * `fromBlock` bounds the `getLogs` scan (both topics are indexed, so the
   * node filters server-side). Callers should pass the registry deployment
   * block — an unbounded scan from genesis is rejected by most RPCs. When the
   * reveal tx hash is already known, read that receipt's logs directly instead
   * of calling this.
   */
  async getRevealedPackUri(
    verifier: string,
    commitment: string,
    fromBlock: number | 'earliest' = 'earliest',
  ): Promise<string | null> {
    const contract = this._contract();
    const filter = contract.filters.ProbeSetRevealed!(verifier, commitment);
    const logs = await contract.queryFilter(filter, fromBlock, 'latest');
    const latest = logs[logs.length - 1];
    if (!latest || !('args' in latest)) return null;
    const packUri: unknown = latest.args?.packUri ?? latest.args?.[2];
    return typeof packUri === 'string' ? packUri : null;
  }

  async lastAuditedAt(agentId: number | bigint, service: string): Promise<number> {
    const v = await this._contract().getFunction('lastAuditedAt')(agentId, serviceHash(service));
    return Number(v);
  }

  async lastCreditedAt(agentId: number | bigint, service: string): Promise<number> {
    const v = await this._contract().getFunction('lastCreditedAt')(agentId, serviceHash(service));
    return Number(v);
  }

  async latestAttestation(agentId: number | bigint, service: string): Promise<VerifierAttestation | null> {
    const raw = await this._contract().getFunction('latestAttestation')(agentId, serviceHash(service));
    const attestation: VerifierAttestation = {
      verifier: raw.verifier ?? raw[0],
      attestedAt: Number(raw.attestedAt ?? raw[1]),
      verdict: Number(raw.verdict ?? raw[2]),
      probeCount: Number(raw.probeCount ?? raw[3]),
      cohortSize: Number(raw.cohortSize ?? raw[4]),
      evidenceHash: raw.evidenceHash ?? raw[5],
      probeCommitment: raw.probeCommitment ?? raw[6],
      batchRoot: raw.batchRoot ?? raw[7],
    };
    if (attestation.attestedAt === 0) return null;
    return attestation;
  }

  async verificationStats(agentId: number | bigint, service: string): Promise<ServiceVerificationStats> {
    const raw = await this._contract().getFunction('verificationStats')(agentId, serviceHash(service));
    return decodeStats(raw);
  }

  /** Aggregate stats for an agent across every audited service. */
  async agentVerificationStats(agentId: number | bigint): Promise<ServiceVerificationStats> {
    const raw = await this._contract().getFunction('agentVerificationStats')(agentId);
    return decodeStats(raw);
  }

  async epochCredits(epoch: number, verifier: string): Promise<number> {
    const v = await this._contract().getFunction('epochCredits')(epoch, verifier);
    return Number(v);
  }

  async epochTotalCredits(epoch: number): Promise<number> {
    const v = await this._contract().getFunction('epochTotalCredits')(epoch);
    return Number(v);
  }

  async currentEpoch(): Promise<number> {
    const v = await this._contract().getFunction('currentEpoch')();
    return Number(v);
  }

  async getAuditPolicy(): Promise<{ auditCooldown: number; maxCreditsPerVerifierPerEpoch: number; minProbeCount: number }> {
    const contract = this._contract();
    const [cooldown, maxCredits, minProbes] = await Promise.all([
      contract.getFunction('auditCooldown')(),
      contract.getFunction('maxCreditsPerVerifierPerEpoch')(),
      contract.getFunction('minProbeCount')(),
    ]);
    return {
      auditCooldown: Number(cooldown),
      maxCreditsPerVerifierPerEpoch: Number(maxCredits),
      minProbeCount: Number(minProbes),
    };
  }
}

/** Client for AntseedVerifierRewards (emissions bucket claims). */
export class VerifierRewardsClient extends BaseEvmClient {
  constructor(config: VerifierRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  private _contract(): Contract {
    return new Contract(this._contractAddress, VERIFIER_REWARDS_ABI, this._provider);
  }

  async claimVerifierReward(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'claimVerifierReward', epoch);
  }

  async claimDelegateReward(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'claimDelegateReward', epoch);
  }

  async pendingDelegateReward(epoch: number, delegate: string): Promise<bigint> {
    return this._contract().getFunction('pendingDelegateReward')(epoch, delegate);
  }

  async delegateEpochPool(epoch: number): Promise<bigint> {
    return this._contract().getFunction('delegateEpochPool')(epoch);
  }

  async epochDelegateRewardClaimed(epoch: number, delegate: string): Promise<boolean> {
    return this._contract().getFunction('epochDelegateRewardClaimed')(epoch, delegate);
  }

  async settleEpochRemainder(signer: AbstractSigner, epoch: number): Promise<string> {
    return this._execWrite(signer, VERIFIER_REWARDS_ABI, 'settleEpochRemainder', epoch);
  }

  async pendingVerifierReward(epoch: number, verifier: string): Promise<bigint> {
    return this._contract().getFunction('pendingVerifierReward')(epoch, verifier);
  }

  async verifierEpochBudget(epoch: number): Promise<bigint> {
    return this._contract().getFunction('verifierEpochBudget')(epoch);
  }

  async epochRewardClaimed(epoch: number, verifier: string): Promise<boolean> {
    return this._contract().getFunction('epochRewardClaimed')(epoch, verifier);
  }

  /** Gate epoch window: rewards are claimable for effectiveEpoch <= epoch < currentEpoch. */
  async getEpochWindow(): Promise<{ currentEpoch: number; effectiveEpoch: number }> {
    const gateAddress: string = await this._contract().getFunction('gate')();
    const gate = new Contract(gateAddress, EMISSIONS_GATE_MINI_ABI, this._provider);
    const [current, effective] = await Promise.all([
      gate.getFunction('currentEpoch')(),
      gate.getFunction('effectiveEpoch')(),
    ]);
    return { currentEpoch: Number(current), effectiveEpoch: Number(effective) };
  }
}
