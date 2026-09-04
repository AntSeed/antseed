import type { Command } from 'commander';
import { isAddress, ZeroAddress } from 'ethers';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createAntsTokenClient,
  createLegacyStakingClient,
  createPositionInitClient,
  createSellerPoolsClient,
  createSellerPoolsRewardsClient,
  createSellerRegistryClient,
  formatAnts,
  formatAntsExact,
  loadCryptoContext,
  parseAntsToBaseUnits,
  resolveCliContractStack,
} from '../../payment-utils.js';
import type { SellerPoolPosition } from '@antseed/node/payments';
import { claimPoolRewards, previewPoolRewards, RewardClaimProgress } from '../reward-actions.js';
import { requireSellerBinding } from '../../seller-contract-clients.js';

export function positionState(position: SellerPoolPosition, currentEpoch: number): string {
  if (position.withdrawn) return 'withdrawn';
  if (position.closedAtEpoch !== 0) return 'closed';
  if (currentEpoch < position.stakeStartEpoch) return 'pending';
  if (currentEpoch < position.stakeEndEpoch) return 'active';
  return 'matured';
}

export function validateStakeEpochs(epochs: number, min: number, max: number): void {
  if (!Number.isInteger(epochs) || epochs < min || epochs > max) {
    throw new Error(`--epochs must be an integer between ${min} and ${max}`);
  }
}

async function requirePoolStack(config: Awaited<ReturnType<typeof loadConfig>>) {
  const stack = await resolveCliContractStack(config);
  if (stack.mode !== 'recognized-usage') {
    throw new Error('Seller pool commands are available after the recognized-usage upgrade.');
  }
  return stack;
}

export interface EarlyExitEstimate {
  id: number;
  amount: bigint;
  slashBps: number;
  slashedAmount: bigint;
  returnedAmount: bigint;
}

export function estimateEarlyExit(position: SellerPoolPosition, slashBps: number): EarlyExitEstimate {
  const slashedAmount = position.amount * BigInt(slashBps) / 10_000n;
  return {
    id: position.id,
    amount: position.amount,
    slashBps,
    slashedAmount,
    returnedAmount: position.amount - slashedAmount,
  };
}

async function confirmEarlyExit(totalSlashed: bigint): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Early withdrawal needs interactive confirmation. Re-run in a terminal, or add --yes after reviewing the slashing estimate.');
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(chalk.red(`Withdraw with an estimated burn of ${formatAntsExact(totalSlashed)} ANTS? [y/N] `));
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('Withdrawal cancelled.');
  } finally {
    input.close();
  }
}

export function registerSellerPoolCommand(sellerCmd: Command): void {
  const pool = sellerCmd.command('pool').description('Manage ANTS staking positions');

  pool.command('claim-starter').aliases(['bootstrap', 'init']).description('Claim the legacy-seller starter ANTS position').action(async () => {
    const global = getGlobalOptions(pool);
    const config = await loadConfig(global.config);
    const spinner = ora('Checking starter position...').start();
    try {
      await requirePoolStack(config);
      const { wallet, address } = await loadCryptoContext(global.dataDir);
      const legacyStaking = createLegacyStakingClient(config);
      const agentId = await legacyStaking.getAgentId(address);
      if (!agentId) throw new Error('No legacy seller agent ID found for this wallet.');
      const init = createPositionInitClient(config);
      if (await init.agentInitialized(agentId)) {
        spinner.succeed(chalk.yellow(`Starter position already initialized for agent ${agentId}.`));
        return;
      }
      const [remaining, amount, endEpoch] = await Promise.all([init.remainingInits(), init.initAmount(), init.initEndEpoch()]);
      if (remaining === 0n) throw new Error('Starter position pool is depleted.');
      spinner.text = `Creating ${formatAnts(amount)} ANTS starter position...`;
      const txHash = await init.initPosition(wallet);
      spinner.succeed(chalk.green(`Starter position created for agent ${agentId} through epoch ${endEpoch}`));
      console.log(chalk.dim(`Transaction: ${txHash}`));
    } catch (error) {
      spinner.fail(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  pool.command('positions').description('List your seller-pool positions').option('--json', 'output as JSON', false).action(async (options) => {
    const global = getGlobalOptions(pool);
    const config = await loadConfig(global.config);
    try {
      const stack = await requirePoolStack(config);
      const { address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const ids = await pools.allStakerPositionIds(address);
      const positions = await Promise.all(ids.map(async (id) => {
        const position = await pools.position(id);
        return { ...position, state: positionState(position, stack.currentEpoch), withdrawableEpoch: await pools.positionWithdrawableEpoch(id) };
      }));
      if (options.json) {
        console.log(JSON.stringify(positions, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
        return;
      }
      if (positions.length === 0) {
        console.log(chalk.yellow('No seller-pool positions found.'));
        return;
      }
      const table = new Table({ head: ['ID', 'Agent', 'Amount', 'Start', 'End', 'State'] });
      for (const position of positions) table.push([position.id, position.agentId, `${formatAnts(position.amount)} ANTS`, position.stakeStartEpoch, position.stakeEndEpoch, position.state]);
      console.log(table.toString());
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  pool.command('withdraw <ids...>')
    .description('Withdraw seller-pool positions')
    .option('--accept-slashing', 'allow an early exit after showing the estimated principal loss', false)
    .option('-y, --yes', 'skip the interactive confirmation after accepting slashing', false)
    .action(async (rawIds: string[], options: { acceptSlashing?: boolean; yes?: boolean }) => {
    const global = getGlobalOptions(pool);
    const config = await loadConfig(global.config);
    const spinner = ora('Checking positions...').start();
    try {
      const stack = await requirePoolStack(config);
      const ids = rawIds.map((value) => Number(value));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Position IDs must be positive safe integers.');
      if (new Set(ids).size !== ids.length) throw new Error('Position IDs must not be repeated.');
      const { wallet, address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const positions = await Promise.all(ids.map((id) => pools.position(id)));
      const notOwned = positions.filter((position) => position.owner.toLowerCase() !== address.toLowerCase());
      if (notOwned.length > 0) throw new Error(`Position(s) ${notOwned.map((position) => position.id).join(', ')} are not owned by this wallet.`);
      const unavailable = positions.filter((position) => position.withdrawn || position.closedAtEpoch !== 0);
      if (unavailable.length > 0) throw new Error(`Position(s) ${unavailable.map((position) => position.id).join(', ')} are already closed or withdrawn.`);
      const withdrawableEpochs = await Promise.all(positions.map((position) => pools.positionWithdrawableEpoch(position.id)));
      const pending = positions.filter((_position, index) => stack.currentEpoch < withdrawableEpochs[index]!);
      if (pending.length > 0) {
        throw new Error(`Position change pending for position(s) ${pending.map((position) => position.id).join(', ')}; try again in the next epoch.`);
      }
      if (options.yes && !options.acceptSlashing) throw new Error('--yes requires --accept-slashing.');
      const estimates = (await Promise.all(positions
        .map(async (position) => estimateEarlyExit(position, await pools.earlyExitSlashBps(position.id)))))
        .filter((estimate) => estimate.slashBps > 0);
      const totalSlashed = estimates.reduce((total, estimate) => total + estimate.slashedAmount, 0n);
      if (estimates.length > 0) {
        spinner.stop();
        console.log(chalk.bold('Early-exit slashing estimate:\n'));
        for (const estimate of estimates) {
          console.log(`  Position ${estimate.id}: burn ${chalk.red(`${formatAntsExact(estimate.slashedAmount)} ANTS`)} (${(estimate.slashBps / 100).toFixed(2)}%), return ${formatAntsExact(estimate.returnedAmount)} ANTS`);
        }
        console.log(chalk.red(`\nEstimated principal burned: ${formatAntsExact(totalSlashed)} ANTS`));
        console.log(chalk.yellow('Final slashing is determined on-chain. Rates may change before the transaction confirms.'));
        if (!options.acceptSlashing) throw new Error('Positions are still locked. Re-run with --accept-slashing to proceed.');
        if (!options.yes) await confirmEarlyExit(totalSlashed);
        spinner.start('Withdrawing positions...');
      }
      const latestQuotes = await Promise.all(positions.map(async (position) => estimateEarlyExit(position, await pools.earlyExitSlashBps(position.id))));
      if (latestQuotes.reduce((total, quote) => total + quote.slashedAmount, 0n) > totalSlashed) {
        throw new Error('The slashing estimate increased. Re-run the command to review the new estimate.');
      }
      const txHash = await pools.withdrawStakes(wallet, ids);
      spinner.succeed(chalk.green(`Withdrew ${ids.length} position(s)`));
      console.log(chalk.dim(`Transaction: ${txHash}`));
    } catch (error) {
      spinner.fail(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  const rewards = pool.command('rewards', { hidden: true }).description('Show or claim pool rewards (use seller rewards for all rewards)').option('--json', 'output as JSON', false);
  rewards.action(async (options) => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    try {
      await requirePoolStack(config);
      const { address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const rewardsClient = createSellerPoolsRewardsClient(config);
      const pending = await previewPoolRewards(pools, rewardsClient, address);
      const total = pending.reduce((sum, item) => sum + item.amount, 0n);
      if (options.json) console.log(JSON.stringify({ positions: pending.map(({ id, amount }) => ({ id, amount })), total }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      else {
        for (const item of pending) console.log(`Position ${item.id}: ${formatAnts(item.amount)} ANTS`);
        console.log(chalk.bold(`Total: ${formatAnts(total)} ANTS`));
      }
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  rewards.command('claim').description('Claim pool rewards').option('--position <id>', 'claim one position', (value) => Number(value)).option('--recipient <address>', 'reward recipient').action(async (options) => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    const spinner = ora('Checking pending rewards...').start();
    let progress: RewardClaimProgress | undefined;
    try {
      if (options.position !== undefined && (!Number.isSafeInteger(options.position) || options.position <= 0)) {
        throw new Error('Position ID must be a positive integer.');
      }
      await requirePoolStack(config);
      const { wallet, address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const rewardsClient = createSellerPoolsRewardsClient(config);
      const recipient = options.recipient || address;
      if (!isAddress(recipient) || recipient === ZeroAddress) throw new Error('Reward recipient must be a valid nonzero address.');
      const token = createAntsTokenClient(config);
      progress = new RewardClaimProgress(
        (hash, kind) => console.log(chalk.dim(`${kind === 'accounting' ? 'Preparation' : 'Claim'} transaction confirmed: ${hash}`)),
        (hash) => token.receivedInTransaction(hash, recipient),
      );
      await claimPoolRewards(pools, rewardsClient, wallet, address, recipient, progress.record, () => {
        spinner.text = 'Updating pool rewards (preparation transactions require gas)...';
      }, options.position);
      spinner.succeed(progress.claimed > 0n ? chalk.green(`Claimed ${formatAnts(progress.claimed)} ANTS`) : chalk.yellow('No pool rewards pending.'));
    } catch (error) {
      spinner.fail(chalk.red(progress?.failure((error as Error).message) ?? (error as Error).message));
      process.exitCode = 1;
    }
  });
}

export interface PoolStakeOptions {
  epochs: number;
  agentId?: number;
}

/** Stake ANTS into a seller pool through the primary `seller stake` command. */
export async function runPoolStake(
  global: { config: string; dataDir: string },
  amount: string,
  options: PoolStakeOptions,
): Promise<void> {
  const config = await loadConfig(global.config);
  const spinner = ora('Checking pool stake...').start();
  try {
    await requirePoolStack(config);
    const amountBaseUnits = parseAntsToBaseUnits(amount);
    const { wallet, address } = await loadCryptoContext(global.dataDir);
    const pools = createSellerPoolsClient(config);
    const registry = createSellerRegistryClient(config);
    const [minEpochs, maxEpochs] = await Promise.all([pools.minStakeEpochs(), pools.maxStakeEpochs()]);
    validateStakeEpochs(options.epochs, minEpochs, maxEpochs);
    const agentId = await requireSellerBinding(registry, address, options.agentId);
    const token = createAntsTokenClient(config);
    const balance = await token.balanceOf(address);
    if (balance < amountBaseUnits) throw new Error(`Insufficient ANTS balance: have ${formatAnts(balance)}, need ${formatAnts(amountBaseUnits)}.`);
    spinner.text = `Staking ${formatAnts(amountBaseUnits)} ANTS for ${options.epochs} epochs...`;
    const txHash = await pools.stake(wallet, agentId, amountBaseUnits, options.epochs);
    spinner.succeed(chalk.green('ANTS pool position created'));
    console.log(chalk.dim(`Transaction: ${txHash}`));
  } catch (error) {
    spinner.fail(chalk.red((error as Error).message));
    process.exitCode = 1;
  }
}
