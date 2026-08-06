import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import { writeJsonAtomic } from '../../../verifier/atomic-files.js'
import { resolveVerifierCommandModels, resolveVerifierModelConfig } from '../../../verifier/model-config.js'
import { buildModelReference } from '../../../verifier/model-reference.js'
import { loadConfiguredVerifierModelCatalog } from '../../../verifier/openrouter-catalog.js'
import { appendModelReferenceToBank } from '../../../verifier/probe-bank.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierReferenceCommand(verifier: Command): void {
  const reference = verifier.command('reference').description('Manage powered model references')
  reference
    .command('build [model]')
    .description('Build and append references for one configured model or every enabled model')
    .option('--all', 'build references for every enabled configured model')
    .action(async (modelValue: string | undefined, options: { all?: boolean }, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const models = resolveVerifierCommandModels(config.verifier, modelValue, options.all === true)
      const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const catalog = await loadConfiguredVerifierModelCatalog(config.verifier)
      const startedAt = new Date().toISOString()
      type ReferenceBuildResult = {
        model: string
        status: 'BUILT' | 'FAILED'
        referenceId?: string
        referencePath?: string
        bankPath?: string
        addedProbeCount?: number
        totalProbeCount?: number
        contrastModels?: string[]
        costUsdMicros?: string
        reason?: string
      }

      const results: ReferenceBuildResult[] = await Promise.all(models.map(async (model) => {
        try {
          const selected = resolveVerifierModelConfig(config.verifier, model, catalog)
          console.log(chalk.dim(`[reference:${model}] selected contrasts: ${selected.contrastModels.join(', ')}`))
          const built = await buildModelReference({
            model,
            referencesDir,
            config: config.verifier,
            catalog,
            log: (message) => console.log(chalk.dim(`[reference:${model}] ${message}`)),
          })
          const appended = await appendModelReferenceToBank({
            banksDir,
            model,
            reference: built.reference,
            cost: built.cost,
          })
          const result: ReferenceBuildResult = {
            model,
            status: 'BUILT',
            referenceId: built.reference.referenceId,
            referencePath: built.path,
            bankPath: appended.path,
            addedProbeCount: appended.addedProbeCount,
            totalProbeCount: appended.totalProbeCount,
            contrastModels: built.reference.contrasts.map((contrast) => contrast.model),
            costUsdMicros: built.cost.totalUsdMicros,
          }
          console.log(chalk.green(
            `Built ${model}: +${appended.addedProbeCount} probes (${appended.totalProbeCount} banked), `
            + `$${(Number(built.cost.totalUsdMicros) / 1_000_000).toFixed(6)}`,
          ))
          return result
        } catch (error) {
          const reason = asError(error).message
          console.warn(chalk.yellow(`FAILED ${model}: ${reason}`))
          return { model, status: 'FAILED', reason }
        }
      }))

      const completedAt = new Date().toISOString()
      const summary = {
        version: 1,
        kind: 'antseed-verifier-reference-build-summary',
        buildId: canonicalHashBytes32({
          domain: 'antseed-verifier-reference-build-v1', models, startedAt, completedAt,
        }),
        startedAt,
        completedAt,
        results,
      }
      const summaryPath = join(banksDir, 'reference-build-summary.json')
      await writeJsonAtomic(summaryPath, summary)
      console.log(chalk.dim(`Summary: ${summaryPath}`))
      if (results.some((result) => result.status === 'FAILED')) process.exitCode = 1
    })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
