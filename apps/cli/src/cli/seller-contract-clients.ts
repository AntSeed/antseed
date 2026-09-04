import { Contract, Interface, zeroPadValue, ZeroAddress, type AbstractSigner, type Log } from 'ethers';
import { ANTSTokenClient, SellerPoolsClient, SellerPoolsRewardsClient, SellerRegistryClient, type SellerPoolPosition } from '@antseed/node/payments';
import { previewPositionReward, REWARD_INDEX_SCALE } from './reward-preview.js';

const POOLS_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'function earlyExitSlashBps(uint256 positionId) view returns (uint256)',
  'function positionPowerSegmentAt(uint256 positionId, uint256 epoch) view returns (uint256, uint256, uint256)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function positions(uint256 positionId) view returns (address, uint256, uint256, uint256, uint64, uint64, uint64, bool)',
];
const REWARDS_ABI = [
  'function sellerPools() view returns (address)',
  'function usageAccounting() view returns (address)',
  'function positionClaimCursor(uint256 positionId) view returns (uint256)',
  'function poolRewardIndexNextEpoch(uint256 agentId) view returns (uint256)',
  'function initialIndexEpoch() view returns (uint256)',
  'function poolCumulativeRewardPerWeightAt(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolCumulativeEpochRewardPerWeightAt(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolEpochEmissions(uint256 epoch, uint256 agentId) view returns (bool, uint256)',
  'function stakerEpochBudget(uint256 epoch) view returns (uint256)',
  'function indexPoolRewards(uint256 agentId, uint256 maxEpochs) returns (uint256)',
];
const ACCOUNTING_ABI = [
  'function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) view returns (uint256)',
  'function totalWeightedPoolPointsByEpoch(uint256 epoch) view returns (uint256)',
];

export class CliSellerRegistryClient extends SellerRegistryClient {
  async isRegisteredSeller(seller: string, agentId: number): Promise<boolean> {
    if (!agentId) return false;
    const registry = new Contract(this.contractAddress, ['function agentSeller(uint256 agentId) view returns (address)'], this.provider);
    const [resolvedId, boundSeller] = await Promise.all([this.getAgentId(seller), registry.getFunction('agentSeller')(agentId)]);
    return resolvedId === agentId && boundSeller.toLowerCase() === seller.toLowerCase();
  }
}

export async function registerSellerBinding(
  registry: Pick<CliSellerRegistryClient, 'getAgentId' | 'isRegisteredSeller' | 'registerSeller'>,
  wallet: AbstractSigner,
  address: string,
  agentId: number,
  confirmed: (hash: string) => void,
): Promise<boolean> {
  const boundAgentId = await registry.getAgentId(address);
  if (boundAgentId !== 0 && boundAgentId !== agentId) {
    throw new Error(`Seller is already bound to agent ${boundAgentId}, not ${agentId}.`);
  }
  if (await registry.isRegisteredSeller(address, agentId)) return false;
  confirmed(await registry.registerSeller(wallet, agentId));
  if (!await registry.isRegisteredSeller(address, agentId)) {
    throw new Error('Registration could not be verified. Re-run: antseed seller register');
  }
  return true;
}

export async function requireSellerBinding(
  registry: Pick<CliSellerRegistryClient, 'getAgentId' | 'isRegisteredSeller'>,
  address: string,
  requestedAgentId?: number,
): Promise<number> {
  const agentId = await registry.getAgentId(address);
  if (!agentId || !await registry.isRegisteredSeller(address, agentId)) {
    throw new Error('Registration needs updating before you can stake. Run: antseed seller register. Your existing identity will be kept.');
  }
  if (requestedAgentId !== undefined && requestedAgentId !== agentId) {
    throw new Error(`Seller is bound to agent ${agentId}, not ${requestedAgentId}.`);
  }
  return agentId;
}

export async function collectPositionIds(readPage: (offset: number, limit: number) => Promise<number[]>): Promise<number[]> {
  const ids: number[] = [];
  for (let offset = 0; ; offset += 256) {
    const page = await readPage(offset, 256);
    ids.push(...page);
    if (page.length < 256) return ids;
  }
}

export class CliSellerPoolsClient extends SellerPoolsClient {
  async earlyExitSlashBps(positionId: number): Promise<number> {
    const pools = new Contract(this.contractAddress, POOLS_ABI, this.provider);
    return Number(await pools.getFunction('earlyExitSlashBps')(positionId));
  }

  allStakerPositionIds(staker: string): Promise<number[]> {
    return collectPositionIds((offset, limit) => this.stakerPositionIds(staker, offset, limit));
  }

  async rewardPositions(staker: string): Promise<SellerPoolPosition[]> {
    const ids = new Set(await this.allStakerPositionIds(staker));
    const tokenInterface = new Interface(POOLS_ABI);
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

export class CliSellerPoolsRewardsClient extends SellerPoolsRewardsClient {
  private previewBlock?: Promise<number>;
  private readonly previewReads = new Map<string, Promise<unknown>>();

  private read<Value>(contract: Contract, method: string, ...args: (number | bigint)[]): Promise<Value> {
    const key = `${contract.target}:${method}:${args.join(',')}`;
    let result = this.previewReads.get(key);
    if (!result) {
      this.previewBlock ??= this.provider.getBlockNumber();
      result = this.previewBlock.then((blockTag) => contract.getFunction(method)(...args, { blockTag }));
      this.previewReads.set(key, result);
    }
    return result as Promise<Value>;
  }

  async previewStakerReward(positionId: number): Promise<bigint> {
    const rewards = new Contract(this.contractAddress, REWARDS_ABI, this.provider);
    const poolAddress = await this.read<string>(rewards, 'sellerPools');
    const pools = new Contract(poolAddress, POOLS_ABI, this.provider);
    const accounting = new Contract(await this.read<string>(rewards, 'usageAccounting'), ACCOUNTING_ABI, this.provider);
    const position = await this.read<[string, bigint, bigint, bigint, bigint, bigint, bigint, boolean]>(pools, 'positions', positionId);
    if (position[0] === ZeroAddress) throw new Error(`Unknown position ${positionId}`);
    return previewPositionReward({
      id: positionId, owner: position[0], agentId: Number(position[1]), amount: position[2], weightAmount: position[3],
      stakeStartEpoch: Number(position[4]), stakeEndEpoch: Number(position[5]), closedAtEpoch: Number(position[6]), withdrawn: position[7],
    }, {
      currentEpoch: async () => Number(await this.read<bigint>(pools, 'currentEpoch')),
      claimCursor: async (id) => Number(await this.read<bigint>(rewards, 'positionClaimCursor', id)),
      indexCursor: async (agentId) => Number(await this.read<bigint>(rewards, 'poolRewardIndexNextEpoch', agentId) || await this.read<bigint>(rewards, 'initialIndexEpoch')),
      segment: async (id, epoch) => {
        const [normalEnd, maxLockPower, nextChange] = await this.read<[bigint, bigint, bigint]>(pools, 'positionPowerSegmentAt', id, epoch);
        return { normalEnd, maxLockPower, nextChange };
      },
      cumulative: async (agentId, epoch) => ({
        reward: await this.read<bigint>(rewards, 'poolCumulativeRewardPerWeightAt', agentId, epoch),
        epochReward: await this.read<bigint>(rewards, 'poolCumulativeEpochRewardPerWeightAt', agentId, epoch),
      }),
      rewardPerWeight: async (agentId, epoch) => {
        const weight = await this.read<bigint>(pools, 'poolWeightAtEpoch', agentId, epoch);
        if (weight === 0n) return 0n;
        const [settled, amount] = await this.read<[boolean, bigint]>(rewards, 'poolEpochEmissions', epoch, agentId);
        if (settled) return amount * REWARD_INDEX_SCALE / weight;
        const [points, total] = await Promise.all([
          this.read<bigint>(accounting, 'weightedPoolPointsByEpoch', epoch, agentId),
          this.read<bigint>(accounting, 'totalWeightedPoolPointsByEpoch', epoch),
        ]);
        if (points === 0n || total === 0n) return 0n;
        const budget = await this.read<bigint>(rewards, 'stakerEpochBudget', epoch);
        return (budget * points / total) * REWARD_INDEX_SCALE / weight;
      },
    });
  }

  async poolRewardIndexNextEpoch(agentId: number): Promise<number> {
    return Number(await new Contract(this.contractAddress, REWARDS_ABI, this.provider).getFunction('poolRewardIndexNextEpoch')(agentId));
  }
  async initialIndexEpoch(): Promise<number> {
    return Number(await new Contract(this.contractAddress, REWARDS_ABI, this.provider).getFunction('initialIndexEpoch')());
  }
  indexPoolRewards(signer: AbstractSigner, agentId: number, maxEpochs: number): Promise<string> {
    return this._execWrite(signer, REWARDS_ABI, 'indexPoolRewards', agentId, maxEpochs);
  }
}

export class CliAntsTokenClient extends ANTSTokenClient {
  async receivedInTransaction(transactionHash: string, recipient: string): Promise<bigint> {
    const receipt = await this.provider.getTransactionReceipt(transactionHash);
    if (!receipt || receipt.status !== 1) throw new Error(`Confirmed receipt unavailable: ${transactionHash}`);
    const tokenInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    const topics = tokenInterface.encodeFilterTopics('Transfer', [null, recipient]);
    return receipt.logs.reduce((received, log) => {
      if (log.address.toLowerCase() !== this.contractAddress.toLowerCase() || log.topics[0] !== topics[0] || log.topics[2]?.toLowerCase() !== zeroPadValue(recipient, 32).toLowerCase()) return received;
      return received + (tokenInterface.parseLog(log)!.args.value as bigint);
    }, 0n);
  }
}
