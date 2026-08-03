import {
  resolveChainConfig,
  type ChainConfig,
  type NodePaymentsConfig,
} from '@antseed/node';

/**
 * The subset of the CLI's `payments.crypto` user overrides that chain-aware
 * network commands actually consume. Matches the shape of
 * `AntseedConfig.payments.crypto` from the CLI's config/types.ts.
 */
export interface ChainCryptoOverrides {
  chainId?: 'base-local' | 'base-sepolia' | 'base-mainnet';
  rpcUrl?: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  freeUsageContractAddress?: string;
  usdcContractAddress?: string;
  stakingContractAddress?: string;
  identityRegistryAddress?: string;
  verifierRegistryAddress?: string;
  relayTreasuryAddress?: string;
  verifierPointsPolicyAddress?: string;
}

/**
 * Build the `NodePaymentsConfig` an ad-hoc `AntseedNode` needs to enrich peers
 * with on-chain stats (channel count, ghost count, total volume, last-settled).
 * Used by short-lived buyer nodes spun up by `antseed network browse` and
 * `antseed network peer` when a buyer daemon isn't already running.
 *
 * Returns `undefined` when the chain can't be resolved (missing `chainId`,
 * RPC, or contract addresses) so callers can gracefully skip on-chain
 * enrichment instead of erroring out. The caller is responsible for deciding
 * what to do with `undefined` — typically: skip the enrichment loop and show
 * on-chain columns as "—".
 *
 * The `stakingAddress` + `identityRegistryAddress` wiring is critical: without
 * them `AntseedNode._initializePayments` never creates a `StakingClient` /
 * `IdentityClient`, which gates the on-chain verification loop in
 * `discoverPeers()`.
 */
export function buildPaymentsConfig(
  cryptoOverrides: ChainCryptoOverrides | undefined,
): NodePaymentsConfig | undefined {
  try {
    return paymentsConfigFromChain(resolveChainConfig({
      chainId: cryptoOverrides?.chainId,
      rpcUrl: cryptoOverrides?.rpcUrl,
      depositsContractAddress: cryptoOverrides?.depositsContractAddress,
      channelsContractAddress: cryptoOverrides?.channelsContractAddress,
      freeUsageContractAddress: cryptoOverrides?.freeUsageContractAddress,
      usdcContractAddress: cryptoOverrides?.usdcContractAddress,
    }));
  } catch {
    return undefined;
  }
}

/**
 * Core `NodePaymentsConfig` projection of a resolved chain config — the
 * fields every payments-enabled CLI node shares. Callers (buyer/verifier
 * daemons) layer role-specific extras (fee caps, verifier registry, deposit
 * defaults) on top with a spread.
 *
 * The `stakingAddress` + `identityRegistryAddress` wiring is critical: without
 * them `AntseedNode._initializePayments` never creates a `StakingClient` /
 * `IdentityClient`, which gates the on-chain verification loop in
 * `discoverPeers()` (e.g. `onChainTotalVolumeUsdcMicros` never populates).
 */
export function paymentsConfigFromChain(resolved: ChainConfig): NodePaymentsConfig {
  return {
    enabled: true,
    rpcUrl: resolved.rpcUrl,
    ...(resolved.fallbackRpcUrls ? { fallbackRpcUrls: resolved.fallbackRpcUrls } : {}),
    depositsAddress: resolved.depositsContractAddress,
    channelsAddress: resolved.channelsContractAddress,
    ...(resolved.freeUsageContractAddress ? { freeUsageAddress: resolved.freeUsageContractAddress } : {}),
    usdcAddress: resolved.usdcContractAddress,
    chainId: resolved.evmChainId,
    ...(resolved.stakingContractAddress ? { stakingAddress: resolved.stakingContractAddress } : {}),
    ...(resolved.identityRegistryAddress ? { identityRegistryAddress: resolved.identityRegistryAddress } : {}),
    ...(resolved.verifierRegistryAddress ? { verifierRegistryAddress: resolved.verifierRegistryAddress } : {}),
    ...(resolved.relayTreasuryAddress ? { relayTreasuryAddress: resolved.relayTreasuryAddress } : {}),
    ...(resolved.verifierPointsPolicyAddress ? { verifierPointsPolicyAddress: resolved.verifierPointsPolicyAddress } : {}),
  };
}
