import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import { AntseedNode, type PeerInfo } from '@antseed/node';
import { parseBootstrapList, toBootstrapConfig } from '@antseed/node/discovery';
import { parsePersistedPeers } from '../../../proxy/buyer-proxy.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to load discovered peers from a live buyer daemon's state file.
 * Returns null unless the file exists, the daemon reports `state === 'connected'`,
 * its PID is still alive, and the peer list is non-empty. This avoids surfacing
 * stale peer data from a daemon that exited without clearing the file.
 */
async function loadPeersFromBuyerState(dataDir: string): Promise<PeerInfo[] | null> {
  try {
    const raw = await readFile(join(dataDir, 'buyer.state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { state?: unknown; pid?: unknown };
    if (parsed.state !== 'connected') return null;
    if (typeof parsed.pid !== 'number' || !isProcessAlive(parsed.pid)) return null;
    const peers = parsePersistedPeers(parsed);
    return peers.length > 0 ? peers : null;
  } catch {
    return null;
  }
}

function getReputationColor(reputation: number): (message: string) => string {
  if (reputation >= 80) {
    return chalk.green;
  }
  if (reputation >= 50) {
    return chalk.yellow;
  }
  return chalk.red;
}

function renderPeersTable(peers: PeerInfo[]): void {
  const table = new Table({
    head: [
      chalk.bold('Name'),
      chalk.bold('Peer ID'),
      chalk.bold('Providers'),
      chalk.bold('Input $/1M'),
      chalk.bold('Output $/1M'),
      chalk.bold('Reputation'),
      chalk.bold('Load'),
    ],
    colWidths: [18, 16, 18, 14, 14, 12, 10],
  });

  for (const peer of peers) {
    const reputation = peer.reputationScore ?? 0;
    const repLabel = `${reputation}%`;
    const repColor = getReputationColor(reputation);

    const load = peer.currentLoad !== undefined && peer.maxConcurrency !== undefined
      ? `${peer.currentLoad}/${peer.maxConcurrency}`
      : chalk.dim('n/a');

    table.push([
      peer.displayName ?? chalk.dim('n/a'),
      chalk.dim(peer.peerId.slice(0, 12) + '...'),
      peer.providers.join(', '),
      peer.defaultInputUsdPerMillion !== undefined
        ? `$${peer.defaultInputUsdPerMillion.toFixed(2)}`
        : chalk.dim('n/a'),
      peer.defaultOutputUsdPerMillion !== undefined
        ? `$${peer.defaultOutputUsdPerMillion.toFixed(2)}`
        : chalk.dim('n/a'),
      repColor(repLabel),
      load,
    ]);
  }

  console.log('');
  console.log(table.toString());
  console.log('');
}

/**
 * Register the `antseed network browse` command on the Commander program.
 * Discovers peers on the network and displays available services, prices, and reputation.
 */
export function registerNetworkBrowseCommand(networkCmd: Command): void {
  networkCmd
    .command('browse')
    .description('Browse available services, prices, and reputation on the P2P network')
    .option('-s, --service <service>', 'filter by service name')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(networkCmd);
      const config = await loadConfig(globalOpts.config);
      const serviceFilter = options.service as string | undefined;

      // Fast path: if a buyer daemon is running, it has already populated
      // buyer.state.json with discovered peers. Read from there to skip a
      // 30-second DHT round-trip.
      const cachedPeers = await loadPeersFromBuyerState(globalOpts.dataDir);
      if (cachedPeers) {
        const filtered = serviceFilter
          ? cachedPeers.filter((peer) => peer.providers.includes(serviceFilter))
          : cachedPeers;
        if (filtered.length > 0) {
          if (options.json) {
            console.log(JSON.stringify(filtered, null, 2));
            return;
          }
          console.log(chalk.dim(`Loaded ${filtered.length} peer(s) from running buyer daemon`));
          renderPeersTable(filtered);
          return;
        }
      }

      const bootstrapNodes = config.network.bootstrapNodes.length > 0
        ? toBootstrapConfig(parseBootstrapList(config.network.bootstrapNodes))
        : undefined;

      const spinner = ora('Discovering peers on the network...').start();

      const node = new AntseedNode({
        role: 'buyer',
        bootstrapNodes,
        dhtOperationTimeoutMs: 30_000,
      });

      try {
        await node.start();
      } catch (err) {
        spinner.fail(chalk.red(`Failed to connect to network: ${(err as Error).message}`));
        process.exit(1);
      }

      try {
        const peers = await node.discoverPeers(serviceFilter);
        spinner.succeed(chalk.green(`Found ${peers.length} peer(s)`));

        if (peers.length === 0) {
          console.log(chalk.dim('No peers found. Try again later or check your bootstrap nodes.'));
          await node.stop();
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(peers, null, 2));
          await node.stop();
          return;
        }

        renderPeersTable(peers);
      } catch (err) {
        spinner.fail(chalk.red(`Discovery failed: ${(err as Error).message}`));
      }

      await node.stop();
    });
}
