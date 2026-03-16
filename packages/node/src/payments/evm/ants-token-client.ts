import { Contract, type AbstractSigner } from 'ethers';
import { BaseEvmClient } from './base-evm-client.js';

export interface ANTSTokenClientConfig {
  rpcUrl: string;
  contractAddress: string;
}

const ANTS_TOKEN_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
  'function transfersEnabled() external view returns (bool)',
  'function emissionsContract() external view returns (address)',
  'function owner() external view returns (address)',
  'function setEmissionsContract(address _emissionsContract) external',
  'function enableTransfers() external',
  'function transferOwnership(address newOwner) external',
] as const;

export class ANTSTokenClient extends BaseEvmClient {
  constructor(config: ANTSTokenClientConfig) {
    super(config.rpcUrl, config.contractAddress);
  }

  async balanceOf(address: string): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('balanceOf')(address);
  }

  async totalSupply(): Promise<bigint> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('totalSupply')();
  }

  async transfersEnabled(): Promise<boolean> {
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, this._provider);
    return contract.getFunction('transfersEnabled')();
  }

  async setEmissionsContract(signer: AbstractSigner, emissionsAddress: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('setEmissionsContract')(emissionsAddress, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async enableTransfers(signer: AbstractSigner): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('enableTransfers')({ nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async transferOwnership(signer: AbstractSigner, newOwner: string): Promise<string> {
    const connected = this._ensureConnected(signer);
    const signerAddress = await connected.getAddress();
    const contract = new Contract(this._contractAddress, ANTS_TOKEN_ABI, connected);
    const nonce = await this._reserveNonce(signerAddress);
    const tx = await contract.getFunction('transferOwnership')(newOwner, { nonce });
    const receipt = await tx.wait();
    return receipt.hash;
  }
}
