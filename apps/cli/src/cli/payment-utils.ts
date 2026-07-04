import { join } from 'node:path';
import {
  DepositsClient,
  ChannelsClient,
  StakingClient,
  loadOrCreateIdentity,
  resolveChainConfig,
} from '@antseed/node';
import {
  IdentityClient,
  EmissionsClient,
  ChannelStore,
} from '@antseed/node/payments';
import type { Identity } from '@antseed/node';
import type { AntseedConfig } from '../config/types.js';

export const ANTSEED_BASE_RPC_URL_ENV = 'ANTSEED_BASE_RPC_URL';

export interface RpcUrlOverrideInput {
  /** Runtime-only CLI flag value. Wins over environment variables. */
  flagValue?: string;
  /** Environment to read from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CryptoConfigOverrides {
  /** Runtime-only RPC URL override. Wins over environment variables and config.json. */
  rpcUrl?: string;
  /** Environment to read ANTSEED_BASE_RPC_URL from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function normalizeHttpRpcUrl(value: string | undefined, label = ANTSEED_BASE_RPC_URL_ENV): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://`);
  }

  return trimmed;
}

function normalizeRpcUrl(value: string | undefined): string | undefined {
  return normalizeHttpRpcUrl(value, ANTSEED_BASE_RPC_URL_ENV);
}

/**
 * Resolve the runtime Base JSON-RPC URL override used by seller infrastructure.
 * Precedence: CLI flag > ANTSEED_BASE_RPC_URL env var > config/defaults.
 */
export function resolveBaseRpcUrlOverride(input: RpcUrlOverrideInput = {}): string | undefined {
  return normalizeRpcUrl(
    input.flagValue ?? (input.env ?? process.env)[ANTSEED_BASE_RPC_URL_ENV],
  );
}

/** Format ANTS token amounts (18 decimals) to human-readable string. */
export function formatAnts(baseUnits: bigint): string {
  const whole = baseUnits / 10n ** 18n;
  const frac = baseUnits % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6) || '0';
  return `${whole}.${fracStr}`;
}

/** Format USDC base units (6 decimals) to human-readable string. */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

export function shortId(value: string, len = 10): string {
  return value.length > len ? `${value.slice(0, len)}...` : value;
}

/** Parse human-readable USDC to base units (6 decimals). */
export function parseUsdcToBaseUnits(amount: string): bigint {
  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return BigInt(Math.round(amountFloat * 1_000_000));
}

export interface CryptoContext {
  identity: Identity;
  wallet: Identity['wallet'];
  address: string;
}

type ResolvedCryptoConfig = NonNullable<AntseedConfig['payments']['crypto']> & {
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcContractAddress: string;
  stakingContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  evmChainId: number;
};

/**
 * Load identity and derive EVM wallet + address. Shared across all payment commands.
 */
export async function loadCryptoContext(dataDir: string): Promise<CryptoContext> {
  const identity = await loadOrCreateIdentity(dataDir);
  const wallet = identity.wallet;
  const address = identity.wallet.address;
  return { identity, wallet, address };
}

/**
 * Validate that crypto payment config is present and return it.
 * Exits with error if not configured.
 */
export function requireCryptoConfig(
  config: AntseedConfig,
  overrides: CryptoConfigOverrides = {},
): ResolvedCryptoConfig {
  const crypto = config.payments?.crypto;
  if (!crypto) {
    throw new Error('No crypto payment configuration found. Configure payments.crypto in your config file.');
  }

  const rpcUrlOverride = normalizeRpcUrl(overrides.rpcUrl)
    ?? resolveBaseRpcUrlOverride({ env: overrides.env });

  // Merge with chain-config defaults so commands work with just chainId.
  // Runtime RPC overrides intentionally win over config.json and built-ins.
  const resolved = resolveChainConfig({
    ...crypto,
    ...(rpcUrlOverride ? { rpcUrl: rpcUrlOverride } : {}),
  });
  return {
    ...crypto,
    rpcUrl: rpcUrlOverride || crypto.rpcUrl || resolved.rpcUrl,
    ...(resolved.fallbackRpcUrls && resolved.fallbackRpcUrls.length > 0
      ? { fallbackRpcUrls: resolved.fallbackRpcUrls }
      : {}),
    usdcContractAddress: crypto.usdcContractAddress || resolved.usdcContractAddress,
    depositsContractAddress: crypto.depositsContractAddress || resolved.depositsContractAddress,
    channelsContractAddress: crypto.channelsContractAddress || resolved.channelsContractAddress,
    stakingContractAddress: crypto.stakingContractAddress || resolved.stakingContractAddress,
    emissionsContractAddress: crypto.emissionsContractAddress || resolved.emissionsContractAddress,
    identityRegistryAddress: crypto.identityRegistryAddress || resolved.identityRegistryAddress,
    evmChainId: resolved.evmChainId,
  };
}

function fallbackClientOpts(crypto: ReturnType<typeof requireCryptoConfig>) {
  return crypto.fallbackRpcUrls && crypto.fallbackRpcUrls.length > 0
    ? { fallbackRpcUrls: crypto.fallbackRpcUrls }
    : {};
}

/**
 * Create a DepositsClient from the CLI config.
 */
export function createDepositsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): DepositsClient {
  const crypto = requireCryptoConfig(config, overrides);
  return new DepositsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.depositsContractAddress,
    usdcAddress: crypto.usdcContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create a ChannelsClient from the CLI config.
 */
export function createChannelsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): ChannelsClient {
  const crypto = requireCryptoConfig(config, overrides);
  return new ChannelsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.channelsContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create an IdentityClient from the CLI config.
 */
export function createIdentityClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): IdentityClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.identityRegistryAddress) {
    throw new Error('No identity registry address configured. Set payments.crypto.identityRegistryAddress in your config file.');
  }
  return new IdentityClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.identityRegistryAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create a StakingClient from the CLI config.
 */
export function createStakingClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): StakingClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.stakingContractAddress) {
    throw new Error('No staking contract address configured. Set payments.crypto.stakingContractAddress in your config file.');
  }
  return new StakingClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.stakingContractAddress,
    usdcAddress: crypto.usdcContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create an EmissionsClient from the CLI config.
 */
export function createEmissionsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): EmissionsClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.emissionsContractAddress) {
    throw new Error('No emissions contract address configured. Set payments.crypto.emissionsContractAddress in your config file.');
  }
  return new EmissionsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.emissionsContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Open a ChannelStore from the given data directory.
 * The runtime stores channels in {dataDir}/payments/sessions.db.
 */
export function openChannelStore(dataDir: string): ChannelStore {
  return new ChannelStore(join(dataDir, 'payments'));
}
