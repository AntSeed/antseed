// Shared fixtures for the vitest suite. Excluded from the build output.
import { Wallet, hexlify, randomBytes } from 'ethers';
import type { ChainGateway, DepositCheck, HeadroomInfo, TxStatus } from './chain.js';
import type { MeridianClient, MeridianSettleResult } from './meridian.js';
import type { X402PaymentPayload } from './x402.js';

export const TEST_X402 = {
  network: 'base',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  assetName: 'USD Coin',
  assetVersion: '2',
  facilitator: '0x8E7769D440b3460b92159Dd9C6D17302b036e2d6',
  resourceUrl: 'http://topup.local/v1/topup',
  evmChainId: 8453,
};

export const RELAYER = '0x1111111111111111111111111111111111111111';

export function randomWallet(): Wallet {
  return new Wallet(hexlify(randomBytes(32)));
}

export async function signedPayment(
  wallet: Wallet,
  opts: {
    value: bigint;
    to?: string;
    validAfter?: bigint;
    validBefore?: bigint;
    nonce?: string;
    network?: string;
    signature?: string;
  },
): Promise<X402PaymentPayload> {
  const authorization = {
    from: wallet.address,
    to: opts.to ?? TEST_X402.facilitator,
    value: opts.value,
    validAfter: opts.validAfter ?? 0n,
    validBefore: opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3_600),
    nonce: opts.nonce ?? hexlify(randomBytes(32)),
  };
  const signature =
    opts.signature ??
    (await wallet.signTypedData(
      {
        name: TEST_X402.assetName,
        version: TEST_X402.assetVersion,
        chainId: TEST_X402.evmChainId,
        verifyingContract: TEST_X402.asset,
      },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      authorization,
    ));
  return {
    x402Version: 1,
    scheme: 'exact',
    network: opts.network ?? TEST_X402.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
}

export class FakeChain implements ChainGateway {
  relayerAddress = RELAYER;
  headroom: HeadroomInfo = {
    balanceTotal: 0n,
    creditLimit: 10_000_000n,
    headroom: 10_000_000n,
    minBuyerDeposit: 1_000_000n,
  };
  blockNumber = 50;
  usedAuthorizations = new Set<string>();
  settlementCredits = new Map<string, { netAmount: bigint; blockNumber: number }>();
  checkDepositResult: DepositCheck = { ok: true };
  depositBehavior: 'ok' | 'revert' | 'throw' = 'ok';
  refundBehavior: 'ok' | 'throw' = 'ok';
  txStatuses = new Map<string, TxStatus>();
  depositedTxLookup: string | null = null;
  refundTxLookup: string | null = null;
  depositCalls: Array<{ buyer: string; amount: bigint }> = [];
  refundCalls: Array<{ to: string; amount: bigint }> = [];
  private _txCounter = 0;

  async getBlockNumber(): Promise<number> {
    return this.blockNumber;
  }
  async getHeadroom(): Promise<HeadroomInfo> {
    return this.headroom;
  }
  async isAuthorizationUsed(from: string, nonce: string): Promise<boolean> {
    return this.usedAuthorizations.has(`${from.toLowerCase()}:${nonce}`);
  }
  markAuthorizationUsed(from: string, nonce: string): void {
    this.usedAuthorizations.add(`${from.toLowerCase()}:${nonce}`);
  }
  async getSettlementCredit(txHash: string): Promise<{ netAmount: bigint; blockNumber: number } | null> {
    return this.settlementCredits.get(txHash) ?? null;
  }
  async checkDeposit(): Promise<DepositCheck> {
    return this.checkDepositResult;
  }
  async deposit(
    buyer: string,
    amount: bigint,
    onBroadcast: (txHash: string) => void,
  ): Promise<{ txHash: string; ok: boolean }> {
    if (this.depositBehavior === 'throw') throw new Error('rpc unreachable');
    this.depositCalls.push({ buyer, amount });
    const txHash = `0xdeposit${++this._txCounter}`;
    onBroadcast(txHash);
    return { txHash, ok: this.depositBehavior === 'ok' };
  }
  async refund(to: string, amount: bigint, onBroadcast: (txHash: string) => void): Promise<string> {
    if (this.refundBehavior === 'throw') throw new Error('rpc unreachable');
    this.refundCalls.push({ to, amount });
    const txHash = `0xrefund${++this._txCounter}`;
    onBroadcast(txHash);
    return txHash;
  }
  async getTxStatus(txHash: string): Promise<TxStatus> {
    return this.txStatuses.get(txHash) ?? 'unknown';
  }
  async findDepositedTx(): Promise<string | null> {
    return this.depositedTxLookup;
  }
  async findRefundTx(): Promise<string | null> {
    return this.refundTxLookup;
  }
  async ensureAllowance(): Promise<void> {}
}

export class FakeMeridian implements MeridianClient {
  results: Array<MeridianSettleResult | Error> = [];
  calls = 0;

  async settle(): Promise<MeridianSettleResult> {
    this.calls += 1;
    const next = this.results.shift();
    if (!next) throw new Error('FakeMeridian: no result queued');
    if (next instanceof Error) throw next;
    return next;
  }
}
