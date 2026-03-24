import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface DepositsClientConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
}

export interface BuyerBalanceInfo {
  available: bigint;
  reserved: bigint;
  pendingWithdrawal: bigint;
  lastActivityAt: bigint;
}

const DEPOSITS_ABI = [
  'function deposit(uint256 amount) external',
  'function depositFor(address buyer, uint256 amount) external',
  'function requestWithdrawal(uint256 amount) external',
  'function executeWithdrawal() external',
  'function cancelWithdrawal() external',
  'function claimEarnings() external',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 pendingWithdrawal, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function sellerEarnings(address seller) external view returns (uint256)',
  'function uniqueSellersCharged(address buyer) external view returns (uint256)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export class DepositsClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: DepositsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
    this._usdcAddress = config.usdcAddress;
  }

  get usdcAddress(): string { return this._usdcAddress; }

  // ─── Buyer Operations ──────────────────────────────────────────────

  async deposit(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const depositNonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('deposit')(amount, { nonce: depositNonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async depositFor(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const depositNonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('depositFor')(buyer, amount, { nonce: depositNonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async requestWithdrawal(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('requestWithdrawal')(amount, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async executeWithdrawal(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('executeWithdrawal')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async cancelWithdrawal(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('cancelWithdrawal')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ─── Seller Earnings ────────────────────────────────────────────────

  async claimEarnings(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('claimEarnings')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async getSellerEarnings(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('sellerEarnings')(sellerAddr) as Promise<bigint>;
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getBuyerBalance(buyerAddr: string): Promise<BuyerBalanceInfo> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    const result = await contract.getFunction('getBuyerBalance')(buyerAddr);
    return {
      available: result[0] as bigint,
      reserved: result[1] as bigint,
      pendingWithdrawal: result[2] as bigint,
      lastActivityAt: result[3] as bigint,
    };
  }

  async getBuyerCreditLimit(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('getBuyerCreditLimit')(buyerAddr) as Promise<bigint>;
  }

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}
