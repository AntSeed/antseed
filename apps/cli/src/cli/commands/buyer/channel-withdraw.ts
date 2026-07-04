import type { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import type { StoredChannel } from '@antseed/node';
import { CHANNEL_STATUS } from '@antseed/node/payments';
import { getGlobalOptions } from '../types.js';
import { loadConfig } from '../../../config/loader.js';
import {
  createChannelsClient,
  formatUsdc,
  loadCryptoContext,
  openChannelStore,
  shortId,
} from '../../payment-utils.js';

export const CHANNEL_CLOSE_GRACE_PERIOD_SECONDS = 15 * 60;
// Contract channel status is a uint8; 1 maps to the on-chain Active enum value.
const ON_CHAIN_STATUS_ACTIVE = 1;

const CHANNEL_STATUS_LABELS: Record<number, string> = {
  0: 'none',
  1: 'active',
  2: 'settled',
  3: 'timed out',
};

function normalizeChannelId(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveBuyerChannelById(
  channels: StoredChannel[],
  channelIdOrPrefix: string,
): StoredChannel {
  const query = normalizeChannelId(channelIdOrPrefix);
  const matches = channels.filter((channel) => normalizeChannelId(channel.sessionId).startsWith(query));

  if (matches.length === 0) {
    throw new Error(`No local buyer channel found for ${channelIdOrPrefix}. Run \`antseed buyer channels\` to list channels.`);
  }
  if (matches.length > 1) {
    const examples = matches.slice(0, 5).map((channel) => channel.sessionId).join(', ');
    throw new Error(`Channel id prefix is ambiguous. Matches: ${examples}`);
  }
  return matches[0]!;
}

export function secondsUntilChannelWithdrawReady(
  closeRequestedAtSeconds: bigint,
  nowSeconds: number,
  gracePeriodSeconds = CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
): number {
  if (closeRequestedAtSeconds <= 0n) return gracePeriodSeconds;
  const readyAt = Number(closeRequestedAtSeconds) + gracePeriodSeconds;
  return Math.max(0, readyAt - nowSeconds);
}

function formatWait(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return 'about 1 minute';
  return `about ${minutes} minutes`;
}

function openChannelStoreOrExit(dataDir: string): ReturnType<typeof openChannelStore> {
  try {
    return openChannelStore(dataDir);
  } catch (err) {
    console.error(chalk.red(`Failed to open channel store: ${(err as Error).message}`));
    console.error(chalk.dim('Have you connected to the network yet? Channels are stored locally after first use.'));
    process.exit(1);
  }
}

export function registerBuyerChannelWithdrawCommands(channelsCmd: Command, buyerCmd: Command): void {
  channelsCmd
    .command('request-close <channelId>')
    .description('Request timeout close for an active buyer payment channel so reserved funds can be withdrawn after the grace period')
    .option('--json', 'output as JSON', false)
    .action(async (channelId: string, options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const channelsClient = createChannelsClient(config);

      let localChannel: StoredChannel;
      const store = openChannelStoreOrExit(globalOpts.dataDir);
      try {
        localChannel = resolveBuyerChannelById(
          store.getAllChannelsByBuyer('buyer', address),
          channelId,
        );
      } finally {
        store.close();
      }

      if (localChannel.status !== CHANNEL_STATUS.ACTIVE) {
        console.error(chalk.red(`Error: Local channel ${shortId(localChannel.sessionId, 18)} is ${localChannel.status}, not active.`));
        console.error(chalk.dim('Only active channels can be timeout closed.'));
        process.exit(1);
      }

      const spinner = ora(`Requesting timeout close for channel ${shortId(localChannel.sessionId, 18)}...`).start();
      try {
        const onChain = await channelsClient.getSession(localChannel.sessionId);
        if (onChain.buyer.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`Configured wallet ${address} is not the on-chain buyer for this channel.`);
        }
        if (onChain.status !== ON_CHAIN_STATUS_ACTIVE) {
          throw new Error(`On-chain channel is ${CHANNEL_STATUS_LABELS[onChain.status] ?? `status ${onChain.status}`}, not active.`);
        }
        if (onChain.closeRequestedAt > 0n) {
          const waitSeconds = secondsUntilChannelWithdrawReady(
            onChain.closeRequestedAt,
            Math.floor(Date.now() / 1000),
          );
          spinner.stop();
          if (options.json) {
            console.log(JSON.stringify({
              channelId: localChannel.sessionId,
              alreadyRequested: true,
              closeRequestedAt: onChain.closeRequestedAt.toString(),
              withdrawReady: waitSeconds === 0,
              waitSeconds,
            }, null, 2));
            return;
          }
          console.log(chalk.yellow(`Close was already requested for ${shortId(localChannel.sessionId, 18)}.`));
          console.log(waitSeconds === 0
            ? chalk.green('It is ready to withdraw now: antseed buyer channels withdraw ' + localChannel.sessionId)
            : chalk.dim(`Withdraw should be available in ${formatWait(waitSeconds)}.`));
          return;
        }

        const txHash = await channelsClient.requestClose(wallet, localChannel.sessionId);
        spinner.succeed(chalk.green(`Requested timeout close for ${shortId(localChannel.sessionId, 18)}`));
        if (options.json) {
          console.log(JSON.stringify({
            channelId: localChannel.sessionId,
            transaction: txHash,
            withdrawAfterSeconds: CHANNEL_CLOSE_GRACE_PERIOD_SECONDS,
          }, null, 2));
          return;
        }
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log(chalk.dim(`Withdraw reserved funds after ${formatWait(CHANNEL_CLOSE_GRACE_PERIOD_SECONDS)}:`));
        console.log(chalk.cyan(`  antseed buyer channels withdraw ${localChannel.sessionId}`));
      } catch (err) {
        spinner.fail(chalk.red(`Close request failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });

  channelsCmd
    .command('withdraw <channelId>')
    .description('Withdraw/release reserved buyer funds after a channel timeout close grace period has elapsed')
    .option('--json', 'output as JSON', false)
    .action(async (channelId: string, options) => {
      const globalOpts = getGlobalOptions(buyerCmd);
      const config = await loadConfig(globalOpts.config);
      const { wallet, address } = await loadCryptoContext(globalOpts.dataDir);
      const channelsClient = createChannelsClient(config);

      let localChannel: StoredChannel;
      const store = openChannelStoreOrExit(globalOpts.dataDir);
      try {
        localChannel = resolveBuyerChannelById(
          store.getAllChannelsByBuyer('buyer', address),
          channelId,
        );
      } finally {
        store.close();
      }

      const spinner = ora(`Withdrawing reserved funds for channel ${shortId(localChannel.sessionId, 18)}...`).start();
      try {
        const onChain = await channelsClient.getSession(localChannel.sessionId);
        if (onChain.buyer.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`Configured wallet ${address} is not the on-chain buyer for this channel.`);
        }
        if (onChain.status !== ON_CHAIN_STATUS_ACTIVE) {
          throw new Error(`On-chain channel is ${CHANNEL_STATUS_LABELS[onChain.status] ?? `status ${onChain.status}`}; nothing active remains to withdraw.`);
        }
        if (onChain.closeRequestedAt <= 0n) {
          throw new Error(`Close has not been requested yet. Run \`antseed buyer channels request-close ${localChannel.sessionId}\` first.`);
        }
        const waitSeconds = secondsUntilChannelWithdrawReady(
          onChain.closeRequestedAt,
          Math.floor(Date.now() / 1000),
        );
        if (waitSeconds > 0) {
          throw new Error(`Close grace period is not over yet. Try again in ${formatWait(waitSeconds)}.`);
        }

        const refund = onChain.deposit > onChain.settled ? onChain.deposit - onChain.settled : 0n;
        const txHash = await channelsClient.withdraw(wallet, localChannel.sessionId);
        spinner.succeed(chalk.green(`Withdrew reserved funds for ${shortId(localChannel.sessionId, 18)}`));
        if (options.json) {
          console.log(JSON.stringify({
            channelId: localChannel.sessionId,
            transaction: txHash,
            deposit: onChain.deposit.toString(),
            settled: onChain.settled.toString(),
            estimatedRefund: refund.toString(),
          }, null, 2));
          return;
        }
        console.log(chalk.dim(`Transaction: ${txHash}`));
        console.log(chalk.dim(`Estimated released reserve: ${formatUsdc(refund)} USDC`));
      } catch (err) {
        spinner.fail(chalk.red(`Withdraw failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
