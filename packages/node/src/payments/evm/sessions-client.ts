import { Contract } from 'ethers';
import type { AbstractSigner } from 'ethers';
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
  settledInputTokens: bigint;
  settledOutputTokens: bigint;
  settledMetadataHash: string;
  deadline: bigint;
  settledAt: bigint;
  status: number;
}

const SESSIONS_ABI = [
  'function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes buyerMetaSig) external',
  'function topUp(bytes32 channelId, uint128 additionalAmount) external',
  'function settle(bytes32 channelId, uint128 cumulativeAmount, bytes metadata, bytes tempoVoucherSig, bytes metadataAuthSig) external',
  'function close(bytes32 channelId, uint128 finalAmount, bytes metadata, bytes tempoVoucherSig, bytes metadataAuthSig) external',
  'function requestClose(bytes32 channelId) external',
  'function withdraw(bytes32 channelId) external',
  'function sessions(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, uint128 settledInputTokens, uint128 settledOutputTokens, bytes32 settledMetadataHash, uint256 deadline, uint256 settledAt, uint8 status)',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'function streamChannel() external view returns (address)',
] as const;

export class SessionsClient extends BaseEvmClient {
  constructor(config: SessionsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  // ─── Core — Reserve ──────────────────────────────────────────────────

  async reserve(
    signer: AbstractSigner,
    buyer: string,
    salt: string,
    maxAmount: bigint,
    deadline: bigint,
    buyerMetaSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'reserve',
      buyer, salt, maxAmount, deadline, buyerMetaSig,
    );
  }

  // ─── Core — Top Up ───────────────────────────────────────────────────

  async topUp(
    signer: AbstractSigner,
    channelId: string,
    additionalAmount: bigint,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'topUp',
      channelId, additionalAmount,
    );
  }

  // ─── Core — Settle (mid-session checkpoint) ──────────────────────────

  async settle(
    signer: AbstractSigner,
    channelId: string,
    cumulativeAmount: bigint,
    metadata: string,
    tempoVoucherSig: string,
    metadataAuthSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'settle',
      channelId, cumulativeAmount, metadata, tempoVoucherSig, metadataAuthSig,
    );
  }

  // ─── Core — Close (final settle) ────────────────────────────────────

  async close(
    signer: AbstractSigner,
    channelId: string,
    finalAmount: bigint,
    metadata: string,
    tempoVoucherSig: string,
    metadataAuthSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'close',
      channelId, finalAmount, metadata, tempoVoucherSig, metadataAuthSig,
    );
  }

  // ─── Timeout — Request Close + Withdraw ──────────────────────────────

  async requestClose(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, SESSIONS_ABI, 'requestClose', channelId);
  }

  async withdraw(signer: AbstractSigner, channelId: string): Promise<string> {
    return this._execWrite(signer, SESSIONS_ABI, 'withdraw', channelId);
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getSession(channelId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    const result = await contract.getFunction('sessions')(channelId);
    return {
      buyer: result[0],
      seller: result[1],
      deposit: result[2],
      settled: result[3],
      settledInputTokens: result[4],
      settledOutputTokens: result[5],
      settledMetadataHash: result[6],
      deadline: result[7],
      settledAt: result[8],
      status: Number(result[9]),
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

  async getStreamChannelAddress(): Promise<string> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('streamChannel')() as Promise<string>;
  }
}
