import { Contract, JsonRpcProvider, type AbstractSigner, type ContractTransactionResponse } from 'ethers';

export interface EscrowConfig {
  /** Base JSON-RPC endpoint (e.g. https://mainnet.base.org) */
  rpcUrl: string;
  /** Deployed AntseedEscrow contract address */
  contractAddress: string;
  /** USDC token contract address */
  usdcAddress: string;
  /** Chain ID (8453 = Base mainnet, 84532 = Base Sepolia) */
  chainId: number;
}

export interface BuyerBalance {
  available: bigint;
  pendingWithdrawal: bigint;
  withdrawalReadyAt: number;  // unix seconds; 0 if no pending withdrawal
}

export interface SessionAuthInfo {
  nonce:    number;
  authMax:  bigint;
  authUsed: bigint;
  deadline: number;
}

export interface ReputationData {
  avgRating:          number;
  ratingCount:        number;
  stakedAmount:       bigint;
  totalTransactions:  number;
  totalVolume:        bigint;
  uniqueBuyersServed: number;
  ageDays:            number;
  totalSlashed:       bigint;
  slashCount:         number;
  antsEarned:         bigint;
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

const ESCROW_ABI = [
  // Buyer
  'function deposit(uint256 amount) external',
  'function requestWithdrawal(uint256 amount) external',
  'function executeWithdrawal() external',
  'function cancelWithdrawal() external',

  // Seller
  'function charge(address buyer, uint256 amount, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes calldata sig) external',
  'function claimEarnings() external',
  'function stake(uint256 amount) external',
  'function unstake(uint256 amount) external',

  // Platform
  'function sweepFees() external',

  // Reputation
  'function rateSeller(address seller, uint8 score) external',
  'function canRate(address buyer, address seller) external view returns (bool)',
  'function getReputation(address seller) external view returns (tuple(uint256 avgRating, uint256 ratingCount, uint256 stakedAmount, uint256 totalTransactions, uint256 totalVolume, uint256 uniqueBuyersServed, uint256 ageDays, uint256 totalSlashed, uint256 slashCount, uint256 antsEarned))',

  // Slashing
  'function slashSeller(address seller, address buyer, bytes32 sessionId, string reason) external',

  // Views
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 pendingWithdrawal, uint256 withdrawalReadyAt)',
  'function getSessionAuth(address buyer, address seller, bytes32 sessionId) external view returns (uint256 nonce, uint256 authMax, uint256 authUsed, uint256 deadline)',

  // State reads
  'function buyers(address) external view returns (uint256 balance, uint256 withdrawalAmount, uint256 withdrawalRequestedAt, uint256 firstTransactionAt, uint256 uniqueSellersCount)',
  'function sellers(address) external view returns (uint256 pendingEarnings, uint256 stakedAmount, uint256 stakedSince, uint256 firstTransactionAt, uint256 totalTransactions, uint256 totalVolume, uint256 uniqueBuyersCount, uint256 totalSlashed, uint256 slashCount, uint256 antsEarned)',
  'function hasInteracted(address buyer, address seller) external view returns (bool)',
  'function accumulatedFees() external view returns (uint256)',
  'function platformFeeBps() external view returns (uint16)',
  'function paused() external view returns (bool)',
  'function DOMAIN_SEPARATOR() external view returns (bytes32)',
] as const;

export class EscrowClient {
  private readonly _provider: JsonRpcProvider;
  private readonly _contractAddress: string;
  private readonly _usdcAddress: string;
  private readonly _chainId: number;
  /** Local nonce cache to avoid pending-tx collisions */
  private readonly _nonceCursor = new Map<string, number>();

  constructor(config: EscrowConfig) {
    this._provider        = new JsonRpcProvider(config.rpcUrl);
    this._contractAddress = config.contractAddress;
    this._usdcAddress     = config.usdcAddress;
    this._chainId         = config.chainId;
  }

  get provider():        JsonRpcProvider { return this._provider; }
  get contractAddress(): string          { return this._contractAddress; }
  get usdcAddress():     string          { return this._usdcAddress; }
  get chainId():         number          { return this._chainId; }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private _connected(signer: AbstractSigner): AbstractSigner {
    return signer.provider ? signer : signer.connect(this._provider);
  }

  private async _reserveNonce(address: string): Promise<number> {
    const network = await this._provider.getTransactionCount(address, 'pending');
    const cached  = this._nonceCursor.get(address);
    const nonce   = cached === undefined ? network : Math.max(network, cached);
    this._nonceCursor.set(address, nonce + 1);
    return nonce;
  }

  private async _prepareWrite(signer: AbstractSigner): Promise<{ contract: Contract; nonce: number }> {
    const s = this._connected(signer);
    const addr = await s.getAddress();
    const nonce = await this._reserveNonce(addr);
    const contract = new Contract(this._contractAddress, ESCROW_ABI, s);
    return { contract, nonce };
  }

  private _readContract(): Contract {
    return new Contract(this._contractAddress, ESCROW_ABI, this._provider);
  }

  private _usdcContract(signer: AbstractSigner): Contract {
    return new Contract(this._usdcAddress, ERC20_ABI, this._connected(signer));
  }

  private async _approveIfNeeded(signer: AbstractSigner, amount: bigint): Promise<void> {
    const s = this._connected(signer);
    const addr = await s.getAddress();
    const usdc = this._usdcContract(signer);
    const current = await usdc.getFunction('allowance')(addr, this._contractAddress) as bigint;
    if (current >= amount) return;
    const nonce = await this._reserveNonce(addr);
    const tx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce });
    await tx.wait();
  }

  private static async _exec(tx: ContractTransactionResponse): Promise<string> {
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction receipt is null');
    return receipt.hash;
  }

  // ── Buyer operations ──────────────────────────────────────────────────────

  async deposit(signer: AbstractSigner, amount: bigint): Promise<string> {
    await this._approveIfNeeded(signer, amount);
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('deposit')(amount, { nonce }));
  }

  async requestWithdrawal(signer: AbstractSigner, amount: bigint): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('requestWithdrawal')(amount, { nonce }));
  }

  async executeWithdrawal(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('executeWithdrawal')({ nonce }));
  }

  async cancelWithdrawal(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('cancelWithdrawal')({ nonce }));
  }

  // ── Seller operations ─────────────────────────────────────────────────────

  async charge(
    seller:    AbstractSigner,
    buyer:     string,
    amount:    bigint,
    sessionId: string,
    maxAmount: bigint,
    authNonce: number,
    deadline:  number,
    sig:       string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(seller);
    return EscrowClient._exec(
      await contract.getFunction('charge')(buyer, amount, sessionId, maxAmount, authNonce, deadline, sig, { nonce }),
    );
  }

  async claimEarnings(seller: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(seller);
    return EscrowClient._exec(await contract.getFunction('claimEarnings')({ nonce }));
  }

  async stake(signer: AbstractSigner, amount: bigint): Promise<string> {
    await this._approveIfNeeded(signer, amount);
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('stake')(amount, { nonce }));
  }

  async unstake(signer: AbstractSigner, amount: bigint): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('unstake')(amount, { nonce }));
  }

  // ── Platform ──────────────────────────────────────────────────────────────

  async sweepFees(signer: AbstractSigner): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(signer);
    return EscrowClient._exec(await contract.getFunction('sweepFees')({ nonce }));
  }

  // ── Reputation ────────────────────────────────────────────────────────────

  async rateSeller(buyer: AbstractSigner, seller: string, score: number): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(buyer);
    return EscrowClient._exec(await contract.getFunction('rateSeller')(seller, score, { nonce }));
  }

  async canRate(buyerAddr: string, sellerAddr: string): Promise<boolean> {
    return this._readContract().getFunction('canRate')(buyerAddr, sellerAddr) as Promise<boolean>;
  }

  async getReputation(sellerAddr: string): Promise<ReputationData> {
    const r = await this._readContract().getFunction('getReputation')(sellerAddr);
    return {
      avgRating:          Number(r.avgRating),
      ratingCount:        Number(r.ratingCount),
      stakedAmount:       r.stakedAmount as bigint,
      totalTransactions:  Number(r.totalTransactions),
      totalVolume:        r.totalVolume as bigint,
      uniqueBuyersServed: Number(r.uniqueBuyersServed),
      ageDays:            Number(r.ageDays),
      totalSlashed:       r.totalSlashed as bigint,
      slashCount:         Number(r.slashCount),
      antsEarned:         r.antsEarned as bigint,
    };
  }

  async slashSeller(
    ownerSigner: AbstractSigner,
    seller: string,
    buyer: string,
    sessionId: string,
    reason: string,
  ): Promise<string> {
    const { contract, nonce } = await this._prepareWrite(ownerSigner);
    return EscrowClient._exec(
      await contract.getFunction('slashSeller')(seller, buyer, sessionId, reason, { nonce }),
    );
  }

  // ── View helpers ──────────────────────────────────────────────────────────

  async getBuyerBalance(buyerAddr: string): Promise<BuyerBalance> {
    const r = await this._readContract().getFunction('getBuyerBalance')(buyerAddr);
    return {
      available:         r[0] as bigint,
      pendingWithdrawal: r[1] as bigint,
      withdrawalReadyAt: Number(r[2]),
    };
  }

  async getSessionAuth(buyerAddr: string, sellerAddr: string, sessionId: string): Promise<SessionAuthInfo> {
    const r = await this._readContract().getFunction('getSessionAuth')(buyerAddr, sellerAddr, sessionId);
    return {
      nonce:    Number(r[0]),
      authMax:  r[1] as bigint,
      authUsed: r[2] as bigint,
      deadline: Number(r[3]),
    };
  }

  async getAccumulatedFees(): Promise<bigint> {
    return this._readContract().getFunction('accumulatedFees')() as Promise<bigint>;
  }

  async getPlatformFeeBps(): Promise<number> {
    const bps = await this._readContract().getFunction('platformFeeBps')();
    return Number(bps);
  }

  async isPaused(): Promise<boolean> {
    return this._readContract().getFunction('paused')() as Promise<boolean>;
  }

  async getSellerPendingEarnings(sellerAddr: string): Promise<bigint> {
    const r = await this._readContract().getFunction('sellers')(sellerAddr);
    return r[0] as bigint;
  }

  async getUSDCBalance(ownerAddr: string): Promise<bigint> {
    const usdc = new Contract(this._usdcAddress, ERC20_ABI, this._provider);
    return usdc.getFunction('balanceOf')(ownerAddr) as Promise<bigint>;
  }
}

/** @deprecated Use EscrowClient. */
export { EscrowClient as BaseEscrowClient };
export type { EscrowConfig as BaseEscrowConfig };
