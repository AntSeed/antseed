import { homedir } from 'node:os';
import path from 'node:path';
import { resolveChainConfig, type ChainConfig } from '@antseed/node';

export const MERIDIAN_API_BASE_DEFAULT = 'https://api.mrdn.finance/v1';

/** Meridian x402 settlement parameters for one network. */
export interface MeridianNetwork {
  /** x402 `network` identifier used in requirements and payment payloads. */
  network: string;
  /** EIP-3009 payment token the Meridian facilitator pulls from the payer. */
  asset: string;
  /** EIP-712 domain name/version of the payment token (signature checks). */
  assetName: string;
  assetVersion: string;
  /** Meridian proxy facilitator — both `payTo` and `authorization.to`. */
  facilitator: string;
}

/**
 * Meridian presets keyed by AntSeed chain id. Note that on base-sepolia the
 * Meridian payment token (Circle testnet USDC) is NOT the AntSeed deposits
 * token (MockUSDC) — the relayer wallet must hold a MockUSDC float there.
 * On base-mainnet both are canonical USDC, so settled funds are deposited 1:1.
 */
const MERIDIAN_NETWORKS: Record<string, MeridianNetwork> = {
  'base-mainnet': {
    network: 'base',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    assetName: 'USD Coin',
    assetVersion: '2',
    facilitator: '0x8E7769D440b3460b92159Dd9C6D17302b036e2d6',
  },
  'base-sepolia': {
    network: 'base-sepolia',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    assetName: 'USDC',
    assetVersion: '2',
    facilitator: '0x8e633dBf31adCc7D41BE3e95B7c8DD3526B5235A',
  },
};

export interface TopupLimits {
  /** Floor for a single top-up in USDC base units (dust guard). */
  minTopupAmount: bigint;
  /** Optional per-request cap in USDC base units. 0 = cap by headroom only. */
  maxTopupAmount: bigint;
  /**
   * Worst-case facilitator fee (bps) assumed when grossing up the on-chain
   * MIN_BUYER_DEPOSIT for a buyer's first top-up. The credited amount is the
   * settled amount net of Meridian fees, which are not knowable up front.
   */
  maxSettleFeeBps: number;
  /** Reject authorizations that expire sooner than this many seconds. */
  minValiditySeconds: number;
}

export interface TopupConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Public base URL advertised as the x402 `resource`. */
  resourceBaseUrl: string;
  chain: ChainConfig;
  relayerPrivateKey: string;
  meridian: MeridianNetwork & { apiBase: string; apiKey: string };
  limits: TopupLimits;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return value;
}

function envBigint(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a base-unit integer, got "${raw}"`);
  return BigInt(raw.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv): TopupConfig {
  const chainId = env.ANTSEED_TOPUP_CHAIN_ID ?? 'base-mainnet';
  const chain = resolveChainConfig({
    chainId,
    rpcUrl: env.ANTSEED_TOPUP_RPC_URL,
    depositsContractAddress: env.ANTSEED_TOPUP_DEPOSITS_ADDRESS,
    usdcContractAddress: env.ANTSEED_TOPUP_USDC_ADDRESS,
  });

  const relayerPrivateKey = env.ANTSEED_TOPUP_RELAYER_KEY?.trim();
  if (!relayerPrivateKey) {
    throw new Error('ANTSEED_TOPUP_RELAYER_KEY is required (hex private key of the gas-funded relayer wallet)');
  }
  const apiKey = env.MERIDIAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('MERIDIAN_API_KEY is required (organization API key from https://mrdn.finance/dev/api-keys)');
  }

  const preset = MERIDIAN_NETWORKS[chain.chainId];
  const network = env.MERIDIAN_X402_NETWORK ?? preset?.network;
  const asset = env.MERIDIAN_PAYMENT_ASSET ?? preset?.asset;
  const assetName = env.MERIDIAN_PAYMENT_ASSET_NAME ?? preset?.assetName;
  const assetVersion = env.MERIDIAN_PAYMENT_ASSET_VERSION ?? preset?.assetVersion;
  const facilitator = env.MERIDIAN_FACILITATOR_ADDRESS ?? preset?.facilitator;
  if (!network || !asset || !assetName || !assetVersion || !facilitator) {
    throw new Error(
      `No Meridian preset for chain "${chain.chainId}" — set MERIDIAN_X402_NETWORK, ` +
      'MERIDIAN_PAYMENT_ASSET, MERIDIAN_PAYMENT_ASSET_NAME, MERIDIAN_PAYMENT_ASSET_VERSION ' +
      'and MERIDIAN_FACILITATOR_ADDRESS explicitly',
    );
  }

  const port = envInt(env, 'ANTSEED_TOPUP_PORT', 8390);
  return {
    port,
    host: env.ANTSEED_TOPUP_HOST ?? '127.0.0.1',
    dataDir: env.ANTSEED_TOPUP_DATA_DIR ?? path.join(homedir(), '.antseed-topup'),
    resourceBaseUrl: (env.ANTSEED_TOPUP_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    chain,
    relayerPrivateKey,
    meridian: {
      apiBase: (env.MERIDIAN_API_BASE ?? MERIDIAN_API_BASE_DEFAULT).replace(/\/$/, ''),
      apiKey,
      network,
      asset,
      assetName,
      assetVersion,
      facilitator,
    },
    limits: {
      minTopupAmount: envBigint(env, 'ANTSEED_TOPUP_MIN_AMOUNT', 100_000n),
      maxTopupAmount: envBigint(env, 'ANTSEED_TOPUP_MAX_AMOUNT', 0n),
      maxSettleFeeBps: envInt(env, 'ANTSEED_TOPUP_MAX_SETTLE_FEE_BPS', 2_000),
      minValiditySeconds: envInt(env, 'ANTSEED_TOPUP_MIN_VALIDITY_SECONDS', 30),
    },
  };
}
