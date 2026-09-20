import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';

export function registerBuyerRouterCommand(buyerCmd: Command): void {
  buyerCmd.command('router').description('Inspect the selected network routing service')
    .command('describe').option('--json', 'Output router metadata as JSON')
    .action(async () => {
      try {
        const options = getGlobalOptions(buyerCmd);
        const state = JSON.parse(await readFile(join(options.dataDir, 'buyer.state.json'), 'utf8')) as { state?: string; port?: number };
        if (state.state !== 'connected' || !Number.isInteger(state.port) || state.port! < 1 || state.port! > 65535) throw new Error('Start the buyer before inspecting router metadata');
        const response = await fetch(`http://127.0.0.1:${state.port}/_antseed/router/metadata`, { signal: AbortSignal.timeout(15_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(body));
        console.log(JSON.stringify(body, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
