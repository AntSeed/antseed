import { Contract, Interface, ZeroAddress, type AbstractSigner, type Log } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerPoolsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  antsTokenAddress: string;
  evmChainId?: number;
}

export interface SellerPoolPosition {
  id: number;
  owner: string;
  agentId: number;
  amount: bigint;
  weightAmount: bigint;
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  withdrawn: boolean;
}

const SELLER_POOLS_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) external returns (uint256 positionId)',
  'function stakerPositionCount(address staker) external view returns (uint256)',
  'function stakerPositionIds(address staker, uint256 offset, uint256 limit) external view returns (uint256[])',
  'function positions(uint256 positionId) external view returns (address owner, uint256 agentId, uint256 amount, uint256 weightAmount, uint64 stakeStartEpoch, uint64 stakeEndEpoch, uint64 closedAtEpoch, bool withdrawn)',
  'function positionWithdrawableEpoch(uint256 positionId) external view returns (uint64)',
  'function earlyExitSlashBps(uint256 positionId) external view returns (uint256)',
  'function withdrawStakes(uint256[] positionIds) external returns (uint256 returnedAmount, uint256 slashedAmount)',
  'function agentIdForSeller(address seller) external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function stakeActivationDelay() external view returns (uint256)',
  'function minStakeEpochs() external view returns (uint256)',
  'function MAX_STAKE_EPOCHS() external view returns (uint256)',
  'function hasPoolAtEpoch(uint256 agentId, uint256 epoch) external view returns (bool)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256)',
] as const;

export class SellerPoolsClient extends BaseEvmClient {
  private readonly antsTokenAddress: string;
  constructor(config: SellerPoolsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this.antsTokenAddress = config.antsTokenAddress;
  }
  private contract(): Contract { return new Contract(this._contractAddress, SELLER_POOLS_ABI, this._provider); }
  stake(signer: AbstractSigner, agentId: number, amount: bigint, epochs: number): Promise<string> {
    return this._approveAndExec(signer, this.antsTokenAddress, amount, SELLER_POOLS_ABI, 'stake', agentId, amount, epochs);
  }
  async stakerPositionCount(staker: string): Promise<number> { return Number(await this.contract().getFunction('stakerPositionCount')(staker)); }
  async stakerPositionIds(staker: string, offset = 0, limit = 256): Promise<number[]> {
    const ids = await this.contract().getFunction('stakerPositionIds')(staker, offset, limit) as bigint[];
    return ids.map(Number);
  }
  async position(id: number): Promise<SellerPoolPosition> {
    const result = await this.contract().getFunction('positions')(id);
    return { id, owner: result[0], agentId: Number(result[1]), amount: result[2], weightAmount: result[3], stakeStartEpoch: Number(result[4]), stakeEndEpoch: Number(result[5]), closedAtEpoch: Number(result[6]), withdrawn: result[7] };
  }
  async positionWithdrawableEpoch(id: number): Promise<number> { return Number(await this.contract().getFunction('positionWithdrawableEpoch')(id)); }
  async earlyExitSlashBps(id: number): Promise<number> { return Number(await this.contract().getFunction('earlyExitSlashBps')(id)); }
  withdrawStakes(signer: AbstractSigner, ids: number[]): Promise<string> { return this._execWrite(signer, SELLER_POOLS_ABI, 'withdrawStakes', ids); }
  async agentIdForSeller(seller: string): Promise<number> { return Number(await this.contract().getFunction('agentIdForSeller')(seller)); }
  async currentEpoch(): Promise<number> { return Number(await this.contract().getFunction('currentEpoch')()); }
  async stakeActivationDelay(): Promise<number> { return Number(await this.contract().getFunction('stakeActivationDelay')()); }
  async minStakeEpochs(): Promise<number> { return Number(await this.contract().getFunction('minStakeEpochs')()); }
  async maxStakeEpochs(): Promise<number> { return Number(await this.contract().getFunction('MAX_STAKE_EPOCHS')()); }
  hasPoolAtEpoch(agentId: number, epoch: number): Promise<boolean> { return this.contract().getFunction('hasPoolAtEpoch(uint256,uint256)')(agentId, epoch); }
  poolActiveStakeAtEpoch(agentId: number, epoch: number): Promise<bigint> { return this.contract().getFunction('poolActiveStakeAtEpoch(uint256,uint256)')(agentId, epoch); }
  allStakerPositionIds(staker: string): Promise<number[]> {
    return collectPositionIds((offset, limit) => this.stakerPositionIds(staker, offset, limit));
  }

  async rewardPositions(staker: string): Promise<SellerPoolPosition[]> {
    const ids = new Set(await this.allStakerPositionIds(staker));
    const tokenInterface = new Interface(SELLER_POOLS_ABI);
    const topics = tokenInterface.encodeFilterTopics('Transfer', [staker, ZeroAddress]);
    const latest = await this.provider.getBlockNumber();
    let first = 0;
    let last = latest;
    while (first < last) {
      const middle = Math.floor((first + last) / 2);
      if (await this.provider.getCode(this.contractAddress, middle) === '0x') first = middle + 1;
      else last = middle;
    }
    const ranges: Array<[number, number]> = [[first, latest]];
    let requests = 0;
    while (ranges.length > 0) {
      const [fromBlock, toBlock] = ranges.pop()!;
      let logs: Log[];
      try {
        if (++requests > 512) throw new Error('Historical position discovery exceeded the RPC request limit. Use an RPC with larger log ranges.');
        logs = await this.provider.getLogs({ address: this.contractAddress, topics, fromBlock, toBlock });
      } catch (error) {
        if (requests > 512 || fromBlock === toBlock || !/range|too many|response.*(size|large)|limit exceeded/i.test(String(error))) throw error;
        const middle = Math.floor((fromBlock + toBlock) / 2);
        ranges.push([fromBlock, middle], [middle + 1, toBlock]);
        continue;
      }
      for (const log of logs) {
        const event = tokenInterface.parseLog(log);
        if (event) ids.add(Number(event.args.tokenId));
      }
    }
    const positions: SellerPoolPosition[] = [];
    const positionIds = [...ids];
    for (let offset = 0; offset < positionIds.length; offset += 16) {
      const page = await Promise.all(positionIds.slice(offset, offset + 16).map((id) => this.position(id)));
      positions.push(...page.filter((position) => position.owner.toLowerCase() === staker.toLowerCase()));
    }
    return positions;
  }
}

async function collectPositionIds(readPage: (offset: number, limit: number) => Promise<number[]>): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; ; offset += 256) {
    const page = await readPage(offset, 256);
    ids.push(...page);
    if (page.length < 256) return ids;
  }
}

export interface EarlyExitEstimate {
  id: number;
  amount: bigint;
  slashBps: number;
  slashedAmount: bigint;
  returnedAmount: bigint;
}

export function estimateEarlyExit(position: SellerPoolPosition, slashBps: number): EarlyExitEstimate {
  const slashedAmount = position.amount * BigInt(slashBps) / 10_000n;
  return {
    id: position.id,
    amount: position.amount,
    slashBps,
    slashedAmount,
    returnedAmount: position.amount - slashedAmount,
  };
}
