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
  nonce: bigint;
  deadline: bigint;
  settledAt: bigint;
  status: number;
}

const SESSIONS_ABI = [
  'function reserve(address buyer, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes calldata buyerSig) external',
  'function settle(bytes32 sessionId, uint256 cumulativeAmount, uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 nonce, uint256 deadline, bytes calldata buyerSig) external',
  'function settleTimeout(bytes32 sessionId) external',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'function sessions(bytes32 sessionId) external view returns (address buyer, address seller, uint256 deposit, uint256 settled, uint256 settledInputTokens, uint256 settledOutputTokens, uint256 nonce, uint256 deadline, uint256 settledAt, uint8 status)',
] as const;

export class SessionsClient extends BaseEvmClient {
  constructor(config: SessionsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  // ─── Core — Reserve & Settle ────────────────────────────────────────

  async reserve(
    signer: AbstractSigner,
    buyer: string,
    sessionId: string,
    maxAmount: bigint,
    nonce: bigint,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'reserve',
      buyer, sessionId, maxAmount, nonce, deadline, buyerSig,
    );
  }

  async settle(
    signer: AbstractSigner,
    sessionId: string,
    cumulativeAmount: bigint,
    cumulativeInputTokens: bigint,
    cumulativeOutputTokens: bigint,
    nonce: bigint,
    deadline: bigint,
    buyerSig: string,
  ): Promise<string> {
    return this._execWrite(
      signer, SESSIONS_ABI, 'settle',
      sessionId, cumulativeAmount, cumulativeInputTokens,
      cumulativeOutputTokens, nonce, deadline, buyerSig,
    );
  }

  async settleTimeout(signer: AbstractSigner, sessionId: string): Promise<string> {
    return this._execWrite(signer, SESSIONS_ABI, 'settleTimeout', sessionId);
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    const result = await contract.getFunction('sessions')(sessionId);
    return {
      buyer: result[0],
      seller: result[1],
      deposit: result[2],
      settled: result[3],
      settledInputTokens: result[4],
      settledOutputTokens: result[5],
      nonce: result[6],
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

}
