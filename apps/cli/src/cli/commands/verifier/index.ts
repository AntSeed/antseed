import type { Command } from 'commander'
import { registerVerifierClaimCommand } from './claim.js'
import { registerVerifierRunCommand } from './run.js'

export function registerVerifierCommands(program: Command): void {
  const verifier = program
    .command('verifier')
    .description('Run paid model verification and claim verifier rewards')
  registerVerifierRunCommand(verifier)
  registerVerifierClaimCommand(verifier)
}
