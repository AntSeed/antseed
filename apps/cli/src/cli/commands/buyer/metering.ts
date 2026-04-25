import type { Command } from 'commander';
import chalk from 'chalk';
import { getGlobalOptions } from '../types.js';
import { loadOrCreateIdentity } from '@antseed/node';
import { openChannelStore } from '../../payment-utils.js';

function formatUsdc(baseUnits: string | number | bigint): string {
  const n = BigInt(baseUnits);
  const abs = n < 0n ? -n : n;
  const sign = n < 0n ? '-' : '';
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${sign}${whole}.${fracStr}`;
}

export function registerBuyerMeteringCommand(buyerCmd: Command): void {
  buyerCmd
    .command('metering')
    .description('Show payment channel and usage stats from local database')
    .option('--peer <peerId>', 'show stats for a specific peer')
    .option('--json', 'output as JSON', false)
    .action(async (options) => {
      const globalOpts = getGlobalOptions(buyerCmd);

      try {
        const identity = await loadOrCreateIdentity(globalOpts.dataDir);
        const buyerAddress = identity.wallet.address;
        const store = openChannelStore(globalOpts.dataDir);

        try {
          const activeChannels = store.getActiveChannelsByBuyer('buyer', buyerAddress);
          const channels = options.peer
            ? activeChannels.filter((channel) => channel.peerId === options.peer)
            : activeChannels;

          if (channels.length === 0) {
            const allChannels = options.peer
              ? [store.getLatestChannelByPeerAndBuyer(options.peer, 'buyer', buyerAddress)].filter(Boolean)
              : [];

            if (allChannels.length === 0) {
              console.log(chalk.dim(options.peer ? 'No channels found for this peer.' : 'No active payment channels.'));
              return;
            }
          }

          const results: Record<string, unknown> = {};
          const peerIds = options.peer
            ? [options.peer]
            : [...new Set(activeChannels.map((channel) => channel.peerId))];

          for (const peerId of peerIds) {
            const channel = store.getActiveChannelByPeerAndBuyer(peerId, 'buyer', buyerAddress)
              ?? store.getLatestChannelByPeerAndBuyer(peerId, 'buyer', buyerAddress);
            const lifetime = store.getTotalsByPeerAndBuyer(peerId, 'buyer', buyerAddress);
            if (!channel && !lifetime) continue;

            const cumulativeSigned = BigInt(channel?.authMax ?? '0');
            const stats = {
              channelId: channel?.sessionId ?? null,
              channelStatus: channel?.status ?? null,
              cumulativeSigned: cumulativeSigned.toString(),
              requests: channel?.requestCount ?? 0,
              lifetimeSessions: lifetime?.totalSessions ?? 0,
              lifetimeRequests: lifetime?.totalRequests ?? 0,
              lifetimeInputTokens: lifetime?.totalInputTokens ?? 0,
              lifetimeOutputTokens: lifetime?.totalOutputTokens ?? 0,
              lifetimeAuthorizedUsdc: (lifetime?.totalAuthorizedUsdc ?? 0n).toString(),
            };
            results[peerId] = stats;

            if (!options.json) {
              console.log(chalk.bold('Peer: ') + chalk.cyan(peerId.slice(0, 16) + '...'));
              console.log('');
              console.log(chalk.bold('  Current Channel:'));
              console.log(`    Channel:      ${chalk.dim(channel?.sessionId ? channel.sessionId.slice(0, 18) + '...' : 'none')}`);
              console.log(`    Status:       ${channel?.status === 'active' ? chalk.green('active') : chalk.dim(channel?.status ?? 'none')}`);
              console.log(`    Signed:       ${chalk.green(formatUsdc(cumulativeSigned) + ' USDC')}`);
              console.log(`    Requests:     ${channel?.requestCount ?? 0}`);
              console.log('');
              console.log(chalk.bold('  Lifetime:'));
              console.log(`    Sessions:     ${lifetime?.totalSessions ?? 0}`);
              console.log(`    Requests:     ${lifetime?.totalRequests ?? 0}`);
              console.log(`    Authorized:   ${chalk.green(formatUsdc(lifetime?.totalAuthorizedUsdc ?? 0n) + ' USDC')}`);
              console.log('');
            }
          }

          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          }
        } finally {
          store.close();
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });
}
