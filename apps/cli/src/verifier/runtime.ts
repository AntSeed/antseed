import { join } from 'node:path'
import {
  AntseedNode,
  DepositsClient,
  OFFICIAL_BOOTSTRAP_NODES,
  type Identity,
  type NodePaymentsConfig,
} from '@antseed/node'
import { checkBuyerReadiness, type ReadinessCheck } from '@antseed/node/payments'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import type { AntseedConfig } from '../config/types.js'
import { paymentsConfigFromChain } from '../cli/commands/network/chain-config-helper.js'
import {
  resolveObservationVerificationChain,
  resolveVerificationChain,
  type VerificationChainContext,
} from '../cli/commands/verification-chain.js'

export interface VerifierRuntime {
  config: AntseedConfig
  node: AntseedNode
  chain: VerificationChainContext
  identity: Identity
  referencesDir: string
  evidenceDir: string
}

export async function startVerifierRuntime(input: {
  config: AntseedConfig
  dataDir: string
  configPath?: string
  noAttest: boolean
}): Promise<VerifierRuntime> {
  const chain = input.noAttest
    ? resolveObservationVerificationChain(input.config)
    : resolveVerificationChain(input.config)
  const bootstrapNodes = input.config.network.bootstrapNodes.length > 0
    ? toBootstrapConfig(parseBootstrapList(input.config.network.bootstrapNodes))
    : OFFICIAL_BOOTSTRAP_NODES
  const payments: NodePaymentsConfig = {
    ...paymentsConfigFromChain(chain.chain),
    defaultDepositAmountUSDC: input.config.payments.crypto?.defaultLockAmountUSDC
      ? String(Math.round(Number(input.config.payments.crypto.defaultLockAmountUSDC) * 1_000_000))
      : '1000000',
    platformFeeRate: input.config.payments.platformFeeRate,
    maxPerRequestUsdc: input.config.payments.maxPerRequestUsdc ?? '300000',
    maxReserveAmountUsdc: input.config.payments.maxReserveAmountUsdc ?? '1000000',
  }
  const node = new AntseedNode({
    role: 'buyer',
    dataDir: input.dataDir,
    configPath: input.configPath,
    bootstrapNodes,
    requestTimeoutMs: input.config.verifier?.probeRequestTimeoutMs ?? 120_000,
    allowPrivateIPs: chain.chain.chainId === 'base-local',
    noOfficialBootstrap: chain.chain.chainId === 'base-local' && input.config.network.bootstrapNodes.length > 0,
    payments,
  })
  await node.start()
  const identity = node.identity
  if (!identity) {
    await node.stop()
    throw new Error('verifier identity is unavailable')
  }
  try {
    await assertBuyerPaymentReady(chain, identity, { requireGas: !input.noAttest })
    if (!input.noAttest) await assertApprovedVerifier(chain, identity)
  } catch (error) {
    await node.stop()
    throw error
  }
  return {
    config: input.config,
    node,
    chain,
    identity,
    referencesDir: input.config.verifier?.referencesDir ?? join(input.dataDir, 'verifier', 'references'),
    evidenceDir: input.config.verifier?.evidenceDir ?? join(input.dataDir, 'verifier', 'evidence'),
  }
}

export async function assertApprovedVerifier(chain: VerificationChainContext, identity: Identity): Promise<void> {
  if (!await chain.registryClient.approvedVerifier(identity.wallet.address)) {
    throw new Error(`wallet ${identity.wallet.address} is not an approved verifier`)
  }
}

export async function assertBuyerPaymentReady(
  chain: VerificationChainContext,
  identity: Identity,
  options: { requireGas?: boolean } = {},
): Promise<void> {
  const depositsClient = new DepositsClient({
    rpcUrl: chain.chain.rpcUrl,
    ...(chain.chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.chain.fallbackRpcUrls } : {}),
    contractAddress: chain.chain.depositsContractAddress,
    usdcAddress: chain.chain.usdcContractAddress,
    evmChainId: chain.chain.evmChainId,
  })
  const failed = failedBuyerReadinessChecks(await checkBuyerReadiness(identity, depositsClient), options.requireGas ?? true)
  if (failed.length > 0) throw new Error(`verifier payment readiness failed: ${failed.map((check) => check.message).join('; ')}`)
}

export function failedBuyerReadinessChecks(checks: readonly ReadinessCheck[], requireGas = true): ReadinessCheck[] {
  return checks.filter((check) => !check.passed && (requireGas || check.name !== 'Gas balance'))
}
