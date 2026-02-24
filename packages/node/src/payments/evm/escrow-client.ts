import { Contract, JsonRpcProvider, type AbstractSigner } from 'ethers';

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
  lockedAmount: bigint;
  status: number;
  expiresAt: number;
  settledAmount: bigint;
  score: number;
  disputeClaimedAmount: bigint;
  disputeOpenedAt: number;
  disputeBuyerResponded: boolean;
}

export interface ReputationInfo {
  totalWeightedScore: bigint;
  totalWeight: bigint;
  sessionCount: number;
  disputeCount: number;
  weightedAverage: number;
}

const ESCROW_ABI = [
  // Deposit & Withdraw
  'function deposit(uint256 amount) external',
  'function withdraw(uint256 amount) external',

  // Session lifecycle
  'function commitLock(bytes32 sessionId, address buyer, uint256 amount, bytes calldata buyerSig) external',
  'function extendLock(bytes32 sessionId, uint256 additionalAmount, bytes calldata buyerSig) external',
  'function settle(bytes32 sessionId, uint256 runningTotal, uint8 score, bytes calldata buyerSig) external',

  // Disputes
  'function openDispute(bytes32 sessionId, uint256 claimedAmount) external',
  'function respondDispute(bytes32 sessionId) external',
  'function resolveDispute(bytes32 sessionId) external',

  // Expired lock
  'function releaseExpiredLock(bytes32 sessionId) external',

  // View functions
  'function buyers(address) external view returns (uint256 deposited, uint256 committed)',
  'function sessions(bytes32) external view returns (address buyer, address seller, uint256 lockedAmount, uint8 status, uint64 expiresAt, uint256 settledAmount, uint8 score, uint256 disputeClaimedAmount, uint64 disputeOpenedAt, bool disputeBuyerResponded, bool exists)',
  'function reputations(address) external view returns (uint256 totalWeightedScore, uint256 totalWeight, uint256 sessionCount, uint256 disputeCount)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export class BaseEscrowClient {
  private readonly _provider: JsonRpcProvider;
  private readonly _contractAddress: string;
  private readonly _usdcAddress: string;
  private readonly _nonceCursor = new Map<string, number>();

  constructor(config: BaseEscrowConfig) {
    this._provider = new JsonRpcProvider(config.rpcUrl);
    this._contractAddress = config.contractAddress;
    this._usdcAddress = config.usdcAddress;
  }

  get provider(): JsonRpcProvider { return this._provider; }
  get contractAddress(): string { return this._contractAddress; }
  get usdcAddress(): string { return this._usdcAddress; }

  private _ensureConnected(signer: AbstractSigner): AbstractSigner {
    if (signer.provider) {
      return signer;
    }
    return signer.connect(this._provider);
  }

  private async reserveNonce(address: string): Promise<number> {
    const networkNonce = await this._provider.getTransactionCount(address, 'pending');
    const cachedNext = this._nonceCursor.get(address);
    const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
    this._nonceCursor.set(address, nonce + 1);
    return nonce;
  }

  private async _prepareEscrowWrite(signer: AbstractSigner): Promise<{
    contract: Contract;
    nonce: number;
  }> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const nonce = await this.reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
    return { contract, nonce };
  }

  async deposit(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this.reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    await approveTx.wait();
    const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
    const depositNonce = await this.reserveNonce(signerAddress);
    const tx = await contract.getFunction('deposit')(amount, { nonce: depositNonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async withdraw(signer: AbstractSigner, amount: bigint): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(signer);
    const tx = await contract.getFunction('withdraw')(amount, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async commitLock(
    seller: AbstractSigner,
    buyerAddr: string,
    sessionId: string,
    amount: bigint,
    buyerSig: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(seller);
    const tx = await contract.getFunction('commitLock')(sessionId, buyerAddr, amount, buyerSig, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async extendLock(
    seller: AbstractSigner,
    sessionId: string,
    additionalAmount: bigint,
    buyerSig: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(seller);
    const tx = await contract.getFunction('extendLock')(sessionId, additionalAmount, buyerSig, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async settle(
    seller: AbstractSigner,
    sessionId: string,
    runningTotal: bigint,
    score: number,
    buyerSig: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(seller);
    const tx = await contract.getFunction('settle')(sessionId, runningTotal, score, buyerSig, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async openDispute(
    caller: AbstractSigner,
    sessionId: string,
    claimedAmount: bigint,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(caller);
    const tx = await contract.getFunction('openDispute')(sessionId, claimedAmount, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async respondDispute(
    buyer: AbstractSigner,
    sessionId: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(buyer);
    const tx = await contract.getFunction('respondDispute')(sessionId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async resolveDispute(
    caller: AbstractSigner,
    sessionId: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(caller);
    const tx = await contract.getFunction('resolveDispute')(sessionId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async releaseExpiredLock(
    buyer: AbstractSigner,
    sessionId: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareEscrowWrite(buyer);
    const tx = await contract.getFunction('releaseExpiredLock')(sessionId, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async getBuyerAccount(buyerAddr: string): Promise<{
    deposited: bigint;
    committed: bigint;
    available: bigint;
  }> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('buyers')(buyerAddr);
    const deposited = result[0] as bigint;
    const committed = result[1] as bigint;
    return {
      deposited,
      committed,
      available: deposited - committed,
    };
  }

  async getSession(sessionId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('sessions')(sessionId);
    return {
      buyer: result[0],
      seller: result[1],
      lockedAmount: result[2],
      status: Number(result[3]),
      expiresAt: Number(result[4]),
      settledAmount: result[5],
      score: Number(result[6]),
      disputeClaimedAmount: result[7],
      disputeOpenedAt: Number(result[8]),
      disputeBuyerResponded: result[9],
    };
  }

  async getReputation(sellerAddr: string): Promise<ReputationInfo> {
    const contract = new Contract(this._contractAddress, ESCROW_ABI, this._provider);
    const result = await contract.getFunction('reputations')(sellerAddr);
    const totalWeightedScore = result[0] as bigint;
    const totalWeight = result[1] as bigint;
    const sessionCount = Number(result[2]);
    const disputeCount = Number(result[3]);
    const weightedAverage = totalWeight > 0n
      ? Number(totalWeightedScore / totalWeight)
      : 50;
    return {
      totalWeightedScore,
      totalWeight,
      sessionCount,
      disputeCount,
      weightedAverage,
    };
  }

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}
