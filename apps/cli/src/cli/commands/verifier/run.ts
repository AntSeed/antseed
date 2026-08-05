import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import {
  classifyVerificationTarget,
  loadBuyerProxySnapshot,
  verifyModelTarget,
  writeRunSummary,
  type ModelVerificationFailure,
  type ModelVerificationTargetResult,
} from '../../../verifier/model-run.js'
import { loadModelReference } from '../../../verifier/model-reference.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierRunCommand(verifier: Command): void {
  verifier
    .command('run <model>')
    .description('Verify every live peer advertising a model through the running buyer proxy')
    .action(async (modelValue: string, _options: unknown, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const model = modelValue.trim()
      if (!model) throw new Error('model must not be empty')
      const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const prepared = await loadModelReference({
        model,
        referencesDir,
        config: config.verifier,
      })
      const proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
      const startedAt = Date.now()
      const runId = canonicalHashBytes32({
        domain: 'antseed-buyer-proxy-model-verification-run-v1',
        model: model.toLowerCase(),
        proxyBaseUrl: proxy.baseUrl,
        referenceId: prepared.reference.referenceId,
        startedAt,
      })
      const results: ModelVerificationTargetResult[] = []
      const failures: ModelVerificationFailure[] = []

      console.log(chalk.dim(`Reference: ${prepared.path}`))
      console.log(chalk.dim(`Probes: ${prepared.reference.probes.length}`))
      console.log(chalk.dim(`Buyer proxy: ${proxy.baseUrl} (pid ${proxy.pid})`))
      console.log(chalk.dim('Evidence: proxy observation only; no ResponseAuth or payment evidence'))

      const normalizedModel = model.toLowerCase()
      const targets = proxy.peers.flatMap((peer) => {
        const eligibility = classifyVerificationTarget(peer, normalizedModel)
        return eligibility.eligible ? [{ peer, service: eligibility.service }] : []
      })
      console.log(chalk.dim(`Targets: ${targets.length}`))

      for (const target of targets) {
        console.log(chalk.dim(`Verifying ${target.peer.peerId.slice(0, 12)}… (${target.service})`))
        try {
          const result = await verifyModelTarget({
            context: {
              proxy,
              evidenceDir,
              requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
            },
            target: target.peer,
            service: target.service,
            reference: prepared.reference,
          })
          results.push(result)
          console.log(chalk.green(
            `${result.status} ${target.peer.peerId.slice(0, 12)}… `
            + `(${result.parsedProbeCount}/${result.probeCount} scoreable)`,
          ))
        } catch (error) {
          const reason = asError(error).message
          failures.push({
            peerId: target.peer.peerId,
            agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
            service: target.service,
            status: 'FAILED',
            reason,
          })
          console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
        }
      }

      const completedAt = Date.now()
      const summaryPath = await writeRunSummary(evidenceDir, {
        version: 1,
        kind: 'antseed-model-verification-run',
        runId,
        model,
        mode: 'buyer-proxy',
        proxyBaseUrl: proxy.baseUrl,
        referenceId: prepared.reference.referenceId,
        probeCount: prepared.reference.probes.length,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        results,
        failures,
      })
      console.log(chalk.dim(`Summary: ${summaryPath}`))
      if (results.length === 0 || failures.length > 0) process.exitCode = 1
    })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
