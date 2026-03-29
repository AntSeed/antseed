import { type AbstractSigner, Contract } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface SessionsClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export interface SessionInfo {
  buyer: string;
  seller: string;
  deposit: bigint;
  settled: bigint;
  metadataHash: string;
  deadline: bigint;
  settledAt: bigint;
  closeRequestedAt: bigint;
  status: number;
}

const SESSIONS_ABI = [
  'function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes buyerSig) external',
  'function settle(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes buyerSig) external',
  'function close(bytes32 channelId, uint128 finalAmount, bytes metadata, bytes buyerSig) external',
  'function requestClose(bytes32 channelId) external',
  'function withdraw(bytes32 channelId) external',
  'function sessions(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'function computeChannelId(address buyer, address seller, bytes32 salt) external pure returns (bytes32)',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
] as const;

export class SessionsClient extends BaseEvmClient {
  constructor(config: SessionsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  async reserve(
    signer: AbstractSigner,
    buyer: string,
    salt: string,
    maxAmount: bigint,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'reserve',
      buyer, salt, maxAmount, deadline, buyerSig,
    );
  }

  async settle(
    signer: AbstractSigner,
    channelId: string,
    cumulativeAmount: bigint,
    metadata: string,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'settle',
      channelId, cumulativeAmount, metadata, buyerSig,
    );
  }

  async close(
    signer: AbstractSigner,
    channelId: string,
    finalAmount: bigint,
    metadata: string,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'close',
      channelId, finalAmount, metadata, buyerSig,
    );
  }

  async requestClose(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, SESSIONS_ABI, 'requestClose', channelId);
  }

  async withdraw(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, SESSIONS_ABI, 'withdraw', channelId);
  }

  async getSession(channelId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    const result = await contract.getFunction('sessions')(channelId);
    return {
      buyer: result[0],
      seller: result[1],
      deposit: result[2],
      settled: result[3],
      metadataHash: result[4],
      deadline: result[5],
      settledAt: result[6],
      closeRequestedAt: result[7],
      status: Number(result[8]),
    };
  }

  async domainSeparator(): Promise<string> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('domainSeparator')() as Promise<string>;
  }

  async getFirstSignCap(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('FIRST_SIGN_CAP')() as Promise<bigint>;
  }

  async computeChannelId(buyer: string, seller: string, salt: string): Promise<string> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('computeChannelId')(buyer, seller, salt) as Promise<string>;
  }
}
