import { Contract, JsonRpcProvider, type AbstractSigner, type InterfaceAbi } from 'ethers';

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
] as const;

export abstract class BaseEvmClient {
  protected readonly _provider: JsonRpcProvider;
  protected readonly _contractAddress: string;
  protected readonly _nonceCursor = new Map<string, number>();
  private readonly _nonceLocks = new Map<string, Promise<void>>();

  constructor(rpcUrl: string, contractAddress: string) {
    this._provider = new JsonRpcProvider(rpcUrl);
    this._contractAddress = contractAddress;
  }

  get provider(): JsonRpcProvider { return this._provider; }
  get contractAddress(): string { return this._contractAddress; }

  protected _ensureConnected(signer: AbstractSigner): AbstractSigner {
    if (signer.provider) return signer;
    return signer.connect(this._provider);
  }

  /**
   * Execute a write transaction: connect signer, reserve nonce, send, wait for receipt.
   */
  protected async _execWrite(
    signer: AbstractSigner,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const nonce = await this._reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, abi, connected);
    let tx;
    try {
      tx = await contract.getFunction(method)(...args, { nonce });
    } catch (err) {
      // Tx was never sent (e.g. estimateGas reverted) — roll back the nonce cursor
      // so subsequent txs don't skip a nonce and hang forever.
      this._nonceCursor.delete(signerAddress);
      throw err;
    }
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  /**
   * Approve USDC spending then execute a contract method.
   */
  protected async _approveAndExec(
    signer: AbstractSigner,
    usdcAddress: string,
    amount: bigint,
    abi: InterfaceAbi,
    method: string,
    ...args: unknown[]
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(usdcAddress, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Approve transaction was dropped or replaced');
    return this._execWrite(signer, abi, method, ...args);
  }

  protected async _reserveNonce(address: string): Promise<number> {
    // Serialize nonce reservation per address to prevent concurrent calls
    // from reading the same network nonce before either updates the cursor
    const prev = this._nonceLocks.get(address) ?? Promise.resolve();
    let resolve: () => void;
    const lock = new Promise<void>(r => { resolve = r; });
    this._nonceLocks.set(address, lock);

    await prev;
    try {
      const networkNonce = await this._provider.getTransactionCount(address, 'pending');
      const cachedNext = this._nonceCursor.get(address);
      const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
      this._nonceCursor.set(address, nonce + 1);
      return nonce;
    } finally {
      resolve!();
    }
  }
}
