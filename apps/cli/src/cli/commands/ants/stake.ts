import type { Command } from 'commander';
import { stake } from '@antseed/ants';
import { ants, runAction } from './shared.js';

export function registerAntsStakeCommand(antsCmd: Command): void {
  antsCmd
    .command('stake <amount>')
    .description('Stake ANTS into a seller agent pool (creates a locked lANTS position)')
    .requiredOption('--agent <agentId>', 'agent ID of the seller pool', parseInt)
    .requiredOption('--epochs <n>', 'lock length in epochs (1 epoch = 1 week)', parseInt)
    .action(async (amount: string, options: { agent: number; epochs: number }) => runAction(antsCmd, 'Staking...', async ({ ctx }, report) => {
      const result = await stake(ctx, { agentId: options.agent, amount, epochs: options.epochs }, report);
      return `Staked ${ants(result.amount)} into agent ${result.agentId} for ${result.epochs} epoch(s); power activates next epoch`;
    }));
}
