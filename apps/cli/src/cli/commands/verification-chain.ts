import {
  RelayJobValidator,
  RelayTreasuryClient,
  VerifierRegistryClient,
  resolveChainConfig,
  type AntseedNode,
  type ChainConfig,
} from '@antseed/node'
import type { AntseedConfig } from '../../config/types.js'
import { resolveBaseRpcUrlOverride } from '../payment-utils.js'

export interface VerificationChainContext {
  chain: ChainConfig
  registryClient: VerifierRegistryClient
  treasuryClient: RelayTreasuryClient
}

export function resolveVerificationChain(config: AntseedConfig, rpcUrlFlag?: string): VerificationChainContext {
  const rpcUrl = resolveBaseRpcUrlOverride({ flagValue: rpcUrlFlag })
  const chain = resolveChainConfig({
    ...(config.payments.crypto ?? {}),
    ...(rpcUrl ? { rpcUrl } : {}),
  })
  if (!chain.verifierRegistryAddress) {
    throw new Error('No verifier registry address configured. Set payments.crypto.verifierRegistryAddress.')
  }
  if (!chain.relayTreasuryAddress) {
    throw new Error('No relay treasury address configured. Set payments.crypto.relayTreasuryAddress.')
  }
  const common = {
    rpcUrl: chain.rpcUrl,
    ...(chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.fallbackRpcUrls } : {}),
    evmChainId: chain.evmChainId,
  }
  return {
    chain,
    registryClient: new VerifierRegistryClient({ ...common, contractAddress: chain.verifierRegistryAddress }),
    treasuryClient: new RelayTreasuryClient({ ...common, contractAddress: chain.relayTreasuryAddress }),
  }
}

export function createRelayValidator(
  node: AntseedNode,
  context: VerificationChainContext,
  minimumPayoutPerJobUsdc: bigint,
): RelayJobValidator {
  const identity = node.identity
  if (!identity) throw new Error('relay node identity is unavailable')
  return new RelayJobValidator({
    chainId: String(context.chain.evmChainId),
    registryAddress: context.chain.verifierRegistryAddress!,
    treasuryAddress: context.chain.relayTreasuryAddress!,
    relayBuyerAddress: identity.wallet.address,
    minimumPayoutPerJobUsdc,
    verifierRegistryClient: context.registryClient,
    relayTreasuryClient: context.treasuryClient,
  })
}
