import chalk from 'chalk'
import type { Command } from 'commander'
import { join } from 'node:path'
import { loadConfig } from '../../../config/loader.js'
import { buildModelReference } from '../../../verifier/model-reference.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierReferenceCommand(verifier: Command): void {
  const reference = verifier.command('reference').description('Manage fixed model references')
  reference
    .command('build <model>')
    .description('Build and save one fixed 100-probe model reference')
    .action(async (modelValue: string, _options: unknown, command: Command) => {
      const model = modelValue.trim()
      if (!model) throw new Error('model must not be empty')
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
      const built = await buildModelReference({
        model,
        referencesDir,
        config: config.verifier,
        log: (message) => console.log(chalk.dim(`[reference] ${message}`)),
      })
      console.log(chalk.green(`Built reference for ${model}`))
      console.log(chalk.dim(`  path: ${built.path}`))
      console.log(chalk.dim(`  id: ${built.reference.referenceId}`))
    })
}
