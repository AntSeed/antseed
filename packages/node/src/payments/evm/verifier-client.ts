import {
  Contract,
  getAddress,
  hexlify,
  Interface,
  keccak256,
  solidityPackedKeccak256,
  toUtf8Bytes,
  toUtf8String,
  type AbstractSigner,
  type BytesLike,
  type EventLog,
  type Log,
} from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import { computeBatchRoot, type ExchangeRecord } from '../../verification/exchange-batch.js';

export interface VerifierRegistryClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export type VerifierRewardsClientConfig = VerifierRegistryClientConfig;

/**
 * On-chain verdict codes. FROZEN mapping shared with
 * AntseedVerifierRegistry.sol and @antseed/fingerprints.
 */
export const VERIFIER_VERDICT_UNKNOWN = 0;
export const VERIFIER_VERDICT_SAME = 1;
export const VERIFIER_VERDICT_DIFF = 2;
export const VERIFIER_VERDICT_UNDETERMINED = 3;

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
  'function claimDelegateCredits(address verifier, bytes32 probeCommitment, address buyer, uint256 agentId, bytes32 serviceHash) external',
  // Reads
  'function approvedVerifiers(address verifier) external view returns (bool)',
  'function batchAnchors(address verifier, bytes32 batchRoot) external view returns (uint64 anchoredAt, uint32 recordCount, uint32 probeCount)',
  'function lastCreditedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64)',
  'function verificationStats(uint256 agentId, bytes32 serviceHash) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function agentVerificationStats(uint256 agentId) external view returns (tuple(uint32 sameCount, uint32 diffCount, uint32 undeterminedCount, uint32 distinctVerifierCount, uint8 lastVerdict, address lastVerifier, uint32 activeDiffVerifierCount))',
  'function epochCredits(uint256 epoch, address verifier) external view returns (uint256)',
  'function epochTotalCredits(uint256 epoch) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function auditCooldown() external view returns (uint64)',
  'function maxCreditsPerVerifierPerEpoch() external view returns (uint32)',
  'function minProbeCount() external view returns (uint32)',
  'function registry() external view returns (address)',
  'function epochDelegateCredits(uint256 epoch, address delegate) external view returns (uint256)',
  'function commitmentDelegateAccrued(address verifier, bytes32 commitment, bytes32 targetKey, address buyer) external view returns (uint32)',
  'function commitmentDelegateClaimed(address verifier, bytes32 commitment, bytes32 targetKey, address buyer) external view returns (uint32)',
  'function anchoredExchangeBy(bytes32 requestHash) external view returns (address)',
  'function parseResponseAuthPayload(bytes payload) external pure returns (address buyer, bytes32 advertisedServiceHash, bytes32 requestHash, bytes32 responseHash, uint64 responseStartedAt, uint64 responseCompletedAt)',
  // Events
  'event ProbeSetRevealed(address indexed verifier, bytes32 indexed probeCommitment, string packUri)',
  'event ExchangeBatchAnchored(address indexed verifier, bytes32 indexed probeCommitment, bytes32 indexed batchRoot, uint32 recordCount, uint32 probeCount)',
  'event DelegateCreditsAccrued(address indexed verifier, bytes32 indexed probeCommitment, address indexed buyer, uint256 agentId, bytes32 serviceHash, uint32 credits)',
  'event AttestationSubmitted(uint256 indexed agentId, bytes32 indexed serviceHash, address indexed verifier, uint8 verdict, bytes32 evidenceHash, bytes32 probeCommitment, bytes32 batchRoot, uint32 probeCount, uint32 cohortSize, bool credited, uint256 epoch)',
] as const;

const REGISTRY_INTERFACE = new Interface(VERIFIER_REGISTRY_ABI);
const ANCHOR_EVENT_TOPIC = REGISTRY_INTERFACE.getEvent('ExchangeBatchAnchored')!.topicHash;

/** Calldata decode of one anchorExchangeBatch call: the commitment + records. */
export interface DecodedAnchor {
  probeCommitment: string;
  records: ExchangeRecord[];
}

/** Decode anchorExchangeBatch calldata into the commitment + records. */
export function decodeAnchorCalldata(data: string): DecodedAnchor {
  const parsed = REGISTRY_INTERFACE.parseTransaction({ data });
  if (!parsed || parsed.name !== 'anchorExchangeBatch') {
    throw new Error('transaction is not an anchorExchangeBatch call');
  }
  const rawRecords = parsed.args[1] as Array<[bigint, string, string, string]>;
  return {
    probeCommitment: parsed.args[0] as string,
    records: rawRecords.map((r) => ({
      agentId: r[0],
      requestHash: r[1],
      responseHash: r[2],
      responseAuthSig: r[3],
    })),
  };
}

/** Decode revealProbeSet calldata into the commitment, probe-set JSON, and pack URI. */
export function decodeRevealCalldata(data: string): { probeCommitment: string; probeSetJson: string; packUri: string } {
  const parsed = REGISTRY_INTERFACE.parseTransaction({ data });
  if (!parsed || parsed.name !== 'revealProbeSet') {
    throw new Error('transaction is not a revealProbeSet call');
  }
  return {
    probeCommitment: parsed.args[0] as string,
    probeSetJson: toUtf8String(parsed.args[1] as string),
    packUri: (parsed.args[2] as string) ?? '',
  };
}

/** An anchor resolved from chain history (tx hash or event scan). */
export interface FetchedAnchor extends DecodedAnchor {
  verifier: string;
  batchRoot: string;
  txHash: string;
  /** Block the anchor tx was mined in — the lower bound for the reveal scan. */
  blockNumber: number;
}

/** The revealed probe-set opening of a commitment. */
export interface ProbeSetReveal {
  probeSetJson: string;
  packUri: string;
}

/** One historical AttestationSubmitted event tied to a specific audit. */
export interface OnChainAttestation {
  verdict: number;
  probeCommitment: string;
  evidenceHash: string;
  batchRoot: string;
}

const VERIFIER_REWARDS_ABI = [
  // Writes
  'function claimVerifierReward(uint256 epoch) external',
  'function claimDelegateReward(uint256 epoch) external',
  // Reads
  'function pendingVerifierReward(uint256 epoch, address verifier) external view returns (uint256)',
  'function pendingDelegateReward(uint256 epoch, address delegate) external view returns (uint256)',
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
 * Storage key binding delegate accrual/budget to the audited target —
 * keccak256(uint256(agentId) || serviceHash). Mirrors the contract's
 * `delegateTargetKey`.
 */
export function delegateTargetKey(agentId: number | bigint, targetServiceHash: string): string {
  return solidityPackedKeccak256(['uint256', 'bytes32'], [BigInt(agentId), targetServiceHash]);
}

/**
 * One anchor-time delegate-credit accrual, discovered from a
 * `DelegateCreditsAccrued` log. The buyer's deposits operator claims it with
 * {@link VerifierRegistryClient.claimDelegateCredits} — the (verifier,
 * probeCommitment, buyer, agentId, serviceHash) tuple is the claim's entire
 * input, so this replaces the former off-chain DelegateVoucher.
 */
export interface DelegateCreditsAccrual {
  /** Verifier that anchored the batch crediting this buyer. */
  verifier: string;
  /** Probe-set commitment the accrual is keyed to. */
  probeCommitment: string;
  /** Buyer (carrier) the credits accrued to. */
  buyer: string;
  /** Audited target's ERC-8004 agent id the carried probes were for. */
  agentId: number;
  /** Audited target's normalized service hash (`serviceHash(service)`). */
  serviceHash: string;
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
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierRegistryClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  /** Read-side contract handle, constructed once (the provider never changes). */
  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFIER_REGISTRY_ABI, this._provider);
    return this._contractInstance;
  }

  /** Call a view function returning a single numeric value. */
  private async _readNumber(fn: string, ...args: unknown[]): Promise<number> {
    return Number(await this._contract().getFunction(fn)(...args));
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
   * `(verifier, probeCommitment, target)` — the target (agentId,
   * serviceHash) comes from the accrual's `DelegateCreditsAccrued` log.
   * Must be sent by the operator registered for `buyer` in AntseedDeposits —
   * the contract credits that operator and rejects any other caller. The
   * claimable amount is the buyer's unclaimed accrual on the target, clamped
   * to that target's remaining credited-attestation budget and the
   * verifier's remaining per-epoch allowance; a clamped remainder stays
   * claimable later. Reverts with NothingToClaim when nothing is claimable.
   */
  async claimDelegateCredits(
    signer: AbstractSigner,
    input: { verifier: string; probeCommitment: string; buyer: string; agentId: number | bigint; serviceHash: string },
  ): Promise<string> {
    return this._execWrite(
      signer,
      VERIFIER_REGISTRY_ABI,
      'claimDelegateCredits',
      input.verifier,
      input.probeCommitment,
      input.buyer,
      BigInt(input.agentId),
      input.serviceHash,
    );
  }

  /**
   * Delegate credits `buyer` has ACCRUED at anchor time on
   * `(verifier, commitment)`, and how much of that has already been claimed by
   * its operator. The claimable remainder is `accrued - claimed` (further
   * clamped on-chain to budget + per-epoch cap at claim time).
   */
  async commitmentDelegateAccrued(
    verifier: string,
    commitment: string,
    targetKey: string,
    buyer: string,
  ): Promise<number> {
    return this._readNumber('commitmentDelegateAccrued', verifier, commitment, targetKey, buyer);
  }

  async commitmentDelegateClaimed(
    verifier: string,
    commitment: string,
    targetKey: string,
    buyer: string,
  ): Promise<number> {
    return this._readNumber('commitmentDelegateClaimed', verifier, commitment, targetKey, buyer);
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
  ): Promise<{
    buyer: string;
    advertisedServiceHash: string;
    requestHash: string;
    responseHash: string;
    responseStartedAt: bigint;
    responseCompletedAt: bigint;
  }> {
    const raw = await this._contract().getFunction('parseResponseAuthPayload')(hexlify(payload));
    return {
      buyer: String(raw.buyer ?? raw[0]),
      advertisedServiceHash: String(raw.advertisedServiceHash ?? raw[1]),
      requestHash: String(raw.requestHash ?? raw[2]),
      responseHash: String(raw.responseHash ?? raw[3]),
      responseStartedAt: BigInt(raw.responseStartedAt ?? raw[4]),
      responseCompletedAt: BigInt(raw.responseCompletedAt ?? raw[5]),
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
        agentId: Number(log.args?.agentId ?? log.args?.[3]),
        serviceHash: String(log.args?.serviceHash ?? log.args?.[4]),
        credits: Number(log.args?.credits ?? log.args?.[5]),
        blockNumber: log.blockNumber,
      });
    }
    return accruals;
  }

  async isApprovedVerifier(verifier: string): Promise<boolean> {
    return this._contract().getFunction('approvedVerifiers')(verifier);
  }

  async epochDelegateCredits(epoch: number, delegate: string): Promise<number> {
    return this._readNumber('epochDelegateCredits', epoch, delegate);
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
    };
  }

  /** Unix seconds when `verifier` anchored `batchRoot` (0 = never anchored). */
  async batchAnchoredAt(verifier: string, batchRoot: string): Promise<number> {
    const anchor = await this.getBatchAnchor(verifier, batchRoot);
    return anchor.anchoredAt;
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
    const latest = await this._lastEventLog('ProbeSetRevealed', verifier, commitment, fromBlock);
    if (!latest || !('args' in latest)) return null;
    const packUri: unknown = latest.args?.packUri ?? latest.args?.[2];
    return typeof packUri === 'string' ? packUri : null;
  }

  /**
   * Fetch the LAST (verifier, commitment)-indexed registry event of a kind
   * from `fromBlock` — the shared shape of the anchor, reveal, and pack-URI
   * lookups. Both topics are indexed, so the node filters server-side.
   */
  private async _lastEventLog(
    eventName: 'ExchangeBatchAnchored' | 'ProbeSetRevealed',
    verifier: string,
    commitment: string,
    fromBlock: number | 'earliest',
  ): Promise<EventLog | Log | null> {
    const contract = this._contract();
    const filter = contract.filters[eventName]!(verifier, commitment);
    const logs = await contract.queryFilter(filter, fromBlock, 'latest');
    return logs[logs.length - 1] ?? null;
  }

  /**
   * Resolve an anchor from its transaction hash — the DIRECT lookup path
   * (no log scan). Decodes the anchorExchangeBatch calldata and reads the
   * verifier + batch root from the tx's own ExchangeBatchAnchored event.
   * The verifier comes from the indexed event topic, NOT `tx.from` — under a
   * relayed/AA submission the tx sender is not the verifier the contract
   * recorded as msg.sender. Throws when the tx is missing, was not sent to
   * this registry, or emitted no anchor event.
   */
  async fetchAnchorByTx(txHash: string): Promise<FetchedAnchor> {
    const tx = await this._provider.getTransaction(txHash);
    if (!tx) throw new Error(`anchor transaction ${txHash} not found`);
    const expectedRegistry = getAddress(this._contractAddress);
    if (!tx.to || getAddress(tx.to) !== expectedRegistry) {
      throw new Error(`anchor transaction ${txHash} was not sent to registry ${expectedRegistry}`);
    }
    const decoded = decodeAnchorCalldata(tx.data);
    const receipt = await this._provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`anchor transaction ${txHash} has no receipt (still pending?)`);
    const log = receipt.logs.find((l) =>
      getAddress(l.address) === expectedRegistry && l.topics[0] === ANCHOR_EVENT_TOPIC);
    if (!log || !log.topics[3]) {
      throw new Error('anchor transaction emitted no ExchangeBatchAnchored event (reverted or wrong contract?)');
    }
    if (!log.topics[1]) throw new Error('malformed ExchangeBatchAnchored event');
    return {
      ...decoded,
      verifier: getAddress(`0x${log.topics[1].slice(26)}`),
      batchRoot: log.topics[3],
      txHash,
      blockNumber: receipt.blockNumber,
    };
  }

  /**
   * Resolve an anchor from the LAST ExchangeBatchAnchored event a `verifier`
   * emitted for `commitment`, scanning from `fromBlock` (pass the registry
   * deployment block — public RPCs reject unbounded genesis scans).
   */
  async fetchAnchorByCommitment(verifier: string, commitment: string, fromBlock: number): Promise<FetchedAnchor> {
    const log = await this._lastEventLog('ExchangeBatchAnchored', verifier, commitment, fromBlock);
    if (!log) {
      throw new Error(
        `no ExchangeBatchAnchored event for commitment ${commitment} by verifier ${verifier} (scanned from block ${fromBlock})`,
      );
    }
    const tx = await this._provider.getTransaction(log.transactionHash);
    if (!tx) throw new Error(`anchor transaction ${log.transactionHash} not found`);
    const decoded = decodeAnchorCalldata(tx.data);
    if (!log.topics[3]) throw new Error('malformed ExchangeBatchAnchored event');
    return {
      ...decoded,
      verifier,
      batchRoot: log.topics[3],
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
  }

  /** Fetch the revealed probe-set JSON (and pack URI) for an anchor. */
  async fetchReveal(verifier: string, commitment: string, fromBlock: number): Promise<ProbeSetReveal> {
    const log = await this._lastEventLog('ProbeSetRevealed', verifier, commitment, fromBlock);
    if (!log) {
      throw new Error(
        `no ProbeSetRevealed event for commitment ${commitment} — the verifier has not revealed this probe set yet (scanned from block ${fromBlock})`,
      );
    }
    const tx = await this._provider.getTransaction(log.transactionHash);
    if (!tx) throw new Error(`reveal transaction ${log.transactionHash} not found`);
    const decoded = decodeRevealCalldata(tx.data);
    return { probeSetJson: decoded.probeSetJson, packUri: decoded.packUri };
  }

  /**
   * Resolve the anchor (by tx hash, or by a commitment event scan bounded by
   * `fromBlock`) and its matching reveal. The reveal scan is always bounded by
   * the anchor's block — the reveal is mined at or after the anchor — so the
   * tx-hash path never degenerates into an unbounded genesis-to-head scan.
   */
  async fetchAnchorAndReveal(
    opts: { txHash?: string; verifier?: string; commitment?: string; fromBlock: number },
  ): Promise<{ anchor: FetchedAnchor; reveal: ProbeSetReveal }> {
    const anchor = opts.txHash
      ? await this.fetchAnchorByTx(opts.txHash)
      : await this.fetchAnchorByCommitment(opts.verifier!, opts.commitment!, opts.fromBlock);
    const reveal = await this.fetchReveal(anchor.verifier, anchor.probeCommitment, anchor.blockNumber);
    return { anchor, reveal };
  }

  /**
   * Read the historical attestation events tied to one exact published audit
   * — the (verifier, probeCommitment, batchRoot, evidenceHash) tuple — for
   * each seller, keyed by agentId. Sellers whose scan fails are skipped
   * (reported via `onSellerError`); sellers without an agentId are ignored.
   */
  async fetchMatchingAttestations(
    input: {
      verifier: string;
      sellers: ReadonlyArray<{ agentId?: number }>;
      service: string;
      probeCommitment: string;
      batchRoot: string;
      evidenceHash: string;
      fromBlock: number;
    },
    onSellerError?: (agentId: number, err: Error) => void,
  ): Promise<Map<number, OnChainAttestation>> {
    const contract = this._contract();
    const attestations = new Map<number, OnChainAttestation>();
    const expectedServiceHash = serviceHash(input.service);
    await Promise.all(input.sellers.map(async (seller) => {
      if (!seller.agentId) return;
      try {
        const filter = contract.filters.AttestationSubmitted!(seller.agentId, expectedServiceHash, input.verifier);
        const logs = await contract.queryFilter(filter, input.fromBlock, 'latest');
        const matching = logs.find((log) =>
          'args' in log
          && String(log.args.probeCommitment).toLowerCase() === input.probeCommitment.toLowerCase()
          && String(log.args.batchRoot).toLowerCase() === input.batchRoot.toLowerCase()
          && String(log.args.evidenceHash).toLowerCase() === input.evidenceHash.toLowerCase());
        if (matching && 'args' in matching) {
          attestations.set(seller.agentId, {
            verdict: Number(matching.args.verdict),
            probeCommitment: String(matching.args.probeCommitment),
            evidenceHash: String(matching.args.evidenceHash),
            batchRoot: String(matching.args.batchRoot),
          });
        }
      } catch (err) {
        onSellerError?.(seller.agentId, err as Error);
      }
    }));
    return attestations;
  }

  async lastCreditedAt(agentId: number | bigint, service: string): Promise<number> {
    return this._readNumber('lastCreditedAt', agentId, serviceHash(service));
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
    return this._readNumber('epochCredits', epoch, verifier);
  }

  async epochTotalCredits(epoch: number): Promise<number> {
    return this._readNumber('epochTotalCredits', epoch);
  }

  async currentEpoch(): Promise<number> {
    return this._readNumber('currentEpoch');
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
  private _contractInstance: Contract | null = null;

  constructor(config: VerifierRewardsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  /** Read-side contract handle, constructed once (the provider never changes). */
  private _contract(): Contract {
    this._contractInstance ??= new Contract(this._contractAddress, VERIFIER_REWARDS_ABI, this._provider);
    return this._contractInstance;
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

  async epochDelegateRewardClaimed(epoch: number, delegate: string): Promise<boolean> {
    return this._contract().getFunction('epochDelegateRewardClaimed')(epoch, delegate);
  }

  async pendingVerifierReward(epoch: number, verifier: string): Promise<bigint> {
    return this._contract().getFunction('pendingVerifierReward')(epoch, verifier);
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
