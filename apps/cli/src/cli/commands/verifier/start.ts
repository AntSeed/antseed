import chalk from 'chalk'
import { InvalidArgumentError, type Command } from 'commander'
import {
  peerIdToAddress,
  serviceHash,
  type PeerInfo,
} from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import { SellerBackoff } from '../../../verifier/backoff.js'
import {
  buildBenchmarkReport,
  runBenchmarkObservation,
  type BenchmarkReportV1,
  type BenchmarkRunOptions,
  type BenchmarkExecutionTransport,
} from '../../../verifier/benchmark.js'
import {
  connectBenchmarkExecutionTransport,
  parseBenchmarkTransportMode,
  type BenchmarkTransportMode,
} from '../../../verifier/benchmark-transport.js'
import {
  claimRewardEpochs,
  verifierRewardSource,
  verifierRewardWindow,
} from '../../../verifier/epoch-rewards.js'
import {
  advertisedServices,
  discoverServices,
} from '../../../verifier/service-discovery.js'
import {
  executeVerifierAudit,
  startVerifierRuntime,
  type VerifierRuntime,
} from '../../../verifier/runtime.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { formatAnts } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'
import { renderBenchmarkReport } from './benchmark.js'
import {
  parseBenchmarkProbeCountFlag,
  parsePositiveIntFlag,
  parseUsdcBaseUnitsFlag,
} from './flags.js'

export type VerifierStartMode = 'attest' | 'observe'

export interface VerifierStartCommandOptions {
  mode: VerifierStartMode
  rpcUrl?: string
  intervalMs?: number
  service?: string[]
  once?: boolean
  probes: number | 'auto'
  maxTotalUsdc?: bigint
  targetConcurrency: number
  probeConcurrency: number
  transport?: BenchmarkTransportMode
  proxyUrl?: string
  proxyTokenFile?: string
}

export interface ObserveVerifierExecutionDependencies {
  runBenchmark?: typeof runBenchmarkObservation
  buildReport?: typeof buildBenchmarkReport
  log?: (message: string) => void
  warn?: (message: string) => void
  executionTransport?: BenchmarkExecutionTransport
}

export interface VerifierDaemonState {
  runningRound: boolean
  stopping: boolean
  rewardScanFloor?: bigint
}

export interface VerifierRoundResult {
  skippedOverlap: boolean
  discoveredPeers: number
  eligibleTargets: number
  attemptedAudits: number
  attestedAudits: number
  creditedAudits: number
  failedAudits: number
  limitReached: boolean
}

export interface VerifierRoundOverrides {
  discoverPeers?: () => Promise<PeerInfo[]>
  executeAudit?: typeof executeVerifierAudit
  now?: () => number
  log?: (message: string) => void
  warn?: (message: string) => void
  backoff?: SellerBackoff
}

export function registerVerifierStartCommand(verifierCmd: Command): void {
  verifierCmd
    .command('start')
    .description('Start the paid local-verifier daemon')
    .option('--mode <mode>', 'attest or observe', parseVerifierStartMode, 'attest')
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .option('--interval-ms <ms>', 'seller/service discovery cadence', parsePositiveIntFlag)
    .option('--service <id...>', 'only audit these advertised services')
    .option('--once', 'run one discovery/audit round and exit')
    .option('--probes <n>', 'shared KBF probe count or auto in observe mode', parseBenchmarkProbeCountFlag, 'auto')
    .option(
      '--max-total-usdc <amount>',
      'hard total seller-payment cap for observe mode in USDC base units',
      parseUsdcBaseUnitsFlag,
    )
    .option('--target-concurrency <n>', 'participants observed concurrently', parsePositiveIntFlag, 2)
    .option('--probe-concurrency <n>', 'requests per participant in observe mode', parsePositiveIntFlag, 2)
    .option('--transport <mode>', 'observe paid request transport: direct or proxy', parseBenchmarkTransportMode, 'direct')
    .option('--proxy-url <url>', 'local buyer proxy URL', 'http://127.0.0.1:8377')
    .option('--proxy-token-file <path>', 'buyer proxy audit token file')
    .action(async (options: VerifierStartCommandOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      if (options.mode === 'observe') {
        const benchmarkOptions = resolveObserveBenchmarkOptions(options)
        const executionTransport = await connectBenchmarkExecutionTransport({
          options,
          responseAuthTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
        })
        const runtime = await startVerifierRuntime({
          config,
          dataDir: globalOptions.dataDir,
          configPath: globalOptions.config,
          ...(options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}),
          readiness: executionTransport ? 'discover' : 'observe',
        })
        setupShutdownHandler(async () => runtime.node.stop())
        const paymentAddress = executionTransport?.verifierAddress ?? runtime.identity.wallet.address
        const paymentPeerId = executionTransport?.verifierPeerId ?? runtime.identity.peerId
        console.log(chalk.green(`Verifier observe-only run started as ${paymentAddress}`))
        console.log(chalk.dim(`  buyer peer: ${paymentPeerId}`))
        console.log(chalk.dim(`  paid request transport: ${executionTransport ? 'local buyer proxy' : 'direct buyer node'}`))
        console.log(chalk.dim(`  service: ${benchmarkOptions.service}`))
        console.log(chalk.dim(`  probes: ${benchmarkOptions.probeCount}`))
        console.log(chalk.dim(`  maximum spend: ${benchmarkOptions.maxTotalUsdc} USDC base units`))
        console.log(chalk.dim('  verifier attestations: disabled'))
        try {
          const { run, report } = await executeObserveVerifierOnce(runtime, benchmarkOptions, {
            ...(executionTransport ? { executionTransport } : {}),
          })
          console.log(renderBenchmarkReport(report, 'table'))
          console.log(chalk.green(`Completed observe-only benchmark ${run.runId}`))
          console.log(chalk.dim(`  JSON: antseed verifier benchmark report --run ${run.runId} --format json`))
          console.log(chalk.dim(`  CSV: antseed verifier benchmark report --run ${run.runId} --format csv`))
        } finally {
          await runtime.node.stop()
        }
        return
      }
      const runtime = await startVerifierRuntime({
        config,
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        ...(options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}),
        readiness: 'attest',
      })
      const state: VerifierDaemonState = { runningRound: false, stopping: false }
      const backoff = new SellerBackoff()
      const configuredServices = normalizeServiceFilters(
        Array.isArray(options.service) && options.service.length > 0
          ? options.service.map(String)
          : config.verifier?.services ?? [],
      )
      const intervalMs = options.intervalMs === undefined
        ? config.verifier?.auditIntervalMs ?? 300_000
        : Number(options.intervalMs)
      setupShutdownHandler(async () => {
        state.stopping = true
        await runtime.node.stop()
      })
      console.log(chalk.green(`Verifier daemon started as ${runtime.identity.wallet.address}`))
      console.log(chalk.dim(`  buyer peer: ${runtime.identity.peerId}`))
      console.log(chalk.dim(`  discovery interval: ${intervalMs}ms`))
      console.log(chalk.dim(`  evidence: ${runtime.evidenceDir}`))
      if (configuredServices.size > 0) {
        console.log(chalk.dim(`  services: ${[...configuredServices].join(', ')}`))
      }

      try {
        for (;;) {
          const result = await runVerifierRound(runtime, state, configuredServices, { backoff })
          if (options.once || state.stopping) break
          console.log(chalk.dim(
            `[verifier] round complete: ${result.attestedAudits} attested, ${result.creditedAudits} credited, `
            + `${result.failedAudits} failed`,
          ))
          await sleepWhileRunning(intervalMs, state)
          if (state.stopping) break
        }
      } finally {
        await runtime.node.stop()
      }
    })
}

export function parseVerifierStartMode(value: string): VerifierStartMode {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'attest' || normalized === 'observe') return normalized
  throw new InvalidArgumentError('mode must be attest or observe')
}

export function resolveObserveBenchmarkOptions(
  options: VerifierStartCommandOptions,
): BenchmarkRunOptions {
  if (!options.once) {
    throw new Error('--mode observe requires --once to prevent repeated paid observations')
  }
  const services = (options.service ?? []).map((service) => service.trim()).filter(Boolean)
  if (services.length !== 1) {
    throw new Error('--mode observe requires exactly one --service')
  }
  if (options.maxTotalUsdc === undefined) {
    throw new Error('--mode observe requires --max-total-usdc')
  }
  if (options.maxTotalUsdc <= 0n) {
    throw new Error('--max-total-usdc must be greater than zero in observe mode')
  }
  return {
    service: services[0]!,
    probeCount: options.probes,
    maxTotalUsdc: options.maxTotalUsdc,
    targetConcurrency: options.targetConcurrency,
    probeConcurrency: options.probeConcurrency,
    epochSource: 'none',
  }
}

export async function executeObserveVerifierOnce(
  runtime: VerifierRuntime,
  options: BenchmarkRunOptions,
  dependencies: ObserveVerifierExecutionDependencies = {},
): Promise<{ run: Awaited<ReturnType<typeof runBenchmarkObservation>>; report: BenchmarkReportV1 }> {
  const run = await (dependencies.runBenchmark ?? runBenchmarkObservation)(runtime, options, {
    log: dependencies.log ?? ((message) => console.log(chalk.dim(`[observe] ${message}`))),
    warn: dependencies.warn ?? ((message) => console.warn(chalk.yellow(`[observe] ${message}`))),
    ...(dependencies.executionTransport ? { executionTransport: dependencies.executionTransport } : {}),
  })
  const report = await (dependencies.buildReport ?? buildBenchmarkReport)(runtime.storage, run.runId)
  return { run, report }
}

export async function runVerifierRound(
  runtime: VerifierRuntime,
  state: VerifierDaemonState,
  serviceFilters: ReadonlySet<string> = new Set(),
  overrides: VerifierRoundOverrides = {},
): Promise<VerifierRoundResult> {
  if (state.runningRound) return emptyRoundResult(true)
  state.runningRound = true
  const log = overrides.log ?? ((message: string) => console.log(chalk.dim(`[verifier] ${message}`)))
  const warn = overrides.warn ?? ((message: string) => console.warn(chalk.yellow(`[verifier] ${message}`)))
  const now = overrides.now ?? Date.now
  const backoff = overrides.backoff ?? new SellerBackoff()
  const result = emptyRoundResult(false)
  try {
    await claimFinalizedRewards(runtime, state, log, warn)
    if (state.stopping) return result

    const [epochWindow, cooldownSeconds, onChainLimit, minimumProbeCount] = await Promise.all([
      runtime.chain.registryClient.currentEpochWindow(),
      runtime.chain.registryClient.auditCooldown(),
      runtime.chain.registryClient.maxCreditsPerVerifierPerEpoch(),
      runtime.chain.registryClient.minProbeCount(),
    ])
    const address = runtime.identity.wallet.address
    let credits = await runtime.chain.registryClient.epochCredits(epochWindow.epoch, address)
    const configuredLimit = runtime.config.verifier?.maxAuditsPerEpoch ?? 50
    let localRemaining = Math.max(
      0,
      configuredLimit - runtime.storage.countDirectAuditsForEpoch(epochWindow.epoch.toString(), address),
    )
    let creditRemaining = Math.max(0, onChainLimit - safeNumber(credits))
    if (localRemaining === 0 || creditRemaining === 0) {
      result.limitReached = true
      return result
    }

    const peers = await (overrides.discoverPeers ?? (() => runtime.node.discoverPeers()))()
    result.discoveredPeers = peers.length
    const seenTargets = new Set<string>()
    const candidates: Array<{ peer: PeerInfo; service: string; key: string; lastCreditedAt: number }> = []
    for (const group of discoverServices(peers)) {
      if (serviceFilters.size > 0 && !serviceFilters.has(group.service)) continue
      for (const peer of group.peers) {
        if (!peer.onChainAgentId) continue
        if (peerIdToAddress(peer.peerId).toLowerCase() === address.toLowerCase()) continue
        const advertisedService = group.advertisedByPeer.get(peer.peerId) ?? group.advertised
        const key = `${peer.onChainAgentId}:${group.service}`
        if (seenTargets.has(key) || backoff.isBlocked(key, now())) continue
        const latest = runtime.storage.latestDirectAudit(String(peer.onChainAgentId), serviceHash(advertisedService))
        if (latest?.state === 'pending' || latest?.state === 'running') continue
        const lastCreditedAt = await runtime.chain.registryClient.lastCreditedAt(
          peer.onChainAgentId,
          serviceHash(advertisedService),
        )
        if (lastCreditedAt > 0 && Math.floor(now() / 1_000) - lastCreditedAt < cooldownSeconds) continue
        seenTargets.add(key)
        candidates.push({ peer, service: advertisedService, key, lastCreditedAt })
      }
    }
    candidates.sort((left, right) => left.lastCreditedAt - right.lastCreditedAt || left.key.localeCompare(right.key))
    result.eligibleTargets = candidates.length

    for (const candidate of candidates) {
      if (state.stopping || localRemaining === 0 || creditRemaining === 0) break
      result.attemptedAudits += 1
      localRemaining -= 1
      try {
        const audit = await (overrides.executeAudit ?? executeVerifierAudit)({
          runtime,
          target: candidate.peer,
          service: candidate.service,
          source: 'automatic',
          epoch: epochWindow.epoch,
          minimumProbeCount,
          log,
          warn,
        })
        result.attestedAudits += 1
        if (audit.credited) {
          result.creditedAudits += 1
          credits += 1n
          creditRemaining = Math.max(0, onChainLimit - safeNumber(credits))
          backoff.recordSuccess(candidate.key)
        } else {
          backoff.recordFailure(candidate.key, now())
        }
        log(
          `${candidate.service} on ${candidate.peer.peerId.slice(0, 12)}…: `
          + `${verdictName(audit.verdict)}, ${audit.authenticatedProbeCount}/${audit.probeCount} authenticated, `
          + `${audit.credited ? 'credited' : 'not credited'}`,
        )
      } catch (error) {
        result.failedAudits += 1
        backoff.recordFailure(candidate.key, now())
        warn(`${candidate.service} on ${candidate.peer.peerId.slice(0, 12)}… failed: ${asError(error).message}`)
      }
    }
    result.limitReached = localRemaining === 0 || creditRemaining === 0
    return result
  } finally {
    state.runningRound = false
  }
}

async function claimFinalizedRewards(
  runtime: VerifierRuntime,
  state: VerifierDaemonState,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<void> {
  try {
    const window = await verifierRewardWindow(runtime.chain.registryClient, runtime.chain.rewardsClient)
    const result = await claimRewardEpochs(
      window,
      verifierRewardSource(
        runtime.chain.registryClient,
        runtime.chain.rewardsClient,
        runtime.identity.wallet.address,
        runtime.identity.wallet,
      ),
      {
        ...(state.rewardScanFloor !== undefined ? { fromEpoch: state.rewardScanFloor } : {}),
        onClaim: (epoch, amount, tx) => log(
          `claimed epoch ${epoch} verifier reward: ${formatAnts(amount)} ANTS (tx ${tx.slice(0, 10)}…)`,
        ),
        onEpochError: (epoch, error) => warn(`epoch ${epoch} reward claim failed: ${error.message}`),
      },
    )
    state.rewardScanFloor = result.settledThrough
  } catch (error) {
    warn(`automatic reward claim pass failed: ${asError(error).message}`)
  }
}

function normalizeServiceFilters(services: readonly string[]): Set<string> {
  return new Set(services.map((service) => service.trim().toLowerCase()).filter(Boolean))
}

function emptyRoundResult(skippedOverlap: boolean): VerifierRoundResult {
  return {
    skippedOverlap,
    discoveredPeers: 0,
    eligibleTargets: 0,
    attemptedAudits: 0,
    attestedAudits: 0,
    creditedAudits: 0,
    failedAudits: 0,
    limitReached: false,
  }
}

async function sleepWhileRunning(milliseconds: number, state: VerifierDaemonState): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!state.stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())))
  }
}

function verdictName(verdict: number): string {
  if (verdict === 1) return 'SAME'
  if (verdict === 2) return 'DIFF'
  return 'UNDETERMINED'
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export { advertisedServices }
