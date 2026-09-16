import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ReferralsClientConfig {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  contractAddress: string;
  evmChainId?: number;
}

export interface ReferralBindingPayload {
  buyer: string;
  referrer: string;
  nonce: bigint;
  deadline: bigint;
  signature: string;
}

export const REFERRAL_BIND_TYPES = {
  BindReferral: [
    { name: 'buyer', type: 'address' },
    { name: 'referrer', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const REFERRALS_ABI = [
  'function referrerOf(address buyer) external view returns (address)',
  'function nonces(address buyer) external view returns (uint256)',
  'function nextAccrualEpoch(address buyer) external view returns (uint256)',
  'function claimable(address referrer) external view returns (uint256)',
  'function referralRateBps() external view returns (uint32)',
  'function usageAccounting() external view returns (address)',
  'function bindReferral(address buyer, address referrer, uint256 nonce, uint256 deadline, bytes signature) external',
  'function accrue(address buyer, uint256 throughEpoch) external',
  'function claim() external',
  'event ReferralBound(address indexed buyer, address indexed referrer, address indexed submitter, uint256 epoch)',
] as const;

export class ReferralsClient extends BaseEvmClient {
  private readonly evmChainId?: number;

  constructor(config: ReferralsClientConfig) {
    super(config.rpcUrl, config.contractAddress, config.fallbackRpcUrls, config.evmChainId);
    this.evmChainId = config.evmChainId;
  }

  private contract(): Contract {
    return new Contract(this._contractAddress, REFERRALS_ABI, this._provider);
  }

  referrerOf(buyer: string): Promise<string> {
    return this.contract().getFunction('referrerOf')(buyer);
  }

  nonce(buyer: string): Promise<bigint> {
    return this.contract().getFunction('nonces')(buyer);
  }

  nextAccrualEpoch(buyer: string): Promise<bigint> {
    return this.contract().getFunction('nextAccrualEpoch')(buyer);
  }

  claimable(referrer: string): Promise<bigint> {
    return this.contract().getFunction('claimable')(referrer);
  }

  async referralRateBps(): Promise<number> {
    return Number(await this.contract().getFunction('referralRateBps')());
  }

  async currentEpoch(): Promise<number> {
    const accounting = await this.contract().getFunction('usageAccounting')() as string;
    const contract = new Contract(accounting, ['function currentEpoch() external view returns (uint256)'], this._provider);
    return Number(await contract.getFunction('currentEpoch')());
  }

  async boundBuyers(fromBlock: number | bigint = 0): Promise<string[]> {
    const logs = await this.contract().queryFilter('ReferralBound', fromBlock);
    const buyers = new Set<string>();
    for (const log of logs) {
      if ('args' in log && typeof log.args?.[0] === 'string') buyers.add(log.args[0]);
    }
    return [...buyers];
  }

  accrue(signer: AbstractSigner, buyer: string, throughEpoch: number): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'accrue', buyer, throughEpoch);
  }

  claim(signer: AbstractSigner): Promise<string> {
    return this._execWrite(signer, REFERRALS_ABI, 'claim');
  }

  bind(signer: AbstractSigner, payload: ReferralBindingPayload): Promise<string> {
    return this._execWrite(
      signer,
      REFERRALS_ABI,
      'bindReferral',
      payload.buyer,
      payload.referrer,
      payload.nonce,
      payload.deadline,
      payload.signature,
    );
  }

  async signBinding(
    buyerSigner: AbstractSigner,
    input: Omit<ReferralBindingPayload, 'buyer' | 'signature'>,
  ): Promise<ReferralBindingPayload> {
    const buyer = await buyerSigner.getAddress();
    const signature = await buyerSigner.signTypedData(
      {
        name: 'AntseedReferrals',
        version: '1',
        chainId: this.evmChainId,
        verifyingContract: this._contractAddress,
      },
      REFERRAL_BIND_TYPES,
      { buyer, referrer: input.referrer, nonce: input.nonce, deadline: input.deadline },
    );
    return { buyer, ...input, signature };
  }
}
