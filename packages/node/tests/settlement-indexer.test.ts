import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSettledEvent } from '../src/payments/evm/channels-client.js';
import { encodeMetadata, getServiceMetadataId } from '../src/payments/evm/signatures.js';
import { indexFinalizedChannelSettlements } from '../src/verification/settlement-indexer.js';
import { VerificationStorage, type StoredAuditJob, type StoredAuditPlan } from '../src/verification/storage.js';

const CHANNELS = '0x' + '11'.repeat(20);
const SELLER = '0x' + '22'.repeat(20);
const CHANNEL_ID = '0x' + '33'.repeat(32);
const AUDIT_ID = '0x' + '44'.repeat(32);
const TARGET_SERVICE = 'gpt-5.6-sol';
const TARGET_HASH = getServiceMetadataId(TARGET_SERVICE);
const OTHER_HASH = getServiceMetadataId('other-service');

function plan(): StoredAuditPlan {
  return {
    auditId: AUDIT_ID,
    state: 'executing',
    source: 'manual',
    epoch: '1',
    durationMs: 86_400_000,
    chainId: '31337',
    registryAddress: '0x' + '55'.repeat(20),
    treasuryAddress: '0x' + '66'.repeat(20),
    verifierAddress: '0x' + '77'.repeat(20),
    agentId: '7',
    targetPeerId: SELLER.slice(2),
    targetService: TARGET_SERVICE,
    targetServiceHash: TARGET_HASH,
    targetSalt: '0x' + '88'.repeat(32),
    targetCommitment: '0x' + '99'.repeat(32),
    probeRoot: '0x' + 'aa'.repeat(32),
    auditJobRoot: '0x' + 'bb'.repeat(32),
    referenceId: '0x' + 'cc'.repeat(32),
    queryProfileHash: '0x' + 'dd'.repeat(32),
    verifierConfigHash: '0x' + 'ee'.repeat(32),
    probeCount: 10,
    jobCount: 1,
    requiredRelayCount: 1,
    jobTimeoutMs: 30_000,
    payoutPerJobUsdc: 30n,
    reservedBudgetUsdc: 30n,
    commitTxHash: '0x' + 'ab'.repeat(32),
    attestationTxHash: null,
    evidenceHash: null,
    evidenceUri: null,
    evidenceState: 'none',
    executeAfter: 1_700_000_000,
    executeBefore: 1_700_000_600,
    forceClaimAvailableAt: 1_700_022_200,
    forceClaimDeadline: 1_702_614_200,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    failureReason: null,
  };
}

function auditJob(): StoredAuditJob {
  return {
    auditId: AUDIT_ID,
    jobIndex: 0,
    state: 'assigned',
    scheduledAt: 1_700_000_000_000,
    relayPeerId: 'ff'.repeat(20),
    relayBuyerAddress: '0x' + 'ff'.repeat(20),
    assignmentAttempt: 0,
    assignmentSignature: '0x' + 'ab'.repeat(65),
    assignmentState: 'assigned',
    assignedAt: 1_700_000_000_000,
    lastDispatchAt: null,
    sellerPeerId: SELLER.slice(2),
    service: TARGET_SERVICE,
    serviceHash: TARGET_HASH,
    requestHash: '0x' + '12'.repeat(32),
    jobSalt: '0x' + '13'.repeat(32),
    executeAfter: 1_700_000_000,
    executeBefore: 1_700_000_600,
    requestBytes: new Uint8Array([1]),
    positionalProof: [],
    responseBytes: null,
    responseAuthPayload: null,
    sellerChargeUsdc: null,
    paymentMetadata: null,
    dispatchedAt: null,
    completedAt: null,
    failureKind: null,
    failureMessage: null,
    entitlementPersistedAt: null,
  };
}

function metadata(targetCumulative: bigint, otherCumulative = 0n): string {
  const services = [{
    serviceId: TARGET_HASH,
    cumulativeAmount: targetCumulative,
    cumulativeInputTokens: 0n,
    cumulativeCachedInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 1n,
  }];
  if (otherCumulative > 0n) services.push({
    serviceId: OTHER_HASH,
    cumulativeAmount: otherCumulative,
    cumulativeInputTokens: 0n,
    cumulativeCachedInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 1n,
  });
  return encodeMetadata({
    cumulativeInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: BigInt(services.length),
    services,
  });
}

function event(input: {
  txByte: string;
  logIndex: number;
  blockNumber: number;
  cumulativeAmount: bigint;
  delta: bigint;
  metadata: string;
}): ChannelSettledEvent {
  return {
    channelId: CHANNEL_ID,
    buyer: '0x' + '14'.repeat(20),
    seller: SELLER,
    cumulativeAmount: input.cumulativeAmount,
    delta: input.delta,
    totalSettled: input.cumulativeAmount,
    platformFee: 0n,
    metadata: input.metadata,
    blockNumber: input.blockNumber,
    blockHash: `0x${input.blockNumber.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${input.txByte.repeat(32)}`,
    logIndex: input.logIndex,
  };
}

describe('finalized settlement indexing', () => {
  let tempDir: string;
  let dbPath: string;
  let storage: VerificationStorage;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'settlement-indexer-'));
    dbPath = join(tempDir, 'verification.db');
    storage = new VerificationStorage(dbPath);
    storage.saveAuditPlan(plan(), [auditJob()]);
    storage.persistAuditJobSuccess({
      auditId: AUDIT_ID,
      jobIndex: 0,
      responseBytes: new Uint8Array([1]),
      responseAuthPayload: new Uint8Array([2]),
      sellerChargeUsdc: 25n,
      paymentMetadata: {
        spendingAuth: {
          channelId: CHANNEL_ID,
          cumulativeAmount: '100',
        },
      },
    });
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes cumulative deltas once, subtracts audit traffic, and resumes from its cursor', async () => {
    const first = event({
      txByte: '15',
      logIndex: 0,
      blockNumber: 9,
      cumulativeAmount: 100n,
      delta: 100n,
      metadata: metadata(100n),
    });
    const second = event({
      txByte: '16',
      logIndex: 0,
      blockNumber: 10,
      cumulativeAmount: 160n,
      delta: 60n,
      metadata: metadata(120n, 40n),
    });
    const getChannelSettledEvents = vi.fn().mockResolvedValue([second, first, first]);
    const blockHashes = new Map<number, string>([
      [9, first.blockHash],
      [10, second.blockHash],
    ]);
    const channelsClient = {
      readAddress: Promise.resolve(CHANNELS),
      getBlockNumber: vi.fn().mockResolvedValue(12),
      getChannelSettledEvents,
      provider: {
        getBlock: vi.fn(async (blockNumber: number) => ({
          hash: blockHashes.get(blockNumber) ?? `0x${blockNumber.toString(16).padStart(64, '0')}`,
          timestamp: 1_700_000_000 + blockNumber,
        })),
      },
    };
    const config = {
      chainId: '31337',
      channelsClient: channelsClient as never,
      stakingClient: { getAgentId: vi.fn().mockResolvedValue(7) },
      storage,
      startBlock: 9,
      confirmationBlocks: 2,
      chunkSize: 10,
    };

    await expect(indexFinalizedChannelSettlements(config)).resolves.toEqual({
      fromBlock: 9,
      toBlock: 10,
      settlementLogs: 3,
      serviceRows: 3,
    });
    expect(storage.computeModelShareBps('7', TARGET_SERVICE, 1_700_000_000_000, 1_700_000_020_000)).toBe(7037);
    expect(storage.getSettlementCursor('31337', CHANNELS)).toMatchObject({
      finalizedBlock: 10,
      finalizedBlockHash: second.blockHash,
    });

    storage.close();
    storage = new VerificationStorage(dbPath);
    await expect(indexFinalizedChannelSettlements({ ...config, storage })).resolves.toEqual({
      fromBlock: 11,
      toBlock: 10,
      settlementLogs: 0,
      serviceRows: 0,
    });
    expect(getChannelSettledEvents).toHaveBeenCalledTimes(1);
  });

  it('refuses to continue when the finalized cursor is no longer canonical', async () => {
    storage.updateSettlementCursor({
      chainId: '31337',
      channelsAddress: CHANNELS,
      finalizedBlock: 10,
      finalizedBlockHash: '0x' + '17'.repeat(32),
      updatedAt: Date.now(),
    });
    const channelsClient = {
      readAddress: Promise.resolve(CHANNELS),
      getBlockNumber: vi.fn().mockResolvedValue(12),
      getChannelSettledEvents: vi.fn(),
      provider: {
        getBlock: vi.fn().mockResolvedValue({ hash: '0x' + '18'.repeat(32), timestamp: 1_700_000_010 }),
      },
    };
    await expect(indexFinalizedChannelSettlements({
      chainId: '31337',
      channelsClient: channelsClient as never,
      stakingClient: { getAgentId: vi.fn().mockResolvedValue(7) },
      storage,
      startBlock: 0,
      confirmationBlocks: 2,
    })).rejects.toThrow(/no longer canonical/);
  });
});
