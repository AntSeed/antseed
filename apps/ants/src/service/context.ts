import { FetchRequest, JsonRpcProvider, ZeroAddress, type AbstractProvider, type AbstractSigner } from 'ethers';
import { RotatingJsonRpcProvider } from './rpc-provider.js';
import { createIndexer, type Indexer } from './indexer.js';
import {
  ANTSTokenClient,
  DepositsClient,
  EmissionsClient,
  EmissionsGateClient,
  IdentityClient,
  PointsPolicyRegistryClient,
  PositionInitClient,
  RegistryClient,
  SellerPoolsClient,
  SellerPoolsRewardsClient,
  SellerRegistryClient,
  SellerRewardsPoolClient,
  StakingClient,
  UsageAccountingClient,
  UsageRewardsClient,
  WashTradingRegistryClient,
} from '@antseed/node/payments';
import type { ProtocolPhase } from '../api-types.js';

/** Resolved chain configuration (the CLI's `requireCryptoConfig` output or a `resolveChainConfig` result). */
export interface AntsChainConfig {
  chainId: string;
  evmChainId: number;
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  registryContractAddress?: string;
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  stakingContractAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
  washTradingRegistryAddress?: string;
  pointsPolicyRegistryAddress?: string;
  recognizedUsage?: { status: 'deployed' | 'active'; effectiveEpoch: number; deploymentBlock?: number };
  /** Explorer REST base (Antscan) for seller profiles; optional. */
  explorerApiUrl?: string;
}

export interface ResolvedStack {
  phase: ProtocolPhase;
  currentEpoch: number;
  /** First recognized-usage epoch; null when the new stack is not deployed. */
  effectiveEpoch: number | null;
  genesis: number;
  epochDuration: number;
  registryPointers: { emissions: string; staking: string };
  /** Legacy V2 emissions (claims for pre-cutover epochs). */
  legacyEmissions: string | null;
  legacyStaking: string | null;
  legacyEmissionsV1: string | null;
  /** Legacy locked seller rewards pool discovered from V2. */
  lockedRewardsPool: string | null;
  resolvedAt: number;
}

export interface AntsContextOptions {
  chain: AntsChainConfig;
  address: string;
  signer?: AbstractSigner;
  /** How long a resolved stack stays fresh (ms). */
  stackTtlMs?: number;
  /** Endpoint scorer used by `selectRpc` (lower is better, null = unusable); defaults to a short burst of `eth_call`s. */
  probeRpc?: (url: string) => Promise<number | null>;
}

function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export class MissingContractError extends Error {
  constructor(name: string, chainId: string) {
    super(`${name} address is not configured for chain '${chainId}'. Set payments.crypto.${name}Address or upgrade @antseed/cli.`);
    this.name = 'MissingContractError';
  }
}

/**
 * One wallet's view of the ANTS contracts. Lazily builds SDK clients from the
 * resolved chain configuration and caches the stack resolution so a burst of
 * dashboard reads does not re-query the registry pointers each time.
 */
export class AntsContext {
  chain: AntsChainConfig;
  readonly address: string;
  readonly signer: AbstractSigner | undefined;
  private readonly stackTtlMs: number;
  private stackCache: ResolvedStack | null = null;
  private readonly clients = new Map<string, unknown>();
  private readonly probeRpc: (url: string) => Promise<number | null>;
  private rpcSelection: Promise<void> | null = null;
  private sharedProvider: RotatingJsonRpcProvider | null = null;
  private indexerClient: Indexer | null | undefined;
  private rpcOrder: string[] | null = null;

  constructor(options: AntsContextOptions) {
    this.chain = options.chain;
    this.address = options.address;
    this.signer = options.signer;
    this.stackTtlMs = options.stackTtlMs ?? 15_000;
    this.probeRpc = options.probeRpc ?? probeRpcEndpoint;
  }

  /**
   * Rank the configured endpoints once by a short `eth_call` burst and route
   * reads through one rotating provider in that order (see
   * `RotatingJsonRpcProvider`). The public Base gateways differ a lot in how
   * hard they throttle a burst (Tenderly rejects about a third, nodies none)
   * and any of them can stall, so the order is a hint and the provider still
   * moves off an endpoint that throttles at run time.
   */
  selectRpc(): Promise<void> {
    if (!this.rpcSelection) {
      this.rpcSelection = (async () => {
        const fallbacks = this.chain.fallbackRpcUrls ?? [];
        if (fallbacks.length === 0) return;
        const candidates = [this.chain.rpcUrl, ...fallbacks];
        const scores = await Promise.all(candidates.map(async (url, index) => ({ url, index, score: await this.probeRpc(url).catch(() => null) })));
        const usable = scores
          .filter((entry): entry is { url: string; index: number; score: number } => entry.score !== null)
          .sort((a, b) => a.score - b.score || a.index - b.index);
        if (usable.length === 0) return;
        const unusable = scores.filter((entry) => entry.score === null);
        const ordered = [...usable, ...unusable].map((entry) => entry.url);
        this.rpcOrder = ordered;
        this.chain = { ...this.chain, rpcUrl: ordered[0]!, fallbackRpcUrls: ordered.slice(1) };
        this.clients.clear();
        this.sharedProvider = null;
      })();
    }
    return this.rpcSelection;
  }

  /** Explorer-backed indexer for lists and history; null when `explorerApiUrl` is empty. */
  indexer(): Indexer | null {
    if (this.indexerClient === undefined) this.indexerClient = createIndexer(this.chain.explorerApiUrl);
    return this.indexerClient;
  }

  requireSigner(): AbstractSigner {
    if (!this.signer) throw new Error('This action needs the node wallet; no signer is available in read-only mode.');
    return this.signer;
  }

  private base(contractAddress: string) {
    return {
      rpcUrl: this.chain.rpcUrl,
      ...(this.chain.fallbackRpcUrls && this.chain.fallbackRpcUrls.length > 0 ? { fallbackRpcUrls: this.chain.fallbackRpcUrls } : {}),
      contractAddress,
      evmChainId: this.chain.evmChainId,
    };
  }

  private cached<T>(key: string, build: () => T): T {
    let client = this.clients.get(key) as T | undefined;
    if (!client) {
      client = build();
      const shared = this.provider();
      if (typeof (client as { withProvider?: unknown }).withProvider === 'function') {
        (client as unknown as { withProvider(provider: AbstractProvider): unknown }).withProvider(shared);
      }
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * One rotating provider shared by every client, in the order `selectRpc`
   * chose (configured order before that), replacing the ethers failover
   * provider each client would otherwise build.
   */
  provider(): RotatingJsonRpcProvider {
    if (!this.sharedProvider) {
      this.sharedProvider = new RotatingJsonRpcProvider(this.rpcOrder ?? [this.chain.rpcUrl, ...(this.chain.fallbackRpcUrls ?? [])], this.chain.evmChainId);
    }
    return this.sharedProvider;
  }

  private optional<T>(key: string, address: string | undefined, build: (address: string) => T): T | null {
    if (!address || sameAddress(address, ZeroAddress)) return null;
    return this.cached(`${key}:${address.toLowerCase()}`, () => build(address));
  }

  private required<T>(name: string, key: string, address: string | undefined, build: (address: string) => T): T {
    const client = this.optional(key, address, build);
    if (!client) throw new MissingContractError(name, this.chain.chainId);
    return client;
  }

  registry(): RegistryClient {
    return this.required('registryContract', 'registry', this.chain.registryContractAddress, (address) => new RegistryClient(this.base(address)));
  }
  antsToken(): ANTSTokenClient {
    return this.required('antsToken', 'ants', this.chain.antsTokenAddress, (address) => new ANTSTokenClient(this.base(address)));
  }
  identity(): IdentityClient | null {
    return this.optional('identity', this.chain.identityRegistryAddress, (address) => new IdentityClient(this.base(address)));
  }
  deposits(): DepositsClient | null {
    return this.optional('deposits', this.chain.depositsContractAddress, (address) => new DepositsClient({
      ...this.base(address), usdcAddress: this.chain.usdcContractAddress ?? ZeroAddress,
    }));
  }
  gate(): EmissionsGateClient | null {
    return this.optional('gate', this.chain.emissionsGateAddress, (address) => new EmissionsGateClient(this.base(address)));
  }
  pools(): SellerPoolsClient | null {
    return this.optional('pools', this.chain.sellerPoolsAddress, (address) => new SellerPoolsClient({
      ...this.base(address), antsTokenAddress: this.chain.antsTokenAddress ?? ZeroAddress,
    }));
  }
  requirePools(): SellerPoolsClient {
    const pools = this.pools();
    if (!pools) throw new MissingContractError('sellerPools', this.chain.chainId);
    return pools;
  }
  poolRewards(): SellerPoolsRewardsClient | null {
    return this.optional('poolRewards', this.chain.sellerPoolsRewardsAddress, (address) => new SellerPoolsRewardsClient(this.base(address)));
  }
  requirePoolRewards(): SellerPoolsRewardsClient {
    const rewards = this.poolRewards();
    if (!rewards) throw new MissingContractError('sellerPoolsRewards', this.chain.chainId);
    return rewards;
  }
  sellerRegistry(): SellerRegistryClient | null {
    return this.optional('sellerRegistry', this.chain.sellerRegistryAddress, (address) => new SellerRegistryClient(this.base(address)));
  }
  usageAccounting(): UsageAccountingClient | null {
    return this.optional('usageAccounting', this.chain.usageAccountingAddress, (address) => new UsageAccountingClient(this.base(address)));
  }
  usageRewards(): UsageRewardsClient | null {
    return this.optional('usageRewards', this.chain.usageRewardsAddress, (address) => new UsageRewardsClient(this.base(address)));
  }
  positionInit(): PositionInitClient | null {
    return this.optional('positionInit', this.chain.positionInitAddress, (address) => new PositionInitClient(this.base(address)));
  }
  washRegistry(): WashTradingRegistryClient | null {
    return this.optional('wash', this.chain.washTradingRegistryAddress, (address) => new WashTradingRegistryClient(this.base(address)));
  }
  pointsPolicyRegistry(): PointsPolicyRegistryClient | null {
    return this.optional('policies', this.chain.pointsPolicyRegistryAddress, (address) => new PointsPolicyRegistryClient(this.base(address)));
  }
  legacyEmissionsAt(address: string | null): EmissionsClient | null {
    return this.optional('legacyEmissions', address ?? undefined, (target) => new EmissionsClient(this.base(target)));
  }
  legacyStakingAt(address: string | null): StakingClient | null {
    return this.optional('legacyStaking', address ?? undefined, (target) => new StakingClient({
      ...this.base(target), usdcAddress: this.chain.usdcContractAddress ?? ZeroAddress,
    }));
  }
  lockedPoolAt(address: string | null): SellerRewardsPoolClient | null {
    return this.optional('lockedPool', address ?? undefined, (target) => new SellerRewardsPoolClient(this.base(target)));
  }

  /** Address book for display. */
  addresses(): Record<string, string> {
    const entries: Array<[string, string | undefined]> = [
      ['registry', this.chain.registryContractAddress],
      ['antsToken', this.chain.antsTokenAddress],
      ['emissionsGate', this.chain.emissionsGateAddress],
      ['sellerPools', this.chain.sellerPoolsAddress],
      ['sellerPoolsRewards', this.chain.sellerPoolsRewardsAddress],
      ['sellerRegistry', this.chain.sellerRegistryAddress],
      ['usageAccounting', this.chain.usageAccountingAddress],
      ['usageRewards', this.chain.usageRewardsAddress],
      ['positionInit', this.chain.positionInitAddress],
      ['pointsPolicyRegistry', this.chain.pointsPolicyRegistryAddress],
      ['washTradingRegistry', this.chain.washTradingRegistryAddress],
      ['legacyEmissionsEscrow', this.chain.legacyEmissionsEscrowAddress],
      ['emissions', this.chain.emissionsContractAddress],
      ['staking', this.chain.stakingContractAddress],
      ['legacyEmissions', this.chain.legacyEmissionsContractAddress],
      ['legacyStaking', this.chain.legacyStakingContractAddress],
      ['legacyEmissionsV1', this.chain.legacyEmissionsV1ContractAddress],
      ['deposits', this.chain.depositsContractAddress],
      ['channels', this.chain.channelsContractAddress],
      ['identityRegistry', this.chain.identityRegistryAddress],
      ['usdc', this.chain.usdcContractAddress],
    ];
    return Object.fromEntries(entries.filter((entry): entry is [string, string] => !!entry[1]));
  }

  invalidate(): void { this.stackCache = null; }

  /** Determine which protocol phase the chain is in and where legacy claims live. */
  async stack(): Promise<ResolvedStack> {
    if (this.stackCache && Date.now() - this.stackCache.resolvedAt < this.stackTtlMs) return this.stackCache;
    await this.selectRpc();
    const registry = this.registry();
    const [emissions, staking] = await Promise.all([registry.emissions(), registry.staking()]);
    const registryPointers = { emissions, staking };
    const deployed = !!this.chain.usageAccountingAddress && !!this.chain.sellerRegistryAddress;
    const active = deployed && sameAddress(emissions, this.chain.usageAccountingAddress) && sameAddress(staking, this.chain.sellerRegistryAddress);
    const phase: ProtocolPhase = active ? 'active' : deployed ? 'deployed' : 'legacy';

    let legacyEmissions: string | null;
    let legacyStaking: string | null;
    let legacyEmissionsV1: string | null;
    if (phase === 'active') {
      // Before the ledger is regenerated for the activated release, `emissions`
      // and `staking` still name the legacy V2/USDC contracts; afterwards they
      // alias the new stack and the `legacy*` fields carry the old ones.
      const emissionsIsLegacy = !!this.chain.emissionsContractAddress && !sameAddress(this.chain.emissionsContractAddress, this.chain.usageAccountingAddress);
      const stakingIsLegacy = !!this.chain.stakingContractAddress && !sameAddress(this.chain.stakingContractAddress, this.chain.sellerRegistryAddress);
      legacyEmissions = emissionsIsLegacy ? this.chain.emissionsContractAddress! : this.chain.legacyEmissionsContractAddress ?? null;
      legacyStaking = stakingIsLegacy ? this.chain.stakingContractAddress! : this.chain.legacyStakingContractAddress ?? null;
      legacyEmissionsV1 = emissionsIsLegacy ? this.chain.legacyEmissionsContractAddress ?? null : this.chain.legacyEmissionsV1ContractAddress ?? null;
    } else {
      legacyEmissions = this.chain.emissionsContractAddress ?? emissions;
      legacyStaking = this.chain.stakingContractAddress ?? staking;
      legacyEmissionsV1 = this.chain.legacyEmissionsContractAddress ?? null;
    }

    const gate = this.gate();
    let currentEpoch: number;
    let effectiveEpoch: number | null = null;
    let genesis: number;
    let epochDuration: number;
    if (gate) {
      [currentEpoch, effectiveEpoch, genesis, epochDuration] = await Promise.all([gate.currentEpoch(), gate.effectiveEpoch(), gate.genesis(), gate.epochDuration()]);
    } else {
      const legacy = this.legacyEmissionsAt(legacyEmissions);
      if (!legacy) throw new MissingContractError('emissionsContract', this.chain.chainId);
      const [info, legacyGenesis] = await Promise.all([legacy.getEpochInfo(), legacy.getGenesis()]);
      currentEpoch = info.epoch;
      epochDuration = info.epochDuration;
      genesis = legacyGenesis;
    }
    let lockedRewardsPool: string | null = null;
    const legacy = this.legacyEmissionsAt(legacyEmissions);
    if (legacy) {
      try {
        const pool = await legacy.sellerRewardsPool();
        lockedRewardsPool = sameAddress(pool, ZeroAddress) ? null : pool;
      } catch {
        lockedRewardsPool = null;
      }
    }
    this.stackCache = {
      phase, currentEpoch, effectiveEpoch, genesis, epochDuration, registryPointers,
      legacyEmissions, legacyStaking, legacyEmissionsV1, lockedRewardsPool, resolvedAt: Date.now(),
    };
    return this.stackCache;
  }

  /** Epoch ranges that can be claimed: legacy epochs end at the effective epoch; recognized epochs start there. */
  async claimableEpochs(): Promise<{ legacy: number[]; recognized: number[] }> {
    const stack = await this.stack();
    const boundary = stack.phase === 'active' && stack.effectiveEpoch !== null ? Math.min(stack.currentEpoch, stack.effectiveEpoch) : stack.currentEpoch;
    const legacy = Array.from({ length: Math.max(0, boundary) }, (_, epoch) => epoch);
    const recognized = stack.phase === 'active' && stack.effectiveEpoch !== null
      ? Array.from({ length: Math.max(0, stack.currentEpoch - stack.effectiveEpoch) }, (_, index) => stack.effectiveEpoch! + index)
      : [];
    return { legacy, recognized };
  }
}

const RPC_PROBE_TIMEOUT_MS = 4_000;
const RPC_PROBE_CALLS = 8;
/** Multicall3 `getBlockNumber()`: a cheap `eth_call`, which is what gateways actually meter (Tenderly lets `eth_blockNumber` through and throttles `eth_call`). */
const RPC_PROBE_CALL = { to: '0xcA11bde05977b3631167028862bE2a173976CA11', data: '0x42cbb15c' };

/**
 * Score `url` with a burst of parallel `eth_call`s: null when
 * none answer, otherwise the failure count weighted heavily plus the median
 * latency in seconds, so a throttling gateway ranks below a slower clean one.
 */
export async function probeRpcEndpoint(url: string): Promise<number | null> {
  const request = new FetchRequest(url);
  request.timeout = RPC_PROBE_TIMEOUT_MS;
  request.setThrottleParams({ maxAttempts: 1 });
  const provider = new JsonRpcProvider(request, undefined, { staticNetwork: true, batchMaxCount: 1 });
  try {
    const latencies = await Promise.all(Array.from({ length: RPC_PROBE_CALLS }, async () => {
      const started = Date.now();
      try {
        await provider.send('eth_call', [RPC_PROBE_CALL, 'latest']);
        return Date.now() - started;
      } catch {
        return null;
      }
    }));
    const answered = latencies.filter((value): value is number => value !== null).sort((a, b) => a - b);
    if (answered.length === 0) return null;
    const failures = RPC_PROBE_CALLS - answered.length;
    return failures * 10 + answered[Math.floor(answered.length / 2)]! / 1000;
  } finally {
    provider.destroy();
  }
}

