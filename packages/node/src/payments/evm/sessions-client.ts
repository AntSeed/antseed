import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';
import type { BuyerBalanceInfo } from './deposits-client.js';

export interface SessionsClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

export interface SessionInfo {
  buyer: string;
  seller: string;
  maxAmount: bigint;
  nonce: bigint;
  deadline: bigint;
  previousConsumption: bigint;
  previousSessionId: string;
  reservedAt: bigint;
  settledAmount: bigint;
  settledTokenCount: bigint;
  tokenRate: bigint;
  status: number;
  isFirstSign: boolean;
  isProvenSign: boolean;
  isQualifiedProvenSign: boolean;
}

const SESSIONS_ABI = [
  'function reserve(address buyer, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, uint256 previousConsumption, bytes32 previousSessionId, bytes calldata buyerSig) external',
  'function settle(bytes32 sessionId, uint256 tokenCount) external',
  'function settleTimeout(bytes32 sessionId) external',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'function PROVEN_SIGN_COOLDOWN() external view returns (uint256)',
  'function latestSessionId(address buyer, address seller) external view returns (bytes32)',
  'function firstSessionTimestamp(address buyer, address seller) external view returns (uint256)',
  'function sessions(bytes32 sessionId) external view returns (address buyer, address seller, uint256 maxAmount, uint256 nonce, uint256 deadline, uint256 previousConsumption, bytes32 previousSessionId, uint256 reservedAt, uint256 settledAmount, uint256 settledTokenCount, uint256 tokenRate, uint8 status, bool isFirstSign, bool isProvenSign, bool isQualifiedProvenSign)',
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
    previousConsumption: bigint,
    previousSessionId: string,
    buyerSig: string,
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const txNonce = await this._reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, connected);
    const tx = await contract.getFunction('reserve')(
      buyer, sessionId, maxAmount, nonce, deadline,
      previousConsumption, previousSessionId, buyerSig,
      { nonce: txNonce },
    );
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async settle(
    signer: AbstractSigner,
    sessionId: string,
    tokenCount: bigint,
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const nonce = await this._reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, connected);
    const tx = await contract.getFunction('settle')(sessionId, tokenCount, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async settleTimeout(
    signer: AbstractSigner,
    sessionId: string,
  ): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const nonce = await this._reserveNonce(signerAddress);
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, connected);
    const tx = await contract.getFunction('settleTimeout')(sessionId, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ─── View Functions ─────────────────────────────────────────────────

  async getSession(sessionId: string): Promise<SessionInfo> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    const result = await contract.getFunction('sessions')(sessionId);
    return {
      buyer: result[0],
      seller: result[1],
      maxAmount: result[2],
      nonce: result[3],
      deadline: result[4],
      previousConsumption: result[5],
      previousSessionId: result[6],
      reservedAt: result[7],
      settledAmount: result[8],
      settledTokenCount: result[9],
      tokenRate: result[10],
      status: Number(result[11]),
      isFirstSign: result[12],
      isProvenSign: result[13],
      isQualifiedProvenSign: result[14],
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

  async getLatestSessionId(buyerAddr: string, sellerAddr: string): Promise<string> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('latestSessionId')(buyerAddr, sellerAddr) as Promise<string>;
  }

  async getFirstSessionTimestamp(buyerAddr: string, sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('firstSessionTimestamp')(buyerAddr, sellerAddr) as Promise<bigint>;
  }

  async getProvenSignCooldown(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, SESSIONS_ABI, this._provider);
    return contract.getFunction('PROVEN_SIGN_COOLDOWN')() as Promise<bigint>;
  }

  /**
   * Fetch all data the buyer needs to display a payment approval card.
   * Requires a deposits client reference for balance data.
   */
  async getBuyerApprovalContext(
    buyerAddr: string,
    sellerAddr: string,
    depositsClient: { getBuyerBalance(addr: string): Promise<BuyerBalanceInfo> },
  ): Promise<{
    buyerBalance: BuyerBalanceInfo;
    firstSignCap: bigint;
    latestSessionId: string;
    firstSessionTimestamp: bigint;
    isFirstSign: boolean;
    cooldownRemainingSecs: number;
  }> {
    const ZERO_BYTES32 = '0x' + '00'.repeat(32);

    const [buyerBalance, firstSignCap, latestSessId, firstSessTs, cooldown] = await Promise.all([
      depositsClient.getBuyerBalance(buyerAddr),
      this.getFirstSignCap(),
      this.getLatestSessionId(buyerAddr, sellerAddr),
      this.getFirstSessionTimestamp(buyerAddr, sellerAddr),
      this.getProvenSignCooldown(),
    ]);

    const isFirstSign = latestSessId === ZERO_BYTES32;
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    let cooldownRemainingSecs = 0;
    if (!isFirstSign && firstSessTs > 0n) {
      const cooldownEnd = firstSessTs + cooldown;
      if (cooldownEnd > nowSecs) {
        cooldownRemainingSecs = Number(cooldownEnd - nowSecs);
      }
    }

    return {
      buyerBalance,
      firstSignCap,
      latestSessionId: latestSessId,
      firstSessionTimestamp: firstSessTs,
      isFirstSign,
      cooldownRemainingSecs,
    };
  }
}
