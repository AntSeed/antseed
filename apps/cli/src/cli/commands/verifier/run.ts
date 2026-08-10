import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import {
  appendVerifierEvent,
  epochAuditReportPath,
  modelAuditsDirectory,
  writeEpochAuditReport,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  writeVerifierStatus,
  type EpochAuditSummaryV1,
  type VerifierStatusV1,
} from '../../../verifier/audit-artifacts.js'
import { utcDayAuditEpochWindow } from '../../../verifier/audit-epoch.js'
import {
  ConcurrencyLimiter,
  KeyedSerialLimiter,
  SerialOperationQueue,
  mapConcurrently,
} from '../../../verifier/audit-concurrency.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { resolveVerifierCommandModels } from '../../../verifier/model-config.js'
import {
  classifyVerificationTarget,
  loadBuyerProxySnapshot,
  verifyModelTarget,
  type ModelVerificationFailure,
  type ModelVerificationSkip,
} from '../../../verifier/model-run.js'
import { reserveModelAuditReference, voidModelAuditReference } from '../../../verifier/probe-bank.js'
import { addAuditCostSummaries, emptyAuditCostSummary } from '../../../verifier/proxy-evidence.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'
import { VerifierRunProgress } from './run-progress.js'

interface RunOptions {
  all?: boolean
  allowProbeReuse?: boolean
}

export function registerVerifierRunCommand(verifier: Command): void {
  verifier
    .command('run [model]')
    .description('Verify live peers for one configured model or every enabled model')
    .option('--all', 'verify every enabled configured model')
    .option('--allow-probe-reuse', 'allow probes assigned in earlier verifier runs to be reused')
    .action(async (modelValue: string | undefined, options: RunOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const models = resolveVerifierCommandModels(config.verifier, modelValue, options.all === true)
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const runLock = await acquirePidFileLock(join(evidenceDir, '.run.lock'))
      let responseAuthReader: Awaited<ReturnType<typeof openResponseAuthReader>> | null = null
      let status: VerifierStatusV1 | null = null
      let runProgress: VerifierRunProgress | null = null
      try {
        const configuredVerificationAddress = config.payments.crypto?.verificationContractAddress?.trim()
        const epochWindow = configuredVerificationAddress
          ? await createVerifierClient(config).currentEpochWindow().then((window) => ({
            epoch: window.epoch.toString(),
            startedAt: window.startedAt,
            endsAt: window.endsAt,
            source: 'onchain' as const,
          }))
          : utcDayAuditEpochWindow()
        const epoch = epochWindow.epoch
        const proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
        responseAuthReader = await openResponseAuthReader({
          dataDir: globalOptions.dataDir,
          timeoutMs: config.verifier?.responseAuthWaitTimeoutMs,
        })
        const startedAtMs = Date.now()
        const runId = canonicalHashBytes32({
          domain: 'antseed-verifier-epoch-run-v1',
          epoch,
          models: models.map((model) => model.toLowerCase()),
          buyerProxy: proxy.baseUrl,
          startedAt: startedAtMs,
        })
        const preparedModels = models.map((model) => {
          const skipped: ModelVerificationSkip[] = []
          const normalizedModel = model.trim().toLowerCase()
          const targets = proxy.peers.flatMap((peer) => {
            const eligibility = classifyVerificationTarget(peer, normalizedModel)
            if (eligibility.eligible) return [{ peer, service: eligibility.service }]
            if (eligibility.code === 'missing_response_auth') {
              skipped.push({
                peerId: peer.peerId,
                displayName: peer.displayName ?? null,
                agentId: peer.onChainAgentId ? String(peer.onChainAgentId) : null,
                service: eligibility.service,
                status: 'SKIPPED',
                code: eligibility.code,
                reason: eligibility.reason,
                source: 'preflight',
                auditId: null,
                evidencePath: null,
                evidenceHash: null,
              })
            }
            return []
          })
          return { model, skipped, targets }
        })
        status = {
          version: 1,
          kind: 'antseed-verifier-status',
          state: 'running',
          runId,
          epoch,
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: null,
          epochStartedAt: epochTimestamp(epochWindow.startedAt),
          epochEndsAt: epochTimestamp(epochWindow.endsAt),
          currentModel: null,
          currentPeerId: null,
          activeAudits: [],
          queuedAudits: preparedModels.reduce((total, model) => total + model.targets.length, 0),
          modelsCompleted: 0,
          modelsTotal: models.length,
          auditsCompleted: 0,
          skipped: preparedModels.reduce((total, model) => total + model.skipped.length, 0),
          failures: 0,
          cost: emptyAuditCostSummary(),
          message: 'starting verifier run',
        }
        await writeVerifierStatus(evidenceDir, status)
        await appendVerifierEvent(evidenceDir, epoch, {
          type: 'run-started', runId, epoch, models, at: status.startedAt,
        })

        console.log(chalk.dim(`Epoch: ${epoch} (${status.epochStartedAt} – ${status.epochEndsAt})`))
        console.log(chalk.dim(`Epoch source: ${epochWindow.source}`))
        console.log(chalk.dim(`Buyer proxy: ${proxy.baseUrl} (pid ${proxy.pid})`))
        console.log(chalk.dim('Evidence: verified ResponseAuth required for every successful batch'))

        const maxConcurrentModels = config.verifier?.auditMaxConcurrentModels ?? 3
        const maxConcurrentPeersPerModel = config.verifier?.auditMaxConcurrentPeersPerModel ?? 4
        const maxConcurrentBatches = config.verifier?.auditMaxConcurrentBatches ?? 12
        const maxConcurrentBatchesPerPeer = config.verifier?.auditMaxConcurrentBatchesPerPeer ?? 2
        const batchLimiter = new ConcurrencyLimiter(maxConcurrentBatches)
        const sellerLimiter = new KeyedSerialLimiter()
        const statusQueue = new SerialOperationQueue()
        const eventQueue = new SerialOperationQueue()
        const updateStatus = async (mutate: (value: VerifierStatusV1) => void): Promise<void> => {
          await statusQueue.run(async () => {
            mutate(status!)
            const current = status!.activeAudits[0] ?? null
            status!.currentModel = current?.model ?? null
            status!.currentPeerId = current?.peerId ?? null
            status!.message = status!.activeAudits.length > 0
              ? `running ${status!.activeAudits.length} audit(s), ${status!.queuedAudits} queued`
              : `${status!.queuedAudits} audit(s) queued`
            await writeVerifierStatus(evidenceDir, status!)
          })
        }
        const appendEvent = async (event: Record<string, unknown>): Promise<void> => {
          await eventQueue.run(async () => { await appendVerifierEvent(evidenceDir, epoch, event) })
        }

        console.log(chalk.dim(
          `Concurrency: ${maxConcurrentModels} models, ${maxConcurrentPeersPerModel} peers/model, `
          + `${maxConcurrentBatches} total batches, ${maxConcurrentBatchesPerPeer} batches/audit`,
        ))
        runProgress = new VerifierRunProgress(preparedModels.map(({ model, targets, skipped }) => ({
          model,
          providerCount: targets.length + skipped.length,
          skippedCount: skipped.length,
        })))
        runProgress.start()

        const epochModels = await mapConcurrently(
          preparedModels,
          maxConcurrentModels,
          async ({ model, skipped, targets }): Promise<EpochAuditSummaryV1['models'][number]> => {
          const modelStartedAt = new Date().toISOString()
          await appendEvent({
            type: 'model-started', runId, epoch, model, at: modelStartedAt,
          })
          for (const entry of skipped) {
            await appendEvent({
              type: 'audit-skipped', runId, epoch, model, peerId: entry.peerId,
              code: entry.code, reason: entry.reason, source: entry.source, at: modelStartedAt,
            })
          }
          runProgress!.activate(model)
          if (!runProgress!.interactive) {
            console.log(chalk.dim(`${model}: ${targets.length} eligible target(s), ${skipped.length} skipped`))
          }

          const outcomes = await mapConcurrently(targets, maxConcurrentPeersPerModel, async (target) => {
            return sellerLimiter.run(target.peer.peerId, async () => {
              const startedAt = new Date().toISOString()
              await updateStatus((value) => {
                value.queuedAudits -= 1
                value.activeAudits.push({ model, peerId: target.peer.peerId, startedAt })
              })
              if (!runProgress!.interactive) {
                console.log(chalk.dim(`Verifying ${model} on ${target.peer.peerId.slice(0, 12)}… (${target.service})`))
              }
              try {
                const reserved = await reserveModelAuditReference({
                  banksDir,
                  model,
                  sellerPeerId: target.peer.peerId,
                  service: target.service,
                  runId,
                  epoch,
                  allowProbeReuse: options.allowProbeReuse === true,
                  config: config.verifier,
                })
                const advertisedConcurrency = target.peer.maxConcurrency && target.peer.maxConcurrency > 0
                  ? target.peer.maxConcurrency
                  : maxConcurrentBatchesPerPeer
                const result = await verifyModelTarget({
                  context: {
                    proxy,
                    evidenceDir: modelAuditsDirectory(evidenceDir, epoch, model),
                    requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
                    auditTimeoutMs: config.verifier?.auditPeerTimeoutMs ?? 600_000,
                    responseAuthReader: responseAuthReader!,
                    batchConcurrency: Math.min(maxConcurrentBatchesPerPeer, advertisedConcurrency),
                    batchConcurrencyPromotionLatencyMs:
                      config.verifier?.auditConcurrencyPromotionLatencyMs ?? 30_000,
                    batchLimiter,
                  },
                  target: target.peer,
                  service: target.service,
                  reference: reserved.reference,
                  auditId: reserved.auditId,
                })
                if (result.status === 'SKIPPED') {
                  await voidModelAuditReference({
                    banksDir,
                    model,
                    sellerPeerId: target.peer.peerId,
                    auditId: reserved.auditId,
                    reason: `${result.code}: ${result.reason}`,
                  })
                  await appendEvent({
                    type: 'audit-skipped', runId, epoch, model, peerId: result.peerId,
                    auditId: result.auditId, code: result.code, reason: result.reason,
                    source: result.source, evidencePath: result.evidencePath, at: new Date().toISOString(),
                  })
                  await updateStatus((value) => { value.skipped += 1 })
                  runProgress!.recordSkip(model)
                  if (!runProgress!.interactive) {
                    console.log(chalk.yellow(`SKIPPED ${target.peer.peerId.slice(0, 12)}…: ${result.reason}`))
                  }
                  return { result: null, failure: null, skipped: result }
                }
                await appendEvent({
                  type: 'audit-completed', runId, epoch, model, peerId: result.peerId,
                  auditId: result.auditId, verdict: result.status, cost: result.cost,
                  at: new Date().toISOString(),
                })
                await updateStatus((value) => {
                  value.auditsCompleted += 1
                  value.cost = addAuditCostSummaries(value.cost, result.cost)
                })
                runProgress!.recordVerdict(model, result.status)
                if (!runProgress!.interactive) {
                  console.log(chalk.green(
                    `${result.status} ${target.peer.peerId.slice(0, 12)}… `
                    + `(${result.parsedProbeCount}/${result.probeCount} scoreable, `
                    + `$${result.cost.estimatedCostUsd.toFixed(6)})`,
                  ))
                }
                return { result, failure: null, skipped: null }
              } catch (error) {
                const reason = asError(error).message
                const failure: ModelVerificationFailure = {
                  peerId: target.peer.peerId,
                  agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
                  service: target.service,
                  status: 'FAILED',
                  reason,
                }
                runProgress!.recordFailure(model)
                if (!runProgress!.interactive) {
                  console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
                }
                await appendEvent({
                  type: 'audit-failed', runId, epoch, model, peerId: target.peer.peerId,
                  reason, at: new Date().toISOString(),
                })
                await updateStatus((value) => { value.failures += 1 })
                return { result: null, failure, skipped: null }
              } finally {
                await updateStatus((value) => {
                  value.activeAudits = value.activeAudits.filter((audit) => !(
                    audit.model === model && audit.peerId === target.peer.peerId
                  ))
                })
              }
            })
          })
          const results = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : [])
          const failures = outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : [])
          const allSkipped = [
            ...skipped,
            ...outcomes.flatMap((outcome) => outcome.skipped ? [outcome.skipped] : []),
          ].sort((left, right) => left.peerId.localeCompare(right.peerId))

          const noAuditableProviders = targets.length === 0 && allSkipped.length === 0
          if (noAuditableProviders) {
            console.warn(chalk.yellow(`${model}: no peers advertise the model with ResponseAuth support`))
            await updateStatus((value) => { value.failures += 1 })
          }
          const modelCompletedAt = new Date().toISOString()
          const modelCost = addAuditCostSummaries(...results.map((result) => result.cost))
          const summaryPath = await writeModelAuditSummary(evidenceDir, epoch, model, {
            version: 1,
            kind: 'antseed-verifier-model-summary',
            runId,
            epoch,
            model,
            startedAt: modelStartedAt,
            completedAt: modelCompletedAt,
            results,
            failures,
            skipped: allSkipped,
            cost: modelCost,
          })
          const modelSummary = {
            model,
            summaryPath,
            resultCount: results.length,
            failureCount: failures.length + (noAuditableProviders ? 1 : 0),
            skippedCount: allSkipped.length,
            cost: modelCost,
          }
          await updateStatus((value) => { value.modelsCompleted += 1 })
          await appendEvent({
            type: 'model-completed', runId, epoch, model, summaryPath,
            resultCount: results.length, failureCount: failures.length,
            skippedCount: allSkipped.length, cost: modelCost,
            at: modelCompletedAt,
          })
          runProgress!.complete(model)
          return modelSummary
        })
        runProgress.finish()

        const completedAt = new Date().toISOString()
        const epochSummary = {
          version: 1,
          kind: 'antseed-verifier-epoch-summary',
          runId,
          epoch,
          epochStartedAt: status.epochStartedAt,
          epochEndsAt: status.epochEndsAt,
          startedAt: status.startedAt,
          completedAt,
          reportPath: epochAuditReportPath(evidenceDir, epoch),
          models: epochModels,
          failureCount: status.failures,
          cost: status.cost,
        } satisfies EpochAuditSummaryV1
        const epochSummaryPath = await writeEpochAuditSummary(evidenceDir, epoch, epochSummary)
        const reportPath = await writeEpochAuditReport(evidenceDir, epoch, epochSummary)
        const manifestPath = await writeVerifierRunManifest(evidenceDir, {
          version: 1,
          kind: 'antseed-verifier-run-manifest',
          runId,
          state: status.failures > 0 ? 'completed-with-failures' : 'completed',
          epoch,
          epochSource: epochWindow.source,
          epochStartedAt: status.epochStartedAt,
          epochEndsAt: status.epochEndsAt,
          startedAt: status.startedAt,
          completedAt,
          summaryPath: epochSummaryPath,
          modelOrder: models,
          models: epochModels,
          failureCount: status.failures,
        })
        status.state = status.failures > 0 ? 'failed' : 'completed'
        status.completedAt = completedAt
        status.currentModel = null
        status.currentPeerId = null
        status.message = status.failures > 0
          ? `completed with ${status.failures} failure(s)`
          : 'completed successfully'
        await writeVerifierStatus(evidenceDir, status)
        await appendVerifierEvent(evidenceDir, epoch, {
          type: 'run-completed', runId, epoch, summaryPath: epochSummaryPath,
          failures: status.failures, cost: status.cost, at: completedAt,
        })
        console.log(chalk.dim(`Summary: ${epochSummaryPath}`))
        console.log(chalk.dim(`Run manifest: ${manifestPath}`))
        console.log(chalk.dim(`Seller report: ${reportPath}`))
        console.log(chalk.dim(`Estimated audit cost: $${status.cost.estimatedCostUsd.toFixed(6)}`))
        if (status.failures > 0) process.exitCode = 1
      } catch (error) {
        if (status) {
          status.state = 'failed'
          status.completedAt = new Date().toISOString()
          status.message = asError(error).message
          await writeVerifierStatus(evidenceDir, status).catch(() => undefined)
        }
        throw error
      } finally {
        runProgress?.finish()
        responseAuthReader?.close()
        await runLock.release()
      }
    })
}

function epochTimestamp(value: number): string {
  return new Date(value * 1_000).toISOString()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
