import {
  VerifierRegistryClient,
  VerifierRewardsClient,
  resolveChainConfig,
  type ChainConfig,
} from '@antseed/node'
import type { AntseedConfig } from '../../config/types.js'
import { resolveBaseRpcUrlOverride } from '../payment-utils.js'

const UNAVAILABLE_CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000'

export interface VerificationChainContext {
  chain: ChainConfig
  registryClient: VerifierRegistryClient
  rewardsClient: VerifierRewardsClient
}

export function resolveVerificationChain(config: AntseedConfig, rpcUrlFlag?: string): VerificationChainContext {
  const chain = resolveChain(config, rpcUrlFlag)
  if (!chain.verifierRegistryAddress) {
    throw new Error('No verifier registry address configured. Set payments.crypto.verifierRegistryAddress.')
  }
  return createVerificationChainContext(chain)
}

export function resolveObservationVerificationChain(
  config: AntseedConfig,
  rpcUrlFlag?: string,
): VerificationChainContext {
  const chain = resolveChain(config, rpcUrlFlag)
  return createVerificationChainContext(chain)
}

function resolveChain(config: AntseedConfig, rpcUrlFlag?: string): ChainConfig {
  const rpcUrl = resolveBaseRpcUrlOverride({ flagValue: rpcUrlFlag })
  return resolveChainConfig({
    ...(config.payments.crypto ?? {}),
    ...(rpcUrl ? { rpcUrl } : {}),
  })
}

function createVerificationChainContext(chain: ChainConfig): VerificationChainContext {
  const common = {
    rpcUrl: chain.rpcUrl,
    ...(chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.fallbackRpcUrls } : {}),
    evmChainId: chain.evmChainId,
  }
  return {
    chain,
    registryClient: new VerifierRegistryClient({
      ...common,
      contractAddress: chain.verifierRegistryAddress ?? UNAVAILABLE_CONTRACT_ADDRESS,
    }),
    rewardsClient: new VerifierRewardsClient({
      ...common,
      contractAddress: chain.verifierRewardsAddress ?? UNAVAILABLE_CONTRACT_ADDRESS,
    }),
  }
}
