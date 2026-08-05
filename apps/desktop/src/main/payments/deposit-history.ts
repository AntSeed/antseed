/**
 * Past on-chain deposits for the signed-in buyer, read from the Deposits
 * contract's `Deposited` events. A full scan from the contract's deploy
 * block is expensive on mainnet (millions of blocks), so results are cached
 * in memory for the session and each subsequent call only scans the blocks
 * produced since the last one.
 */
import { getSecureIdentity } from '../identity.js';
import { loadCachedCryptoConfig } from './credits.js';
import { makeDepositsClient } from './deposit-sweep.js';

export type DepositHistoryEntry = {
  blockNumber: number;
  txHash: string;
  /** USDC base units (6 decimals), bigint string. */
  amountBaseUnits: string;
  /** Block timestamp, unix seconds. */
  timestamp: number;
};

let cachedBuyer: string | null = null;
let cachedChainId: number | null = null;
let cachedEntries: DepositHistoryEntry[] = [];
let cachedThroughBlock = -1;

export async function loadDepositHistory(): Promise<{ ok: boolean; data?: DepositHistoryEntry[]; chainId?: number; error?: string }> {
  const identity = getSecureIdentity();
  if (!identity) return { ok: false, error: 'Identity not available' };
  const cc = await loadCachedCryptoConfig();
  if (!cc) return { ok: false, error: 'No payment chain configured' };

  const buyer = identity.wallet.address;
  if (buyer !== cachedBuyer || cc.chainId !== cachedChainId) {
    cachedBuyer = buyer;
    cachedChainId = cc.chainId;
    cachedEntries = [];
    cachedThroughBlock = -1;
  }

  const client = makeDepositsClient(cc);
  try {
    const toBlock = await client.getBlockNumber();
    const fromBlock = cachedThroughBlock >= 0 ? cachedThroughBlock + 1 : (cc.depositsDeployBlock ?? 0);
    if (fromBlock <= toBlock) {
      const events = await client.getDepositHistory(buyer, { fromBlock, toBlock });
      const additions = events.map((e) => ({
        blockNumber: e.blockNumber,
        txHash: e.txHash,
        amountBaseUnits: e.amount.toString(),
        timestamp: e.timestamp,
      }));
      cachedEntries = [...cachedEntries, ...additions];
      cachedThroughBlock = toBlock;
    }
    // Newest first for display.
    return { ok: true, data: [...cachedEntries].reverse(), chainId: cc.chainId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop the cached history — call when the signing identity changes. */
export function invalidateDepositHistoryCache(): void {
  cachedBuyer = null;
  cachedChainId = null;
  cachedEntries = [];
  cachedThroughBlock = -1;
}
