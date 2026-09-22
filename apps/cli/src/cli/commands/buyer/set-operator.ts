import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getAddress, ZeroAddress } from 'ethers';
import type { DepositsClient } from '@antseed/node';
import type { CryptoContext } from '../../payment-utils.js';
import { getGlobalOptions } from '../types.js';

export function validateOperatorAddress(value: string): string {
  let address: string;
  try {
    address = getAddress(value);
  } catch {
    throw new Error('Invalid authorized wallet address. Use a 0x-prefixed Ethereum address with a valid checksum (or all lowercase).');
  }
  if (!value.startsWith('0x') || address === ZeroAddress) {
    throw new Error('Authorized wallet must be a non-zero, 0x-prefixed Ethereum address.');
  }
  return address;
}

interface SetOperatorInput {
  operator: string;
  context: Pick<CryptoContext, 'wallet' | 'address'>;
  client: Pick<DepositsClient, 'getOperator' | 'getOperatorNonce' | 'setOperator'>;
  evmChainId: number;
  depositsContractAddress: string;
  sign: (wallet: CryptoContext['wallet'], chainId: number, contract: string, operator: string, nonce: bigint) => Promise<string>;
}

/** Initial authorization only: changing an existing wallet requires the current operator. */
export async function setBuyerOperator(input: SetOperatorInput): Promise<string | null> {
  const operator = validateOperatorAddress(input.operator);
  const { wallet, address: buyer } = input.context;
  const current = await input.client.getOperator(buyer);
  if (current.toLowerCase() === operator.toLowerCase()) return null;
  if (current.toLowerCase() !== ZeroAddress) {
    throw new Error(`Authorized wallet is already set to ${current}. Only that wallet can transfer authorization using transferOperator; the buyer identity cannot replace it.`);
  }
  const nonce = await input.client.getOperatorNonce(buyer);
  const signature = await input.sign(wallet, input.evmChainId, input.depositsContractAddress, operator, nonce);
  return input.client.setOperator(wallet, buyer, operator, nonce, signature);
}

export function registerBuyerSetOperatorCommand(buyerCmd: Command): void {
  buyerCmd
    .command('set-operator <address>')
    .description('Set the initial authorized wallet for buyer withdrawals (buyer hot wallet pays ETH gas)')
    .addHelpText('after', '\nEquivalent to “Set authorized wallet” in AI VPN. The address gains withdrawal control; only it can transfer authorization later. This command cannot replace an existing authorized wallet.')
    .action(async (value: string) => {
      let spinner: ReturnType<typeof ora> | undefined;
      try {
        const operator = validateOperatorAddress(value);
        const { loadConfig } = await import('../../../config/loader.js');
        const { loadCryptoContext, createDepositsClient, requireCryptoConfig } = await import('../../payment-utils.js');
        const { makeDepositsDomain, signSetOperator } = await import('@antseed/node');
        const globalOpts = getGlobalOptions(buyerCmd);
        const config = await loadConfig(globalOpts.config);
        const crypto = requireCryptoConfig(config);
        const context = await loadCryptoContext(globalOpts.dataDir);
        console.log(chalk.dim(`Buyer: ${context.address}`));
        console.log(chalk.dim(`Chain: ${crypto.evmChainId} | Deposits: ${crypto.depositsContractAddress}`));
        console.log(chalk.yellow(`Authorized wallet: ${operator} — this wallet will control withdrawals and future authorization transfers.`));
        console.log(chalk.dim('The buyer hot wallet must have ETH on this chain to pay gas.'));
        spinner = ora('Setting authorized wallet...').start();
        const txHash = await setBuyerOperator({
          operator, context, client: createDepositsClient(config),
          evmChainId: crypto.evmChainId,
          depositsContractAddress: crypto.depositsContractAddress,
          sign: (wallet, chainId, contract, address, nonce) =>
            signSetOperator(wallet, makeDepositsDomain(chainId, contract), { operator: address, nonce }),
        });
        spinner.succeed(chalk.green(txHash ? 'Authorized wallet set.' : 'This wallet is already authorized; no transaction sent.'));
        if (txHash) console.log(chalk.dim(`Transaction: ${txHash}`));
      } catch (err) {
        const message = `Failed to set authorized wallet: ${(err as Error).message}`;
        if (spinner) spinner.fail(chalk.red(message));
        else console.error(chalk.red(message));
        process.exitCode = 1;
      }
    });
}
