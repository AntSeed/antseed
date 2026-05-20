import { type AbstractSigner, Contract, ethers } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import type { UsageClaimMessage } from './signatures.js';

export interface UsageVerificationClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface UsageStatsInfo {
  inputTokens: bigint;
  cachedInputTokens: bigint;
  freshInputTokens: bigint;
  outputTokens: bigint;
  requestCount: bigint;
  costUsdc: bigint;
  attestationCount: bigint;
  partialRevealCount: bigint;
  lastUpdatedAt: number;
}

export interface UsageCommitPairInput {
  claimHash: string;
  channelId: string;
  buyer: string;
  seller: string;
  sellerAgentId: bigint;
  serviceKey: string;
  buyerRevealHash: string;
  sellerRevealHash: string;
  expectedEpoch: bigint;
  buyerSig: string;
  sellerSig: string;
}

export interface UsageRevealedEvent {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  claimHash: string;
  channelId: string;
  serviceKey: string;
  epoch: bigint;
  buyer: string;
  seller: string;
  sellerAgentId: bigint;
  providerName: string;
  serviceName: string;
  inputTokensDelta: bigint;
  cachedInputTokensDelta: bigint;
  freshInputTokensDelta: bigint;
  outputTokensDelta: bigint;
  requestCountDelta: bigint;
  costUsdcDelta: bigint;
  paymentCumulativeAmount: bigint;
}

const USAGE_VERIFICATION_ABI = [
  'function currentEpoch() external view returns (uint256)',
  'function domainSeparator() external view returns (bytes32)',
  'function hashUsageClaim((uint256 version, bytes32 channelId, address buyer, address seller, uint256 sellerAgentId, bytes32 serviceKey, string providerName, string serviceName, uint256 cumulativeInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeFreshInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeCostUsdc, uint256 paymentCumulativeAmount) claim) external pure returns (bytes32)',
  'function revealHash(bytes32 claimHash, bytes32 nonce) external pure returns (bytes32)',
  'function commitPair((bytes32 claimHash, bytes32 channelId, address buyer, address seller, uint256 sellerAgentId, bytes32 serviceKey, bytes32 buyerRevealHash, bytes32 sellerRevealHash, uint256 expectedEpoch, bytes buyerSig, bytes sellerSig) input) external',
  'function revealPair((uint256 version, bytes32 channelId, address buyer, address seller, uint256 sellerAgentId, bytes32 serviceKey, string providerName, string serviceName, uint256 cumulativeInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeFreshInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeCostUsdc, uint256 paymentCumulativeAmount) claim, bytes32 buyerNonce, bytes32 sellerNonce) external',
  'function revealPartial((uint256 version, bytes32 channelId, address buyer, address seller, uint256 sellerAgentId, bytes32 serviceKey, string providerName, string serviceName, uint256 cumulativeInputTokens, uint256 cumulativeCachedInputTokens, uint256 cumulativeFreshInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount, uint256 cumulativeCostUsdc, uint256 paymentCumulativeAmount) claim, bytes32 nonce, uint8 party) external',
  'function getSellerServiceStats(uint256 sellerAgentId, bytes32 serviceKey, uint256 epoch) external view returns (uint256 inputTokens, uint256 cachedInputTokens, uint256 freshInputTokens, uint256 outputTokens, uint256 requestCount, uint256 costUsdc, uint256 attestationCount, uint256 partialRevealCount, uint64 lastUpdatedAt)',
  'function getBuyerServiceStats(address buyer, bytes32 serviceKey, uint256 epoch) external view returns (uint256 inputTokens, uint256 cachedInputTokens, uint256 freshInputTokens, uint256 outputTokens, uint256 requestCount, uint256 costUsdc, uint256 attestationCount, uint256 partialRevealCount, uint64 lastUpdatedAt)',
  'event UsageRevealed(bytes32 indexed claimHash, bytes32 indexed channelId, bytes32 indexed serviceKey, uint256 epoch, address buyer, address seller, uint256 sellerAgentId, string providerName, string serviceName, uint256 inputTokensDelta, uint256 cachedInputTokensDelta, uint256 freshInputTokensDelta, uint256 outputTokensDelta, uint256 requestCountDelta, uint256 costUsdcDelta, uint256 paymentCumulativeAmount)',
] as const;

export class UsageVerificationClient extends BaseEvmClient {
  constructor(config: UsageVerificationClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
  }

  async currentEpoch(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    return contract.getFunction('currentEpoch')() as Promise<bigint>;
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  async hashUsageClaim(claim: UsageClaimMessage): Promise<string> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    return contract.getFunction('hashUsageClaim')(claimToTuple(claim)) as Promise<string>;
  }

  async revealHash(claimHash: string, nonce: string): Promise<string> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    return contract.getFunction('revealHash')(claimHash, nonce) as Promise<string>;
  }

  async commitPair(signer: AbstractSigner, input: UsageCommitPairInput): Promise<string> {
    return this._execWrite(signer, USAGE_VERIFICATION_ABI, 'commitPair', inputToTuple(input));
  }

  async revealPair(signer: AbstractSigner, claim: UsageClaimMessage, buyerNonce: string, sellerNonce: string): Promise<string> {
    return this._execWrite(signer, USAGE_VERIFICATION_ABI, 'revealPair', claimToTuple(claim), buyerNonce, sellerNonce);
  }

  async revealPartial(signer: AbstractSigner, claim: UsageClaimMessage, nonce: string, party: number): Promise<string> {
    return this._execWrite(signer, USAGE_VERIFICATION_ABI, 'revealPartial', claimToTuple(claim), nonce, party);
  }

  async getSellerServiceStats(sellerAgentId: bigint | number, serviceKey: string, epoch: bigint | number): Promise<UsageStatsInfo> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    const result = await contract.getFunction('getSellerServiceStats')(sellerAgentId, serviceKey, epoch);
    return statsFromTuple(result as unknown[]);
  }

  async getBuyerServiceStats(buyer: string, serviceKey: string, epoch: bigint | number): Promise<UsageStatsInfo> {
    const contract = new Contract(this._contractAddress, USAGE_VERIFICATION_ABI, this._provider);
    const result = await contract.getFunction('getBuyerServiceStats')(buyer, serviceKey, epoch);
    return statsFromTuple(result as unknown[]);
  }

  async getUsageRevealedEvents(params: { fromBlock: number; toBlock: number }): Promise<UsageRevealedEvent[]> {
    const iface = new ethers.Interface(USAGE_VERIFICATION_ABI);
    const topic = iface.getEvent('UsageRevealed')!.topicHash;
    const logs = await this._provider.getLogs({
      address: this._contractAddress,
      fromBlock: params.fromBlock,
      toBlock: params.toBlock,
      topics: [topic],
    });

    return logs.map((log) => {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'UsageRevealed') throw new Error('Unexpected usage verification event');
      return {
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        claimHash: parsed.args[0] as string,
        channelId: parsed.args[1] as string,
        serviceKey: parsed.args[2] as string,
        epoch: parsed.args[3] as bigint,
        buyer: (parsed.args[4] as string).toLowerCase(),
        seller: (parsed.args[5] as string).toLowerCase(),
        sellerAgentId: parsed.args[6] as bigint,
        providerName: parsed.args[7] as string,
        serviceName: parsed.args[8] as string,
        inputTokensDelta: parsed.args[9] as bigint,
        cachedInputTokensDelta: parsed.args[10] as bigint,
        freshInputTokensDelta: parsed.args[11] as bigint,
        outputTokensDelta: parsed.args[12] as bigint,
        requestCountDelta: parsed.args[13] as bigint,
        costUsdcDelta: parsed.args[14] as bigint,
        paymentCumulativeAmount: parsed.args[15] as bigint,
      };
    }).sort((a, b) => a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex);
  }

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }
}

function claimToTuple(claim: UsageClaimMessage): unknown[] {
  return [
    claim.version,
    claim.channelId,
    claim.buyer,
    claim.seller,
    claim.sellerAgentId,
    claim.serviceKey,
    claim.providerName,
    claim.serviceName,
    claim.cumulativeInputTokens,
    claim.cumulativeCachedInputTokens,
    claim.cumulativeFreshInputTokens,
    claim.cumulativeOutputTokens,
    claim.cumulativeRequestCount,
    claim.cumulativeCostUsdc,
    claim.paymentCumulativeAmount,
  ];
}

function inputToTuple(input: UsageCommitPairInput): unknown[] {
  return [
    input.claimHash,
    input.channelId,
    input.buyer,
    input.seller,
    input.sellerAgentId,
    input.serviceKey,
    input.buyerRevealHash,
    input.sellerRevealHash,
    input.expectedEpoch,
    input.buyerSig,
    input.sellerSig,
  ];
}

function statsFromTuple(result: unknown[]): UsageStatsInfo {
  return {
    inputTokens: result[0] as bigint,
    cachedInputTokens: result[1] as bigint,
    freshInputTokens: result[2] as bigint,
    outputTokens: result[3] as bigint,
    requestCount: result[4] as bigint,
    costUsdc: result[5] as bigint,
    attestationCount: result[6] as bigint,
    partialRevealCount: result[7] as bigint,
    lastUpdatedAt: Number(result[8]),
  };
}
