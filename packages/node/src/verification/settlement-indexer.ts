import { getAddress } from 'ethers';
import type { ChannelsClient, ChannelSettledEvent } from '../payments/evm/channels-client.js';
import { decodeMetadata } from '../payments/evm/signatures.js';
import type { StakingClient } from '../payments/evm/staking-client.js';
import type {
  SettlementIndexCursor,
  SettlementUsageEvent,
  VerificationSettlementStore,
} from './storage.js';

export interface SettlementIndexResult {
  fromBlock: number;
  toBlock: number;
  settlementLogs: number;
  serviceRows: number;
}

export interface SettlementIndexerConfig {
  chainId: string;
  channelsClient: ChannelsClient;
  stakingClient: Pick<StakingClient, 'getAgentId'>;
  storage: VerificationSettlementStore;
  startBlock?: number;
  confirmationBlocks?: number;
  chunkSize?: number;
  warn?: (message: string) => void;
}

export async function indexFinalizedChannelSettlements(
  config: SettlementIndexerConfig,
): Promise<SettlementIndexResult> {
  const channelsAddress = getAddress(await config.channelsClient.readAddress);
  const confirmationBlocks = Math.max(0, Math.floor(config.confirmationBlocks ?? 20));
  const latestBlock = await config.channelsClient.getBlockNumber();
  const finalizedBlock = Math.max(0, latestBlock - confirmationBlocks);
  const existing = config.storage.getSettlementCursor(config.chainId, channelsAddress);
  if (existing) await assertCursorCanonical(config.channelsClient, existing);
  const fromBlock = Math.max(0, existing ? existing.finalizedBlock + 1 : config.startBlock ?? 0);
  if (fromBlock > finalizedBlock) {
    return { fromBlock, toBlock: finalizedBlock, settlementLogs: 0, serviceRows: 0 };
  }

  const chunkSize = Math.max(1, Math.floor(config.chunkSize ?? 2_000));
  let settlementLogs = 0;
  let serviceRows = 0;
  for (let chunkStart = fromBlock; chunkStart <= finalizedBlock; chunkStart += chunkSize) {
    const chunkEnd = Math.min(finalizedBlock, chunkStart + chunkSize - 1);
    const events = (await config.channelsClient.getChannelSettledEvents(chunkStart, chunkEnd))
      .slice()
      .sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    for (const event of events) {
      settlementLogs += 1;
      try {
        serviceRows += await indexSettlementEvent(config, channelsAddress, event);
      } catch (error) {
        config.warn?.(`Skipping ChannelSettled ${event.transactionHash}/${event.logIndex}: ${(error as Error).message}`);
      }
    }
    const block = await config.channelsClient.provider.getBlock(chunkEnd);
    if (!block?.hash) throw new Error(`finalized block ${chunkEnd} is unavailable`);
    config.storage.updateSettlementCursor({
      chainId: config.chainId,
      channelsAddress,
      finalizedBlock: chunkEnd,
      finalizedBlockHash: block.hash,
      updatedAt: Date.now(),
    });
  }
  return { fromBlock, toBlock: finalizedBlock, settlementLogs, serviceRows };
}

async function indexSettlementEvent(
  config: SettlementIndexerConfig,
  channelsAddress: string,
  event: ChannelSettledEvent,
): Promise<number> {
  const metadata = decodeMetadata(event.metadata);
  const agentId = await config.stakingClient.getAgentId(event.seller);
  if (agentId <= 0) return 0;
  const block = await config.channelsClient.provider.getBlock(event.blockNumber);
  if (!block) throw new Error(`block ${event.blockNumber} is unavailable`);
  const previousChannelCumulative = event.cumulativeAmount - event.delta;
  let indexed = 0;
  for (const service of metadata.services ?? []) {
    const previous = config.storage.getSettlementServiceTotal(
      config.chainId,
      channelsAddress,
      event.channelId,
      service.serviceId,
    );
    const previousServiceCumulative = previous?.cumulativeServiceUsdc ?? 0n;
    if (service.cumulativeAmount < previousServiceCumulative) {
      throw new Error(`service ${service.serviceId} cumulative amount moved backwards`);
    }
    const serviceDeltaUsdc = service.cumulativeAmount - previousServiceCumulative;
    const auditChargeUsdc = config.storage.auditChargeForSettlement(
      event.channelId,
      service.serviceId,
      previous?.cumulativeChannelUsdc ?? previousChannelCumulative,
      event.cumulativeAmount,
    );
    const organicServiceDeltaUsdc = serviceDeltaUsdc > auditChargeUsdc
      ? serviceDeltaUsdc - auditChargeUsdc
      : 0n;
    const usage: SettlementUsageEvent = {
      chainId: config.chainId,
      channelsAddress,
      txHash: event.transactionHash,
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      settledAt: block.timestamp * 1_000,
      channelId: event.channelId,
      agentId: String(agentId),
      sellerPeerId: event.seller.slice(2).toLowerCase(),
      service: service.serviceId,
      cumulativeServiceUsdc: service.cumulativeAmount,
      serviceDeltaUsdc,
      cumulativeChannelUsdc: event.cumulativeAmount,
      channelDeltaUsdc: event.delta,
      auditChargeUsdc,
      organicServiceDeltaUsdc,
    };
    if (config.storage.recordFinalizedSettlement(usage)) indexed += 1;
  }
  return indexed;
}

async function assertCursorCanonical(
  channelsClient: ChannelsClient,
  cursor: SettlementIndexCursor,
): Promise<void> {
  const block = await channelsClient.provider.getBlock(cursor.finalizedBlock);
  if (!block?.hash || block.hash.toLowerCase() !== cursor.finalizedBlockHash.toLowerCase()) {
    throw new Error(`settlement cursor block ${cursor.finalizedBlock} is no longer canonical`);
  }
}
