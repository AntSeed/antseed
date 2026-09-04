import type { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { requireCryptoConfig, resolveCliContractStack } from '../../payment-utils.js';

function sameAddress(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

export function registerNetworkContractsCommand(networkCmd: Command): void {
  networkCmd.command('contracts')
    .description('Verify configured contract addresses against AntseedRegistry')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      try {
        const global = getGlobalOptions(networkCmd);
        const config = await loadConfig(global.config);
        const crypto = requireCryptoConfig(config);
        const stack = await resolveCliContractStack(config);
        const expectedEmissions = stack.mode === 'legacy' ? crypto.emissionsContractAddress : crypto.usageAccountingAddress;
        const expectedStaking = stack.mode === 'legacy' ? crypto.stakingContractAddress : crypto.sellerRegistryAddress;
        const matches = {
          emissions: sameAddress(stack.registryPointers.emissions, expectedEmissions),
          staking: sameAddress(stack.registryPointers.staking, expectedStaking),
        };
        const addresses = Object.fromEntries(Object.entries(crypto).filter(([key, value]) => key.endsWith('Address') && typeof value === 'string'));
        if (options.json) {
          console.log(JSON.stringify({
            chainId: crypto.chainId,
            mode: stack.mode,
            currentEpoch: stack.currentEpoch,
            firstRewardedEpoch: stack.firstRewardedEpoch ?? null,
            addresses,
            registryPointers: stack.registryPointers,
            matches,
          }, null, 2));
          return;
        }
        console.log(chalk.bold(`Contract Stack (${crypto.chainId})\n`));
        console.log(`Mode: ${chalk.cyan(stack.mode)}`);
        console.log(`Current epoch: ${stack.currentEpoch}`);
        if (stack.firstRewardedEpoch !== undefined) console.log(`First rewarded epoch: ${stack.firstRewardedEpoch}`);
        console.log('');
        const pointers = new Table({ head: ['Registry pointer', 'On-chain', 'Configured', 'Match'] });
        pointers.push(
          ['emissions', stack.registryPointers.emissions, expectedEmissions ?? 'missing', matches.emissions ? chalk.green('✓') : chalk.red('✗')],
          ['staking', stack.registryPointers.staking, expectedStaking ?? 'missing', matches.staking ? chalk.green('✓') : chalk.red('✗')],
        );
        console.log(pointers.toString());
        console.log(chalk.bold('\nConfigured addresses'));
        for (const [key, value] of Object.entries(addresses)) console.log(`  ${key}: ${value}`);
      } catch (error) {
        console.error(chalk.red(`${(error as Error).name}: ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });
}
