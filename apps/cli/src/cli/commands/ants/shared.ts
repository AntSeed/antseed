import type { Command } from 'commander';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { AntsContext, formatAnts, jsonReplacer, rewardAddress, type StepReporter } from '@antseed/ants';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { loadCryptoContext, requireCryptoConfig } from '../../payment-utils.js';
import type { AntsChainConfig } from '@antseed/ants';

export interface AntsCommandContext {
  ctx: AntsContext;
  chain: AntsChainConfig;
  dataDir: string;
  configPath: string;
}

/** Build the ANTS service context from the CLI config and the node identity wallet. */
export async function loadAntsContext(command: Command, readAddress?: string): Promise<AntsCommandContext> {
  const global = getGlobalOptions(command);
  const config = await loadConfig(global.config);
  const chain = requireCryptoConfig(config) as unknown as AntsChainConfig;
  const identity = readAddress === undefined
    ? await loadCryptoContext(global.dataDir)
    : { address: rewardAddress(readAddress), wallet: undefined };
  const ctx = new AntsContext({ chain, address: identity.address, signer: identity.wallet });
  await ctx.selectRpc();
  return { ctx, chain: ctx.chain, dataDir: global.dataDir, configPath: global.config };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, jsonReplacer, 2));
}

export function ants(baseUnits: string | bigint, digits = 4): string {
  return `${formatAnts(baseUnits, digits)} ANTS`;
}

export function explorerTx(evmChainId: number, hash: string): string {
  if (evmChainId === 8453) return `https://basescan.org/tx/${hash}`;
  if (evmChainId === 84532) return `https://sepolia.basescan.org/tx/${hash}`;
  return hash;
}

/** Spinner-backed reporter: each step becomes a line, transaction hashes are printed dimmed. */
export function spinnerReporter(spinner: Ora, evmChainId: number): StepReporter {
  return (label, hash) => {
    if (hash) {
      spinner.stopAndPersist({ symbol: chalk.green('✔'), text: label });
      console.log(chalk.dim(`  ${explorerTx(evmChainId, hash)}`));
      spinner.start();
    } else {
      spinner.text = label;
    }
  };
}

export async function runAction(command: Command, title: string, work: (context: AntsCommandContext, report: StepReporter, spinner: Ora) => Promise<string | void>): Promise<void> {
  const spinner = ora(title).start();
  try {
    const context = await loadAntsContext(command);
    const summary = await work(context, spinnerReporter(spinner, context.chain.evmChainId), spinner);
    spinner.succeed(chalk.green(summary ?? 'Done'));
  } catch (error) {
    spinner.fail(chalk.red((error as Error).message));
    process.exitCode = 1;
  }
}

export async function runRead(command: Command, title: string, work: (context: AntsCommandContext) => Promise<void>, options: { address?: string; json?: boolean } = {}): Promise<void> {
  const spinner = ora(title).start();
  try {
    const context = await loadAntsContext(command, options.address);
    spinner.stop();
    await work(context);
  } catch (error) {
    if (options.json) {
      spinner.stop();
      printJson({ status: 'unavailable', error: (error as Error).message });
    } else {
      spinner.fail(chalk.red((error as Error).message));
    }
    process.exitCode = 1;
  }
}

export function parseIds(raw: string[]): number[] {
  return raw.map((value) => Number(value));
}

export function epochDate(genesis: number, epochDuration: number, epoch: number): string {
  return new Date((genesis + epoch * epochDuration) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function pct(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('This action needs interactive confirmation. Re-run in a terminal or pass --yes after reviewing the estimate.');
  }
  const { createInterface } = await import('node:readline/promises');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(question);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    input.close();
  }
}

/** USDC base units (6 decimals) as a dollar string, e.g. 1234567 → "$1.23". */
export function usdc(baseUnits: string | bigint, digits = 2): string {
  return `$${(Number(baseUnits) / 1e6).toLocaleString('en-US', { maximumFractionDigits: digits })}`;
}
