import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { join } from 'node:path'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { AntseedNode, resolveChainConfig } from '@antseed/node'
import type { NodePaymentsConfig, PeerInfo } from '@antseed/node'
import { OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../../shutdown.js'
import {
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  resolveBaseRpcUrlOverride,
} from '../../payment-utils.js'
import { loadReferences, findReferenceForService } from '../../../verifier/references.js'
import { selectCohort, runCohortAudit } from '../../../verifier/audit-runner.js'
import type { ProbeSourceKind } from '../../../verifier/audit-runner.js'
import { discoverServices } from '../../../verifier/service-discovery.js'
import { buildKbfReference, resolveUpstream } from '../../../verifier/reference-builder.js'
import type { VerifierCLIConfig } from '../../../config/types.js'
import { mkdir, writeFile } from 'node:fs/promises'

const DEFAULT_MAX_AUDITS_PER_EPOCH = 50
const DEFAULT_PROBES_PER_AUDIT = 24
const DEFAULT_MAX_PROBES_PER_REQUEST = 3
const DEFAULT_COHORT_MIN_SIZE = 3
const DEFAULT_COHORT_MAX_SIZE = 10
const DEFAULT_AUDIT_INTERVAL_MS = 300_000
const DEFAULT_PROBE_SOURCE = 'compositional' as const
const DEFAULT_PROBE_ROTATION_HISTORY = 2000
/**
 * KBF references drift as upstream backends update — the published KBF study
 * (arXiv:2605.29524) measured probe staleness at ~7–9 weeks. Warn (once per
 * service) when a reference is older than 7 weeks so operators rebuild it.
 */
const REFERENCE_STALE_MS = 49 * 24 * 60 * 60 * 1000

interface ResolvedVerifierOptions {
  services: string[]
  maxAuditsPerEpoch: number
  probesPerAudit: number
  maxProbesPerRequest: number
  cohortMinSize: number
  cohortMaxSize: number
  auditIntervalMs: number
  stalenessWindowSecs: number | undefined
  probeSource: ProbeSourceKind
  probeRotationHistory: number
  referencesDir: string
  evidenceDir: string
  probeLogDir: string
}

function resolveVerifierOptions(
  verifierConfig: VerifierCLIConfig | undefined,
  flags: { service?: string[]; interval?: number },
  dataDir: string,
): ResolvedVerifierOptions {
  // Empty services = auto-discover mode: the verifier is a buyer node, so the
  // full peer + service catalog is available locally after one wildcard
  // discovery — audit everything the network claims to serve.
  const services = (flags.service && flags.service.length > 0 ? flags.service : verifierConfig?.services ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  return {
    services,
    maxAuditsPerEpoch: verifierConfig?.maxAuditsPerEpoch ?? DEFAULT_MAX_AUDITS_PER_EPOCH,
    probesPerAudit: verifierConfig?.probesPerAudit ?? DEFAULT_PROBES_PER_AUDIT,
    maxProbesPerRequest: verifierConfig?.maxProbesPerRequest ?? DEFAULT_MAX_PROBES_PER_REQUEST,
    cohortMinSize: verifierConfig?.cohortMinSize ?? DEFAULT_COHORT_MIN_SIZE,
    cohortMaxSize: verifierConfig?.cohortMaxSize ?? DEFAULT_COHORT_MAX_SIZE,
    auditIntervalMs: flags.interval ?? verifierConfig?.auditIntervalMs ?? DEFAULT_AUDIT_INTERVAL_MS,
    stalenessWindowSecs: verifierConfig?.stalenessWindowSecs,
    probeSource: verifierConfig?.probeSource ?? DEFAULT_PROBE_SOURCE,
    probeRotationHistory: verifierConfig?.probeRotationHistory ?? DEFAULT_PROBE_ROTATION_HISTORY,
    referencesDir: verifierConfig?.referencesDir ?? join(dataDir, 'fingerprints', 'references'),
    evidenceDir: verifierConfig?.evidenceDir ?? join(dataDir, 'fingerprints', 'evidence'),
    probeLogDir: verifierConfig?.probeLogDir ?? join(dataDir, 'fingerprints', 'probe-log'),
  }
}

export function registerVerifierStartCommand(verifierCmd: Command): void {
  verifierCmd
    .command('start')
    .description('Start the verifier daemon: audit sellers for the configured services and attest results on-chain')
    .option('--service <id...>', 'service/model IDs to verify (overrides config verifier.services)')
    .option('--interval <ms>', 'pause between audit rounds in ms', (v) => parseInt(v, 10))
    .option('--once', 'run a single audit round and exit')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options) => {
      const globalOpts = getGlobalOptions(verifierCmd)
      const config = await loadConfig(globalOpts.config)

      const verifierOptions = resolveVerifierOptions(
        config.verifier,
        { service: options.service as string[] | undefined, interval: options.interval as number | undefined },
        globalOpts.dataDir,
      )

      const rpcOverrides = {
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl as string } : {}),
      }

      let registryClient
      let rewardsClient
      try {
        registryClient = createVerifierRegistryClient(config, rpcOverrides)
        rewardsClient = createVerifierRewardsClient(config, rpcOverrides)
      } catch (err) {
        console.error(chalk.red((err as Error).message))
        process.exit(1)
      }

      const cryptoOverrides = config.payments?.crypto
      const rpcUrlOverride = (options.rpcUrl as string | undefined) ?? resolveBaseRpcUrlOverride()
      const chainConfig = resolveChainConfig({
        ...(cryptoOverrides ?? {}),
        ...(rpcUrlOverride ? { rpcUrl: rpcUrlOverride } : {}),
      })

      // Probe traffic must be paid, organic-looking buyer traffic — payments
      // are mandatory for a verifier, unlike an ordinary buyer.
      const paymentsConfig: NodePaymentsConfig = {
        enabled: true,
        rpcUrl: chainConfig.rpcUrl,
        ...(chainConfig.fallbackRpcUrls ? { fallbackRpcUrls: chainConfig.fallbackRpcUrls } : {}),
        depositsAddress: chainConfig.depositsContractAddress,
        channelsAddress: chainConfig.channelsContractAddress,
        ...(chainConfig.freeUsageContractAddress ? { freeUsageAddress: chainConfig.freeUsageContractAddress } : {}),
        usdcAddress: chainConfig.usdcContractAddress,
        ...(chainConfig.stakingContractAddress ? { stakingAddress: chainConfig.stakingContractAddress } : {}),
        ...(chainConfig.identityRegistryAddress ? { identityRegistryAddress: chainConfig.identityRegistryAddress } : {}),
        chainId: chainConfig.evmChainId,
        platformFeeRate: config.payments?.platformFeeRate,
        maxPerRequestUsdc: config.payments?.maxPerRequestUsdc ?? '300000',
        maxReserveAmountUsdc: config.payments?.maxReserveAmountUsdc ?? '1000000',
      }

      const bootstrapEntries = Array.isArray(config.network?.bootstrapNodes) && config.network.bootstrapNodes.length > 0
        ? config.network.bootstrapNodes
        : OFFICIAL_BOOTSTRAP_NODES.map((node) => `${node.host}:${node.port}`)
      const bootstrapNodes = toBootstrapConfig(parseBootstrapList(bootstrapEntries))

      const nodeSpinner = ora('Connecting to P2P network...').start()
      const node = new AntseedNode({
        role: 'buyer',
        bootstrapNodes,
        allowPrivateIPs: true,
        dataDir: globalOpts.dataDir,
        configPath: globalOpts.config,
        payments: paymentsConfig,
        // Keep full request/response evidence for every verified exchange —
        // audit probes are the whole point of this daemon.
        verification: { sampleRate: 1 },
      })

      try {
        await node.start()
        nodeSpinner.succeed(chalk.green('Connected to P2P network'))
      } catch (err) {
        nodeSpinner.fail(chalk.red(`Failed to connect: ${(err as Error).message}`))
        process.exit(1)
      }

      const identity = node.identity!
      const address = identity.wallet.address
      console.log(chalk.dim(`Verifier wallet: ${address}`))

      let approved = false
      try {
        approved = await registryClient.isApprovedVerifier(address)
      } catch (err) {
        nodeSpinner.fail(chalk.red(`Cannot reach verifier registry: ${(err as Error).message}`))
        await node.stop()
        process.exit(1)
      }
      if (!approved) {
        console.error(chalk.red(`Wallet ${address} is not an approved verifier. Ask the registry owner to approve it.`))
        await node.stop()
        process.exit(1)
      }
      console.log(chalk.green('Verifier approval: OK'))

      const policy = await registryClient.getAuditPolicy()
      const stalenessWindowSecs = verifierOptions.stalenessWindowSecs ?? policy.auditCooldown
      console.log(chalk.bold('Verifier settings:'))
      console.log(chalk.dim(`  services: ${verifierOptions.services.length > 0 ? verifierOptions.services.join(', ') : 'auto-discover (all advertised on the network)'}`))
      console.log(chalk.dim(`  probes per audit: ${verifierOptions.probesPerAudit} (${verifierOptions.maxProbesPerRequest}/request, stealth)`))
      console.log(chalk.dim(`  probe source: ${verifierOptions.probeSource} (rotation history: ${verifierOptions.probeRotationHistory})`))
      console.log(chalk.dim(`  cohort size: ${verifierOptions.cohortMinSize}-${verifierOptions.cohortMaxSize}`))
      console.log(chalk.dim(`  audits per epoch: ${verifierOptions.maxAuditsPerEpoch} (on-chain cap: ${policy.maxCreditsPerVerifierPerEpoch})`))
      console.log(chalk.dim(`  staleness window: ${stalenessWindowSecs}s`))
      console.log(chalk.dim(`  audit interval: ${verifierOptions.auditIntervalMs}ms`))
      console.log('')

      const references = await loadReferences(verifierOptions.referencesDir, (m) => console.warn(chalk.yellow(m)))
      if (references.length > 0) {
        console.log(chalk.dim(`Loaded ${references.length} KBF reference(s) from ${verifierOptions.referencesDir}`))
      }

      const upstream = resolveUpstream(config.verifier?.upstream)
      if (upstream) {
        console.log(chalk.dim(`Reference enrollment upstream: ${upstream.baseUrl} (services without a reference are enrolled automatically)`))
      }
      const enrollAttempted = new Set<string>()
      const staleWarned = new Set<string>()

      let stopped = false
      setupShutdownHandler(async () => {
        stopped = true
        nodeSpinner.start('Shutting down...')
        await node.stop()
        nodeSpinner.succeed('Disconnected.')
      })

      const log = (m: string) => console.log(chalk.dim(`[verifier] ${m}`))
      const warn = (m: string) => console.warn(chalk.yellow(`[verifier] ${m}`))

      const claimFinalizedRewards = async (): Promise<void> => {
        try {
          const { currentEpoch, effectiveEpoch } = await rewardsClient.getEpochWindow()
          const firstEpoch = Math.max(effectiveEpoch, currentEpoch - 8)
          for (let epoch = firstEpoch; epoch < currentEpoch; epoch += 1) {
            const [credits, claimed] = await Promise.all([
              registryClient.epochCredits(epoch, address),
              rewardsClient.epochRewardClaimed(epoch, address),
            ])
            if (credits === 0 || claimed) continue
            const pending = await rewardsClient.pendingVerifierReward(epoch, address)
            if (pending === 0n) continue
            const tx = await rewardsClient.claimVerifierReward(identity.wallet, epoch)
            console.log(chalk.green(`Claimed ${formatAnts(pending)} ANTS for epoch ${epoch} (tx ${tx.slice(0, 10)}…)`))
          }
        } catch (err) {
          warn(`reward claim pass failed: ${(err as Error).message}`)
        }
      }

      const runRound = async (): Promise<void> => {
        await claimFinalizedRewards()

        const epoch = await registryClient.currentEpoch()
        const creditsUsed = await registryClient.epochCredits(epoch, address)
        const epochBudget = Math.min(verifierOptions.maxAuditsPerEpoch, policy.maxCreditsPerVerifierPerEpoch)
        let remaining = epochBudget - creditsUsed
        if (remaining <= 0) {
          log(`Epoch ${epoch} audit budget exhausted (${creditsUsed}/${epochBudget}); waiting for next epoch`)
          return
        }
        log(`Epoch ${epoch}: ${creditsUsed}/${epochBudget} credits used`)

        // One wildcard discovery per round: the verifier is itself a buyer
        // node, so the whole peer + service catalog lands locally in a single
        // sweep instead of one DHT walk per service.
        let peers: PeerInfo[]
        try {
          peers = await node.discoverPeers()
        } catch (err) {
          warn(`peer discovery failed: ${(err as Error).message}`)
          return
        }
        const discovered = discoverServices(peers)
        const configured = verifierOptions.services
        const targets = configured.length > 0
          ? discovered.filter((d) => configured.includes(d.service))
          : discovered
        if (configured.length > 0) {
          for (const service of configured) {
            if (!targets.some((t) => t.service === service)) {
              log(`${service}: no peers advertising it this round`)
            }
          }
        } else {
          log(`Discovered ${discovered.length} advertised service(s) across ${peers.length} peer(s)`)
        }

        for (const { service, peers: servicePeers } of targets) {
          if (stopped) return
          if (remaining <= 0) {
            log(`Epoch ${epoch} audit budget exhausted mid-round; deferring remaining services`)
            return
          }

          let reference = findReferenceForService(references, service)
          const cohort = await selectCohort(servicePeers, service, registryClient, {
            cohortMaxSize: Math.min(verifierOptions.cohortMaxSize, remaining),
            stalenessWindowSecs,
            warn,
          })
          if (cohort.length === 0) {
            log(`${service}: no eligible sellers (need on-chain agent id + response-auth); skipping`)
            continue
          }

          // No reference yet but an upstream is configured: enroll one now
          // (once per service per daemon run). A certified reference both
          // anchors cohort consensus and unlocks auditing lone sellers.
          if (!reference?.selfTest && upstream && !enrollAttempted.has(service)) {
            enrollAttempted.add(service)
            const upstreamModel = config.verifier?.upstream?.modelMap?.[service] ?? service
            log(`${service}: no reference — enrolling via ${upstream.baseUrl} as "${upstreamModel}"`)
            try {
              const built = await buildKbfReference(upstream, { model: upstreamModel, service, log })
              await mkdir(verifierOptions.referencesDir, { recursive: true })
              const outPath = join(verifierOptions.referencesDir, `${service.replace(/[^a-z0-9._-]/gi, '_')}.json`)
              await writeFile(outPath, JSON.stringify(built, null, 2))
              references.push(built)
              reference = built
              log(`${service}: reference enrolled (${built.probes.length} probes, self-error ${(built.selfTest.errorRate * 100).toFixed(1)}%) → ${outPath}`)
            } catch (err) {
              warn(`${service}: reference enrollment failed: ${(err as Error).message}`)
            }
          }

          if (reference?.selfTest && !staleWarned.has(service)) {
            const age = Date.now() - Date.parse(reference.createdAt)
            if (Number.isFinite(age) && age > REFERENCE_STALE_MS) {
              staleWarned.add(service)
              warn(`${service}: reference is ${Math.round(age / 86_400_000)} days old — backends drift in ~7-9 weeks; rebuild with \`antseed verifier reference build\``)
            }
          }

          // Cohort consensus needs cohortMinSize sellers, but a certified
          // reference is ground truth on its own — with one, audit even a
          // single seller.
          const minSize = reference?.selfTest ? 1 : verifierOptions.cohortMinSize
          if (cohort.length < minSize) {
            log(
              `${service}: only ${cohort.length} eligible seller(s) (< ${minSize}` +
                `${reference?.selfTest ? '' : ', no reference'}); skipping round`,
            )
            continue
          }

          try {
            const result = await runCohortAudit(
              node,
              identity,
              registryClient,
              service,
              cohort,
              reference,
              {
                probesPerAudit: verifierOptions.probesPerAudit,
                cohortMinSize: verifierOptions.cohortMinSize,
                cohortMaxSize: verifierOptions.cohortMaxSize,
                stalenessWindowSecs,
                maxProbesPerRequest: verifierOptions.maxProbesPerRequest,
                evidenceDir: verifierOptions.evidenceDir,
                probeSource: verifierOptions.probeSource,
                probeLogDir: verifierOptions.probeLogDir,
                probeRotationHistory: verifierOptions.probeRotationHistory,
                log,
                warn,
              },
            )
            const attested = result.outcomes.filter((o) => o.attested).length
            const diffs = result.outcomes.filter((o) => o.verdict === 'DIFF').length
            remaining -= attested
            console.log(chalk.bold(`${service}: audited ${result.cohortSize} sellers — ${attested} attested, ${diffs} DIFF`))
          } catch (err) {
            warn(`audit round failed for ${service}: ${(err as Error).message}`)
          }
        }
      }

      if (options.once) {
        await runRound()
        await node.stop()
        return
      }

      console.log(chalk.bold('Verifier daemon running. Press Ctrl+C to stop.'))
      for (;;) {
        if (stopped) return
        await runRound()
        if (stopped) return
        await new Promise((resolve) => setTimeout(resolve, verifierOptions.auditIntervalMs))
      }
    })
}
