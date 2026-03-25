import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  loadOrCreateIdentity,
  DepositsClient,
  identityToEvmWallet,
  identityToEvmAddress,
} from '@antseed/node';

export function registerWithdrawCommand(program: Command): void {
  program
    .command('withdraw <amount>')
    .description('Withdraw USDC from the deposits contract (amount in human-readable USDC, e.g. "5" = 5 USDC)')
    .action(async (amount: string) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const payments = config.payments;
      if (!payments?.crypto) {
        console.error(chalk.red('Error: No crypto payment configuration found.'));
        console.error(chalk.dim('Configure payments.crypto in your config file or run: antseed init'));
        process.exit(1);
      }

      const amountFloat = parseFloat(amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        console.error(chalk.red('Error: Amount must be a positive number.'));
        process.exit(1);
      }

      // Convert human-readable USDC to base units (6 decimals)
      const amountBaseUnits = BigInt(Math.round(amountFloat * 1_000_000));

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const wallet = identityToEvmWallet(identity);
      const address = identityToEvmAddress(identity);

      const depositsClient = new DepositsClient({
        rpcUrl: payments.crypto.rpcUrl,
        contractAddress: payments.crypto.depositsContractAddress,
        usdcAddress: payments.crypto.usdcContractAddress,
      });

      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Withdrawing USDC from deposits contract...').start();

      try {
        const txHash = await depositsClient.requestWithdrawal(wallet, amountBaseUnits);
        spinner.succeed(chalk.green(`Withdrawal requested for ${amountFloat} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Withdrawal failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
