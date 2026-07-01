import {
  Contract,
  Interface,
  JsonRpcProvider,
  MaxUint256,
  Network,
  Wallet,
  id as selectorId,
  isCallException,
  type EventLog,
  type Log,
  type TransactionReceipt,
} from 'ethers';

export interface HeadroomInfo {
  /** Total accounted balance (available + reserved) — the value the contract checks against the credit limit. */
  balanceTotal: bigint;
  creditLimit: bigint;
  /** How much more can be deposited before `CreditLimitExceeded`. */
  headroom: bigint;
  /** On-chain minimum for a buyer's first deposit. */
  minBuyerDeposit: bigint;
}

export type TxStatus = 'success' | 'reverted' | 'pending' | 'unknown';

export interface DepositCheck {
  ok: boolean;
  reason?: string;
}

/**
 * All on-chain interaction behind one interface so the top-up state machine
 * can be tested against a fake.
 */
export interface ChainGateway {
  relayerAddress: string;
  getBlockNumber(): Promise<number>;
  getHeadroom(buyer: string): Promise<HeadroomInfo>;
  /** EIP-3009 `authorizationState` on the payment token. */
  isAuthorizationUsed(from: string, nonce: string): Promise<boolean>;
  /** Sum of payment-token transfers credited to the relayer in the settlement tx. */
  getSettlementCredit(txHash: string): Promise<{ netAmount: bigint; blockNumber: number } | null>;
  /** Static-call `deposit(buyer, amount)` to catch CreditLimitExceeded/BelowMinDeposit before spending gas. */
  checkDeposit(buyer: string, amount: bigint): Promise<DepositCheck>;
  deposit(buyer: string, amount: bigint, onBroadcast: (txHash: string) => void): Promise<{ txHash: string; ok: boolean }>;
  /** Return settled funds to the payer in the payment token. */
  refund(to: string, amount: bigint, onBroadcast: (txHash: string) => void): Promise<string>;
  getTxStatus(txHash: string): Promise<TxStatus>;
  /** Recovery: find a relayer-sent Deposited(buyer, amount) event at/after fromBlock. */
  findDepositedTx(buyer: string, amount: bigint, fromBlock: number): Promise<string | null>;
  /** Recovery: find a relayer→to payment-token transfer of `amount` at/after fromBlock. */
  findRefundTx(to: string, amount: bigint, fromBlock: number): Promise<string | null>;
  /** One-time max approval so each relayed deposit is a single transaction. */
  ensureAllowance(): Promise<void>;
}

const DEPOSITS_ABI = [
  'function deposit(address buyer, uint256 amount) external',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function MIN_BUYER_DEPOSIT() external view returns (uint256)',
  'event Deposited(address indexed buyer, uint256 amount)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

/** AntseedDeposits custom errors surfaced by the pre-deposit static call. */
const DEPOSIT_ERROR_SELECTORS: Record<string, string> = {
  [selectorId('InvalidAmount()').slice(0, 10)]: 'InvalidAmount',
  [selectorId('BelowMinDeposit()').slice(0, 10)]: 'BelowMinDeposit',
  [selectorId('CreditLimitExceeded()').slice(0, 10)]: 'CreditLimitExceeded',
  [selectorId('InvalidAddress()').slice(0, 10)]: 'InvalidAddress',
};

function decodeRevert(err: unknown): string {
  if (isCallException(err)) {
    const data = typeof err.data === 'string' ? err.data : undefined;
    if (data && data.length >= 10) {
      const named = DEPOSIT_ERROR_SELECTORS[data.slice(0, 10)];
      if (named) return named;
    }
    if (err.reason) return err.reason;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface EvmChainGatewayConfig {
  rpcUrl: string;
  evmChainId?: number;
  depositsAddress: string;
  /** Token AntseedDeposits custodies (chain config USDC). */
  depositTokenAddress: string;
  /** Token the Meridian facilitator settles in. Same as depositToken on base-mainnet. */
  paymentAssetAddress: string;
  relayerPrivateKey: string;
  receiptAttempts?: number;
  receiptDelayMs?: number;
}

export class EvmChainGateway implements ChainGateway {
  readonly relayerAddress: string;
  private readonly _provider: JsonRpcProvider;
  private readonly _wallet: Wallet;
  private readonly _deposits: Contract;
  private readonly _depositToken: Contract;
  private readonly _paymentAsset: Contract;
  private readonly _paymentAssetAddress: string;
  private readonly _erc20Interface = new Interface(ERC20_ABI);
  private readonly _receiptAttempts: number;
  private readonly _receiptDelayMs: number;
  /** Serializes relayer-signed transactions to avoid nonce races. */
  private _writeQueue: Promise<unknown> = Promise.resolve();

  constructor(config: EvmChainGatewayConfig) {
    const network = config.evmChainId ? Network.from(config.evmChainId) : undefined;
    this._provider = new JsonRpcProvider(config.rpcUrl, network, {
      staticNetwork: network ? true : undefined,
      batchMaxCount: 1,
    });
    this._wallet = new Wallet(config.relayerPrivateKey, this._provider);
    this.relayerAddress = this._wallet.address;
    this._deposits = new Contract(config.depositsAddress, DEPOSITS_ABI, this._wallet);
    this._depositToken = new Contract(config.depositTokenAddress, ERC20_ABI, this._wallet);
    this._paymentAsset = new Contract(config.paymentAssetAddress, ERC20_ABI, this._wallet);
    this._paymentAssetAddress = config.paymentAssetAddress.toLowerCase();
    this._receiptAttempts = config.receiptAttempts ?? 10;
    this._receiptDelayMs = config.receiptDelayMs ?? 1_500;
  }

  private _enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._writeQueue.then(fn, fn);
    this._writeQueue = run.catch(() => undefined);
    return run;
  }

  async getBlockNumber(): Promise<number> {
    return this._provider.getBlockNumber();
  }

  async getHeadroom(buyer: string): Promise<HeadroomInfo> {
    const [balance, creditLimit, minBuyerDeposit] = await Promise.all([
      this._deposits.getFunction('getBuyerBalance')(buyer) as Promise<[bigint, bigint, bigint]>,
      this._deposits.getFunction('getBuyerCreditLimit')(buyer) as Promise<bigint>,
      this._deposits.getFunction('MIN_BUYER_DEPOSIT')() as Promise<bigint>,
    ]);
    const balanceTotal = balance[0] + balance[1];
    return {
      balanceTotal,
      creditLimit,
      headroom: creditLimit > balanceTotal ? creditLimit - balanceTotal : 0n,
      minBuyerDeposit,
    };
  }

  async isAuthorizationUsed(from: string, nonce: string): Promise<boolean> {
    try {
      return (await this._paymentAsset.getFunction('authorizationState')(from, nonce)) as boolean;
    } catch {
      // Tokens without EIP-3009 (e.g. local MockUSDC) — treat as unused.
      return false;
    }
  }

  async getSettlementCredit(txHash: string): Promise<{ netAmount: bigint; blockNumber: number } | null> {
    const receipt = await this._waitForReceipt(txHash);
    if (!receipt) return null;
    let netAmount = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this._paymentAssetAddress) continue;
      let parsed;
      try {
        parsed = this._erc20Interface.parseLog({ topics: [...log.topics], data: log.data });
      } catch {
        continue;
      }
      if (parsed?.name !== 'Transfer') continue;
      if ((parsed.args[1] as string).toLowerCase() === this.relayerAddress.toLowerCase()) {
        netAmount += parsed.args[2] as bigint;
      }
    }
    return { netAmount, blockNumber: receipt.blockNumber };
  }

  private async _waitForReceipt(txHash: string): Promise<TransactionReceipt | null> {
    for (let i = 0; i < this._receiptAttempts; i++) {
      const receipt = await this._provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      if (i < this._receiptAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this._receiptDelayMs));
      }
    }
    return null;
  }

  async checkDeposit(buyer: string, amount: bigint): Promise<DepositCheck> {
    try {
      await this._deposits.getFunction('deposit').staticCall(buyer, amount);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: decodeRevert(err) };
    }
  }

  async deposit(buyer: string, amount: bigint, onBroadcast: (txHash: string) => void): Promise<{ txHash: string; ok: boolean }> {
    return this._enqueue(async () => {
      const tx = await this._deposits.getFunction('deposit')(buyer, amount);
      onBroadcast(tx.hash);
      try {
        const receipt = await tx.wait();
        return { txHash: receipt?.hash ?? tx.hash, ok: receipt?.status === 1 };
      } catch (err) {
        if (isCallException(err) && err.receipt) {
          return { txHash: tx.hash, ok: false };
        }
        throw err;
      }
    });
  }

  async refund(to: string, amount: bigint, onBroadcast: (txHash: string) => void): Promise<string> {
    return this._enqueue(async () => {
      const tx = await this._paymentAsset.getFunction('transfer')(to, amount);
      onBroadcast(tx.hash);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`refund transfer reverted (tx ${tx.hash})`);
      }
      return receipt.hash as string;
    });
  }

  async getTxStatus(txHash: string): Promise<TxStatus> {
    const receipt = await this._provider.getTransactionReceipt(txHash);
    if (receipt) return receipt.status === 1 ? 'success' : 'reverted';
    const tx = await this._provider.getTransaction(txHash);
    return tx ? 'pending' : 'unknown';
  }

  async findDepositedTx(buyer: string, amount: bigint, fromBlock: number): Promise<string | null> {
    const filter = this._deposits.filters.Deposited(buyer);
    const logs = (await this._deposits.queryFilter(filter, fromBlock)) as Array<EventLog | Log>;
    for (const log of logs) {
      const eventLog = log as EventLog;
      if (!eventLog.args || (eventLog.args[1] as bigint) !== amount) continue;
      const tx = await this._provider.getTransaction(log.transactionHash);
      if (tx?.from.toLowerCase() === this.relayerAddress.toLowerCase()) {
        return log.transactionHash;
      }
    }
    return null;
  }

  async findRefundTx(to: string, amount: bigint, fromBlock: number): Promise<string | null> {
    const filter = this._paymentAsset.filters.Transfer(this.relayerAddress, to);
    const logs = (await this._paymentAsset.queryFilter(filter, fromBlock)) as Array<EventLog | Log>;
    for (const log of logs) {
      const eventLog = log as EventLog;
      if (eventLog.args && (eventLog.args[2] as bigint) === amount) {
        return log.transactionHash;
      }
    }
    return null;
  }

  async ensureAllowance(): Promise<void> {
    await this._enqueue(async () => {
      const allowance = (await this._depositToken.getFunction('allowance')(
        this.relayerAddress,
        this._deposits.target,
      )) as bigint;
      if (allowance >= MaxUint256 / 2n) return;
      const tx = await this._depositToken.getFunction('approve')(this._deposits.target, MaxUint256);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error('USDC approval for AntseedDeposits failed');
      }
    });
  }
}
