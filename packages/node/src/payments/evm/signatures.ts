import { type AbstractSigner, type TypedDataDomain, AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

// =========================================================================
// EIP-712 Types — AntSeed SpendingAuth (cumulative payment authorization)
// =========================================================================

export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
};

export const RESERVE_AUTH_TYPES = {
  ReserveAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const SET_OPERATOR_TYPES = {
  SetOperator: [
    { name: 'operator', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export const USAGE_COMMIT_TYPES = {
  UsageCommit: [
    { name: 'claimHash', type: 'bytes32' },
    { name: 'revealHash', type: 'bytes32' },
    { name: 'expectedEpoch', type: 'uint256' },
    { name: 'party', type: 'uint8' },
  ],
};

export const USAGE_CLAIM_TYPES = {
  UsageClaim: [
    { name: 'version', type: 'uint256' },
    { name: 'channelId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'sellerAgentId', type: 'uint256' },
    { name: 'serviceKey', type: 'bytes32' },
    { name: 'providerName', type: 'string' },
    { name: 'serviceName', type: 'string' },
    { name: 'cumulativeInputTokens', type: 'uint256' },
    { name: 'cumulativeCachedInputTokens', type: 'uint256' },
    { name: 'cumulativeFreshInputTokens', type: 'uint256' },
    { name: 'cumulativeOutputTokens', type: 'uint256' },
    { name: 'cumulativeRequestCount', type: 'uint256' },
    { name: 'cumulativeCostUsdc', type: 'uint256' },
    { name: 'paymentCumulativeAmount', type: 'uint256' },
  ],
};

// =========================================================================
// Message interfaces
// =========================================================================

export interface SpendingAuthMessage {
  channelId: string;
  cumulativeAmount: bigint;
  metadataHash: string; // bytes32 hex
}

export interface ReserveAuthMessage {
  channelId: string;
  maxAmount: bigint;
  deadline: bigint;
}

export interface SetOperatorMessage {
  operator: string;
  nonce: bigint;
}

export interface UsageCommitMessage {
  claimHash: string;
  revealHash: string;
  expectedEpoch: bigint;
  party: number;
}

export interface UsageClaimMessage {
  version: bigint;
  channelId: string;
  buyer: string;
  seller: string;
  sellerAgentId: bigint;
  serviceKey: string;
  providerName: string;
  serviceName: string;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeFreshInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeCostUsdc: bigint;
  paymentCumulativeAmount: bigint;
}

export const USAGE_CLAIM_VERSION = 1n;
export const USAGE_PARTY_BUYER = 1;
export const USAGE_PARTY_SELLER = 2;

// =========================================================================
// Metadata encoding
// =========================================================================

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
}

export const METADATA_VERSION = 1n;

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256'],
    [METADATA_VERSION, metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeRequestCount],
  );
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

// =========================================================================
// Channel ID computation (must match AntseedChannels.computeChannelId)
// =========================================================================

/**
 * Compute the deterministic channelId.
 * Must match: keccak256(abi.encode(buyer, seller, salt))
 */
export function computeChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['address', 'address', 'bytes32'],
    [buyer, seller, salt],
  ));
}

// =========================================================================
// EIP-712 Domain helpers
// =========================================================================

export function makeChannelsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedChannels',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeDepositsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedDeposits',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeUsageVerificationDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedUsageVerification',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function normalizeServicePart(value: string): string {
  return value.trim().toLowerCase();
}

export function computeServiceKey(providerName: string, serviceName: string): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['string', 'string'],
    [normalizeServicePart(providerName), normalizeServicePart(serviceName)],
  ));
}

export function computeUsageClaimHash(claim: UsageClaimMessage): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    [
      'bytes32',
      'uint256',
      'bytes32',
      'address',
      'address',
      'uint256',
      'bytes32',
      'bytes32',
      'bytes32',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
      'uint256',
    ],
    [
      keccak256(toUtf8Bytes('UsageClaim(uint256 version,bytes32 channelId,address buyer,address seller,uint256 sellerAgentId,bytes32 serviceKey,string providerName,string serviceName,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeFreshInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeCostUsdc,uint256 paymentCumulativeAmount')),
      claim.version,
      claim.channelId,
      claim.buyer,
      claim.seller,
      claim.sellerAgentId,
      claim.serviceKey,
      keccak256(toUtf8Bytes(claim.providerName)),
      keccak256(toUtf8Bytes(claim.serviceName)),
      claim.cumulativeInputTokens,
      claim.cumulativeCachedInputTokens,
      claim.cumulativeFreshInputTokens,
      claim.cumulativeOutputTokens,
      claim.cumulativeRequestCount,
      claim.cumulativeCostUsdc,
      claim.paymentCumulativeAmount,
    ],
  ));
}

export function computeUsageRevealHash(claimHash: string, nonce: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [claimHash, nonce]));
}

// =========================================================================
// Signing functions — EIP-712 (on-chain)
// =========================================================================

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}

export async function signReserveAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: ReserveAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, RESERVE_AUTH_TYPES, msg);
}

export async function signSetOperator(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SetOperatorMessage,
): Promise<string> {
  return signer.signTypedData(domain, SET_OPERATOR_TYPES, msg);
}

export async function signUsageCommit(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: UsageCommitMessage,
): Promise<string> {
  return signer.signTypedData(domain, USAGE_COMMIT_TYPES, msg);
}
