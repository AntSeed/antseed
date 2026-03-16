import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface EmissionsClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

const EMISSIONS_ABI = [
  'function advanceEpoch() external',
  'function claimEmissions() external',
  'function pendingEmissions(address account) external view returns (uint256 seller, uint256 buyer)',
  'function currentEpoch() external view returns (uint256)',
  'function currentEmissionRate() external view returns (uint256)',
  'function epochStart() external view returns (uint256)',
  'function EPOCH_DURATION() external view returns (uint256)',
  'function INITIAL_EMISSION() external view returns (uint256)',
  'function SELLER_SHARE_PCT() external view returns (uint256)',
  'function BUYER_SHARE_PCT() external view returns (uint256)',
  'function RESERVE_SHARE_PCT() external view returns (uint256)',
  'function MAX_SELLER_SHARE_PCT() external view returns (uint256)',
  'function HALVING_INTERVAL() external view returns (uint256)',
  'function totalSellerPoints() external view returns (uint256)',
  'function totalBuyerPoints() external view returns (uint256)',
  'function reserveAccumulated() external view returns (uint256)',
  'function flushReserve() external',
  'function setEscrowContract(address _escrow) external',
  'function setReserveDestination(address _dest) external',
  'function setSharePercentages(uint256 sellerPct, uint256 buyerPct, uint256 reservePct) external',
  'function transferOwnership(address newOwner) external',
] as const;

export class EmissionsClient extends BaseEvmClient {
  constructor(config: EmissionsClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  async advanceEpoch(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('advanceEpoch')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async claimEmissions(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('claimEmissions')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async pendingEmissions(address: string): Promise<{ seller: bigint; buyer: bigint }> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const [seller, buyer] = await contract.getFunction('pendingEmissions')(address);
    return { seller, buyer };
  }

  async getEpochInfo(): Promise<{ epoch: number; emission: bigint; epochStart: number; epochDuration: number }> {
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, this._provider);
    const [epoch, emission, start, duration] = await Promise.all([
      contract.getFunction('currentEpoch')(),
      contract.getFunction('currentEmissionRate')(),
      contract.getFunction('epochStart')(),
      contract.getFunction('EPOCH_DURATION')(),
    ]);
    return {
      epoch: Number(epoch),
      emission: BigInt(emission),
      epochStart: Number(start),
      epochDuration: Number(duration),
    };
  }

  async flushReserve(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, EMISSIONS_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('flushReserve')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }
}
