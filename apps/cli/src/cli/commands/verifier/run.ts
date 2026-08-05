import chalk from 'chalk'
import type { Command } from 'commander'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { parseUnits } from 'ethers'
import { loadConfig } from '../../../config/loader.js'
import {
  classifyVerificationTarget,
  verifyModelTarget,
  writeRunSummary,
  type ModelVerificationFailure,
  type ModelVerificationTargetResult,
} from '../../../verifier/model-run.js'
import { loadModelReference } from '../../../verifier/model-reference.js'
import { startVerifierRuntime } from '../../../verifier/runtime.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierRunCommand(verifier: Command): void {
  verifier
    .command('run <model>')
    .description('Verify every live peer advertising a model')
    .option('--no-attest', 'write paid verification evidence without registry transactions')
    .action(async (modelValue: string, options: { attest?: boolean }, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const noAttest = options.attest === false
      const model = modelValue.trim()
      if (!model) throw new Error('model must not be empty')
      const maximumSpendUsdc = parseMaximumSpend(config.verifier?.maxTotalSpendUSDC)
      const runtime = await startVerifierRuntime({
        config,
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        noAttest,
      })
      const startedAt = Date.now()
      const runId = canonicalHashBytes32({
        domain: 'antseed-model-verification-run-v1',
        model: model.toLowerCase(),
        noAttest,
        startedAt,
      })
      const results: ModelVerificationTargetResult[] = []
      const failures: ModelVerificationFailure[] = []
      const spend = {
        maximumUsdc: maximumSpendUsdc,
        spentUsdc: 0n,
        maximumPerRequestUsdc: BigInt(config.payments.maxPerRequestUsdc ?? '300000'),
      }
      let summaryPath: string | null = null
      try {
        const prepared = await loadModelReference({
          model,
          referencesDir: runtime.referencesDir,
          config: config.verifier,
        })
        console.log(chalk.dim(`Reference: ${prepared.path}`))
        console.log(chalk.dim(`Probes: ${prepared.reference.probes.length}`))

        const normalizedModel = model.toLowerCase()
        const peers = await runtime.node.discoverPeers(model)
        const targets = peers.map((peer) => ({
          peer,
          eligibility: classifyVerificationTarget(peer, runtime.identity.wallet.address, normalizedModel),
        }))
        for (const target of targets) {
          if (!target.eligibility.eligible) {
            failures.push({
              peerId: target.peer.peerId,
              agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
              service: model,
              status: 'INELIGIBLE',
              reason: target.eligibility.reason,
            })
            continue
          }
          console.log(chalk.dim(`Verifying ${target.peer.peerId.slice(0, 12)}… (${target.eligibility.service})`))
          try {
            const result = await verifyModelTarget({
              context: {
                node: runtime.node,
                verifierAddress: runtime.identity.wallet.address,
                verifierPeerId: runtime.identity.peerId,
                evidenceDir: runtime.evidenceDir,
                requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
                spend,
              },
              target: target.peer,
              service: target.eligibility.service,
              reference: prepared.reference,
              ...(!noAttest ? {
                registryClient: runtime.chain.registryClient,
                signer: runtime.identity.wallet,
              } : {}),
            })
            results.push(result)
            console.log(chalk.green(
              `${result.status} ${target.peer.peerId.slice(0, 12)}… `
              + `(${result.authenticatedProbeCount}/${result.probeCount} authenticated)`,
            ))
          } catch (error) {
            const reason = asError(error).message
            failures.push({
              peerId: target.peer.peerId,
              agentId: String(target.peer.onChainAgentId),
              service: target.eligibility.service,
              status: 'FAILED',
              reason,
            })
            console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
          }
        }
        const completedAt = Date.now()
        summaryPath = await writeRunSummary(runtime.evidenceDir, {
          version: 1,
          kind: 'antseed-model-verification-run',
          runId,
          model,
          mode: noAttest ? 'evidence' : 'attest',
          referenceId: prepared.reference.referenceId,
          probeCount: prepared.reference.probes.length,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date(completedAt).toISOString(),
          maximumSpendUsdc: maximumSpendUsdc.toString(),
          spentUsdc: spend.spentUsdc.toString(),
          results,
          failures,
        })
        console.log(chalk.dim(`Summary: ${summaryPath}`))
        console.log(chalk.dim(`Spent: ${spend.spentUsdc}/${maximumSpendUsdc} USDC base units`))
        if (results.length === 0 || failures.some((failure) => failure.status === 'FAILED')) process.exitCode = 1
      } finally {
        await runtime.node.stop()
      }
    })
}

function parseMaximumSpend(value: string | undefined): bigint {
  if (!value) throw new Error('verifier.maxTotalSpendUSDC must be configured')
  try {
    const parsed = parseUnits(value, 6)
    if (parsed <= 0n) throw new Error('must be greater than zero')
    return parsed
  } catch (error) {
    throw new Error(`verifier.maxTotalSpendUSDC must be a positive USDC amount: ${asError(error).message}`)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
