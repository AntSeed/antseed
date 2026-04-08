import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from './types.js';
import { loadConfig } from '../../config/loader.js';

/** Format USDC base units (6 decimals) to human-readable string. */
function formatUsdc(baseUnits: string | number): string {
  const n = BigInt(baseUnits);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

interface PeerInfo {
  peerId: string;
  services?: string[];
}

interface MeteringStats {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reservedUsdc: string | null;
  consumedUsdc: string | null;
  channelStatus: string | null;
  reservedAt: number | null;
  lifetimeSessions: number;
  lifetimeRequests: number;
  lifetimeInputTokens: number;
  lifetimeOutputTokens: number;
  lifetimeTotalTokens: number;
  lifetimeAuthorizedUsdc: string;
  lifetimeFirstSessionAt: number;
}

export function registerMeteringCommand(program: Command): void {
  program
    .command('metering')
    .description('Show payment channel and usage stats for connected peers')
    .option('--port <port>', 'proxy port', '5005')
    .option('--peer <peerId>', 'show stats for a specific peer')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const port = options.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Get peers
        const peersRes = await fetch(`${baseUrl}/_antseed/peers`);
        if (!peersRes.ok) throw new Error(`Proxy not reachable on port ${port}`);
        const peersData = await peersRes.json() as { peers: PeerInfo[] };
        const peers = peersData.peers ?? [];

        if (peers.length === 0 && !options.peer) {
          console.log(chalk.dim('No peers connected.'));
          return;
        }

        // If specific peer requested, just show that one
        const targetPeers = options.peer
          ? [{ peerId: options.peer }]
          : peers;

        const results: Record<string, MeteringStats> = {};

        for (const peer of targetPeers) {
          try {
            const res = await fetch(`${baseUrl}/_antseed/metering/${encodeURIComponent(peer.peerId)}`);
            if (res.ok) {
              results[peer.peerId] = await res.json() as MeteringStats;
            }
          } catch {
            // Skip unreachable peers
          }
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (Object.keys(results).length === 0) {
          console.log(chalk.dim('No metering data available.'));
          return;
        }

        for (const [peerId, stats] of Object.entries(results)) {
          console.log(chalk.bold(`Peer: `) + chalk.cyan(peerId.slice(0, 16) + '...'));
          console.log('');

          // Current session
          console.log(chalk.bold('  Current Session:'));
          console.log(`    Status:       ${stats.channelStatus === 'active' ? chalk.green('active') : chalk.dim(stats.channelStatus ?? 'none')}`);
          console.log(`    Reserved:     ${chalk.yellow(formatUsdc(stats.reservedUsdc ?? '0') + ' USDC')}`);
          console.log(`    Consumed:     ${chalk.green(formatUsdc(stats.consumedUsdc ?? '0') + ' USDC')}`);
          const remaining = BigInt(stats.reservedUsdc ?? '0') - BigInt(stats.consumedUsdc ?? '0');
          console.log(`    Remaining:    ${remaining > 0n ? chalk.green(formatUsdc(remaining.toString()) + ' USDC') : chalk.red(formatUsdc(remaining.toString()) + ' USDC')}`);
          console.log(`    Requests:     ${stats.totalRequests}`);
          console.log(`    Tokens:       ${stats.inputTokens.toLocaleString()} in / ${stats.outputTokens.toLocaleString()} out`);
          console.log('');

          // Lifetime
          console.log(chalk.bold('  Lifetime:'));
          console.log(`    Sessions:     ${stats.lifetimeSessions}`);
          console.log(`    Requests:     ${stats.lifetimeRequests}`);
          console.log(`    Tokens:       ${stats.lifetimeInputTokens.toLocaleString()} in / ${stats.lifetimeOutputTokens.toLocaleString()} out`);
          console.log(`    Authorized:   ${chalk.green(formatUsdc(stats.lifetimeAuthorizedUsdc) + ' USDC')}`);
          console.log('');
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        console.error(chalk.dim(`Make sure the buyer proxy is running on port ${port}`));
        process.exitCode = 1;
      }
    });
}
