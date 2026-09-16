import { randomUUID } from 'node:crypto';
import { AbstractSigner, getAddress, resolveProperties, type Provider, type TransactionRequest, type TransactionResponse, type TypedDataDomain, type TypedDataField } from 'ethers';

export interface BrowserTransaction {
  id: string;
  from: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  submittedHash?: string;
  approvalStarted?: boolean;
}
interface Pending {
  request: BrowserTransaction;
  provider: Provider;
  nonceFloor: number;
  resolve: (tx: TransactionResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One wallet approval at a time. No private key or local transaction signer is held here. */
export class BrowserSigning {
  private pending: Pending | null = null;
  private generation = 0;
  constructor(private readonly chainId: number) {}
  get request(): BrowserTransaction | null { return this.pending?.request ?? null; }
  signer(address: string, provider: Provider): AbstractSigner {
    return new BrowserSigner(getAddress(address), provider, this, this.generation);
  }
  cancel(reason = 'Wallet or network changed. Review completed transactions before starting again.'): void {
    this.generation++;
    const pending = this.pending;
    // A broadcast transaction must still be reconciled. The old signer cannot start another step.
    if (pending && !pending.request.submittedHash && !pending.request.approvalStarted) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(new Error(reason));
    }
  }
  async send(address: string, provider: Provider, generation: number, tx: TransactionRequest): Promise<TransactionResponse> {
    if (generation !== this.generation) throw new Error('The signing wallet changed. Reopen the action.');
    if (this.pending) throw new Error('Another wallet approval is pending.');
    const resolved = await resolveProperties(tx);
    if (!resolved.to || typeof resolved.to !== 'string') throw new Error('Contract creation is not supported.');
    if (resolved.from && getAddress(String(resolved.from)) !== address) throw new Error('Transaction sender does not match the connected wallet.');
    if (resolved.chainId != null && BigInt(resolved.chainId) !== BigInt(this.chainId)) throw new Error('Transaction network mismatch.');
    if ((await provider.getNetwork()).chainId !== BigInt(this.chainId)) throw new Error('RPC network mismatch.');
    const request: BrowserTransaction = { id: randomUUID(), from: address, to: getAddress(resolved.to), data: resolved.data ?? '0x', value: BigInt(resolved.value ?? 0).toString(), chainId: this.chainId };
    const nonceFloor = await provider.getTransactionCount(address, 'latest');
    // Simulate using the actual external sender before asking for approval.
    await provider.call({ from: address, to: request.to, data: request.data, value: BigInt(request.value) });
    if (generation !== this.generation) throw new Error('The signing wallet changed.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.request.id === request.id && !this.pending.request.submittedHash) {
          this.pending = null;
          reject(new Error('Wallet approval expired. No transaction was automatically retried.'));
        }
      }, 10 * 60_000);
      timer.unref();
      this.pending = { request, provider, nonceFloor, resolve, reject, timer };
    });
  }
  begin(id: string): void {
    const request = this.pending?.request;
    if (!request || request.id !== id) throw new Error('This wallet request is no longer active.');
    if (request.approvalStarted || request.submittedHash) throw new Error('This request is already being approved. Check the original wallet window.');
    request.approvalStarted = true;
  }
  async complete(id: string, hash?: string, error?: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) throw new Error('This wallet request is no longer active.');
    if (pending.request.submittedHash) {
      if (pending.request.submittedHash === hash) return;
      throw new Error('A transaction has already been submitted for this request.');
    }
    if (error) {
      clearTimeout(pending.timer); this.pending = null;
      pending.reject(new Error('Wallet request rejected or failed. Check your wallet before retrying.'));
      return;
    }
    if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    pending.request.submittedHash = hash;
    clearTimeout(pending.timer);
    // Keep HTTP acknowledgment short; the job continues only after chain verification.
    void (async () => {
      try {
        const receipt = await pending.provider.waitForTransaction(hash, 1, 180_000);
        const tx = await pending.provider.getTransaction(hash);
        const expected = pending.request;
        if (!tx || tx.nonce < pending.nonceFloor || tx.chainId !== BigInt(expected.chainId) || getAddress(tx.from) !== expected.from || !tx.to || getAddress(tx.to) !== expected.to || tx.data.toLowerCase() !== expected.data.toLowerCase() || tx.value !== BigInt(expected.value)) {
          throw new Error('Submitted transaction does not match the reviewed wallet request.');
        }
        if (!receipt || receipt.status !== 1) throw new Error('Transaction failed or confirmation timed out. Check the transaction before retrying.');
        pending.resolve(tx);
      } catch (err) { pending.reject(err instanceof Error ? err : new Error(String(err))); }
      finally { if (this.pending === pending) this.pending = null; }
    })();
  }
}

class BrowserSigner extends AbstractSigner {
  constructor(private readonly address: string, provider: Provider, private readonly bridge: BrowserSigning, private readonly generation: number) { super(provider); }
  getAddress(): Promise<string> { return Promise.resolve(this.address); }
  connect(provider: Provider | null): AbstractSigner {
    if (!provider) throw new Error('Browser signing requires a provider.');
    return new BrowserSigner(this.address, provider, this.bridge, this.generation);
  }
  signTransaction(_tx: TransactionRequest): Promise<string> { return Promise.reject(new Error('Use wallet transaction approval.')); }
  signMessage(_message: string | Uint8Array): Promise<string> { return Promise.reject(new Error('Arbitrary message signing is not supported.')); }
  signTypedData(_domain: TypedDataDomain, _types: Record<string, TypedDataField[]>, _value: Record<string, unknown>): Promise<string> { return Promise.reject(new Error('Use the existing wallet authorization flow.')); }
  override sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> { return this.bridge.send(this.address, this.provider!, this.generation, tx); }
}
