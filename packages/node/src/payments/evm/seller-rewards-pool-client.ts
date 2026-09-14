import { Contract, getAddress, ZeroAddress, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SellerRewardsPoolClientConfig { rpcUrl: string; fallbackRpcUrls?: string[]; contractAddress: string; evmChainId?: number; }

const ABI = [
  'function lockedRewards(address seller) external view returns (uint256)',
  'function totalLockedRewards() external view returns (uint256)',
  'function sellerClaimPolicy() external view returns (address)',
  'function registry() external view returns (address)',
  'function claim(address recipient) external',
] as const;

const POLICY_ABI = ['function claimableSellerRewards(address seller, uint256 lockedAmount) external view returns (uint256)'] as const;

const LEGACY_POLICY_ABI = [
  ...POLICY_ABI,
  'function cumulativeLocked(address seller) external view returns (uint256)',
  'function releaseBps() external view returns (uint256)',
  'function lastEpoch() external view returns (uint256)',
  'function v2() external view returns (address)',
  'function washTradingRegistry() external view returns (address)',
  'function isWashTrader(address seller) external view returns (bool)',
] as const;

export function validateRewardAddress(address: string): string {
  const normalized = getAddress(address);
  if (normalized === ZeroAddress) throw new Error('Reward address must not be the zero address.');
  return normalized;
}

/** Legacy locked seller rewards pool (`AntseedSellerRewardsPool`). Releases are gated by the M002 claim policy. */
export class SellerRewardsPoolClient extends BaseEvmClient {
  constructor(config: SellerRewardsPoolClientConfig) { super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId); }
  private contract(): Contract { return new Contract(this._contractAddress, ABI, this._provider); }

  lockedRewards(seller: string): Promise<bigint> { return this.contract().getFunction('lockedRewards')(seller); }
  totalLockedRewards(): Promise<bigint> { return this.contract().getFunction('totalLockedRewards')(); }
  sellerClaimPolicy(): Promise<string> { return this.contract().getFunction('sellerClaimPolicy')(); }
  /** Amount the configured policy would release now; zero when no policy is installed. */
  async claimable(seller: string): Promise<{ locked: bigint; claimable: bigint; policy: string }> {
    const [locked, policy] = await Promise.all([this.lockedRewards(seller), this.sellerClaimPolicy()]);
    if (policy === ZeroAddress || locked === 0n) return { locked, claimable: 0n, policy };
    const allowed = await new Contract(policy, POLICY_ABI, this._provider).getFunction('claimableSellerRewards')(seller, locked) as bigint;
    return { locked, claimable: allowed > locked ? locked : allowed, policy };
  }

  async details(sellerAddress: string) {
    const seller = validateRewardAddress(sellerAddress);
    const blockNumber = await this._provider.getBlockNumber();
    const overrides = { blockTag: blockNumber };
    const pool = this.contract();
    const [locked, policyAddress, registryAddress] = await Promise.all([
      pool.getFunction('lockedRewards')(seller, overrides) as Promise<bigint>,
      pool.getFunction('sellerClaimPolicy')(overrides) as Promise<string>,
      pool.getFunction('registry')(overrides) as Promise<string>,
    ]);
    const registry = new Contract(registryAddress, ['function antsToken() view returns (address)'], this._provider);
    const tokenAddress = await registry.getFunction('antsToken')(overrides) as string;
    const token = new Contract(tokenAddress, [
      'function transfersEnabled() view returns (bool)',
      'function transferWhitelist(address) view returns (bool)',
      'function balanceOf(address) view returns (uint256)',
    ], this._provider);
    const [transfersEnabled, poolWhitelisted, poolBalance] = await Promise.all([
      token.getFunction('transfersEnabled')(overrides) as Promise<boolean>,
      token.getFunction('transferWhitelist')(this._contractAddress, overrides) as Promise<boolean>,
      token.getFunction('balanceOf')(this._contractAddress, overrides) as Promise<bigint>,
    ]);
    const common = { seller, blockNumber, pool: this._contractAddress, token: tokenAddress, locked, poolBalance, transferAllowed: transfersEnabled || poolWhitelisted };
    if (policyAddress === ZeroAddress) return { ...common, policy: null };
    const policy = new Contract(policyAddress, LEGACY_POLICY_ABI, this._provider);
    const [cumulativeLocked, releaseBps, lastEpoch, legacyEmissions, washTradingRegistry, restricted, allowed] = await Promise.all([
      policy.getFunction('cumulativeLocked')(seller, overrides) as Promise<bigint>,
      policy.getFunction('releaseBps')(overrides) as Promise<bigint>,
      policy.getFunction('lastEpoch')(overrides) as Promise<bigint>,
      policy.getFunction('v2')(overrides) as Promise<string>,
      policy.getFunction('washTradingRegistry')(overrides) as Promise<string>,
      policy.getFunction('isWashTrader')(seller, overrides) as Promise<boolean>,
      policy.getFunction('claimableSellerRewards')(seller, locked, overrides) as Promise<bigint>,
    ]);
    if (releaseBps <= 0n || releaseBps > 10_000n) throw new Error('Unsupported claim policy release percentage.');
    const accountingCumulative = cumulativeLocked < locked ? locked : cumulativeLocked;
    const withdrawn = accountingCumulative - locked;
    const entitlement = accountingCumulative * releaseBps / 10_000n;
    return { ...common, policy: {
      address: policyAddress, cumulativeLocked, accountingCumulative, withdrawn, entitlement,
      releaseBps, lastEpoch, legacyEmissions, washTradingRegistry, restricted,
      claimable: allowed > locked ? locked : allowed,
    } };
  }

  async previewClaim(sellerAddress: string, recipientAddress: string) {
    const seller = validateRewardAddress(sellerAddress);
    const recipient = validateRewardAddress(recipientAddress);
    const claim = this.contract().getFunction('claim');
    await claim.staticCall(recipient, { from: seller });
    const gasEstimate = await claim.estimateGas(recipient, { from: seller });
    const gasLimit = gasEstimate * 130n / 100n;
    const [fees, ethBalance] = await Promise.all([this._provider.getFeeData(), this._provider.getBalance(seller)]);
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (maxFeePerGas === null) throw new Error('RPC did not provide a gas price; cannot estimate claim cost.');
    const maxExecutionFee = gasLimit * maxFeePerGas;
    if (ethBalance < maxExecutionFee) throw new Error('Insufficient ETH for the estimated claim execution fee.');
    return { gasEstimate, gasLimit, maxFeePerGas, maxExecutionFee, ethBalance };
  }

  claim(signer: AbstractSigner, recipient: string): Promise<string> { return this._execWrite(signer, ABI, 'claim', validateRewardAddress(recipient)); }
}
