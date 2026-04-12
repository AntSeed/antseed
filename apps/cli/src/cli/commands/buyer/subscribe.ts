import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createSubPoolClient,
  loadCryptoContext,
  formatUsdc,
} from '../../payment-utils.js';

export function registerBuyerSubscribeCommand(buyerCmd: Command): void {
  const subscribe = buyerCmd
    .command('subscribe')
    .description('Manage subscription pool membership');

  subscribe
    .command('join <tierId>')
    .description('Subscribe to a tier')
    .action(async (tierIdStr: string) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);

      const tierId = parseInt(tierIdStr, 10);
      if (isNaN(tierId) || tierId < 0) {
        console.error(chalk.red('Error: tierId must be a non-negative integer.'));
        process.exit(1);
      }

      const spinner = ora('Fetching tier info...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const subPoolClient = createSubPoolClient(config);

        console.log(chalk.dim(`Wallet: ${address}`));

        const tier = await subPoolClient.getTier(tierId);
        if (!tier.active) {
          spinner.fail(chalk.red(`Tier ${tierId} is not active.`));
          return;
        }

        console.log(chalk.dim(`Tier ${tierId}: ${formatUsdc(tier.monthlyFee)} USDC/month, ${tier.dailyTokenBudget.toString()} tokens/day`));

        spinner.text = 'Subscribing...';
        const txHash = await subPoolClient.subscribe(wallet, tierId);
        spinner.succeed(chalk.green(`Subscribed to tier ${tierId}`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Subscribe failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  subscribe
    .command('status')
    .description('Check subscription status')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Checking subscription...').start();

      try {
        const { address } = await loadCryptoContext(globalOpts.dataDir);
        const subPoolClient = createSubPoolClient(config);

        const [active, remaining] = await Promise.all([
          subPoolClient.isSubscriptionActive(address),
          subPoolClient.getRemainingDailyBudget(address),
        ]);

        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify({
            address,
            active,
            remainingDailyBudget: remaining.toString(),
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Subscription Status:\n'));
        console.log(`  Active:                 ${active ? chalk.green('Yes') : chalk.red('No')}`);
        console.log(`  Remaining daily budget: ${chalk.cyan(remaining.toString() + ' tokens')}`);
      } catch (err) {
        spinner.fail(chalk.red(`Status check failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  subscribe
    .command('cancel')
    .description('Cancel your subscription')
    .action(async () => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Cancelling subscription...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const subPoolClient = createSubPoolClient(config);

        console.log(chalk.dim(`Wallet: ${address}`));

        const txHash = await subPoolClient.cancelSubscription(wallet);
        spinner.succeed(chalk.green('Subscription cancelled'));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Cancel failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
