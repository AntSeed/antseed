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
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { resolveVerifierCommandModels } from '../../../verifier/model-config.js'
import {
  classifyVerificationTarget,
  loadBuyerProxySnapshot,
  verifyModelTarget,
  type ModelVerificationFailure,
  type ModelVerificationTargetResult,
} from '../../../verifier/model-run.js'
import { reserveModelAuditReference } from '../../../verifier/probe-bank.js'
import { addAuditCostSummaries, emptyAuditCostSummary } from '../../../verifier/proxy-evidence.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { createVerifierClient } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface RunOptions {
  all?: boolean
}

export function registerVerifierRunCommand(verifier: Command): void {
  verifier
    .command('run [model]')
    .description('Verify live peers for one configured model or every enabled model')
    .option('--all', 'verify every enabled configured model')
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
        const verifierClient = createVerifierClient(config)
        const epochWindow = await verifierClient.currentEpochWindow()
        const epoch = epochWindow.epoch.toString()
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
        console.log(chalk.dim(`Buyer proxy: ${proxy.baseUrl} (pid ${proxy.pid})`))
        console.log(chalk.dim('Evidence: verified ResponseAuth required for every successful batch'))

        const epochModels: EpochAuditSummaryV1['models'] = []
        for (const model of models) {
          const modelStartedAt = new Date().toISOString()
          const results: ModelVerificationTargetResult[] = []
          const failures: ModelVerificationFailure[] = []
          const skipped: Array<{ peerId: string; reason: string }> = []
          status.currentModel = model
          status.currentPeerId = null
          status.message = `auditing ${model}`
          await writeVerifierStatus(evidenceDir, status)
          await appendVerifierEvent(evidenceDir, epoch, {
            type: 'model-started', runId, epoch, model, at: modelStartedAt,
          })

          const normalizedModel = model.trim().toLowerCase()
          const targets = proxy.peers.flatMap((peer) => {
            const eligibility = classifyVerificationTarget(peer, normalizedModel)
            if (eligibility.eligible) return [{ peer, service: eligibility.service }]
            skipped.push({ peerId: peer.peerId, reason: eligibility.reason })
            return []
          })
          console.log(chalk.dim(`${model}: ${targets.length} eligible target(s), ${skipped.length} skipped`))

          for (const target of targets) {
            status.currentPeerId = target.peer.peerId
            status.message = `auditing ${model} on ${target.peer.peerId}`
            await writeVerifierStatus(evidenceDir, status)
            console.log(chalk.dim(`Verifying ${model} on ${target.peer.peerId.slice(0, 12)}… (${target.service})`))
            try {
              const reserved = await reserveModelAuditReference({
                banksDir,
                model,
                sellerPeerId: target.peer.peerId,
                service: target.service,
                epoch,
                config: config.verifier,
              })
              const result = await verifyModelTarget({
                context: {
                  proxy,
                  evidenceDir: modelAuditsDirectory(evidenceDir, epoch, model),
                  requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
                  responseAuthReader,
                },
                target: target.peer,
                service: target.service,
                reference: reserved.reference,
                auditId: reserved.auditId,
              })
              results.push(result)
              status.auditsCompleted += 1
              status.cost = addAuditCostSummaries(status.cost, result.cost)
              console.log(chalk.green(
                `${result.status} ${target.peer.peerId.slice(0, 12)}… `
                + `(${result.parsedProbeCount}/${result.probeCount} scoreable, `
                + `$${result.cost.estimatedCostUsd.toFixed(6)})`,
              ))
              await appendVerifierEvent(evidenceDir, epoch, {
                type: 'audit-completed', runId, epoch, model, peerId: result.peerId,
                auditId: result.auditId, verdict: result.status, cost: result.cost,
                at: new Date().toISOString(),
              })
            } catch (error) {
              const reason = asError(error).message
              failures.push({
                peerId: target.peer.peerId,
                agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
                service: target.service,
                status: 'FAILED',
                reason,
              })
              status.failures += 1
              console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
              await appendVerifierEvent(evidenceDir, epoch, {
                type: 'audit-failed', runId, epoch, model, peerId: target.peer.peerId,
                reason, at: new Date().toISOString(),
              })
            }
            await writeVerifierStatus(evidenceDir, status)
          }

          if (targets.length === 0) {
            status.failures += 1
            console.warn(chalk.yellow(`${model}: no peers advertise the model with ResponseAuth support`))
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
          epochModels.push({
            model,
            summaryPath,
            resultCount: results.length,
            failureCount: failures.length + (targets.length === 0 ? 1 : 0),
            skippedCount: skipped.length,
            cost: modelCost,
          })
          status.modelsCompleted += 1
          status.currentPeerId = null
          await writeVerifierStatus(evidenceDir, status)
          await appendVerifierEvent(evidenceDir, epoch, {
            type: 'model-completed', runId, epoch, model, summaryPath,
            resultCount: results.length, failureCount: failures.length, cost: modelCost,
            at: modelCompletedAt,
          })
        }

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
