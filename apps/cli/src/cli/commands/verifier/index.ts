import type { Command } from 'commander'
import { registerVerifierClaimCommand } from './claim.js'
import { registerVerifierReferenceCommand } from './reference.js'
import { registerVerifierRunCommand } from './run.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run buyer-proxy model verification and manage verifier references')
  registerVerifierRunCommand(verifier)
  registerVerifierReferenceCommand(verifier)
  registerVerifierClaimCommand(verifier)
}
