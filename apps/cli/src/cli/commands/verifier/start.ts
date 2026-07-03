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
import type { VerifierCLIConfig } from '../../../config/types.js'

const DEFAULT_MAX_AUDITS_PER_EPOCH = 50
const DEFAULT_PROBES_PER_AUDIT = 24
const DEFAULT_MAX_PROBES_PER_REQUEST = 3
const DEFAULT_COHORT_MIN_SIZE = 3
const DEFAULT_COHORT_MAX_SIZE = 10
const DEFAULT_AUDIT_INTERVAL_MS = 300_000

interface ResolvedVerifierOptions {
  services: string[]
  maxAuditsPerEpoch: number
  probesPerAudit: number
  maxProbesPerRequest: number
  cohortMinSize: number
  cohortMaxSize: number
  auditIntervalMs: number
  stalenessWindowSecs: number | undefined
  referencesDir: string
  evidenceDir: string
}

function resolveVerifierOptions(
  verifierConfig: VerifierCLIConfig | undefined,
  flags: { service?: string[]; interval?: number },
  dataDir: string,
): ResolvedVerifierOptions | null {
  const services = (flags.service && flags.service.length > 0 ? flags.service : verifierConfig?.services ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (services.length === 0) return null
  return {
    services,
    maxAuditsPerEpoch: verifierConfig?.maxAuditsPerEpoch ?? DEFAULT_MAX_AUDITS_PER_EPOCH,
    probesPerAudit: verifierConfig?.probesPerAudit ?? DEFAULT_PROBES_PER_AUDIT,
    maxProbesPerRequest: verifierConfig?.maxProbesPerRequest ?? DEFAULT_MAX_PROBES_PER_REQUEST,
    cohortMinSize: verifierConfig?.cohortMinSize ?? DEFAULT_COHORT_MIN_SIZE,
    cohortMaxSize: verifierConfig?.cohortMaxSize ?? DEFAULT_COHORT_MAX_SIZE,
    auditIntervalMs: flags.interval ?? verifierConfig?.auditIntervalMs ?? DEFAULT_AUDIT_INTERVAL_MS,
    stalenessWindowSecs: verifierConfig?.stalenessWindowSecs,
    referencesDir: verifierConfig?.referencesDir ?? join(dataDir, 'fingerprints', 'references'),
    evidenceDir: verifierConfig?.evidenceDir ?? join(dataDir, 'fingerprints', 'evidence'),
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
      if (!verifierOptions) {
        console.error(chalk.red('No services to verify. Set verifier.services in your config or pass --service.'))
        process.exit(1)
      }

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
      console.log(chalk.dim(`  services: ${verifierOptions.services.join(', ')}`))
      console.log(chalk.dim(`  probes per audit: ${verifierOptions.probesPerAudit} (${verifierOptions.maxProbesPerRequest}/request, stealth)`))
      console.log(chalk.dim(`  cohort size: ${verifierOptions.cohortMinSize}-${verifierOptions.cohortMaxSize}`))
      console.log(chalk.dim(`  audits per epoch: ${verifierOptions.maxAuditsPerEpoch} (on-chain cap: ${policy.maxCreditsPerVerifierPerEpoch})`))
      console.log(chalk.dim(`  staleness window: ${stalenessWindowSecs}s`))
      console.log(chalk.dim(`  audit interval: ${verifierOptions.auditIntervalMs}ms`))
      console.log('')

      const references = await loadReferences(verifierOptions.referencesDir, (m) => console.warn(chalk.yellow(m)))
      if (references.length > 0) {
        console.log(chalk.dim(`Loaded ${references.length} KBF reference(s) from ${verifierOptions.referencesDir}`))
      }

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
        const remaining = epochBudget - creditsUsed
        if (remaining <= 0) {
          log(`Epoch ${epoch} audit budget exhausted (${creditsUsed}/${epochBudget}); waiting for next epoch`)
          return
        }
        log(`Epoch ${epoch}: ${creditsUsed}/${epochBudget} credits used`)

        for (const service of verifierOptions.services) {
          if (stopped) return
          let peers: PeerInfo[]
          try {
            peers = await node.discoverPeers(service)
          } catch (err) {
            warn(`discovery failed for ${service}: ${(err as Error).message}`)
            continue
          }

          const cohort = await selectCohort(peers, service, registryClient, {
            cohortMaxSize: Math.min(verifierOptions.cohortMaxSize, remaining),
            stalenessWindowSecs,
            warn,
          })
          if (cohort.length < verifierOptions.cohortMinSize) {
            log(`${service}: only ${cohort.length} eligible seller(s) (< ${verifierOptions.cohortMinSize}); skipping round`)
            continue
          }

          try {
            const result = await runCohortAudit(
              node,
              identity,
              registryClient,
              service,
              cohort,
              findReferenceForService(references, service),
              {
                probesPerAudit: verifierOptions.probesPerAudit,
                cohortMinSize: verifierOptions.cohortMinSize,
                cohortMaxSize: verifierOptions.cohortMaxSize,
                stalenessWindowSecs,
                maxProbesPerRequest: verifierOptions.maxProbesPerRequest,
                evidenceDir: verifierOptions.evidenceDir,
                log,
                warn,
              },
            )
            const attested = result.outcomes.filter((o) => o.attested).length
            const diffs = result.outcomes.filter((o) => o.verdict === 'DIFF').length
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
