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
              firstSignCount: reputation.firstSignCount,
              qualifiedProvenSignCount: reputation.qualifiedProvenSignCount,
              unqualifiedProvenSignCount: reputation.unqualifiedProvenSignCount,
              ghostCount: reputation.ghostCount,
              totalQualifiedTokenVolume: reputation.totalQualifiedTokenVolume.toString(),
              lastProvenAt: reputation.lastProvenAt,
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
        console.log(chalk.bold('  Proof Chain:'));
        console.log(`    First signs:               ${chalk.green(String(reputation.firstSignCount))}`);
        console.log(`    Qualified proven signs:     ${chalk.green(String(reputation.qualifiedProvenSignCount))}`);
        console.log(`    Unqualified proven signs:   ${chalk.yellow(String(reputation.unqualifiedProvenSignCount))}`);
        console.log(`    Ghost sessions:             ${chalk.red(String(reputation.ghostCount))}`);
        console.log(`    Total qualified volume:     ${chalk.dim(reputation.totalQualifiedTokenVolume.toString() + ' tokens')}`);
        if (reputation.lastProvenAt > 0) {
          console.log(`    Last proven at:             ${chalk.dim(new Date(reputation.lastProvenAt * 1000).toISOString())}`);
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
