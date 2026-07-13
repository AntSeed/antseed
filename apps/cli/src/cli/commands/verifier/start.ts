import type { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import {
  AntseedNode,
  makeVerifierRegistryDomain,
  peerIdToAddress,
  resolveChainConfig,
  signDelegateVoucher,
  toPeerId,
} from '@antseed/node'
import type { DelegateVoucherMessage, NodePaymentsConfig, PeerInfo } from '@antseed/node'
import { mergeBootstrapNodes, OFFICIAL_BOOTSTRAP_NODES, parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../../shutdown.js'
import {
  createVerifierRegistryClient,
  createVerifierRewardsClient,
  formatAnts,
  resolveBaseRpcUrlOverride,
} from '../../payment-utils.js'
import { loadReferences, findReferenceForService } from '../../../verifier/references.js'
import { selectCohort, runCohortAudit } from '../../../verifier/audit-runner.js'
import type { ProbeExecutor, ProbeSourceKind } from '../../../verifier/audit-runner.js'
import { probeSellerViaDelegates } from '../../../verifier/delegated-probing.js'
import { discoverServices } from '../../../verifier/service-discovery.js'
import { buildKbfReference, resolveUpstream } from '../../../verifier/reference-builder.js'
import { SellerBackoff, EpochAttemptBudget } from '../../../verifier/backoff.js'
import { safeServiceSlug } from '../../../verifier/slug.js'
import { parsePositiveIntFlag } from './flags.js'
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
const DEFAULT_DELEGATE_JOB_TIMEOUT_MS = 60_000
const DEFAULT_MIN_DELEGATES = 1
/**
 * How long an issued DelegateVoucher stays claimable. Generous by design:
 * claims land in the claim-time epoch, so a delegate whose verifier already
 * exhausted its per-epoch grant cap simply claims in a later epoch.
 */
const VOUCHER_TTL_SECS = 30 * 24 * 60 * 60
/**
 * KBF references drift as upstream backends update — the published KBF study
 * (arXiv:2605.29524) measured probe staleness at ~7–9 weeks. Warn (once per
 * service) when a reference is older than 7 weeks so operators rebuild it.
 */
const REFERENCE_STALE_MS = 49 * 24 * 60 * 60 * 1000
/**
 * Hard cap on ATTEMPTED seller-audits per epoch, as a multiple of the
 * credited budget. Credits only move on successful attestations, so a seller
 * that never produces a valid ResponseAuth would otherwise be probed (and
 * paid for) every round forever without ever consuming budget.
 */
const MAX_ATTEMPTS_PER_CREDIT = 2
/** Upper bound for the round-failure retry backoff. */
const MAX_ROUND_BACKOFF_MS = 60 * 60 * 1000

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
  delegation: {
    enabled: boolean
    signalingPort: number | undefined
    jobTimeoutMs: number
    minDelegates: number
    requireDelegates: boolean
  }
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
    delegation: {
      enabled: verifierConfig?.delegation?.enabled ?? false,
      signalingPort: verifierConfig?.delegation?.signalingPort,
      jobTimeoutMs: verifierConfig?.delegation?.jobTimeoutMs ?? DEFAULT_DELEGATE_JOB_TIMEOUT_MS,
      minDelegates: verifierConfig?.delegation?.minDelegates ?? DEFAULT_MIN_DELEGATES,
      requireDelegates: verifierConfig?.delegation?.requireDelegates ?? false,
    },
  }
}

/**
 * Custom bootstrap entries MERGE with (never replace) the official nodes —
 * replacing them silently detaches the daemon from the public DHT (known
 * repo gotcha; matches how AntseedNode itself treats bootstrap config).
 */
export function resolveVerifierBootstrapNodes(customEntries: string[] | undefined): Array<{ host: string; port: number }> {
  const custom = Array.isArray(customEntries) ? parseBootstrapList(customEntries) : []
  return toBootstrapConfig(mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, custom))
}

export function registerVerifierStartCommand(verifierCmd: Command): void {
  verifierCmd
    .command('start')
    .description('Start the verifier daemon: audit sellers for the configured services and attest results on-chain')
    .option('--service <id...>', 'service/model IDs to verify (overrides config verifier.services)')
    .option('--interval <ms>', 'pause between audit rounds in ms', parsePositiveIntFlag)
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

      const bootstrapNodes = resolveVerifierBootstrapNodes(config.network?.bootstrapNodes)

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
        // Delegated probing: announce as a delegation host so opt-in organic
        // buyers can connect and carry probe traffic. The verifier whitelist
        // is public, so probes from this daemon's own wallet are
        // classifiable; delegate-carried probes are not.
        ...(verifierOptions.delegation.enabled
          ? {
              delegationHost: {
                ...(verifierOptions.delegation.signalingPort !== undefined
                  ? { signalingPort: verifierOptions.delegation.signalingPort }
                  : {}),
              },
            }
          : {}),
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

      // Fetched once for startup validation, refreshed at every round (the
      // on-chain policy is owner-tunable and must not be cached for the
      // daemon's whole lifetime).
      let policy = await registryClient.getAuditPolicy()
      if (verifierOptions.probesPerAudit < policy.minProbeCount) {
        console.error(chalk.red(
          `Configured probesPerAudit (${verifierOptions.probesPerAudit}) is below the on-chain ` +
          `minProbeCount (${policy.minProbeCount}) — every attestation would revert with ProbeCountTooLow ` +
          'after paying for all probes. Raise verifier.probesPerAudit.',
        ))
        await node.stop()
        process.exit(1)
      }
      const stalenessWindowSecs = verifierOptions.stalenessWindowSecs ?? policy.auditCooldown
      console.log(chalk.bold('Verifier settings:'))
      console.log(chalk.dim(`  services: ${verifierOptions.services.length > 0 ? verifierOptions.services.join(', ') : 'auto-discover (all advertised on the network)'}`))
      console.log(chalk.dim(`  probes per audit: ${verifierOptions.probesPerAudit} (${verifierOptions.maxProbesPerRequest}/request, stealth)`))
      console.log(chalk.dim(`  probe source: ${verifierOptions.probeSource} (rotation history: ${verifierOptions.probeRotationHistory})`))
      console.log(chalk.dim(`  cohort size: ${verifierOptions.cohortMinSize}-${verifierOptions.cohortMaxSize}`))
      console.log(chalk.dim(`  audits per epoch: ${verifierOptions.maxAuditsPerEpoch} (on-chain cap: ${policy.maxCreditsPerVerifierPerEpoch})`))
      console.log(chalk.dim(`  staleness window: ${stalenessWindowSecs}s`))
      console.log(chalk.dim(`  audit interval: ${verifierOptions.auditIntervalMs}ms`))
      if (verifierOptions.delegation.enabled) {
        console.log(chalk.dim(
          `  delegation: hosting on port ${node.signalingPort} `
          + `(min ${verifierOptions.delegation.minDelegates} delegate(s), `
          + `${verifierOptions.delegation.requireDelegates ? 'delegates required' : 'direct fallback'})`,
        ))
      }
      console.log('')

      if (verifierOptions.delegation.enabled) {
        node.on('delegate:connected', (delegate: { peerId: string }) => {
          console.log(chalk.dim(`[verifier] Delegate connected: ${delegate.peerId.slice(0, 12)}…`))
        })
        node.on('delegate:disconnected', (peerId: string) => {
          console.log(chalk.dim(`[verifier] Delegate disconnected: ${peerId.slice(0, 12)}…`))
        })
      }

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

      /**
       * Sign and deliver one EIP-712 DelegateVoucher per carrier for a cohort
       * audit's probe commitment. Nothing goes on-chain here — the delegate's
       * operator claims the voucher itself, and the contract enforces the
       * commitment budget (credited attestations only), the operator binding,
       * and the per-epoch cap. We clamp to the commitment's remaining budget
       * up front so we never issue vouchers that can only revert.
       */
      const issueDelegateVouchers = async (probeCommitment: string, roundJobs: Map<string, number>): Promise<void> => {
        if (roundJobs.size === 0) return
        const registryAddress = chainConfig.verifierRegistryAddress
        if (!registryAddress) {
          warn('verifierRegistryAddress missing from chain config; cannot issue delegate vouchers')
          return
        }
        try {
          const [budget, granted] = await Promise.all([
            registryClient.commitmentDelegateBudget(address, probeCommitment),
            registryClient.commitmentDelegateCredits(address, probeCommitment),
          ])
          const available = budget - granted
          if (available <= 0) {
            log(`No delegate-credit budget on commitment ${probeCommitment.slice(0, 10)}… (no credited attestations); skipping vouchers`)
            return
          }
          // Largest contributors first; scale down when carried jobs exceed
          // what the credited attestations can back.
          let entries = [...roundJobs.entries()].sort((a, b) => b[1] - a[1])
          let total = entries.reduce((sum, [, jobs]) => sum + jobs, 0)
          if (total > available) {
            const scale = available / total
            entries = entries
              .map(([peerId, jobs]) => [peerId, Math.floor(jobs * scale)] as [string, number])
              .filter(([, credits]) => credits > 0)
            total = entries.reduce((sum, [, credits]) => sum + credits, 0)
            if (entries.length === 0 || total === 0) {
              log(`Commitment budget too low to voucher this round (${available} left)`)
              return
            }
          }
          const domain = makeVerifierRegistryDomain(chainConfig.evmChainId, registryAddress)
          const deadline = Math.floor(Date.now() / 1000) + VOUCHER_TTL_SECS
          let issued = 0
          for (const [delegatePeerId, credits] of entries) {
            const msg: DelegateVoucherMessage = {
              buyer: peerIdToAddress(delegatePeerId),
              probeCommitment,
              credits,
              nonce: BigInt('0x' + randomBytes(16).toString('hex')),
              deadline,
            }
            const signature = await signDelegateVoucher(identity.wallet, domain, msg)
            try {
              node.sendDelegateVoucher(toPeerId(delegatePeerId), {
                version: 1,
                chainId: chainConfig.evmChainId,
                registry: registryAddress,
                buyer: msg.buyer,
                probeCommitment,
                credits,
                nonce: msg.nonce.toString(),
                deadline,
                signature,
              })
              issued += 1
            } catch (err) {
              // The delegate disconnected between carrying and crediting; its
              // budget share stays unissued rather than being reassigned.
              warn(`voucher delivery to ${delegatePeerId.slice(0, 12)}… failed: ${(err as Error).message}`)
            }
          }
          log(`Issued ${issued}/${entries.length} delegate voucher(s) for ${total} credit(s) on commitment ${probeCommitment.slice(0, 10)}…`)
        } catch (err) {
          warn(`delegate voucher issuance failed: ${(err as Error).message}`)
        }
      }

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

      // Cost-control state shared across rounds. In-memory by design: a
      // restart forgets failure history / attempt counts, which at worst
      // allows one extra probe batch per seller — bounded and acceptable.
      const sellerBackoff = new SellerBackoff()
      const attemptBudget = new EpochAttemptBudget(
        Math.max(1, verifierOptions.maxAuditsPerEpoch * MAX_ATTEMPTS_PER_CREDIT),
      )
      const backoffKey = (peerId: string, service: string): string => `${peerId}:${service}`

      const runRound = async (): Promise<void> => {
        await claimFinalizedRewards()

        // Refresh the on-chain audit policy every round; keep the last-known
        // policy when the read transiently fails.
        try {
          policy = await registryClient.getAuditPolicy()
        } catch (err) {
          warn(`audit policy refresh failed (using last known): ${(err as Error).message}`)
        }
        const stalenessWindowSecs = verifierOptions.stalenessWindowSecs ?? policy.auditCooldown
        if (verifierOptions.probesPerAudit < policy.minProbeCount) {
          warn(
            `probesPerAudit (${verifierOptions.probesPerAudit}) fell below the on-chain minProbeCount ` +
            `(${policy.minProbeCount}); skipping round — raise verifier.probesPerAudit`,
          )
          return
        }

        const epoch = await registryClient.currentEpoch()
        const creditsUsed = await registryClient.epochCredits(epoch, address)
        const epochBudget = Math.min(verifierOptions.maxAuditsPerEpoch, policy.maxCreditsPerVerifierPerEpoch)
        let remaining = epochBudget - creditsUsed
        if (remaining <= 0) {
          log(`Epoch ${epoch} audit budget exhausted (${creditsUsed}/${epochBudget}); waiting for next epoch`)
          return
        }
        if (attemptBudget.remaining(epoch) <= 0) {
          log(`Epoch ${epoch} attempted-audit cap reached (${epochBudget * MAX_ATTEMPTS_PER_CREDIT} attempts); waiting for next epoch`)
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

        for (const { service, advertised, advertisedByPeer, peers: servicePeers } of targets) {
          if (stopped) return
          if (remaining <= 0) {
            log(`Epoch ${epoch} audit budget exhausted mid-round; deferring remaining services`)
            return
          }
          const remainingAttempts = attemptBudget.remaining(epoch)
          if (remainingAttempts <= 0) {
            log(`Epoch ${epoch} attempted-audit cap reached mid-round; deferring remaining services`)
            return
          }

          // Per-seller failure backoff: sellers whose recent audits finished
          // uncredited cool down exponentially instead of staying
          // stalest-first and drawing a full paid probe batch every round.
          const probeablePeers = servicePeers.filter((peer) => {
            if (!sellerBackoff.isBlocked(backoffKey(peer.peerId, service))) return true
            log(`${service}: ${peer.peerId.slice(0, 10)}… cooling down after ${sellerBackoff.consecutiveFailures(backoffKey(peer.peerId, service))} uncredited audit(s); skipping`)
            return false
          })

          let reference = findReferenceForService(references, service)
          const cohort = await selectCohort(probeablePeers, service, registryClient, {
            cohortMaxSize: Math.min(verifierOptions.cohortMaxSize, remaining, remainingAttempts),
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
              const outPath = join(verifierOptions.referencesDir, `${safeServiceSlug(service)}.json`)
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

          // Route probes through connected delegates when possible so probe
          // traffic originates from organic buyer identities instead of this
          // publicly-whitelisted one.
          let probeExecutor: ProbeExecutor | undefined
          if (verifierOptions.delegation.enabled) {
            const delegates = node.getConnectedDelegates()
            if (delegates.length >= verifierOptions.delegation.minDelegates) {
              probeExecutor = (peer, svc, probeSet, maxPerRequest) =>
                probeSellerViaDelegates(
                  node,
                  node.getConnectedDelegates(),
                  peer,
                  svc,
                  probeSet,
                  maxPerRequest,
                  { jobTimeoutMs: verifierOptions.delegation.jobTimeoutMs, log, warn },
                )
            } else if (verifierOptions.delegation.requireDelegates) {
              log(`${service}: ${delegates.length}/${verifierOptions.delegation.minDelegates} delegate(s) connected; skipping (delegates required)`)
              continue
            } else {
              log(`${service}: ${delegates.length}/${verifierOptions.delegation.minDelegates} delegate(s) connected — probing directly this round`)
            }
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
                minProbeCount: policy.minProbeCount,
                cohortMinSize: verifierOptions.cohortMinSize,
                cohortMaxSize: verifierOptions.cohortMaxSize,
                stalenessWindowSecs,
                maxProbesPerRequest: verifierOptions.maxProbesPerRequest,
                evidenceDir: verifierOptions.evidenceDir,
                probeSource: verifierOptions.probeSource,
                probeLogDir: verifierOptions.probeLogDir,
                probeRotationHistory: verifierOptions.probeRotationHistory,
                // Sellers match the wire model id case-sensitively: probe
                // with the advertised spelling, keep the normalized form for
                // grouping/config/hash keys only.
                advertisedService: advertised,
                advertisedByPeer,
                ...(probeExecutor ? { probeExecutor } : {}),
                log,
                warn,
              },
            )
            if (result === null) continue // skipped before commit/probes — no attempts spent

            attemptBudget.recordAttempts(epoch, result.cohortSize)
            const attested = result.outcomes.filter((o) => o.attested).length
            const credited = result.outcomes.filter((o) => o.credited).length
            const diffs = result.outcomes.filter((o) => o.verdict === 'DIFF').length
            // Only CREDITED attestations consume budget on-chain; an
            // attested-but-uncredited tx (cooldown, epoch cap) does not.
            remaining -= credited
            for (const outcome of result.outcomes) {
              const key = backoffKey(outcome.peerId, service)
              if (outcome.credited) sellerBackoff.recordSuccess(key)
              else sellerBackoff.recordFailure(key)
            }
            // Vouchers are per probe commitment: issue right after the
            // audit's attestations funded the commitment's delegate budget.
            if (verifierOptions.delegation.enabled && result.delegateJobs.size > 0) {
              await issueDelegateVouchers(result.probeCommitment, result.delegateJobs)
            }
            console.log(chalk.bold(`${service}: audited ${result.cohortSize} sellers — ${attested} attested (${credited} credited), ${diffs} DIFF`))
          } catch (err) {
            // Probes may have been dispatched before the failure — count the
            // whole cohort against the attempt cap (the safe direction).
            attemptBudget.recordAttempts(epoch, cohort.length)
            warn(`audit round failed for ${service}: ${(err as Error).message}`)
          }
        }
      }

      if (options.once) {
        try {
          await runRound()
        } catch (err) {
          console.error(chalk.red(`Audit round failed: ${(err as Error).message}`))
          process.exitCode = 1
        }
        await node.stop()
        return
      }

      console.log(chalk.bold('Verifier daemon running. Press Ctrl+C to stop.'))
      // Round boundary is an error boundary: a transient RPC outage in the
      // pre-round reads (epoch, credits, policy) must never kill the daemon.
      // Consecutive failures back off exponentially (bounded, jittered).
      let consecutiveRoundFailures = 0
      for (;;) {
        if (stopped) return
        try {
          await runRound()
          consecutiveRoundFailures = 0
        } catch (err) {
          consecutiveRoundFailures += 1
          warn(`audit round failed (${consecutiveRoundFailures} in a row): ${(err as Error).message}`)
        }
        if (stopped) return
        const baseDelay = consecutiveRoundFailures === 0
          ? verifierOptions.auditIntervalMs
          : Math.min(verifierOptions.auditIntervalMs * 2 ** consecutiveRoundFailures, MAX_ROUND_BACKOFF_MS)
        const jitter = consecutiveRoundFailures === 0 ? 0 : Math.floor(baseDelay * 0.2 * Math.random())
        await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter))
      }
    })
}
