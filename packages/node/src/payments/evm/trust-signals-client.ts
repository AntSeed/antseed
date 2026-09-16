import { Interface, type AbstractProvider } from 'ethers';
import { multicallRead, MULTICALL3_ADDRESS, type MulticallRequest } from './multicall.js';

/**
 * Reads every on-chain input of the buyer trust score for a batch of sellers
 * in two Multicall3 round trips, regardless of batch size:
 *
 *   round 1: usage.currentEpoch, and per seller
 *            registry.getAgentId, wash.isProvenWashTrader, wash.provenWashShareBps
 *   round 2: pools.totalPowerWeightAtEpoch, and per seller
 *            channels.getAgentStats, pools.poolWeightAtEpoch,
 *            pools.poolActiveStakeAtEpoch, usage.sellerPointsByEpoch x2
 *
 * Each round is chunked at 80 calls per `eth_call`. Contracts that are not
 * configured (older chains without the recognized-usage stack) are skipped
 * and their signals come back `undefined`.
 */

export interface TrustSignalsAddresses {
  /** `AntseedSellerRegistry` (or legacy `AntseedStaking`): `getAgentId`. */
  sellerRegistry: string;
  /** `AntseedChannels`: `getAgentStats`. */
  channels: string;
  /** `AntseedSellerPools`: pool power and active stake. */
  sellerPools?: string;
  /** `AntseedUsageAccounting`: epoch and recognized seller points. */
  usageAccounting?: string;
  /** `AntseedWashTradingRegistry`: proven wash-trader verdicts. */
  washTradingRegistry?: string;
}

export interface TrustSignals {
  agentId: number;
  channelCount?: number;
  ghostCount?: number;
  totalVolumeUsdcMicros?: number;
  lastSettledAtSec?: number;
  usageEpoch?: number;
  usageCurrentEpochUsdcMicros?: number;
  usageLastEpochUsdcMicros?: number;
  poolStakeAnts?: number;
  poolPowerShareBps?: number;
  washFlagged?: boolean;
  washShareBps?: number;
}

const REGISTRY_IFACE = new Interface(['function getAgentId(address seller) view returns (uint256)']);
const CHANNELS_IFACE = new Interface(['function getAgentStats(uint256 agentId) view returns (uint64 channelCount, uint64 ghostCount, uint256 totalVolumeUsdc, uint64 lastSettledAt)']);
const POOLS_IFACE = new Interface([
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256 epoch) view returns (uint256)',
]);
const USAGE_IFACE = new Interface([
  'function currentEpoch() view returns (uint256)',
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
]);
const WASH_IFACE = new Interface([
  'function isProvenWashTrader(address seller) view returns (bool)',
  'function provenWashShareBps(address seller) view returns (uint256)',
]);

const ANTS_WEI = 10n ** 18n;

function toSafeNumber(value: unknown): number | undefined {
  if (typeof value !== 'bigint') return undefined;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
}

function first(result: unknown[] | null): unknown {
  return result && result.length > 0 ? result[0] : undefined;
}

export class TrustSignalsClient {
  private _multicallAvailable: Promise<boolean> | undefined;

  constructor(
    private readonly _provider: AbstractProvider,
    private readonly _addresses: TrustSignalsAddresses,
  ) {}

  private async _read(requests: MulticallRequest[]): Promise<Array<unknown[] | null>> {
    // `multicallRead` probes for Multicall3 with `eth_getCode` on every call;
    // remember the answer so a discovery cycle costs only the batched reads.
    this._multicallAvailable ??= this._provider.getCode(MULTICALL3_ADDRESS).then((code) => code !== '0x').catch(() => false);
    if (await this._multicallAvailable) return multicallRead(this._provider, requests, { assumeDeployed: true });
    return Promise.all(requests.map(async (request) => {
      try {
        const data = await this._provider.call({ to: request.target, data: request.iface.encodeFunctionData(request.method, request.args ?? []) });
        return [...request.iface.decodeFunctionResult(request.method, data)];
      } catch {
        return null;
      }
    }));
  }

  /**
   * Read trust signals for `sellers` (EVM addresses). Sellers without an agent
   * id are omitted from the result.
   */
  async read(sellers: readonly string[]): Promise<Map<string, TrustSignals>> {
    const out = new Map<string, TrustSignals>();
    if (sellers.length === 0) return out;
    const { sellerRegistry, channels, sellerPools, usageAccounting, washTradingRegistry } = this._addresses;

    // Round 1: agent ids, wash verdicts, current epoch.
    const round1: MulticallRequest[] = [];
    if (usageAccounting) round1.push({ target: usageAccounting, iface: USAGE_IFACE, method: 'currentEpoch' });
    const round1Offset = round1.length;
    const perSeller1 = 1 + (washTradingRegistry ? 2 : 0);
    for (const seller of sellers) {
      round1.push({ target: sellerRegistry, iface: REGISTRY_IFACE, method: 'getAgentId', args: [seller] });
      if (washTradingRegistry) {
        round1.push({ target: washTradingRegistry, iface: WASH_IFACE, method: 'isProvenWashTrader', args: [seller] });
        round1.push({ target: washTradingRegistry, iface: WASH_IFACE, method: 'provenWashShareBps', args: [seller] });
      }
    }
    const results1 = await this._read(round1);
    const epoch = usageAccounting ? toSafeNumber(first(results1[0] ?? null)) : undefined;
    const agentIds = new Map<string, number>();
    sellers.forEach((seller, index) => {
      const base = round1Offset + index * perSeller1;
      const agentId = toSafeNumber(first(results1[base] ?? null));
      if (!agentId || agentId <= 0) return;
      agentIds.set(seller, agentId);
      const signals: TrustSignals = { agentId };
      if (washTradingRegistry) {
        const flagged = first(results1[base + 1] ?? null);
        const share = toSafeNumber(first(results1[base + 2] ?? null));
        if (typeof flagged === 'boolean') signals.washFlagged = flagged;
        if (share !== undefined) signals.washShareBps = share;
      }
      out.set(seller, signals);
    });
    if (agentIds.size === 0) return out;

    // Round 2: channel stats, pool power, recognized usage.
    const poolsEnabled = Boolean(sellerPools) && epoch !== undefined;
    const usageEnabled = Boolean(usageAccounting) && epoch !== undefined;
    const round2: MulticallRequest[] = [];
    if (poolsEnabled) round2.push({ target: sellerPools!, iface: POOLS_IFACE, method: 'totalPowerWeightAtEpoch', args: [epoch] });
    const round2Offset = round2.length;
    const perSeller2 = 1 + (poolsEnabled ? 2 : 0) + (usageEnabled ? 2 : 0);
    const ordered = [...agentIds];
    for (const [seller, agentId] of ordered) {
      round2.push({ target: channels, iface: CHANNELS_IFACE, method: 'getAgentStats', args: [agentId] });
      if (poolsEnabled) {
        round2.push({ target: sellerPools!, iface: POOLS_IFACE, method: 'poolWeightAtEpoch', args: [agentId, epoch] });
        round2.push({ target: sellerPools!, iface: POOLS_IFACE, method: 'poolActiveStakeAtEpoch', args: [agentId, epoch] });
      }
      if (usageEnabled) {
        round2.push({ target: usageAccounting!, iface: USAGE_IFACE, method: 'sellerPointsByEpoch', args: [epoch, seller] });
        round2.push({ target: usageAccounting!, iface: USAGE_IFACE, method: 'sellerPointsByEpoch', args: [Math.max(0, epoch! - 1), seller] });
      }
    }
    const results2 = await this._read(round2);
    const totalPower = poolsEnabled ? (first(results2[0] ?? null) as bigint | undefined) : undefined;
    ordered.forEach(([seller], index) => {
      const signals = out.get(seller)!;
      let cursor = round2Offset + index * perSeller2;
      const stats = results2[cursor++];
      if (stats && stats.length >= 4) {
        signals.channelCount = toSafeNumber(stats[0]);
        signals.ghostCount = toSafeNumber(stats[1]);
        signals.totalVolumeUsdcMicros = toSafeNumber(stats[2]);
        signals.lastSettledAtSec = toSafeNumber(stats[3]);
      }
      if (poolsEnabled) {
        const power = first(results2[cursor++] ?? null);
        const stake = first(results2[cursor++] ?? null);
        if (typeof power === 'bigint' && typeof totalPower === 'bigint') {
          signals.poolPowerShareBps = totalPower > 0n ? Number((power * 10_000n) / totalPower) : 0;
        }
        if (typeof stake === 'bigint') signals.poolStakeAnts = Number(stake / ANTS_WEI) + Number(stake % ANTS_WEI) / 1e18;
      }
      if (usageEnabled) {
        const current = toSafeNumber(first(results2[cursor++] ?? null));
        const last = toSafeNumber(first(results2[cursor++] ?? null));
        if (current !== undefined && last !== undefined) {
          signals.usageEpoch = epoch;
          signals.usageCurrentEpochUsdcMicros = current;
          signals.usageLastEpochUsdcMicros = epoch === 0 ? 0 : last;
        }
      }
    });
    return out;
  }
}
