import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SubPoolClientConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
] as const;

const SUBPOOL_ABI = [
  'function subscribe(uint256 tierId) external',
  'function renewSubscription() external',
  'function cancelSubscription() external',
  'function isSubscriptionActive(address buyer) external view returns (bool)',
  'function getRemainingDailyBudget(address buyer) external view returns (uint256)',
  'function recordTokenUsage(address buyer, uint256 tokens) external',
  'function optIn(uint256 tokenId) external',
  'function optOut(uint256 tokenId) external',
  'function claimRevenue() external',
  'function distributeRevenue() external',
  'function getProjectedRevenue(address seller) external view returns (uint256)',
  'function getTier(uint256 tierId) external view returns (uint256 monthlyFee, uint256 dailyTokenBudget, bool active)',
  'function getOptedInPeerCount() external view returns (uint256)',
  'function currentEpoch() external view returns (uint256)',
  'function currentEpochRevenue() external view returns (uint256)',
  'function epochDuration() external view returns (uint256)',
  'function epochStart() external view returns (uint256)',
  'function tierCount() external view returns (uint256)',
] as const;

export class SubPoolClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: SubPoolClientConfig) {
    super(config.rpcUrl, config.contractAddress);
    this._usdcAddress = config.usdcAddress;
  }

  // ─── Subscription Methods ──────────────────────────────────────────

  async subscribe(signer: AbstractSigner, tierId: number): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);

    // Fetch tier fee and approve USDC
    const [monthlyFee] = await contract.getFunction('getTier')(tierId);
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, monthlyFee, { nonce: approveNonce });
    await approveTx.wait();

    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('subscribe')(tierId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async renewSubscription(signer: AbstractSigner, monthlyFee: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();

    // Approve USDC for renewal
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, monthlyFee, { nonce: approveNonce });
    await approveTx.wait();

    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('renewSubscription')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async cancelSubscription(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('cancelSubscription')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async isSubscriptionActive(buyer: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('isSubscriptionActive')(buyer);
  }

  async getRemainingDailyBudget(buyer: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('getRemainingDailyBudget')(buyer);
  }

  async recordTokenUsage(signer: AbstractSigner, buyer: string, tokens: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('recordTokenUsage')(buyer, tokens, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ─── Peer Methods ──────────────────────────────────────────────────

  async optIn(signer: AbstractSigner, tokenId: number): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('optIn')(tokenId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async optOut(signer: AbstractSigner, tokenId: number): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('optOut')(tokenId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ─── Revenue Methods ───────────────────────────────────────────────

  async claimRevenue(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('claimRevenue')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async getProjectedRevenue(seller: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('getProjectedRevenue')(seller);
  }

  // ─── View Methods ──────────────────────────────────────────────────

  async getTier(tierId: number): Promise<{ monthlyFee: bigint; dailyTokenBudget: bigint; active: boolean }> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    const [monthlyFee, dailyTokenBudget, active] = await contract.getFunction('getTier')(tierId);
    return { monthlyFee, dailyTokenBudget, active };
  }

  async getOptedInPeerCount(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('getOptedInPeerCount')();
  }

  async currentEpoch(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('currentEpoch')();
  }

  async currentEpochRevenue(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SUBPOOL_ABI, this._provider);
    return contract.getFunction('currentEpochRevenue')();
  }
}
