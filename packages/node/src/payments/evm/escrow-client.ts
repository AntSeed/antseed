import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface BaseEscrowConfig {
  /** Base JSON-RPC endpoint (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /** Confirmation commitment level (not used on EVM, reserved for future) */
  commitment?: 'latest' | 'finalized';
}

export interface SessionInfo {
  buyer: string;
  seller: string;
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  previousConsumption: bigint;
  previousSessionId: string;
  reservedAt: bigint;
  settledAmount: bigint;
  settledTokenCount: bigint;
  tokenRate: bigint;
  status: number;
  isFirstSign: boolean;
  isProvenSign: boolean;
  isQualifiedProvenSign: boolean;
}

export interface BuyerBalanceInfo {
  available: bigint;
  reserved: bigint;
  pendingWithdrawal: bigint;
  lastActivityAt: bigint;
}

export interface SellerAccountInfo {
  stake: bigint;
  earnings: bigint;
  stakedAt: bigint;
  tokenRate: bigint;
}

const ESCROW_ABI = [
  // Buyer operations
  'function deposit(uint256 amount) external',
  'function depositFor(address buyer, uint256 amount) external',
  'function requestWithdrawal(uint256 amount) external',
  'function executeWithdrawal() external',
  'function cancelWithdrawal() external',

  // Seller operations
  'function stake(uint256 amount) external',
  'function unstake() external',
  'function setTokenRate(uint256 rate) external',
  'function claimEarnings() external',

  // Core — reserve & settle
  'function reserve(address buyer, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, uint256 previousConsumption, bytes32 previousSessionId, bytes calldata buyerSig) external',
  'function settle(bytes32 sessionId, uint256 tokenCount) external',
  'function settleTimeout(bytes32 sessionId) external',

  // View functions
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 pendingWithdrawal, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function getSellerAccount(address seller) external view returns (uint256 stake, uint256 earnings, uint256 stakedAt, uint256 tokenRate)',
  'function domainSeparator() external view returns (bytes32)',
  'function sessions(bytes32 sessionId) external view returns (address buyer, address seller, uint256 maxAmount, uint256 nonce, uint256 deadline, uint256 previousConsumption, bytes32 previousSessionId, uint256 reservedAt, uint256 settledAmount, uint256 settledTokenCount, uint256 tokenRate, uint8 status, bool isFirstSign, bool isProvenSign, bool isQualifiedProvenSign)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export class BaseEscrowClient extends BaseEvmClient {
  private readonly _usdcAddress: string;

  constructor(config: BaseEscrowConfig) {
    super(config.rpcUrl, config.contractAddress);
    this._usdcAddress = config.usdcAddress;
  }

  get usdcAddress(): string { return this._usdcAddress; }

  private async _prepareEscrowWrite(signer: AbstractSigner): Promise<{
    contract: Contract;
    nonce: number;
  }> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const nonce = await this._reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
    return { contract, nonce };
  }

  // ─── Buyer Operations ──────────────────────────────────────────────

  async deposit(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
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
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
    const depositNonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('depositFor')(buyer, amount, { nonce: depositNonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async requestWithdrawal(signer: AbstractSigner, amount: bigint): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('requestWithdrawal')(amount, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async executeWithdrawal(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('executeWithdrawal')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async cancelWithdrawal(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('cancelWithdrawal')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ─── Seller Operations ─────────────────────────────────────────────

  async stake(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
    const stakeNonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('stake')(amount, { nonce: stakeNonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async unstake(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('unstake')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async setTokenRate(signer: AbstractSigner, rate: bigint): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('setTokenRate')(rate, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async claimEarnings(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('claimEarnings')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ─── Core — Reserve & Settle ───────────────────────────────────────

  async reserve(
    signer: AbstractSigner,
    buyer: string,
    sessionId: string,
    maxAmount: bigint,
    nonce: bigint,
    deadline: bigint,
    previousConsumption: bigint,
    previousSessionId: string,
    buyerSig: string,
  ): Promise<string> {
    const { contract, nonce: txNonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('reserve')(
      buyer, sessionId, maxAmount, nonce, deadline,
      previousConsumption, previousSessionId, buyerSig,
      { nonce: txNonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async settle(
    signer: AbstractSigner,
    sessionId: string,
    tokenCount: bigint,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('settle')(sessionId, tokenCount, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async settleTimeout(
    signer: AbstractSigner,
    sessionId: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('settleTimeout')(sessionId, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ─── View Functions ────────────────────────────────────────────────

  async getBuyerBalance(buyerAddr: string): Promise<BuyerBalanceInfo> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('getBuyerBalance')(buyerAddr);
    return {
      available: result[0] as bigint,
      reserved: result[1] as bigint,
      pendingWithdrawal: result[2] as bigint,
      lastActivityAt: result[3] as bigint,
    };
  }

  async getBuyerCreditLimit(buyerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    return contract.getFunction('getBuyerCreditLimit')(buyerAddr) as Promise<bigint>;
  }

  async getSellerAccount(sellerAddr: string): Promise<SellerAccountInfo> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('getSellerAccount')(sellerAddr);
    return {
      stake: result[0] as bigint,
      earnings: result[1] as bigint,
      stakedAt: result[2] as bigint,
      tokenRate: result[3] as bigint,
    };
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('sessions')(sessionId);
    return {
      buyer: result[0],
      seller: result[1],
      maxAmount: result[2],
      nonce: result[3],
      deadline: result[4],
      previousConsumption: result[5],
      previousSessionId: result[6],
      reservedAt: result[7],
      settledAmount: result[8],
      settledTokenCount: result[9],
      tokenRate: result[10],
      status: Number(result[11]),
      isFirstSign: result[12],
      isProvenSign: result[13],
      isQualifiedProvenSign: result[14],
    };
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}
