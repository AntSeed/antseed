import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  writeEpochAuditSummary,
  writeModelAuditSummary,
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
} from '../../../verifier/model-run.js'
import { reserveModelAuditReference } from '../../../verifier/probe-bank.js'
import { addAuditCostSummaries, emptyAuditCostSummary } from '../../../verifier/proxy-evidence.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

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
          const skipped: Array<{ peerId: string; reason: string }> = []
          const normalizedModel = model.trim().toLowerCase()
          const targets = proxy.peers.flatMap((peer) => {
            const eligibility = classifyVerificationTarget(peer, normalizedModel)
            if (eligibility.eligible) return [{ peer, service: eligibility.service }]
            skipped.push({ peerId: peer.peerId, reason: eligibility.reason })
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

        const epochModels = await mapConcurrently(
          preparedModels,
          maxConcurrentModels,
          async ({ model, skipped, targets }): Promise<EpochAuditSummaryV1['models'][number]> => {
          const modelStartedAt = new Date().toISOString()
          await appendEvent({
            type: 'model-started', runId, epoch, model, at: modelStartedAt,
          })
          console.log(chalk.dim(`${model}: ${targets.length} eligible target(s), ${skipped.length} skipped`))

          const outcomes = await mapConcurrently(targets, maxConcurrentPeersPerModel, async (target) => {
            return sellerLimiter.run(target.peer.peerId, async () => {
              const startedAt = new Date().toISOString()
              await updateStatus((value) => {
                value.queuedAudits -= 1
                value.activeAudits.push({ model, peerId: target.peer.peerId, startedAt })
              })
              console.log(chalk.dim(`Verifying ${model} on ${target.peer.peerId.slice(0, 12)}… (${target.service})`))
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
                    auditTimeoutMs: config.verifier?.auditPeerTimeoutMs ?? 180_000,
                    responseAuthReader: responseAuthReader!,
                    batchConcurrency: Math.min(maxConcurrentBatchesPerPeer, advertisedConcurrency),
                    batchLimiter,
                  },
                  target: target.peer,
                  service: target.service,
                  reference: reserved.reference,
                  auditId: reserved.auditId,
                })
                console.log(chalk.green(
                  `${result.status} ${target.peer.peerId.slice(0, 12)}… `
                  + `(${result.parsedProbeCount}/${result.probeCount} scoreable, `
                  + `$${result.cost.estimatedCostUsd.toFixed(6)})`,
                ))
                await appendEvent({
                  type: 'audit-completed', runId, epoch, model, peerId: result.peerId,
                  auditId: result.auditId, verdict: result.status, cost: result.cost,
                  at: new Date().toISOString(),
                })
                await updateStatus((value) => {
                  value.auditsCompleted += 1
                  value.cost = addAuditCostSummaries(value.cost, result.cost)
                })
                return { result, failure: null }
              } catch (error) {
                const reason = asError(error).message
                const failure: ModelVerificationFailure = {
                  peerId: target.peer.peerId,
                  agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
                  service: target.service,
                  status: 'FAILED',
                  reason,
                }
                console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
                await appendEvent({
                  type: 'audit-failed', runId, epoch, model, peerId: target.peer.peerId,
                  reason, at: new Date().toISOString(),
                })
                await updateStatus((value) => { value.failures += 1 })
                return { result: null, failure }
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

          if (targets.length === 0) {
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
            skipped,
            cost: modelCost,
          })
          const modelSummary = {
            model,
            summaryPath,
            resultCount: results.length,
            failureCount: failures.length + (targets.length === 0 ? 1 : 0),
            skippedCount: skipped.length,
            cost: modelCost,
          }
          await updateStatus((value) => { value.modelsCompleted += 1 })
          await appendEvent({
            type: 'model-completed', runId, epoch, model, summaryPath,
            resultCount: results.length, failureCount: failures.length, cost: modelCost,
            at: modelCompletedAt,
          })
          return modelSummary
        })

        const completedAt = new Date().toISOString()
        const epochSummaryPath = await writeEpochAuditSummary(evidenceDir, epoch, {
          version: 1,
          kind: 'antseed-verifier-epoch-summary',
          runId,
          epoch,
          epochStartedAt: status.epochStartedAt,
          epochEndsAt: status.epochEndsAt,
          startedAt: status.startedAt,
          completedAt,
          models: epochModels,
          failureCount: status.failures,
          cost: status.cost,
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
