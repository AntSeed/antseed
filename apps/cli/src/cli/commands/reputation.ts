import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { identityToEvmAddress, loadOrCreateIdentity } from '@antseed/node';
import { createStakingClient, createStatsClient } from '../payment-utils.js';

export function registerReputationCommand(program: Command): void {
  program
    .command('reputation [address]')
    .description('View on-chain reputation for an address (defaults to your own)')
    .option('--json', 'output as JSON', false)
    .action(async (targetAddress: string | undefined, options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      let address: string;
      if (targetAddress) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(targetAddress)) {
          console.error(chalk.red('Error: Invalid Ethereum address format. Expected 0x followed by 40 hex characters.'));
          process.exit(1);
        }
        address = targetAddress;
      } else {
        const identity = await loadOrCreateIdentity(globalOpts.dataDir);
        address = identityToEvmAddress(identity);
      }

      const stakingClient = createStakingClient(config);
      const statsClient = createStatsClient(config);

      const spinner = ora('Fetching reputation data...').start();

      try {
        const agentId = await stakingClient.getAgentId(address);
        if (agentId === 0) {
          spinner.fail(chalk.yellow(`Address ${address} has no staked agent (not registered or not staked).`));
          return;
        }

        const tokenId = agentId;
        const stats = await statsClient.getStats(tokenId);

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            tokenId,
            stats: {
              sessionCount: stats.sessionCount,
              ghostCount: stats.ghostCount,
              totalVolumeUsdc: stats.totalVolumeUsdc.toString(),
              totalInputTokens: stats.totalInputTokens.toString(),
              totalOutputTokens: stats.totalOutputTokens.toString(),
              totalLatencyMs: stats.totalLatencyMs.toString(),
              totalRequestCount: stats.totalRequestCount,
              lastSettledAt: stats.lastSettledAt,
            },
          }, null, 2));
          return;
        }

        console.log(chalk.bold(`Reputation for ${address.slice(0, 10)}...\n`));
        console.log(`  Token ID:                    ${chalk.cyan(String(tokenId))}`);
        console.log('');
        console.log(chalk.bold('  Settlement History:'));
        console.log(`    Settled sessions:           ${chalk.green(String(stats.sessionCount))}`);
        console.log(`    Ghost sessions:             ${chalk.red(String(stats.ghostCount))}`);
        console.log(`    Total volume:                ${chalk.dim(stats.totalVolumeUsdc.toString() + ' USDC base units')}`);
        console.log(`    Total input tokens:          ${chalk.dim(stats.totalInputTokens.toString())}`);
        console.log(`    Total output tokens:         ${chalk.dim(stats.totalOutputTokens.toString())}`);
        console.log(`    Total requests:              ${chalk.dim(String(stats.totalRequestCount))}`);
        if (stats.lastSettledAt > 0) {
          console.log(`    Last settled at:             ${chalk.dim(new Date(stats.lastSettledAt * 1000).toISOString())}`);
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch reputation: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
