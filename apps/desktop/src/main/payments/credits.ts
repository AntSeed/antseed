/**
 * Buyer balance: USDC deposits, ANTS rewards, and the on-chain clients used to
 * read them. Everything here is cached — the renderer polls it, and a failing
 * RPC backs off rather than hammering.
 *
 * The client cache is shared with the other payments modules through the
 * accessors below; `invalidateChainClients()` drops it when chain config
 * changes under us.
 */
import {
  ANTSTokenClient,
  ChannelsClient,
  DepositsClient,
  EmissionsClient,
  formatUsdc,
  resolveChainConfig,
} from '@antseed/node';
import { spendableBalance } from '../billing/credits-balance.js';
import { getSecureIdentity } from '../identity.js';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { asRecord, asString } from '../utils.js';
import { getPendingSpendUsdc } from './buyer-channels.js';

export type CreditsInfo = {
  evmAddress: string | null;
  operatorAddress: string | null;
  /** Everything on deposit for this buyer: unreserved + locked in channels. */
  balanceUsdc: string;
  /** Locked into open payment channels (still the buyer's money). */
  reservedUsdc: string;
  /** Unreserved deposits — what a new channel reserve or a withdrawal can draw on. */
  availableUsdc: string;
  /** Signed via SpendingAuth but not settled on-chain yet: committed, not gone. */
  pendingUsdc: string;
  /** balanceUsdc - pendingUsdc — what the buyer actually still owns. */
  spendableUsdc: string;
  creditLimitUsdc: string;
};

const EMPTY_CREDITS: Omit<CreditsInfo, 'evmAddress'> = {
  operatorAddress: null,
  balanceUsdc: '0',
  reservedUsdc: '0',
  availableUsdc: '0',
  pendingUsdc: '0',
  spendableUsdc: '0',
  creditLimitUsdc: '0',
};

// Use shared formatUsdc from @antseed/node
const formatUsdc6 = formatUsdc;

let cachedCreditsInfo: CreditsInfo | null = null;

// Cached crypto config — invalidated on config update. Uses protocol defaults
// from resolveChainConfig with optional user overrides from config.json.
let cachedCryptoConfig: {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  depositsAddress: string;
  channelsAddress: string;
  usdcAddress: string;
  chainId: number;
  emissionsAddress?: string;
  antsTokenAddress?: string;
  depositRelayAddress?: string;
  depositsDeployBlock?: number;
} | null = null;

// Cached on-chain clients for the rewards summary — invalidated together with
// cachedCryptoConfig on config updates.
let cachedEmissionsClient: EmissionsClient | null = null;
let cachedAntsTokenClient: ANTSTokenClient | null = null;
let cachedChannelsClient: ChannelsClient | null = null;

export async function loadCachedCryptoConfig(): Promise<typeof cachedCryptoConfig> {
  if (cachedCryptoConfig) return cachedCryptoConfig;
  let overrides: Record<string, unknown> = {};
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const payments = asRecord(config.payments);
    overrides = asRecord(payments.crypto);
  } catch {
    // No config — no crypto config available
  }
  // Resolve chain config from the selected chain ID (default: base-mainnet).
  // All contract addresses come from the preset in chain-config.ts.
  const selectedChain = asString(overrides.chainId as string, '') || 'base-mainnet';
  const userRpcUrl = asString(overrides.rpcUrl as string, '');
  const cc = resolveChainConfig({ chainId: selectedChain, ...(userRpcUrl ? { rpcUrl: userRpcUrl } : {}) });
  cachedCryptoConfig = {
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    depositsAddress: cc.depositsContractAddress,
    channelsAddress: cc.channelsContractAddress,
    usdcAddress: cc.usdcContractAddress,
    chainId: cc.evmChainId,
    ...(cc.emissionsContractAddress ? { emissionsAddress: cc.emissionsContractAddress } : {}),
    ...(cc.antsTokenAddress ? { antsTokenAddress: cc.antsTokenAddress } : {}),
    ...(cc.depositRelayAddress ? { depositRelayAddress: cc.depositRelayAddress } : {}),
    ...(cc.depositsDeployBlock !== undefined ? { depositsDeployBlock: cc.depositsDeployBlock } : {}),
  };
  return cachedCryptoConfig;
}

let creditsRpcFailCount = 0;
let creditsRpcLastFailAt = 0;
const CREDITS_RPC_BACKOFF_THRESHOLD = 3;
const CREDITS_RPC_RETRY_COOLDOWN_MS = 60_000;

export async function refreshCreditsInfo(): Promise<CreditsInfo> {
  const identity = getSecureIdentity();
  if (!identity) {
    return { evmAddress: null, ...EMPTY_CREDITS };
  }

  const evmAddress = identity.wallet.address;
  const cc = await loadCachedCryptoConfig();
  if (!cc) {
    return { evmAddress, ...EMPTY_CREDITS };
  }

  // Back off after repeated RPC failures; retry after cooldown so transient
  // outages don't permanently disable balance display for the session.
  if (creditsRpcFailCount >= CREDITS_RPC_BACKOFF_THRESHOLD) {
    if (Date.now() - creditsRpcLastFailAt < CREDITS_RPC_RETRY_COOLDOWN_MS) {
      if (cachedCreditsInfo) return cachedCreditsInfo;
      return { evmAddress, ...EMPTY_CREDITS };
    }
    // Cooldown elapsed — allow a retry attempt
    creditsRpcFailCount = 0;
  }

  const depositsClient = new DepositsClient({ rpcUrl: cc.rpcUrl, ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}), contractAddress: cc.depositsAddress, usdcAddress: cc.usdcAddress, ...(cc.chainId ? { evmChainId: cc.chainId } : {}) });

  try {
    const [balance, creditLimit, operatorAddress, pending] = await Promise.all([
      depositsClient.getBuyerBalance(evmAddress),
      depositsClient.getBuyerCreditLimit(evmAddress),
      (async (): Promise<string | null> => {
        try {
          const addr = await depositsClient.getOperator(evmAddress);
          return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null;
        } catch { return null; }
      })(),
      getPendingSpendUsdc().catch(() => 0n),
    ]);
    creditsRpcFailCount = 0;

    const deposited = balance.available + balance.reserved;
    const spendable = spendableBalance(deposited, pending);

    const info: CreditsInfo = {
      evmAddress,
      operatorAddress,
      balanceUsdc: formatUsdc6(deposited),
      reservedUsdc: formatUsdc6(balance.reserved),
      availableUsdc: formatUsdc6(balance.available),
      pendingUsdc: formatUsdc6(pending),
      spendableUsdc: formatUsdc6(spendable),
      creditLimitUsdc: formatUsdc6(creditLimit),
    };
    cachedCreditsInfo = info;
    return info;
  } catch (err) {
    creditsRpcFailCount++;
    creditsRpcLastFailAt = Date.now();
    if (creditsRpcFailCount <= 1) {
      try { console.warn('[credits] Deposits RPC unavailable:', err instanceof Error ? err.message : String(err)); }
      catch { /* EPIPE — ignore */ }
    }
    if (cachedCreditsInfo) return cachedCreditsInfo;
    return { evmAddress, ...EMPTY_CREDITS };
  }
}


/** Drop the cached balance — call when the signing identity changes. */
export function invalidateCreditsCache(): void {
  cachedCreditsInfo = null;
}

/**
 * Drop every cached chain client and reset the RPC backoff. Call when chain
 * config changes, so the next read builds clients against the new endpoints
 * instead of serving answers from the old chain.
 */
export function invalidateChainClients(): void {
  cachedCryptoConfig = null;
  cachedEmissionsClient = null;
  cachedAntsTokenClient = null;
  cachedChannelsClient = null;
  creditsRpcFailCount = 0;
}

export function getCachedChannelsClient(): ChannelsClient | null {
  return cachedChannelsClient;
}

export function setCachedChannelsClient(client: ChannelsClient): void {
  cachedChannelsClient = client;
}

export function getCachedEmissionsClient(): EmissionsClient | null {
  return cachedEmissionsClient;
}

export function setCachedEmissionsClient(client: EmissionsClient): void {
  cachedEmissionsClient = client;
}

export function getCachedAntsTokenClient(): ANTSTokenClient | null {
  return cachedAntsTokenClient;
}

export function setCachedAntsTokenClient(client: ANTSTokenClient): void {
  cachedAntsTokenClient = client;
}
