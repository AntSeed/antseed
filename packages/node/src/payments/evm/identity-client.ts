import { Contract, encodeBytes32String, keccak256, toUtf8Bytes, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface IdentityClientConfig {
  rpcUrl: string;
  contractAddress: string;
  usdcAddress?: string;
}

export interface ProvenReputation {
  firstSignCount: number;
  qualifiedProvenSignCount: number;
  unqualifiedProvenSignCount: number;
  ghostCount: number;
  totalQualifiedTokenVolume: bigint;
  lastProvenAt: number;
}

export interface FeedbackSummary {
  count: number;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

export interface SellerAccountInfo {
  stake: bigint;
  stakedAt: bigint;
  tokenRate: bigint;
}

const IDENTITY_ABI = [
  // Registration
  'function register(bytes32 peerId, string metadataURI) external returns (uint256)',
  'function deregister(uint256 tokenId) external',
  'function updateMetadata(uint256 tokenId, string metadataURI) external',

  // View — identity lookups
  'function isRegistered(address addr) external view returns (bool)',
  'function getTokenId(address addr) external view returns (uint256)',
  'function getTokenIdByPeerId(bytes32 peerId) external view returns (uint256)',
  'function getPeerId(uint256 tokenId) external view returns (bytes32)',

  // Reputation
  'function getReputation(uint256 tokenId) external view returns (uint64 firstSignCount, uint64 qualifiedProvenSignCount, uint64 unqualifiedProvenSignCount, uint64 ghostCount, uint256 totalQualifiedTokenVolume, uint64 lastProvenAt)',
  'function updateReputation(uint256 tokenId, tuple(uint8 updateType, uint256 tokenVolume) update) external',

  // Staking
  'function stake(uint256 amount) external',
  'function unstake() external',
  'function setTokenRate(uint256 rate) external',
  'function getSellerAccount(address seller) external view returns (uint256 stake, uint256 stakedAt, uint256 tokenRate)',
  'function getStake(address seller) external view returns (uint256)',
  'function getTokenRate(address seller) external view returns (uint256)',
  'function isStakedAboveMin(address seller) external view returns (bool)',

  // Feedback (ERC-8004)
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, bytes32 tag1, bytes32 tag2) external',
  'function getSummary(uint256 agentId, bytes32 tag) external view returns (uint256 count, int256 summaryValue, uint8 summaryValueDecimals)',
  'function readFeedback(uint256 agentId, address client, uint256 index) external view returns (tuple(address client, int128 value, uint8 valueDecimals, bytes32 tag1, bytes32 tag2, uint64 timestamp, bool revoked))',
  'function revokeFeedback(uint256 agentId, uint256 index) external',
  'function getFeedbackCount(uint256 agentId, address client) external view returns (uint256)',

  // Admin
  'function setSessionsContract(address _sessions) external',
  'function sessionsContract() external view returns (address)',
  'function owner() external view returns (address)',
] as const;

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
] as const;

export class IdentityClient extends BaseEvmClient {
  private readonly _usdcAddress?: string;

  constructor(config: IdentityClientConfig) {
    super(config.rpcUrl, config.contractAddress);
    this._usdcAddress = config.usdcAddress;
  }

  // ── Write methods ──────────────────────────────────────────────────

  async register(signer: AbstractSigner, peerId: string, metadataURI: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const peerIdBytes = keccak256(toUtf8Bytes(peerId));
    const tx = await contract.getFunction('register')(peerIdBytes, metadataURI, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async deregister(signer: AbstractSigner, tokenId: number): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('deregister')(tokenId, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async updateMetadata(signer: AbstractSigner, tokenId: number, metadataURI: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('updateMetadata')(tokenId, metadataURI, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async submitFeedback(signer: AbstractSigner, agentId: number, value: number, tag: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tagBytes = encodeBytes32String(tag);
    const tx = await contract.getFunction('giveFeedback')(agentId, value, 0, tagBytes, tagBytes, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  // ── Staking methods ──────────────────────────────────────────────────

  async stake(signer: AbstractSigner, amount: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const usdc = new Contract(this._usdcAddress!, ERC20_ABI, connected);
    const approveNonce = await this._reserveNonce(signerAddress);
    const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
    const approveReceipt = await approveTx.wait();
    if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const stakeNonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('stake')(amount, { nonce: stakeNonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async unstake(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('unstake')({ nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async setTokenRate(signer: AbstractSigner, rate: bigint): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('setTokenRate')(rate, { nonce });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('Transaction was dropped or replaced');
    return receipt.hash;
  }

  async getSellerAccount(sellerAddr: string): Promise<SellerAccountInfo> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    const result = await contract.getFunction('getSellerAccount')(sellerAddr);
    return {
      stake: result[0] as bigint,
      stakedAt: result[1] as bigint,
      tokenRate: result[2] as bigint,
    };
  }

  async getStake(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    return contract.getFunction('getStake')(sellerAddr) as Promise<bigint>;
  }

  async getTokenRate(sellerAddr: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    return contract.getFunction('getTokenRate')(sellerAddr) as Promise<bigint>;
  }

  async isStakedAboveMin(sellerAddr: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    return contract.getFunction('isStakedAboveMin')(sellerAddr) as Promise<boolean>;
  }

  // ── View methods ───────────────────────────────────────────────────

  async isRegistered(address: string): Promise<boolean> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    return contract.getFunction('isRegistered')(address);
  }

  async getTokenId(address: string): Promise<number> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    const result = await contract.getFunction('getTokenId')(address);
    return Number(result);
  }

  async getTokenIdByPeerId(peerId: string): Promise<number> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    const peerIdBytes = keccak256(toUtf8Bytes(peerId));
    const result = await contract.getFunction('getTokenIdByPeerId')(peerIdBytes);
    return Number(result);
  }

  async getPeerId(tokenId: number): Promise<string> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    return contract.getFunction('getPeerId')(tokenId);
  }

  async getReputation(tokenId: number): Promise<ProvenReputation> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    const result = await contract.getFunction('getReputation')(tokenId);
    return {
      firstSignCount: Number(result[0]),
      qualifiedProvenSignCount: Number(result[1]),
      unqualifiedProvenSignCount: Number(result[2]),
      ghostCount: Number(result[3]),
      totalQualifiedTokenVolume: result[4] as bigint,
      lastProvenAt: Number(result[5]),
    };
  }

  async getReputationByPeerId(peerId: string): Promise<ProvenReputation> {
    const tokenId = await this.getTokenIdByPeerId(peerId);
    return this.getReputation(tokenId);
  }

  async getFeedbackSummary(agentId: number, tag: string): Promise<FeedbackSummary> {
    const contract = new Contract(this._contractAddress, IDENTITY_ABI, this._provider);
    const tagBytes = encodeBytes32String(tag);
    const result = await contract.getFunction('getSummary')(agentId, tagBytes);
    return {
      count: Number(result[0]),
      summaryValue: result[1] as bigint,
      summaryValueDecimals: Number(result[2]),
    };
  }
}
