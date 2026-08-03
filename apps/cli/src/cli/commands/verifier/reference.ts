import type { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'node:path'
import { VerificationStorage } from '@antseed/node'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { resolveUpstream } from '../../../verifier/reference-builder.js'
import { certifyNewProbes, importAdaptiveReferences } from '../../../verifier/probe-catalog.js'
import { loadReferences } from '../../../verifier/references.js'
import { resolveReferencePolicy, resolveReferenceSource } from '../../../verifier/reference-config.js'
import { parsePositiveIntFlag, resolveReferenceUpstreamInput } from './flags.js'

export function registerVerifierReferenceCommand(verifierCmd: Command): void {
  const referenceCmd = verifierCmd
    .command('reference')
    .description('Manage the certified KBF probe catalog')

  referenceCmd
    .command('build')
    .description('Add newly certified probes to the verifier KBF catalog')
    .requiredOption('--model <id>', 'upstream model id to enroll (what the reference API calls it)')
    .option('--service <id>', 'network service id these probes certify (default: --model)')
    .option('--base-url <url>', 'OpenAI-compatible base URL (default: config verifier.referenceEndpoint.baseUrl)')
    .option('--api-key <key>', 'reference API key (default: verifier reference endpoint config)')
    .option('--api-key-env <var>', 'environment variable holding the reference API key')
    .option('--probes <n>', 'new certified probes to add', parsePositiveIntFlag, 100)
    .option('--out <dir>', 'reference artifacts directory (default: config verifier.referencesDir)')
    .action(async (options, command: Command) => {
      const globalOpts = getGlobalOptions(command)
      const config = await loadConfig(globalOpts.config)
      const service = (options.service as string | undefined) ?? (options.model as string)
      const configured = resolveReferenceSource(config.verifier, service, service)
      const configuredInput = config.verifier?.referenceEndpoint ?? config.verifier?.upstream
      const upstream = resolveUpstream(resolveReferenceUpstreamInput(
        {
          ...(options.baseUrl ? { baseUrl: options.baseUrl as string } : {}),
          ...(options.apiKey ? { apiKey: options.apiKey as string } : {}),
          ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv as string } : {}),
        },
        configuredInput,
      ))
      if (!upstream) {
        console.error(chalk.red('No reference API configured. Pass --base-url or set verifier.referenceEndpoint.baseUrl.'))
        process.exit(1)
      }
      const referencesDir = (options.out as string | undefined)
        ?? config.verifier?.referencesDir
        ?? join(globalOpts.dataDir, 'fingerprints', 'references')
      const source = {
        upstream: {
          ...upstream,
          ...(configured?.upstream.sourceId ? { sourceId: configured.upstream.sourceId } : {}),
          ...(configured?.upstream.trust ? { trust: configured.upstream.trust } : {}),
          ...(configured?.upstream.antseedPeerId ? { antseedPeerId: configured.upstream.antseedPeerId } : {}),
        },
        model: options.model as string,
        contrastModels: configured?.contrastModels ?? [],
        policy: configured?.policy ?? resolveReferencePolicy(config.verifier?.referencePolicy),
      }
      const storage = new VerificationStorage(join(globalOpts.dataDir, 'verification.db'))
      try {
        const references = await loadReferences(referencesDir, (message) => console.warn(chalk.yellow(message)), {
          trustedImportedReferenceIds: config.verifier?.trustedImportedReferenceIds,
        })
        const imported = importAdaptiveReferences({ storage, service, source, references })
        const result = await certifyNewProbes({
          storage,
          service,
          source,
          requiredCount: options.probes as number,
          minimumCertifiedCount: options.probes as number,
          referencesDir,
          log: (message) => console.log(chalk.dim(`[catalog] ${message}`)),
        })
        console.log(chalk.green(`Certified probe catalog warmed for ${service}`))
        console.log(chalk.dim(`  imported: ${imported.probes}`))
        console.log(chalk.dim(`  generated: ${result.generated}; inserted: ${result.inserted}; known: ${result.known}`))
        console.log(chalk.dim(`  rejected: ${result.rejected}; unhealthy: ${result.unhealthy}`))
        console.log(chalk.dim(`  requests: ${result.requestCount}; retries: ${result.retryCount}; failures: ${result.failureCount}`))
      } catch (error) {
        console.error(chalk.red(`Catalog build failed: ${(error as Error).message}`))
        process.exitCode = 1
      } finally {
        storage.close()
      }
    })
}
