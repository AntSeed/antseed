import type { Command } from 'commander';
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
  loadCryptoContext,
  parseAntsToBaseUnits,
  resolveCliContractStack,
} from '../../payment-utils.js';
import type { SellerPoolPosition } from '@antseed/node/payments';

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
    throw new Error('Seller pool commands require the recognized-usage contract stack. Run them after M001 cutover.');
  }
  return stack;
}

export function registerSellerPoolCommand(sellerCmd: Command): void {
  const pool = sellerCmd.command('pool').description('Manage recognized-usage ANTS seller-pool positions');

  pool.command('bootstrap').alias('init').description('Claim the legacy-seller starter ANTS position').action(async () => {
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

  pool.command('stake <amount>')
    .description('Stake ANTS into a seller pool (alias of `antseed seller stake`)')
    .requiredOption('--epochs <n>', 'lock duration in epochs', (value) => Number(value))
    .option('--agent-id <id>', 'seller agent ID', (value) => Number(value))
    .action(async (amount: string, options: PoolStakeOptions) => {
      await runPoolStake(getGlobalOptions(pool), amount, options);
    });

  pool.command('positions').description('List your seller-pool positions').option('--json', 'output as JSON', false).action(async (options) => {
    const global = getGlobalOptions(pool);
    const config = await loadConfig(global.config);
    try {
      const stack = await requirePoolStack(config);
      const { address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const ids = await pools.stakerPositionIds(address);
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

  pool.command('withdraw <ids...>').description('Withdraw seller-pool positions').option('--force', 'allow early exit and slashing', false).action(async (rawIds: string[], options) => {
    const global = getGlobalOptions(pool);
    const config = await loadConfig(global.config);
    const spinner = ora('Checking positions...').start();
    try {
      const stack = await requirePoolStack(config);
      const ids = rawIds.map((value) => Number(value));
      if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('Position IDs must be positive integers.');
      const positions = await Promise.all(ids.map((id) => createSellerPoolsClient(config).position(id)));
      const early = positions.filter((position) => !position.withdrawn && position.closedAtEpoch === 0 && stack.currentEpoch < position.stakeEndEpoch);
      if (early.length > 0 && !options.force) throw new Error(`Position(s) ${early.map((position) => position.id).join(', ')} are still locked; re-run with --force to accept early-exit slashing.`);
      const { wallet } = await loadCryptoContext(global.dataDir);
      const txHash = await createSellerPoolsClient(config).withdrawStakes(wallet, ids);
      spinner.succeed(chalk.green(`Withdrew ${ids.length} position(s)`));
      console.log(chalk.dim(`Transaction: ${txHash}`));
    } catch (error) {
      spinner.fail(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  const rewards = pool.command('rewards').description('Show or claim indexed seller-pool rewards').option('--json', 'output as JSON', false);
  rewards.action(async (options) => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    try {
      await requirePoolStack(config);
      const { address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const rewardsClient = createSellerPoolsRewardsClient(config);
      const ids = await pools.stakerPositionIds(address);
      const pending = await Promise.all(ids.map(async (id) => ({ id, amount: await rewardsClient.pendingIndexedStakerReward(id) })));
      const total = pending.reduce((sum, item) => sum + item.amount, 0n);
      if (options.json) console.log(JSON.stringify({ positions: pending, total }, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      else {
        for (const item of pending) console.log(`Position ${item.id}: ${formatAnts(item.amount)} ANTS`);
        console.log(chalk.bold(`Total: ${formatAnts(total)} ANTS`));
      }
    } catch (error) {
      console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

  rewards.command('claim').description('Claim indexed rewards').option('--position <id>', 'claim one position', (value) => Number(value)).option('--recipient <address>', 'reward recipient').action(async (options) => {
    const global = getGlobalOptions(rewards);
    const config = await loadConfig(global.config);
    const spinner = ora('Checking pending rewards...').start();
    try {
      await requirePoolStack(config);
      const { wallet, address } = await loadCryptoContext(global.dataDir);
      const pools = createSellerPoolsClient(config);
      const rewardsClient = createSellerPoolsRewardsClient(config);
      const ids = options.position ? [options.position] : await pools.stakerPositionIds(address);
      const pendingIds = [];
      for (const id of ids) if (await rewardsClient.pendingIndexedStakerReward(id) > 0n) pendingIds.push(id);
      if (pendingIds.length === 0) {
        spinner.succeed(chalk.yellow('No indexed pool rewards pending.'));
        return;
      }
      const recipient = options.recipient || address;
      const txHash = pendingIds.length === 1
        ? await rewardsClient.claimStakerRewards(wallet, pendingIds[0]!, recipient)
        : await rewardsClient.claimStakerRewardsBatch(wallet, pendingIds, recipient);
      spinner.succeed(chalk.green(`Claimed rewards for ${pendingIds.length} position(s)`));
      console.log(chalk.dim(`Transaction: ${txHash}`));
    } catch (error) {
      spinner.fail(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });
}

export interface PoolStakeOptions {
  epochs: number;
  agentId?: number;
}

/** Stake ANTS into a seller pool. Shared by `seller stake` and `seller pool stake`. */
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
    let agentId = options.agentId || await registry.getAgentId(address);
    if (!agentId) agentId = await createLegacyStakingClient(config).getAgentId(address);
    if (!agentId) throw new Error('No seller agent ID found. Pass --agent-id <id> or run antseed seller register.');
    const boundAgentId = await registry.getAgentId(address);
    if (boundAgentId === 0) {
      spinner.text = 'Binding seller registry...';
      await registry.registerSeller(wallet, agentId);
    } else if (boundAgentId !== agentId) {
      throw new Error(`Seller is bound to agent ${boundAgentId}, not ${agentId}.`);
    }
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
