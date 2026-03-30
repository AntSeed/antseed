import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient, ERC20_ABI } from './base-evm-client.js';

export interface DepositsClientConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress: string;
}

export interface BuyerBalanceInfo {
  available: bigint;
  reserved: bigint;
  lastActivityAt: bigint;
}

const DEPOSITS_ABI = [
  'function deposit(uint256 amount) external',
  'function depositFor(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function claimPayouts() external',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function sellerPayouts(address seller) external view returns (uint256)',
  'function uniqueSellersCharged(address buyer) external view returns (uint256)',
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
    return this._approveAndExec(signer, this._usdcAddress, amount, DEPOSITS_ABI, 'deposit', amount);
  }

  async depositFor(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._approveAndExec(signer, this._usdcAddress, amount, DEPOSITS_ABI, 'depositFor', buyer, amount);
  }

  async withdraw(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'withdraw', buyer, amount);
  }

  // ─── Seller Payouts ─────────────────────────────────────────────────

  async claimPayouts(signer: AbstractSigner): Promise<string> {
    return this._execWrite(signer, DEPOSITS_ABI, 'claimPayouts');
  }

  async getSellerPayouts(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, DEPOSITS_ABI, this._provider);
    return contract.getFunction('sellerPayouts')(sellerAddr) as Promise<bigint>;
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

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}
