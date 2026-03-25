import { Contract, encodeBytes32String, keccak256, toUtf8Bytes, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface IdentityClientConfig {
  rpcUrl: string;
  contractAddress: string;
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


export class IdentityClient extends BaseEvmClient {
  constructor(config: IdentityClientConfig) {
    super(config.rpcUrl, config.contractAddress);
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
