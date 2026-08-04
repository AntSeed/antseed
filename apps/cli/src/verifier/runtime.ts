import { join } from 'node:path'
import {
  AntseedNode,
  DepositsClient,
  OFFICIAL_BOOTSTRAP_NODES,
  type Identity,
  type NodePaymentsConfig,
  type PeerInfo,
  type VerificationStorage,
} from '@antseed/node'
import { checkBuyerReadiness } from '@antseed/node/payments'
import type { ReadinessCheck } from '@antseed/node/payments'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import type { AntseedConfig } from '../config/types.js'
import { paymentsConfigFromChain } from '../cli/commands/network/chain-config-helper.js'
import {
  resolveObservationVerificationChain,
  resolveVerificationChain,
  type VerificationChainContext,
} from '../cli/commands/verification-chain.js'
import {
  createDirectAuditRunId,
  initializeDirectAudit,
  runDirectAudit,
  type DirectAuditResult,
} from './audit-runner.js'
import { prepareDirectAuditReference } from './direct-reference.js'
import { resolveReferencePolicy } from './reference-config.js'

export interface VerifierRuntime {
  config: AntseedConfig
  dataDir: string
  node: AntseedNode
  chain: VerificationChainContext
  identity: Identity
  storage: VerificationStorage
  referencesDir: string
  evidenceDir: string
}

export type VerifierReadinessMode = 'discover' | 'observe' | 'attest'

export async function startVerifierRuntime(input: {
  config: AntseedConfig
  dataDir: string
  configPath?: string
  rpcUrl?: string
  readiness?: VerifierReadinessMode
}): Promise<VerifierRuntime> {
  const readiness = input.readiness ?? 'attest'
  const chain = readiness === 'attest'
    ? resolveVerificationChain(input.config, input.rpcUrl)
    : resolveObservationVerificationChain(input.config, input.rpcUrl)
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
    verification: { sampleRate: 1 },
  })
  await node.start()
  const identity = node.identity
  const storage = node.verificationStorage
  if (!identity || !storage) {
    await node.stop()
    throw new Error('verifier identity or verification storage is unavailable')
  }
  try {
    if (readiness !== 'discover') {
      await assertBuyerPaymentReady(chain, identity, {
        requireGas: readiness === 'attest',
      })
    }
    if (readiness === 'attest') {
      await assertApprovedVerifier(chain, identity)
    }
  } catch (error) {
    await node.stop()
    throw error
  }
  return {
    config: input.config,
    dataDir: input.dataDir,
    node,
    chain,
    identity,
    storage,
    referencesDir: input.config.verifier?.referencesDir ?? join(input.dataDir, 'fingerprints', 'references'),
    evidenceDir: input.config.verifier?.evidenceDir ?? join(input.dataDir, 'verifier', 'evidence'),
  }
}

export async function assertVerifierReady(
  chain: VerificationChainContext,
  identity: Identity,
): Promise<void> {
  await assertBuyerPaymentReady(chain, identity)
  await assertApprovedVerifier(chain, identity)
}

export async function assertApprovedVerifier(
  chain: VerificationChainContext,
  identity: Identity,
): Promise<void> {
  const approved = await chain.registryClient.approvedVerifier(identity.wallet.address)
  if (!approved) throw new Error(`wallet ${identity.wallet.address} is not an approved verifier`)
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
  const checks = await checkBuyerReadiness(identity, depositsClient)
  const failed = failedBuyerReadinessChecks(checks, options.requireGas ?? true)
  if (failed.length > 0) {
    throw new Error(`verifier payment readiness failed: ${failed.map((check) => check.message).join('; ')}`)
  }
}

export function failedBuyerReadinessChecks(
  checks: readonly ReadinessCheck[],
  requireGas: boolean,
): ReadinessCheck[] {
  return checks.filter((check) => !check.passed && (requireGas || check.name !== 'Gas balance'))
}

export async function executeVerifierAudit(input: {
  runtime: VerifierRuntime
  target: PeerInfo
  service: string
  source: 'manual' | 'automatic'
  epoch: bigint
  minimumProbeCount: number
  evidenceUri?: string
  warn?: (message: string) => void
  log?: (message: string) => void
}): Promise<DirectAuditResult> {
  if (!input.target.onChainAgentId) throw new Error('target has no on-chain agent id')
  const now = Date.now()
  const runId = createDirectAuditRunId({
    verifierAddress: input.runtime.identity.wallet.address,
    targetPeerId: input.target.peerId,
    agentId: input.target.onChainAgentId,
    service: input.service,
    now,
  })
  initializeDirectAudit({
    storage: input.runtime.storage,
    runId,
    source: input.source,
    epoch: input.epoch,
    verifierAddress: input.runtime.identity.wallet.address,
    target: input.target,
    service: input.service,
    now,
  })
  try {
    const policy = resolveReferencePolicy(input.runtime.config.verifier?.referencePolicy)
    const reference = await prepareDirectAuditReference({
      storage: input.runtime.storage,
      runId,
      target: input.target,
      service: input.service,
      advertisedService: input.service,
      verifierConfig: input.runtime.config.verifier,
      referencesDir: input.runtime.referencesDir,
      minimumProbeCount: input.minimumProbeCount,
      minimumStatisticalPower: policy.minimumStatisticalPower,
      warn: input.warn,
      log: input.log,
      now,
    })
    return await runDirectAudit({
      node: input.runtime.node,
      registryClient: input.runtime.chain.registryClient,
      storage: input.runtime.storage,
      signer: input.runtime.identity.wallet,
      verifierAddress: input.runtime.identity.wallet.address,
      verifierPeerId: input.runtime.identity.peerId,
      evidenceDir: input.runtime.evidenceDir,
      minAuthenticatedProbeCount: Math.max(input.minimumProbeCount, policy.minimumAuditProbeCount),
      minimumStatisticalPower: policy.minimumStatisticalPower,
      probeRequestTimeoutMs: input.runtime.config.verifier?.probeRequestTimeoutMs ?? 120_000,
      maxConcurrentProbeRequests: input.runtime.config.verifier?.maxConcurrentProbeRequests ?? 2,
      warn: input.warn,
    }, {
      runId,
      source: input.source,
      epoch: input.epoch,
      target: input.target,
      service: input.service,
      reference,
      ...(input.evidenceUri ? { evidenceUri: input.evidenceUri } : {}),
    })
  } catch (error) {
    const audit = input.runtime.storage.getDirectAudit(runId)
    if (audit && audit.state !== 'attested' && audit.state !== 'failed') {
      input.runtime.storage.updateDirectAudit(runId, 'failed', {
        completedAt: Date.now(),
        failureReason: error instanceof Error ? error.message : String(error),
      })
      input.runtime.storage.releaseUnexposedDirectAuditProbes(runId)
    }
    throw error
  }
}
