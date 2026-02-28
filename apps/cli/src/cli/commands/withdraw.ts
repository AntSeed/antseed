import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { loadOrCreateIdentity, identityToEvmWallet, identityToEvmAddress } from '@antseed/node';
import { createEscrowClient, parseUsdcToBaseUnits } from '../payment-utils.js';

export function registerWithdrawCommand(program: Command): void {
  program
    .command('withdraw [amount]')
    .description(
      'Withdraw USDC from the escrow contract.\n' +
      '  Step 1: antseed withdraw <amount>   — request withdrawal (1-hour timelock starts)\n' +
      '  Step 2: antseed withdraw --execute   — execute after the timelock expires',
    )
    .option('--execute', 'execute a previously requested withdrawal after the 1-hour timelock')
    .action(async (amount: string | undefined, options: { execute?: boolean }) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      if (!payments?.crypto) {
        console.error(chalk.red('Error: No crypto payment configuration found.'));
        console.error(chalk.dim('Configure payments.crypto in your config file or run: antseed init'));
        process.exit(1);
      }

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const wallet = identityToEvmWallet(identity);
      const address = identityToEvmAddress(identity);

      const escrowClient = createEscrowClient(payments.crypto);

      if (options.execute) {
        // Step 2: execute a previously-requested withdrawal
        const spinner = ora('Executing withdrawal...').start();
        try {
          const txHash = await escrowClient.executeWithdrawal(wallet);
          spinner.succeed(chalk.green('Withdrawal executed — USDC sent to your wallet'));
          console.log(chalk.dim(`Transaction: ${txHash}`));
        } catch (err) {
          spinner.fail(chalk.red(`Withdrawal failed: ${(err as Error).message}`));
          process.exit(1);
        }
        return;
      }

      // Step 1: request a withdrawal (starts the 1-hour timelock)
      if (!amount) {
        console.error(chalk.red('Error: Amount is required. Usage: antseed withdraw <amount>'));
        process.exit(1);
      }

      const amountFloat = parseFloat(amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        console.error(chalk.red('Error: Amount must be a positive number.'));
        process.exit(1);
      }

      const amountBaseUnits = parseUsdcToBaseUnits(amountFloat);

      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Requesting withdrawal from escrow...').start();

      try {
        const txHash = await escrowClient.requestWithdrawal(wallet, amountBaseUnits);
        spinner.succeed(chalk.green(`Withdrawal of ${amountFloat} USDC requested`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log('');
        console.log(chalk.yellow('A 1-hour timelock is now active.'));
        console.log(chalk.dim('After it expires, run: ') + chalk.bold('antseed withdraw --execute'));
      } catch (err) {
        spinner.fail(chalk.red(`Withdrawal request failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
