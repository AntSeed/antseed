import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { identityToEvmAddress, loadOrCreateIdentity } from '@antseed/node';
import { createIdentityClient } from '../payment-utils.js';

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

      const identityClient = createIdentityClient(config);

      const spinner = ora('Fetching reputation data...').start();

      try {
        const isReg = await identityClient.isRegistered(address);
        if (!isReg) {
          spinner.fail(chalk.yellow(`Address ${address} is not registered.`));
          return;
        }

        const tokenId = await identityClient.getTokenId(address);
        const reputation = await identityClient.getReputation(tokenId);

        // Try to get feedback summary for common tags
        let qualityFeedback = { count: 0, summaryValue: 0n, summaryValueDecimals: 0 };
        try {
          qualityFeedback = await identityClient.getFeedbackSummary(tokenId, 'quality');
        } catch {
          // Feedback may not exist yet
        }

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            tokenId,
            reputation: {
              sessionCount: reputation.sessionCount,
              ghostCount: reputation.ghostCount,
              totalSettledVolume: reputation.totalSettledVolume.toString(),
              totalInputTokens: reputation.totalInputTokens.toString(),
              totalOutputTokens: reputation.totalOutputTokens.toString(),
              lastSettledAt: reputation.lastSettledAt,
            },
            feedback: {
              quality: {
                count: qualityFeedback.count,
                summaryValue: qualityFeedback.summaryValue.toString(),
              },
            },
          }, null, 2));
          return;
        }

        console.log(chalk.bold(`Reputation for ${address.slice(0, 10)}...\n`));
        console.log(`  Token ID:                    ${chalk.cyan(String(tokenId))}`);
        console.log('');
        console.log(chalk.bold('  Settlement History:'));
        console.log(`    Settled sessions:           ${chalk.green(String(reputation.sessionCount))}`);
        console.log(`    Ghost sessions:             ${chalk.red(String(reputation.ghostCount))}`);
        console.log(`    Total settled volume:        ${chalk.dim(reputation.totalSettledVolume.toString() + ' USDC base units')}`);
        console.log(`    Total input tokens:          ${chalk.dim(reputation.totalInputTokens.toString())}`);
        console.log(`    Total output tokens:         ${chalk.dim(reputation.totalOutputTokens.toString())}`);
        if (reputation.lastSettledAt > 0) {
          console.log(`    Last settled at:             ${chalk.dim(new Date(reputation.lastSettledAt * 1000).toISOString())}`);
        }
        console.log('');
        console.log(chalk.bold('  Feedback:'));
        if (qualityFeedback.count > 0) {
          console.log(`    Quality:  ${qualityFeedback.count} reviews (score: ${qualityFeedback.summaryValue.toString()})`);
        } else {
          console.log(chalk.dim('    No feedback yet.'));
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch reputation: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
