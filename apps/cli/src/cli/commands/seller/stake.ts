import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createStakingClient,
  createIdentityClient,
  loadCryptoContext,
  formatUsdc,
  parseUsdcToBaseUnits,
  resolveCliContractStack,
  createLegacyStakingClient,
} from '../../payment-utils.js';
import { runPoolStake } from './pool.js';

type GlobalOptions = ReturnType<typeof getGlobalOptions>;

async function runLegacyStake(
  global: GlobalOptions,
  amount: string,
  options: { agentId?: number },
): Promise<void> {
  const config = await loadConfig(global.config);

  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = parseUsdcToBaseUnits(amount);
  } catch {
    console.error(chalk.red('Error: Amount must be a positive number.'));
    process.exit(1);
  }

  const spinner = ora('Verifying registration...').start();

  try {
    const stack = await resolveCliContractStack(config);
    if (stack.mode === 'recognized-usage') {
      spinner.fail(chalk.red('Legacy USDC staking is closed after cutover. Use: antseed seller stake <ants> --epochs <n>'));
      process.exit(1);
    }
    const { wallet, address } = await loadCryptoContext(global.dataDir);
    const stakingClient = createStakingClient(config);
    const identityClient = createIdentityClient(config);
    const isReg = await identityClient.isRegistered(address);
    if (!isReg) {
      spinner.fail(chalk.red('Not registered. Run: antseed seller register'));
      process.exit(1);
    }

    // Look up agentId from staking contract, or use --agent-id for first-time staking
    let agentId = await stakingClient.getAgentId(address);
    if (agentId === 0 && options.agentId) {
      agentId = options.agentId;
    }
    if (agentId === 0) {
      spinner.fail(chalk.red('No agentId found. Pass --agent-id <id> from your antseed seller register output.'));
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
}

async function runLegacyUnstake(global: GlobalOptions): Promise<void> {
  const config = await loadConfig(global.config);
  const spinner = ora('Fetching stake info...').start();

  try {
    const stack = await resolveCliContractStack(config);
    const { wallet, address } = await loadCryptoContext(global.dataDir);
    const stakingClient = stack.mode === 'recognized-usage'
      ? createLegacyStakingClient(config)
      : createStakingClient(config);
    console.log(chalk.dim(`Wallet: ${address}`));
    if (stack.mode === 'recognized-usage') {
      console.log(chalk.yellow('⚠ Withdrawing legacy USDC stake may remove temporary post-cutover eligibility until your ANTS pool is active.'));
    }
    const stake = await stakingClient.getStake(address);
    if (stake === 0n) {
      spinner.fail(chalk.yellow('No active stake to withdraw.'));
      return;
    }

    console.log(chalk.dim(`Current stake: ${formatUsdc(stake)} USDC`));

    spinner.text = 'Unstaking...';
    const txHash = await stakingClient.unstake(wallet);
    spinner.succeed(chalk.green('Unstaked successfully'));
    console.log(chalk.dim(`Transaction: ${txHash}`));
  } catch (err) {
    spinner.fail(chalk.red(`Unstake failed: ${(err as Error).message}`));
    process.exit(1);
  }
}

export function registerSellerStakeCommand(sellerCmd: Command): void {
  sellerCmd
    .command('stake <amount>')
    .description('Stake as a provider — ANTS into your seller pool after cutover, USDC before it')
    .option('--epochs <n>', 'ANTS lock duration in epochs (recognized-usage stack)', (value) => Number(value))
    .option('--agent-id <id>', 'seller agent ID (from antseed seller register output)', parseInt)
    .action(async (amount: string, options: { epochs?: number; agentId?: number }) => {
      const globalOpts = getGlobalOptions(sellerCmd);
      const config = await loadConfig(globalOpts.config);
      const stack = await resolveCliContractStack(config);

      if (stack.mode === 'recognized-usage') {
        if (options.epochs === undefined) {
          console.error(chalk.red('ANTS pool staking requires a lock duration. Use: antseed seller stake <ants> --epochs <n>'));
          process.exit(1);
        }
        await runPoolStake(globalOpts, amount, { epochs: options.epochs, agentId: options.agentId });
        return;
      }

      if (options.epochs !== undefined) {
        console.error(chalk.red('--epochs applies to ANTS pool staking, which is only available after the recognized-usage cutover.'));
        process.exit(1);
      }
      await runLegacyStake(globalOpts, amount, { agentId: options.agentId });
    });

  sellerCmd
    .command('unstake')
    .description('Withdraw legacy USDC stake (alias of `antseed seller legacy unstake`)')
    .action(async () => {
      await runLegacyUnstake(getGlobalOptions(sellerCmd));
    });

  const legacy = sellerCmd.command('legacy').description('Legacy USDC staking commands');

  legacy
    .command('stake <amount>')
    .description('Stake USDC as a provider (legacy stack only, e.g. "10" = 10 USDC)')
    .option('--agent-id <id>', 'ERC-8004 agent ID (from antseed seller register output)', parseInt)
    .action(async (amount: string, options: { agentId?: number }) => {
      await runLegacyStake(getGlobalOptions(legacy), amount, options);
    });

  legacy
    .command('unstake')
    .description('Withdraw legacy USDC stake (subject to slash conditions)')
    .action(async () => {
      await runLegacyUnstake(getGlobalOptions(legacy));
    });
}
