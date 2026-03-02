import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import { loadOrCreateIdentity, identityToEvmWallet, identityToEvmAddress } from '@antseed/node';
import { createEscrowClient, parseUsdcToBaseUnits } from '../payment-utils.js';

export function registerDepositCommand(program: Command): void {
  program
    .command('deposit <amount>')
    .description('Deposit USDC into the escrow contract (amount in human-readable USDC, e.g. "5" = 5 USDC)')
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

      const amountBaseUnits = parseUsdcToBaseUnits(amountFloat);

      const identity = await loadOrCreateIdentity(globalOpts.dataDir);
      const wallet = identityToEvmWallet(identity);
      const address = identityToEvmAddress(identity);
      const escrowClient = createEscrowClient(payments.crypto);

      console.log(chalk.dim(`Wallet: ${address}`));
      console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

      const spinner = ora('Depositing USDC into escrow...').start();

      try {
        const txHash = await escrowClient.deposit(wallet, amountBaseUnits);
        spinner.succeed(chalk.green(`Deposited ${amountFloat} USDC into escrow`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Deposit failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
