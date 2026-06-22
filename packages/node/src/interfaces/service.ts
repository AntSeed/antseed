import type { ChainConfig } from '../payments/chain-config.js'

/** Serializable, mechanism-agnostic status a client (e.g. the desktop) renders. */
export interface ServiceStatus {
  enabled: boolean
  /** True when the service is paused on a deterministic failure; drives error styling. */
  attention: boolean
  /** Human-readable status line. */
  summary: string
  /** Optional address the user can fund; present => UI shows copy + QR. */
  receiveAddress?: string | null
  /** Max USDC the user can deposit right now (e.g. on-chain credit-limit
   * headroom); present => UI shows the live cap. Null when not yet known. */
  receiveLimitUsdc?: number | null
}

/** Sensitive capabilities a service plugin may declare a need for. The host
 * grants only the ones the plugin asks for, so a service never receives a
 * capability (e.g. the wallet key) it did not request. */
export type ServiceCapability = 'wallet' | 'chain'

export interface WalletCapability {
  privateKey: `0x${string}`
  address: `0x${string}`
}

/** The capability bag a {@link ServiceHost} carries. Each field is present only
 * when the plugin declared the matching {@link ServiceCapability} and the host
 * was able to grant it. */
export interface ServiceCapabilities {
  wallet?: WalletCapability
  chain?: ChainConfig
}

/** Context every service gets: consent, an attention logger, and the subset of
 * capabilities it declared. The host (e.g. the CLI buyer process) owns the
 * underlying resources and hands in only what the plugin asked for. */
export interface ServiceHost {
  consent: { isEnabled(): boolean }
  onAttention?(message: string): void
  capabilities: ServiceCapabilities
}

export interface Service {
  start(): void
  stop(): void
  getStatus(): ServiceStatus
  /** Optional: trigger an immediate evaluation, e.g. right after consent is enabled. */
  poke?(): void | Promise<void>
}
