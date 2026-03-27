import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';
import {
  createStakingClient,
  createIdentityClient,
  loadCryptoContext,
  formatUsdc,
  parseUsdcToBaseUnits,
} from '../payment-utils.js';

export function registerStakeCommand(program: Command): void {
  program
    .command('stake <amount>')
    .description('Stake USDC as a provider (amount in human-readable USDC, e.g. "10" = 10 USDC)')
    .action(async (amount: string) => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = parseUsdcToBaseUnits(amount);
      } catch {
        console.error(chalk.red('Error: Amount must be a positive number.'));
        process.exit(1);
      }

      const spinner = ora('Verifying registration...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const stakingClient = createStakingClient(config);
        const identityClient = createIdentityClient(config);
        const isReg = await identityClient.isRegistered(address);
        if (!isReg) {
          spinner.fail(chalk.red('Not registered. Run: antseed register'));
          process.exit(1);
        }

        // Look up agentId from staking contract (set during stakeFor or previous stake)
        // If not yet staked, we need the agentId from registration. For first stake,
        // the user should have registered first; we can try getAgentId which returns 0 if not set.
        let agentId = await stakingClient.getAgentId(address);
        if (agentId === 0) {
          // First-time staker: agentId not yet recorded. We need the user to provide it
          // or derive from registry. For now, use 0 which will be set by stakeFor flow.
          spinner.fail(chalk.red('No agentId found. Register first with: antseed register, then use the stakeFor flow.'));
          process.exit(1);
        }

        const amountFloat = parseFloat(amount);
        console.log(chalk.dim(`Wallet: ${address}`));
        console.log(chalk.dim(`Agent ID: ${agentId}`));
        console.log(chalk.dim(`Amount: ${amountFloat} USDC (${amountBaseUnits} base units)`));

        spinner.text = 'Staking USDC...';
        const txHash = await stakingClient.stake(wallet, agentId, amountBaseUnits);
        spinner.succeed(chalk.green(`Staked ${amountFloat} USDC`));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Staking failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  program
    .command('unstake')
    .description('Unstake USDC (subject to slash conditions)')
    .action(async () => {
      const globalOpts = getGlobalOptions(program);
      const config = await loadConfig(globalOpts.config);

      const spinner = ora('Fetching stake info...').start();

      try {
        const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
        const stakingClient = createStakingClient(config);
        console.log(chalk.dim(`Wallet: ${address}`));
        const account = await stakingClient.getSellerAccount(address);
        if (account.stake === 0n) {
          spinner.fail(chalk.yellow('No active stake to withdraw.'));
          return;
        }

        console.log(chalk.dim(`Current stake: ${formatUsdc(account.stake)} USDC`));

        spinner.text = 'Unstaking...';
        const txHash = await stakingClient.unstake(wallet);
        spinner.succeed(chalk.green('Unstaked successfully'));
        console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        spinner.fail(chalk.red(`Unstake failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
