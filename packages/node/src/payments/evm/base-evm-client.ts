import { JsonRpcProvider, type AbstractSigner } from 'ethers';

export abstract class BaseEvmClient {
  protected readonly _provider: JsonRpcProvider;
  protected readonly _contractAddress: string;
  protected readonly _nonceCursor = new Map<string, number>();

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

  protected async _reserveNonce(address: string): Promise<number> {
    const networkNonce = await this._provider.getTransactionCount(address, 'pending');
    const cachedNext = this._nonceCursor.get(address);
    const nonce = cachedNext === undefined ? networkNonce : Math.max(networkNonce, cachedNext);
    this._nonceCursor.set(address, nonce + 1);
    return nonce;
  }
}
