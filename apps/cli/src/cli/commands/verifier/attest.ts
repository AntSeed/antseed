import type { Command } from 'commander'
import chalk from 'chalk'
import { join } from 'node:path'
import {
  ChannelsClient,
  StakingClient,
  VerificationStorage,
  indexFinalizedChannelSettlements,
} from '@antseed/node'
import { getGlobalOptions } from '../types.js'
import { loadConfig } from '../../../config/loader.js'
import { loadCryptoContext } from '../../payment-utils.js'
import { loadReferences } from '../../../verifier/references.js'
import { loadReservedReferenceSubset } from '../../../verifier/reference-subset.js'
import {
  ATTEST_NOT_READY_EXIT_CODE,
  AuditNotReadyError,
  attestReferenceAudit,
} from '../../../verifier/attestation.js'
import { resolveVerificationChain } from '../verification-chain.js'

export function registerVerifierAttestCommand(verifierCmd: Command): void {
  verifierCmd
    .command('attest')
    .description('Validate a completed relay audit and submit its reference KBF attestation')
    .requiredOption('--audit-id <id>', 'committed audit id')
    .option('--no-wait', 'return exit code 3 when the audit epoch is not complete')
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .action(async (options, command: Command) => {
      const globalOpts = getGlobalOptions(command)
      const config = await loadConfig(globalOpts.config)
      const storage = new VerificationStorage(join(globalOpts.dataDir, 'verification.db'))
      try {
        const plan = storage.getAuditPlan(String(options.auditId))
        if (!plan) throw new Error(`unknown audit ${String(options.auditId)}`)
        const references = await loadReferences(
          config.verifier?.referencesDir ?? join(globalOpts.dataDir, 'fingerprints', 'references'),
          (message) => console.warn(chalk.yellow(message)),
          { trustedImportedReferenceIds: config.verifier?.trustedImportedReferenceIds },
        )
        const fullReference = references.find((candidate) => candidate.referenceId === plan.referenceId)
        if (!fullReference) throw new Error(`trusted reference ${plan.referenceId} is unavailable`)
        const reference = loadReservedReferenceSubset(storage, plan.auditId, fullReference)
        const { identity } = await loadCryptoContext(globalOpts.dataDir)
        const chain = resolveVerificationChain(config, options.rpcUrl as string | undefined)
        if (!chain.chain.stakingContractAddress) throw new Error('staking contract address is required for usage attribution')
        const channelsClient = new ChannelsClient({
          rpcUrl: chain.chain.rpcUrl,
          ...(chain.chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.chain.fallbackRpcUrls } : {}),
          contractAddress: chain.chain.channelsContractAddress,
          evmChainId: chain.chain.evmChainId,
        })
        const stakingClient = new StakingClient({
          rpcUrl: chain.chain.rpcUrl,
          ...(chain.chain.fallbackRpcUrls ? { fallbackRpcUrls: chain.chain.fallbackRpcUrls } : {}),
          contractAddress: chain.chain.stakingContractAddress,
          usdcAddress: chain.chain.usdcContractAddress,
          evmChainId: chain.chain.evmChainId,
        })
        const result = await attestReferenceAudit({
          registryClient: chain.registryClient,
          treasuryClient: chain.treasuryClient,
          storage,
          signer: identity.wallet,
          dataDir: globalOpts.dataDir,
          refreshUsageAttribution: async () => {
            await indexFinalizedChannelSettlements({
              chainId: String(chain.chain.evmChainId),
              channelsClient,
              stakingClient,
              storage,
              startBlock: chain.chain.channelsDeployBlock ?? 0,
              confirmationBlocks: chain.chain.chainId === 'base-local' ? 0 : 20,
              warn: (message) => console.warn(chalk.yellow(message)),
            })
            return true
          },
        }, {
          auditId: plan.auditId,
          reference,
          fullReference,
          wait: options.wait !== false,
        })
        console.log(chalk.green(`Attested ${plan.auditId}: ${result.verdict}`))
        console.log(chalk.dim(`  relay claims: ${result.submittedClaims} submitted, ${result.alreadyPaidClaims} already paid`))
        console.log(chalk.dim(`  evidence: ${result.evidencePath}`))
        console.log(chalk.dim(`  tx: ${result.attestationTxHash}`))
      } catch (error) {
        if (error instanceof AuditNotReadyError) {
          console.error(chalk.yellow(error.message))
          process.exitCode = ATTEST_NOT_READY_EXIT_CODE
        } else {
          console.error(chalk.red((error as Error).message))
          process.exitCode = 1
        }
      } finally {
        storage.close()
      }
    })
}
