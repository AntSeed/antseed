import { Contract, ethers } from 'ethers';
import type { AbstractSigner, Log } from 'ethers';
import { BaseEvmClient, ERC20_ABI } from './base-evm-client.js';

export interface DepositsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  usdcAddress: string;
  evmChainId?: number;
}

export interface BuyerBalanceInfo {
  available: bigint;
  reserved: bigint;
  lastActivityAt: bigint;
}

export interface DecodedDeposited {
  blockNumber: number;
  txHash: string;
  logIndex: number;
  buyer: string;
  amount: bigint;
  /** Block timestamp, unix seconds. */
  timestamp: number;
}

const DEPOSITS_ABI = [
  'function deposit(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function uniqueSellersCharged(address buyer) external view returns (uint256)',
  'function getOperator(address buyer) external view returns (address)',
  'function getOperatorNonce(address buyer) external view returns (uint256)',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
  'function domainSeparator() external view returns (bytes32)',
  'event Deposited(address indexed buyer, uint256 amount)',
] as const;

// Public RPC providers cap eth_getLogs to widely varying block ranges (and
// signal it in provider-specific error shapes), so a fixed chunk size can't
// be trusted. Start at a generous span and, on any error, halve the range
// and retry until either it succeeds or hits the floor (where the error is
// no longer a range problem and should surface to the caller).
const DEFAULT_LOG_CHUNK_BLOCKS = 50_000;
const MIN_LOG_CHUNK_BLOCKS = 500;

export class DepositsClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: DepositsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this._usdcAddress = config.usdcAddress;
  }

  get usdcAddress(): string { return this._usdcAddress; }

  // ─── Buyer Operations ──────────────────────────────────────────────

  async deposit(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._approveAndExec(signer, this._usdcAddress, amount, DEPOSITS_ABI, 'deposit', buyer, amount);
  }

  async withdraw(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'withdraw', buyer, amount);
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getBuyerBalance(buyerAddr: string): Promise<BuyerBalanceInfo> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    const result = await contract.getFunction('getBuyerBalance')(buyerAddr);
    return {
      available: result[0] as bigint,
      reserved: result[1] as bigint,
      lastActivityAt: result[2] as bigint,
    };
  }

  async getBuyerCreditLimit(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getBuyerCreditLimit')(buyerAddr) as Promise<bigint>;
  }

  // ─── Operator Management ─────────────────────────────────────────

  async getOperator(buyerAddr: string): Promise<string> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getOperator')(buyerAddr) as Promise<string>;
  }

  async getOperatorNonce(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getOperatorNonce')(buyerAddr) as Promise<bigint>;
  }

  async setOperator(signer: AbstractSigner, buyer: string, operator: string, nonce: bigint, buyerSig: string): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'setOperator', buyer, operator, nonce, buyerSig);
  }

  async transferOperator(signer: AbstractSigner, buyer: string, newOperator: string): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'transferOperator', buyer, newOperator);
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  // ─── USDC Balance ───────────────────────────────────────────────

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }

  // ─── Deposit History ────────────────────────────────────────────

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }

  /**
   * Fetch this buyer's past Deposited events between fromBlock and toBlock
   * (inclusive, defaults to the full chain history through the latest
   * block). Scans in chunks with adaptive range-halving so it works against
   * public RPCs regardless of their eth_getLogs block-range cap, and
   * resolves each event's block timestamp. Returns events sorted by
   * (blockNumber, logIndex) ascending.
   */
  async getDepositHistory(buyerAddr: string, opts?: {
    fromBlock?: number;
    toBlock?: number;
    chunkSize?: number;
  }): Promise<DecodedDeposited[]> {
    const toBlock = opts?.toBlock ?? await this.getBlockNumber();
    const fromBlock = opts?.fromBlock ?? 0;
    if (fromBlock > toBlock) return [];
    const chunkSize = opts?.chunkSize ?? DEFAULT_LOG_CHUNK_BLOCKS;

    const iface = new ethers.Interface(DEPOSITS_ABI);
    const topic = iface.getEvent('Deposited')!.topicHash;
    const buyerTopic = ethers.zeroPadValue(ethers.getAddress(buyerAddr), 32);

    const decoded: DecodedDeposited[] = [];
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const logs = await this._getLogsAdaptive(topic, buyerTopic, start, end);
      for (const log of logs) {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (!parsed || parsed.name !== 'Deposited') continue;
        decoded.push({
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.index,
          buyer: (parsed.args[0] as string).toLowerCase(),
          amount: parsed.args[1] as bigint,
          timestamp: 0,
        });
      }
    }

    // Resolve block timestamps — one lookup per unique block, not per event.
    const uniqueBlocks = [...new Set(decoded.map((e) => e.blockNumber))];
    const timestamps = new Map<number, number>();
    await Promise.all(uniqueBlocks.map(async (blockNumber) => {
      const block = await this._provider.getBlock(blockNumber);
      timestamps.set(blockNumber, block?.timestamp ?? 0);
    }));
    for (const event of decoded) event.timestamp = timestamps.get(event.blockNumber) ?? 0;

    decoded.sort((a, b) =>
      a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex,
    );
    return decoded;
  }

  private async _getLogsAdaptive(topic: string, buyerTopic: string, fromBlock: number, toBlock: number): Promise<Log[]> {
    try {
      return await this._provider.getLogs({
        address: this._contractAddress,
        fromBlock,
        toBlock,
        topics: [topic, buyerTopic],
      });
    } catch (err) {
      const span = toBlock - fromBlock + 1;
      if (span <= MIN_LOG_CHUNK_BLOCKS) throw err;
      const mid = fromBlock + Math.floor(span / 2) - 1;
      const [left, right] = await Promise.all([
        this._getLogsAdaptive(topic, buyerTopic, fromBlock, mid),
        this._getLogsAdaptive(topic, buyerTopic, mid + 1, toBlock),
      ]);
      return [...left, ...right];
    }
  }
}
