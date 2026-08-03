import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import {
  AntseedNode,
  ChannelsClient,
  OFFICIAL_BOOTSTRAP_NODES,
  StakingClient,
  indexFinalizedChannelSettlements,
  type NodePaymentsConfig,
  type PeerId,
  type PeerInfo,
  type StoredAuditPlan,
  type StoredAuditRound,
  type VerificationStorage,
} from '@antseed/node'
import { canonicalHash, computeBinomialPower } from '@antseed/fingerprints'
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { loadConfig } from '../../../config/loader.js'
import type { AntseedConfig } from '../../../config/types.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { getGlobalOptions } from '../types.js'
import { paymentsConfigFromChain } from '../network/chain-config-helper.js'
import { resolveVerificationChain, type VerificationChainContext } from '../verification-chain.js'
import { parsePositiveIntFlag } from './flags.js'
import { createQueuedAuditPlan } from '../../../verifier/audit-queue.js'
import { DEFAULT_AUDIT_DURATION_MS } from '../../../verifier/audit-duration.js'
import {
  dispatchDueReferenceAuditJobs,
  planReferenceAudit,
  resumeReferenceAuditCommit,
  type AuditContext,
} from '../../../verifier/audit-runner.js'
import { discoverServices } from '../../../verifier/service-discovery.js'
import { loadReferences } from '../../../verifier/references.js'
import { loadReservedReferenceSubset } from '../../../verifier/reference-subset.js'
import { referenceBuildKey, resolveReferenceSource } from '../../../verifier/reference-config.js'
import {
  certificationProfileHash,
  certifyNewProbes,
  eligibleCatalogProbes,
  freshSelfTestProbes,
  importAdaptiveReferences,
  materializeAuditReference,
  maximumAvailabilityDeficit,
  nextAdaptiveProbeCount,
  selectCatalogProbes,
  type FreshSelfTestResult,
} from '../../../verifier/probe-catalog.js'
import { attestReferenceAudit } from '../../../verifier/attestation.js'

const DEFAULT_TICK_MS = 5_000
const DEFAULT_DISCOVERY_INTERVAL_MS = 300_000
const DEFAULT_JOB_TIMEOUT_MS = 120_000

interface VerifierDaemonRuntime {
  config: AntseedConfig
  dataDir: string
  node: AntseedNode
  chain: VerificationChainContext
  auditContext: AuditContext
  storage: VerificationStorage
  referencesDir: string
  tickMs: number
  discoveryIntervalMs: number
  stopping: () => boolean
}

export function registerVerifierStartCommand(verifierCmd: Command): void {
  verifierCmd
    .command('start')
    .description('Start the autonomous verifier audit daemon and relay host')
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .option('--tick-ms <ms>', 'workflow scheduler cadence', parsePositiveIntFlag, DEFAULT_TICK_MS)
    .option('--discovery-interval-ms <ms>', 'automatic target discovery cadence', parsePositiveIntFlag, DEFAULT_DISCOVERY_INTERVAL_MS)
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const chain = resolveVerificationChain(config, options.rpcUrl as string | undefined)
      const bootstrapNodes = config.network.bootstrapNodes.length > 0
        ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
        : OFFICIAL_BOOTSTRAP_NODES
      const payments: NodePaymentsConfig = {
        ...paymentsConfigFromChain(chain.chain),
        defaultDepositAmountUSDC: config.payments.crypto?.defaultLockAmountUSDC
          ? String(Math.round(Number(config.payments.crypto.defaultLockAmountUSDC) * 1_000_000))
          : '1000000',
        platformFeeRate: config.payments.platformFeeRate,
        maxPerRequestUsdc: config.payments.maxPerRequestUsdc ?? '300000',
        maxReserveAmountUsdc: config.payments.maxReserveAmountUsdc ?? '1000000',
      }
      const node = new AntseedNode({
        role: 'buyer',
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        bootstrapNodes,
        allowPrivateIPs: chain.chain.chainId === 'base-local',
        noOfficialBootstrap: chain.chain.chainId === 'base-local' && config.network.bootstrapNodes.length > 0,
        payments,
        verification: { sampleRate: 1 },
        relayHost: {
          ...(config.verifier?.relaySignalingPort !== undefined
            ? { signalingPort: config.verifier.relaySignalingPort }
            : {}),
          ...(config.verifier?.maxRelays !== undefined ? { maxRelays: config.verifier.maxRelays } : {}),
        },
      })

      await node.start()
      const identity = node.identity
      const storage = node.verificationStorage
      if (!identity || !storage) {
        await node.stop()
        throw new Error('verifier identity or verification storage is unavailable')
      }
      if (!await chain.registryClient.isApprovedVerifier(identity.wallet.address)) {
        await node.stop()
        throw new Error(`wallet ${identity.wallet.address} is not an approved verifier`)
      }

      let stopping = false
      setupShutdownHandler(async () => {
        stopping = true
        await node.stop()
      })
      const auditContext: AuditContext = {
        registryClient: chain.registryClient,
        treasuryClient: chain.treasuryClient,
        storage,
        signer: identity.wallet,
        chainId: String(chain.chain.evmChainId),
        registryAddress: chain.chain.verifierRegistryAddress!,
        treasuryAddress: chain.chain.relayTreasuryAddress!,
        runRelayJob: (relayPeerId, offer, timeoutMs) => node.runRelayJob(relayPeerId as PeerId, offer, timeoutMs),
      }
      console.log(chalk.green(`Verifier daemon started as ${identity.wallet.address}`))
      console.log(chalk.dim(`  relay host: verification.audit-relay.v1`))
      console.log(chalk.dim(`  database: ${join(globalOptions.dataDir, 'verification.db')}`))

      await runVerifierDaemon({
        config,
        dataDir: globalOptions.dataDir,
        node,
        chain,
        auditContext,
        storage,
        referencesDir: config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'fingerprints', 'references'),
        tickMs: Number(options.tickMs),
        discoveryIntervalMs: Number(options.discoveryIntervalMs),
        stopping: () => stopping,
      })
    })
}

export async function runVerifierDaemon(runtime: VerifierDaemonRuntime): Promise<void> {
  let nextDiscoveryAt = 0
  while (!runtime.stopping()) {
    try {
      await resumeAudits(runtime)
      const now = runtime.auditContext.now?.() ?? Date.now()
      if (now >= nextDiscoveryAt) {
        await discoverAutomaticAudits(runtime)
        nextDiscoveryAt = now + runtime.discoveryIntervalMs
      }
    } catch (error) {
      console.warn(chalk.yellow(`verifier daemon tick failed: ${(error as Error).message}`))
    }
    if (!runtime.stopping()) await (runtime.auditContext.sleep ?? sleep)(runtime.tickMs)
  }
}

async function resumeAudits(runtime: VerifierDaemonRuntime): Promise<void> {
  await createPendingAuditRounds(runtime)
  const now = runtime.auditContext.now?.() ?? Date.now()
  const rounds = runtime.storage.listAuditRounds().sort((left, right) => left.createdAt - right.createdAt)
  for (const round of rounds) {
    if (runtime.stopping()) return
    try {
      if (round.state === 'queued' || round.state === 'preparing'
        || (round.state === 'backoff' && (round.nextRetryAt ?? 0) <= now)) {
        await prepareAuditRound(runtime, round)
      }
      const refreshed = runtime.storage.getAuditRound(round.roundId)
      if (refreshed?.state === 'ready' || refreshed?.state === 'committing') {
        await commitAuditRound(runtime, refreshed)
      }
    } catch (error) {
      console.warn(chalk.yellow(`round ${round.roundId}: ${(error as Error).message}`))
    }
  }

  const plans = runtime.auditContext.storage.listAuditPlans().sort((left, right) => left.createdAt - right.createdAt)
  for (const plan of plans) {
    if (runtime.stopping()) return
    try {
      const member = runtime.storage.getAuditRoundMemberByAuditId(plan.auditId)
      const round = member ? runtime.storage.getAuditRound(member.roundId) : null
      if ((plan.state === 'committed' || plan.state === 'executing') && round?.state === 'committed') {
        await dispatchDueReferenceAuditJobs(runtime.auditContext, plan, runtime.node.getConnectedRelays())
      } else if (plan.state === 'awaiting-attestation' || plan.state === 'attesting') {
        await autoAttest(runtime, plan)
      }
    } catch (error) {
      console.warn(chalk.yellow(`audit ${plan.auditId}: ${(error as Error).message}`))
    }
  }

  for (const round of runtime.storage.listAuditRounds('committed')) {
    const states = runtime.storage.listAuditRoundMembers(round.roundId)
      .map((member) => runtime.storage.getAuditPlan(member.auditId)?.state)
    if (states.length > 0 && states.every((state) => state === 'attested' || state === 'failed')) {
      runtime.storage.updateAuditRound(round.roundId, 'complete')
    }
  }
}

async function createPendingAuditRounds(runtime: VerifierDaemonRuntime): Promise<void> {
  const rounds = runtime.storage.listAuditRounds()
  const assigned = new Set(rounds.flatMap((round) => runtime.storage.listAuditRoundMembers(round.roundId).map((member) => member.auditId)))
  const queued = runtime.storage.listAuditPlans('queued').filter((plan) => !assigned.has(plan.auditId))
  const groups = new Map<string, StoredAuditPlan[]>()
  for (const plan of queued) {
    const source = resolveReferenceSource(runtime.config.verifier, plan.targetService, plan.targetService)
    if (!source) continue
    const service = plan.targetService.trim().toLowerCase()
    const key = plan.source === 'manual'
      ? `manual:${plan.auditId}`
      : `${service}:${plan.epoch ?? 'unknown'}:${referenceBuildKey(source)}`
    const group = groups.get(key) ?? []
    group.push(plan)
    groups.set(key, group)
  }
  for (const plans of groups.values()) {
    const first = plans[0]!
    const source = resolveReferenceSource(runtime.config.verifier, first.targetService, first.targetService)!
    const now = runtime.auditContext.now?.() ?? Date.now()
    const roundId = canonicalHash({
      service: first.targetService.trim().toLowerCase(),
      endpointHash: referenceBuildKey(source),
      epoch: first.epoch,
      auditIds: plans.map((plan) => plan.auditId).sort(),
    })
    runtime.storage.saveAuditRound({
      roundId,
      service: first.targetService,
      endpointHash: referenceBuildKey(source),
      epoch: first.epoch,
      state: 'queued',
      attempts: 0,
      nextRetryAt: null,
      targetCount: plans.length,
      generatedProbeCount: 0,
      requestCount: 0,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    }, plans.map((plan) => ({
      roundId,
      auditId: plan.auditId,
      state: 'queued' as const,
      referenceId: null,
      probeCount: null,
      cachedProbeCount: 0,
      generatedProbeCount: 0,
      createdAt: now,
      updatedAt: now,
    })))
  }
}

async function prepareAuditRound(runtime: VerifierDaemonRuntime, round: StoredAuditRound): Promise<void> {
  const members = runtime.storage.listAuditRoundMembers(round.roundId)
  const plans = members.map((member) => runtime.storage.getAuditPlan(member.auditId)).filter((plan): plan is StoredAuditPlan => plan !== null)
  if (plans.length !== members.length || plans.length === 0) throw new Error('round membership is incomplete')
  const source = resolveReferenceSource(runtime.config.verifier, round.service, round.service)
  if (!source) throw new Error('reference generation is unavailable: configure verifier.referenceEndpoint')
  if (referenceBuildKey(source) !== round.endpointHash) throw new Error('round endpoint profile changed; a new round is required')
  runtime.storage.updateAuditRound(round.roundId, 'preparing', { failureReason: null })
  try {
    const references = await loadReferences(
      runtime.referencesDir,
      (message) => console.warn(chalk.yellow(message)),
      { trustedImportedReferenceIds: runtime.config.verifier?.trustedImportedReferenceIds },
    )
    const imported = importAdaptiveReferences({ storage: runtime.storage, service: round.service, source, references })
    if (imported.probes > 0) console.log(chalk.dim(`Imported ${imported.probes} certified probes into ${round.service} catalog`))

    const targets = new Map<string, PeerInfo>()
    for (const plan of plans) targets.set(plan.auditId, await resolveTarget(runtime.node, plan))
    const initialEligible = new Map(plans.map((plan) => {
      const target = targets.get(plan.auditId)!
      return [plan.auditId, eligibleCatalogProbes({
        storage: runtime.storage,
        agentId: String(target.onChainAgentId),
        service: plan.targetService,
        source,
        auditId: plan.auditId,
      })] as const
    }))
    const minimum = source.policy.minimumAuditProbeCount
    const maximumInitialDeficit = maximumAvailabilityDeficit(
      minimum,
      plans.map((plan) => initialEligible.get(plan.auditId)!.length),
    )
    let generatedProbeCount = 0
    let requestCount = 0
    if (maximumInitialDeficit > 0) {
      const generated = await certifyNewProbes({
        storage: runtime.storage,
        service: round.service,
        source,
        requiredCount: maximumInitialDeficit,
        maxRequests: source.policy.maxRequestsPerRound - requestCount,
        referencesDir: runtime.referencesDir,
        log: (message) => console.log(chalk.dim(`[round ${round.roundId.slice(0, 12)}] ${message}`)),
      })
      generatedProbeCount += generated.inserted
      requestCount += generated.requestCount
    }

    const selections = new Map<string, ReturnType<typeof eligibleCatalogProbes>>()
    const cachedCounts = new Map<string, number>()
    for (const plan of plans) {
      const target = targets.get(plan.auditId)!
      const eligible = eligibleCatalogProbes({
        storage: runtime.storage,
        agentId: String(target.onChainAgentId),
        service: plan.targetService,
        source,
        auditId: plan.auditId,
      })
      cachedCounts.set(plan.auditId, Math.min(initialEligible.get(plan.auditId)!.length, minimum))
      const selected = selectCatalogProbes(plan.auditId, eligible, minimum)
      selections.set(plan.auditId, selected)
      runtime.storage.reserveAuditProbes(plan.auditId, selected.map((probe) => probe.probeId))
    }

    const outcomes = new Map<string, FreshSelfTestResult['outcomes'][number]>()
    const testUnion = async (probes: ReturnType<typeof eligibleCatalogProbes>): Promise<void> => {
      const unseen = probes.filter((probe) => !outcomes.has(probe.probeId))
      if (unseen.length === 0) return
      const tested = await freshSelfTestProbes({
        source,
        probes: unseen,
        maxRequests: source.policy.maxRequestsPerRound - requestCount,
        log: (message) => console.log(chalk.dim(`[round ${round.roundId.slice(0, 12)}] ${message}`)),
      })
      requestCount += tested.requestCount
      for (const outcome of tested.outcomes) outcomes.set(outcome.probeId, outcome)
      const malformed = tested.outcomes.filter((outcome) => outcome.match === null).map((outcome) => outcome.probeId)
      if (malformed.length > 0) {
        runtime.storage.markCertifiedKbfProbesUnhealthy(
          round.service,
          certificationProfileHash(source),
          malformed,
          'fresh self-test response was unparseable',
        )
        throw new Error(`${malformed.length} catalog probes failed fresh self-test; round will retry with replacements`)
      }
    }
    await testUnion(deduplicateSelections(selections))

    while (true) {
      const underpowered = plans.filter((plan) => {
        const selected = selections.get(plan.auditId)!
        const hamming = selected.filter((probe) => outcomes.get(probe.probeId)?.match !== 1).length
        const minimumMismatchDelta = selected.length < 100 && source.upstream.trust === 'smoke' ? 0.25 : 0.1
        return computeBinomialPower({ selfHamming: hamming, selfTotal: selected.length, minimumMismatchDelta }).power
          < source.policy.minimumStatisticalPower
      })
      if (underpowered.length === 0) break
      if (underpowered.some((plan) => selections.get(plan.auditId)!.length >= source.policy.maximumAuditProbeCount)) {
        throw new Error(`round remains underpowered at ${source.policy.maximumAuditProbeCount} probes`)
      }
      const requiredCounts = new Map(underpowered.map((plan) => [
        plan.auditId,
        nextAdaptiveProbeCount(
          selections.get(plan.auditId)!.length,
          source.policy.auditProbeStep,
          source.policy.maximumAuditProbeCount,
        ),
      ]))
      let maximumShortage = 0
      for (const plan of underpowered) {
        const target = targets.get(plan.auditId)!
        const eligible = eligibleCatalogProbes({
          storage: runtime.storage,
          agentId: String(target.onChainAgentId),
          service: plan.targetService,
          source,
          auditId: plan.auditId,
        })
        maximumShortage = Math.max(maximumShortage, requiredCounts.get(plan.auditId)! - eligible.length)
      }
      if (maximumShortage > 0) {
        const generated = await certifyNewProbes({
          storage: runtime.storage,
          service: round.service,
          source,
          requiredCount: maximumShortage,
          maxRequests: source.policy.maxRequestsPerRound - requestCount,
          referencesDir: runtime.referencesDir,
          log: (message) => console.log(chalk.dim(`[round ${round.roundId.slice(0, 12)}] ${message}`)),
        })
        generatedProbeCount += generated.inserted
        requestCount += generated.requestCount
      }
      const additions = []
      for (const plan of underpowered) {
        const target = targets.get(plan.auditId)!
        const current = selections.get(plan.auditId)!
        const selectedIds = new Set(current.map((probe) => probe.probeId))
        const eligible = eligibleCatalogProbes({
          storage: runtime.storage,
          agentId: String(target.onChainAgentId),
          service: plan.targetService,
          source,
          auditId: plan.auditId,
        }).filter((probe) => !selectedIds.has(probe.probeId))
        const needed = requiredCounts.get(plan.auditId)! - current.length
        const added = selectCatalogProbes(`${plan.auditId}:${current.length}`, eligible, needed)
        current.push(...added)
        additions.push(...added)
        runtime.storage.reserveAuditProbes(plan.auditId, current.map((probe) => probe.probeId))
      }
      await testUnion(deduplicateProbes(additions))
      if (requestCount > source.policy.maxRequestsPerRound) throw new Error('round reference request budget exhausted')
    }

    let totalReservedBudget = 0n
    for (const plan of plans) {
      const selected = selections.get(plan.auditId)!
      const materialized = await materializeAuditReference({
        auditId: plan.auditId,
        service: plan.targetService,
        source,
        probes: selected,
        selfTestOutcomes: selected.map((probe) => outcomes.get(probe.probeId)!),
        referencesDir: runtime.referencesDir,
      })
      const planned = await planReferenceAudit(runtime.auditContext, {
        auditId: plan.auditId,
        source: plan.source,
        target: targets.get(plan.auditId)!,
        service: plan.targetService,
        reference: materialized.reference,
        executionProfile: materialized.reference.queryProfile,
        flatRelayFeeUsdc: BigInt(runtime.config.verifier?.flatRelayFeeUsdc ?? '1000'),
        jobTimeoutMs: plan.jobTimeoutMs,
        durationMs: plan.durationMs,
      })
      totalReservedBudget += planned.plan.reservedBudgetUsdc ?? 0n
      runtime.storage.updateAuditRoundMember(round.roundId, plan.auditId, 'prepared', {
        referenceId: materialized.reference.referenceId,
        probeCount: selected.length,
        cachedProbeCount: cachedCounts.get(plan.auditId) ?? 0,
        generatedProbeCount: Math.max(0, selected.length - (cachedCounts.get(plan.auditId) ?? 0)),
      })
    }
    const available = await runtime.chain.treasuryClient.availableBalance()
    if (available < totalReservedBudget) {
      throw new Error(`relay treasury underfunded for round: ${available} < ${totalReservedBudget}`)
    }
    runtime.storage.updateAuditRound(round.roundId, 'ready', {
      generatedProbeCount,
      requestCount,
      targetCount: plans.length,
      failureReason: null,
    })
    console.log(chalk.green(`Prepared round ${round.roundId.slice(0, 14)}… for ${plans.length} ${round.service} target(s)`))
  } catch (error) {
    backoffAuditRound(runtime, round, plans, error as Error)
    throw error
  }
}

async function commitAuditRound(runtime: VerifierDaemonRuntime, round: StoredAuditRound): Promise<void> {
  runtime.storage.updateAuditRound(round.roundId, 'committing')
  const members = runtime.storage.listAuditRoundMembers(round.roundId)
  for (const member of members) {
    if (member.state === 'committed') continue
    const plan = runtime.storage.getAuditPlan(member.auditId)
    if (!plan) throw new Error(`round audit ${member.auditId} is unavailable`)
    const committed = await resumeReferenceAuditCommit(runtime.auditContext, plan)
    runtime.storage.updateAuditRoundMember(round.roundId, member.auditId, 'committed')
    console.log(chalk.dim(`Committed round audit ${committed.auditId}`))
  }
  runtime.storage.updateAuditRound(round.roundId, 'committed')
  console.log(chalk.green(`Round ${round.roundId.slice(0, 14)}… committed; dispatch is now enabled`))
}

function backoffAuditRound(
  runtime: VerifierDaemonRuntime,
  round: StoredAuditRound,
  plans: readonly StoredAuditPlan[],
  error: Error,
): void {
  const attempts = round.attempts + 1
  const delays = [60_000, 300_000, 1_800_000]
  const failed = attempts > delays.length
  const now = runtime.auditContext.now?.() ?? Date.now()
  runtime.storage.updateAuditRound(round.roundId, failed ? 'failed' : 'backoff', {
    attempts,
    nextRetryAt: failed ? null : now + delays[attempts - 1]!,
    failureReason: error.message,
  })
  for (const plan of plans) {
    const persisted = runtime.storage.getAuditPlan(plan.auditId)
    if (persisted && !['committed', 'executing', 'awaiting-attestation', 'attesting', 'attested'].includes(persisted.state)) {
      runtime.storage.updateAuditState(plan.auditId, failed ? 'failed' : 'queued', { failureReason: error.message })
      runtime.storage.releaseUnexposedAuditProbeReservations(plan.auditId)
      runtime.storage.updateAuditRoundMember(round.roundId, plan.auditId, failed ? 'failed' : 'queued')
    }
  }
}

function deduplicateSelections(
  selections: ReadonlyMap<string, ReturnType<typeof eligibleCatalogProbes>>,
): ReturnType<typeof eligibleCatalogProbes> {
  return deduplicateProbes([...selections.values()].flat())
}

function deduplicateProbes(
  probes: ReturnType<typeof eligibleCatalogProbes>,
): ReturnType<typeof eligibleCatalogProbes> {
  return [...new Map(probes.map((probe) => [probe.probeId, probe])).values()]
}

async function resolveTarget(node: AntseedNode, plan: StoredAuditPlan): Promise<PeerInfo> {
  const direct = await node.findPeer(plan.targetPeerId)
  if (direct) return direct
  const discovered = await node.discoverPeers(plan.targetService)
  const target = discovered.find((peer) => peer.peerId.toLowerCase() === plan.targetPeerId.toLowerCase())
  if (!target) throw new Error(`target ${plan.targetPeerId} is not currently discoverable`)
  return target
}

async function discoverAutomaticAudits(runtime: VerifierDaemonRuntime): Promise<void> {
  const epoch = await runtime.chain.registryClient.currentEpochWindow()
  const existing = runtime.auditContext.storage.listAuditPlans()
  const keys = new Set(existing
    .filter((plan) => plan.source === 'automatic' && plan.epoch === epoch.epoch.toString())
    .map((plan) => `${plan.epoch}:${plan.agentId}:${plan.targetService.trim().toLowerCase()}`))
  const configuredServices = new Set((runtime.config.verifier?.services ?? []).map((service) => service.trim().toLowerCase()))
  const peers = await runtime.node.discoverPeers()
  for (const group of discoverServices(peers)) {
    if (configuredServices.size > 0 && !configuredServices.has(group.service)) continue
    for (const peer of group.peers) {
      if (!peer.onChainAgentId) continue
      const key = `${epoch.epoch}:${peer.onChainAgentId}:${group.service}`
      if (keys.has(key)) continue
      const plan = createQueuedAuditPlan({
        source: 'automatic',
        epoch: epoch.epoch,
        durationMs: runtime.config.verifier?.auditDurationMs ?? DEFAULT_AUDIT_DURATION_MS,
        targetPeerId: peer.peerId,
        targetService: group.advertisedByPeer.get(peer.peerId) ?? group.advertised,
        agentId: String(peer.onChainAgentId),
        jobTimeoutMs: runtime.config.verifier?.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
        now: runtime.auditContext.now?.() ?? Date.now(),
      })
      runtime.auditContext.storage.saveAuditPlan(plan)
      keys.add(key)
      console.log(chalk.dim(`Queued automatic audit ${plan.auditId} for agent ${peer.onChainAgentId} ${plan.targetService}`))
    }
  }
}

async function autoAttest(runtime: VerifierDaemonRuntime, plan: StoredAuditPlan): Promise<void> {
  const now = runtime.auditContext.now?.() ?? Date.now()
  if (plan.executeBefore === null || Math.floor(now / 1_000) < plan.executeBefore) return
  const chainAudit = await runtime.chain.registryClient.getAudit(plan.auditId)
  if (chainAudit.attested) {
    runtime.auditContext.storage.updateAuditState(plan.auditId, 'attested')
    return
  }
  const references = await loadReferences(
    runtime.referencesDir,
    (message) => console.warn(chalk.yellow(message)),
    { trustedImportedReferenceIds: runtime.config.verifier?.trustedImportedReferenceIds },
  )
  const fullReference = references.find((candidate) => candidate.referenceId === plan.referenceId)
  if (!fullReference) throw new Error(`trusted reference ${plan.referenceId} is unavailable`)
  const reference = loadReservedReferenceSubset(runtime.storage, plan.auditId, fullReference)
  try {
    const result = await attestReferenceAudit({
      registryClient: runtime.chain.registryClient,
      treasuryClient: runtime.chain.treasuryClient,
      storage: runtime.storage,
      signer: runtime.auditContext.signer,
      dataDir: runtime.dataDir,
      refreshUsageAttribution: buildUsageAttributionRefresh(runtime),
    }, { auditId: plan.auditId, reference, fullReference, wait: false })
    console.log(chalk.green(`Attested audit ${plan.auditId}: ${result.verdict}`))
  } catch (error) {
    runtime.auditContext.storage.updateAuditState(plan.auditId, 'awaiting-attestation', {
      failureReason: (error as Error).message,
    })
    throw error
  }
}

function buildUsageAttributionRefresh(runtime: VerifierDaemonRuntime): (() => Promise<boolean>) | undefined {
  const stakingAddress = runtime.chain.chain.stakingContractAddress
  if (!stakingAddress) return undefined
  const channelsClient = new ChannelsClient({
    rpcUrl: runtime.chain.chain.rpcUrl,
    ...(runtime.chain.chain.fallbackRpcUrls ? { fallbackRpcUrls: runtime.chain.chain.fallbackRpcUrls } : {}),
    contractAddress: runtime.chain.chain.channelsContractAddress,
    evmChainId: runtime.chain.chain.evmChainId,
  })
  const stakingClient = new StakingClient({
    rpcUrl: runtime.chain.chain.rpcUrl,
    ...(runtime.chain.chain.fallbackRpcUrls ? { fallbackRpcUrls: runtime.chain.chain.fallbackRpcUrls } : {}),
    contractAddress: stakingAddress,
    usdcAddress: runtime.chain.chain.usdcContractAddress,
    evmChainId: runtime.chain.chain.evmChainId,
  })
  return async () => {
    await indexFinalizedChannelSettlements({
      chainId: String(runtime.chain.chain.evmChainId),
      channelsClient,
      stakingClient,
      storage: runtime.storage,
      startBlock: runtime.chain.chain.channelsDeployBlock ?? 0,
      confirmationBlocks: runtime.chain.chain.chainId === 'base-local' ? 0 : 20,
      warn: (message) => console.warn(chalk.yellow(message)),
    })
    return true
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
