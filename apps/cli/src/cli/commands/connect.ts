import type { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { createInterface } from 'node:readline/promises';
import {
  parseRequestLink,
  resolveScopeValues,
  signConnectResponse,
  parseManifest,
  SCOPES,
  type ConnectManifest,
  type AutoDepositState,
} from '@antseed/connect-core';
import { getGlobalOptions } from './types.js';
import { loadCryptoContext, requireCryptoConfig } from '../payment-utils.js';
import { loadConfig } from '../../config/loader.js';
import { loadAutoDepositConnectStateReader } from '../../plugins/service-state.js';

const MANIFEST_TIMEOUT_MS = 1500;

/** Resolve the auto-deposit status to share over Connect: consent from config,
 * delegation read on-chain. Best-effort: any failure reports off + undelegated. */
async function autoDepositStateForConnect(configPath: string, address: string): Promise<AutoDepositState> {
  let enabled = false;
  try {
    const config = await loadConfig(configPath);
    enabled = config.buyer?.services?.['auto-deposit']?.enabled ?? false;
    const crypto = requireCryptoConfig(config);
    const readAutoDepositConnectState = await loadAutoDepositConnectStateReader();
    if (!readAutoDepositConnectState) {
      return { enabled, delegated: false };
    }
    return await readAutoDepositConnectState({
      chainId: crypto.chainId,
      rpcUrl: crypto.rpcUrl,
      address,
      enabled,
    });
  } catch {
    return { enabled, delegated: false };
  }
}

/** Best-effort, display-only manifest fetch. Never a security input. */
async function fetchManifest(origin: string): Promise<ConnectManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/.well-known/antseed-connect.json`, {
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res.ok) return null;
    return parseManifest(await res.text(), origin);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function registerConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('Respond to an AntSeed Connect request link, sharing signed account info on consent')
    .argument('<link>', 'the antseed://connect (or https) request link')
    .option('--yes', 'skip the consent prompt (non-interactive approval)', false)
    .option('--print', 'print the redirect URL instead of opening a browser', false)
    .action(async (link: string, options: { yes: boolean; print: boolean }) => {
      try {
        const globalOpts = getGlobalOptions(program);

        const request = parseRequestLink(link);
        const { wallet } = await loadCryptoContext(globalOpts.dataDir);
        const account = request.scopes.includes('auto-deposit')
          ? { address: wallet.address, autoDeposit: await autoDepositStateForConnect(globalOpts.config, wallet.address) }
          : wallet;
        const values = resolveScopeValues(request, account);

        const manifest = await fetchManifest(request.origin);

        console.log('');
        if (manifest) {
          console.log(`${chalk.bold('App:')}     ${manifest.name}`);
        }
        console.log(`${chalk.bold('Origin:')}  ${chalk.cyan(request.origin)}`);
        console.log(`${chalk.bold('Request:')} Share the following with this app:`);
        for (const scope of request.scopes) {
          const def = SCOPES[scope];
          console.log(`  ${chalk.bold(def.label)}: ${values[scope]}`);
          console.log(`  ${chalk.dim(def.description)}`);
        }
        console.log('');

        if (!options.yes) {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question('Approve? [y/N]: ');
          rl.close();
          const normalized = answer.trim().toLowerCase();
          if (normalized !== 'y' && normalized !== 'yes') {
            console.log(chalk.yellow('Declined. Nothing shared.'));
            return;
          }
        }

        const { fragmentUrl } = await signConnectResponse(wallet, request, values);

        console.log(chalk.green('Approved. Delivering signed response to:'));
        console.log(fragmentUrl);
        if (!options.print) {
          await open(fragmentUrl);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
