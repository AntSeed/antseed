/**
 * Shared infrastructure for Antseed service plugins.
 *
 * A service plugin runs a start/stop background lifecycle on the buyer's behalf
 * (e.g. the gasless auto-deposit funder). The plugin *type* and runtime
 * contracts live in @antseed/node alongside the provider/router plugin types;
 * this package provides the reusable helpers concrete service plugins build on,
 * mirroring how @antseed/provider-core and @antseed/router-core relate to node.
 */
import type { ChainConfig, ServiceHost, WalletCapability } from '@antseed/node'

export type {
  AntseedServicePlugin,
  Service,
  ServiceStatus,
  ServiceHost,
  ServiceCapability,
  ServiceCapabilities,
  WalletCapability,
} from '@antseed/node'

/** Read the wallet capability or throw. Use when the plugin declared 'wallet'
 * in its capabilities; the host guarantees it, so absence is a misconfig. */
export function requireWallet(host: ServiceHost): WalletCapability {
  const wallet = host.capabilities.wallet
  if (!wallet) {
    throw new Error('Service host did not grant the "wallet" capability')
  }
  return wallet
}

/** Read the chain capability or throw. Use when the plugin declared 'chain'. */
export function requireChain(host: ServiceHost): ChainConfig {
  const chain = host.capabilities.chain
  if (!chain) {
    throw new Error('Service host did not grant the "chain" capability')
  }
  return chain
}
