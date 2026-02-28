import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { loadOrCreateIdentity, identityToEvmAddress } from '@antseed/node';
import { createEscrowClient } from '../payment-utils.js';
import { formatUsdc } from '../formatters.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Show escrow balance for your wallet')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      if (!payments?.crypto) {
        console.error(chalk.red('Error: No crypto payment configuration found.'));
        console.error(chalk.dim('Configure payments.crypto in your config file or run: antseed init'));
        process.exit(1);
      }

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const address = identityToEvmAddress(identity);

      const escrowClient = createEscrowClient(payments.crypto);

      const spinner = ora('Fetching balance...').start();

      try {
        const balance = await escrowClient.getBuyerBalance(address);
        const usdcBalance = await escrowClient.getUSDCBalance(address);

        spinner.stop();

        const withdrawalReady = balance.withdrawalReadyAt > 0
          ? new Date(balance.withdrawalReadyAt * 1000).toLocaleString()
          : null;

        if (options.json) {
          console.log(JSON.stringify({
            address,
            walletUSDC:        formatUsdc(usdcBalance),
            escrowAvailable:   formatUsdc(balance.available),
            pendingWithdrawal: formatUsdc(balance.pendingWithdrawal),
            withdrawalReadyAt: withdrawalReady,
          }, null, 2));
          return;
        }

        console.log(chalk.bold('Wallet: ') + chalk.cyan(address));
        console.log('');
        console.log(chalk.bold('USDC Balance (wallet): ') + chalk.green(formatUsdc(usdcBalance) + ' USDC'));
        console.log('');
        console.log(chalk.bold('Escrow Account:'));
        console.log(`  Available:         ${chalk.green(formatUsdc(balance.available) + ' USDC')}`);
        console.log(`  Pending withdrawal: ${chalk.yellow(formatUsdc(balance.pendingWithdrawal) + ' USDC')}`);
        if (withdrawalReady) {
          console.log(`  Withdrawal ready:   ${chalk.dim(withdrawalReady)}`);
        }
      } catch (err) {
        spinner.fail(chalk.red(`Failed to fetch balance: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
