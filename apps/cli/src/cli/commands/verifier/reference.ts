import type { Command } from 'commander'
import chalk from 'chalk'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { buildKbfReference, resolveUpstream } from '../../../verifier/reference-builder.js'

/**
 * `antseed verifier reference build` — enroll a model through a trusted
 * OpenAI-compatible upstream and write a certified KBF reference file the
 * verifier daemon picks up automatically. With a reference, a service can be
 * audited down to a single seller; without one, cohort consensus needs
 * cohortMinSize sellers advertising the same service.
 */
export function registerVerifierReferenceCommand(verifierCmd: Command): void {
  const referenceCmd = verifierCmd
    .command('reference')
    .description('Manage trusted KBF reference files')

  referenceCmd
    .command('build')
    .description('Enroll a model via a trusted OpenAI-compatible upstream API and write a KBF reference file')
    .requiredOption('--model <id>', 'upstream model id to enroll (what the trusted API calls it)')
    .option('--service <id>', 'network service id this reference certifies (default: --model)')
    .option('--alias <id...>', 'additional service aliases')
    .option('--base-url <url>', 'OpenAI-compatible base URL (default: config verifier.upstream.baseUrl)')
    .option('--api-key <key>', 'upstream API key (default: config verifier.upstream)')
    .option('--api-key-env <var>', 'environment variable holding the upstream API key')
    .option('--probes <n>', 'candidate probes to draw from the compositional space', (v) => parseInt(v, 10))
    .option('--out <dir>', 'references directory (default: config verifier.referencesDir)')
    .action(async (options, command: Command) => {
      const globalOpts = getGlobalOptions(command)
      const config = await loadConfig(globalOpts.config)

      const upstream = resolveUpstream({
        baseUrl: (options.baseUrl as string | undefined) ?? config.verifier?.upstream?.baseUrl ?? '',
        ...(options.apiKey ? { apiKey: options.apiKey as string } : config.verifier?.upstream?.apiKey ? { apiKey: config.verifier.upstream.apiKey } : {}),
        ...(options.apiKeyEnv
          ? { apiKeyEnv: options.apiKeyEnv as string }
          : config.verifier?.upstream?.apiKeyEnv
            ? { apiKeyEnv: config.verifier.upstream.apiKeyEnv }
            : {}),
      })
      if (!upstream) {
        console.error(chalk.red('No upstream API configured. Pass --base-url or set verifier.upstream.baseUrl in your config.'))
        process.exit(1)
      }

      const outDir =
        (options.out as string | undefined)
        ?? config.verifier?.referencesDir
        ?? join(globalOpts.dataDir, 'fingerprints', 'references')

      try {
        const reference = await buildKbfReference(upstream, {
          model: options.model as string,
          ...(options.service ? { service: options.service as string } : {}),
          ...(options.alias ? { aliases: options.alias as string[] } : {}),
          ...(Number.isInteger(options.probes) ? { candidateCount: options.probes as number } : {}),
          log: (m) => console.log(chalk.dim(`[reference] ${m}`)),
        })

        await mkdir(outDir, { recursive: true })
        const slug = (reference.referenceModel || (options.model as string)).replace(/[^a-z0-9._-]/gi, '_')
        const outPath = join(outDir, `${slug}.json`)
        await writeFile(outPath, JSON.stringify(reference, null, 2))

        console.log(chalk.green(`Reference ${reference.referenceId.slice(0, 18)}… written to ${outPath}`))
        console.log(chalk.dim(`  model: ${reference.referenceModel} (aliases: ${reference.serviceAliases.join(', ')})`))
        console.log(chalk.dim(`  probes: ${reference.probes.length} certified`))
        console.log(chalk.dim(`  self-test: ${reference.selfTest.hamming}/${reference.selfTest.total} mismatches (error rate ${(reference.selfTest.errorRate * 100).toFixed(1)}%)`))
        console.log(chalk.dim('  the verifier daemon picks this up on its next start'))
      } catch (err) {
        console.error(chalk.red(`Reference build failed: ${(err as Error).message}`))
        process.exit(1)
      }
    })
}
