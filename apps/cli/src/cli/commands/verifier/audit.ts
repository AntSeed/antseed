import chalk from 'chalk'
import type { Command } from 'commander'
import { peerIdToAddress } from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import { advertisedServices } from '../../../verifier/service-discovery.js'
import {
  executeVerifierAudit,
  startVerifierRuntime,
} from '../../../verifier/runtime.js'
import { getGlobalOptions } from '../types.js'

export function registerVerifierAuditCommand(verifierCmd: Command): void {
  verifierCmd
    .command('audit')
    .description('Run one paid direct audit and submit its final attestation immediately')
    .requiredOption('--service <id>', 'exact advertised service/model id')
    .requiredOption('--peer <peer-id>', 'target seller peer id')
    .option('--rpc-url <url>', 'runtime JSON-RPC override')
    .option('--evidence-uri <uri>', 'publish this evidence URI after a successful attestation')
    .action(async (options, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const runtime = await startVerifierRuntime({
        config,
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        ...(options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}),
      })
      try {
        const requestedPeerId = String(options.peer).trim().toLowerCase().replace(/^0x/, '')
        let target = await runtime.node.findPeer(requestedPeerId)
        if (!target) {
          const peers = await runtime.node.discoverPeers(String(options.service))
          target = peers.find((peer) => peer.peerId.toLowerCase() === requestedPeerId) ?? null
        }
        if (!target) throw new Error(`target ${requestedPeerId} is not currently discoverable`)
        if (peerIdToAddress(target.peerId).toLowerCase() === runtime.identity.wallet.address.toLowerCase()) {
          throw new Error('verifiers cannot audit their own seller identity')
        }
        const normalizedService = String(options.service).trim().toLowerCase()
        const advertisedService = advertisedServices(target).get(normalizedService)
        if (!advertisedService) throw new Error(`target does not advertise service ${options.service}`)
        const [epoch, minimumProbeCount] = await Promise.all([
          runtime.chain.registryClient.currentEpoch(),
          runtime.chain.registryClient.minProbeCount(),
        ])
        const result = await executeVerifierAudit({
          runtime,
          target,
          service: advertisedService,
          source: 'manual',
          epoch,
          minimumProbeCount,
          ...(options.evidenceUri ? { evidenceUri: String(options.evidenceUri) } : {}),
          warn: (message) => console.warn(chalk.yellow(`[verifier] ${message}`)),
          log: (message) => console.log(chalk.dim(`[verifier] ${message}`)),
        })
        console.log(chalk.green(`Attested direct audit ${result.auditId}`))
        console.log(chalk.dim(`  verdict: ${verdictName(result.verdict)} (${result.modelShareBps} bps model share)`))
        console.log(chalk.dim(`  probes: ${result.authenticatedProbeCount}/${result.probeCount} authenticated`))
        console.log(chalk.dim(`  credited: ${result.credited === null ? 'unknown' : result.credited ? 'yes' : 'no'}`))
        console.log(chalk.dim(`  evidence: ${result.evidencePath}`))
        console.log(chalk.dim(`  transaction: ${result.attestationTxHash}`))
      } finally {
        await runtime.node.stop()
      }
    })
}

function verdictName(verdict: number): string {
  if (verdict === 1) return 'SAME'
  if (verdict === 2) return 'DIFF'
  return 'UNDETERMINED'
}
