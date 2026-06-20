import { type AbstractSigner, type TypedDataDomain, AbiCoder, id, keccak256 } from 'ethers';

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

export const FREE_USAGE_OPEN_TYPES = {
  FreeUsageOpen: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const FREE_USAGE_AUTH_TYPES = {
  FreeUsageAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'sequence', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
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

export interface FreeUsageOpenMessage {
  channelId: string;
  deadline: bigint;
}

export interface FreeUsageAuthMessage {
  channelId: string;
  sequence: bigint;
  metadataHash: string;
  deadline: bigint;
}

// =========================================================================
// Metadata encoding
// =========================================================================

/**
 * SpendingAuth metadata v2.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     ServiceTotal[] services
 *   )
 *
 * The first four fields intentionally match v1 so legacy decoders can read
 * aggregate token/request counters by decoding only those fields. Service
 * entries are buyer-side attribution metadata for indexers: input tokens
 * include cached input, with cached input broken out separately.
 *
 * Service cumulativeAmount values may be lower than the top-level
 * cumulativeAmount because the buyer can sign reserve headroom, cap a
 * per-request amount, or extend auth without attributing that delta to a
 * specific service.
 */

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  services?: SpendingAuthServiceMetadata[];
}

export interface SpendingAuthServiceMetadata {
  serviceId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
}

export const METADATA_VERSION = 2n;

const SERVICE_METADATA_ABI_TYPE =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]';

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE],
    [
      METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      services,
    ],
  );
}

export function getServiceMetadataId(service: string): string {
  return id(service.trim());
}

export interface ServiceMetadataDelta {
  amount: bigint;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  requests: bigint;
}

export function withServiceMetadata<T extends { services?: SpendingAuthServiceMetadata[] }>(
  metadata: T,
  service: string | undefined,
  delta: ServiceMetadataDelta,
): T {
  if (!service || service.trim().length === 0) return metadata;

  const serviceId = getServiceMetadataId(service);
  const byServiceId = new Map<string, SpendingAuthServiceMetadata>();
  for (const entry of metadata.services ?? []) {
    byServiceId.set(entry.serviceId, { ...entry });
  }

  const existing = byServiceId.get(serviceId) ?? {
    serviceId,
    cumulativeAmount: 0n,
    cumulativeInputTokens: 0n,
    cumulativeCachedInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 0n,
  };

  byServiceId.set(serviceId, {
    serviceId,
    cumulativeAmount: existing.cumulativeAmount + delta.amount,
    cumulativeInputTokens: existing.cumulativeInputTokens + delta.inputTokens,
    cumulativeCachedInputTokens: existing.cumulativeCachedInputTokens + delta.cachedInputTokens,
    cumulativeOutputTokens: existing.cumulativeOutputTokens + delta.outputTokens,
    cumulativeRequestCount: existing.cumulativeRequestCount + delta.requests,
  });

  return {
    ...metadata,
    services: [...byServiceId.values()].sort((a, b) =>
      a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
    ),
  };
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  services: [],
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

/**
 * FreeUsage metadata v1.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     ServiceTotal[] services
 *   )
 *
 * Uses the same service tuple as paid SpendingAuth metadata so indexers can
 * decode per-service attribution uniformly. cumulativeAmount is always zero
 * for free usage.
 */
export interface FreeUsageMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  services?: SpendingAuthServiceMetadata[];
}

export type FreeUsageServiceMetadata = SpendingAuthServiceMetadata;

export const FREE_USAGE_METADATA_VERSION = 1n;

export function encodeFreeUsageMetadata(metadata: FreeUsageMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE],
    [
      FREE_USAGE_METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      services,
    ],
  );
}

export function computeFreeUsageMetadataHash(metadata: FreeUsageMetadata): string {
  return keccak256(encodeFreeUsageMetadata(metadata));
}

export const ZERO_FREE_USAGE_METADATA: FreeUsageMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  services: [],
};

export const ZERO_FREE_USAGE_METADATA_HASH: string = computeFreeUsageMetadataHash(ZERO_FREE_USAGE_METADATA);

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

export const FREE_USAGE_CHANNEL_DOMAIN = id('ANTSEED_FREE_USAGE_CHANNEL');

/**
 * Compute the deterministic free usage channelId.
 * Domain-separated from AntseedChannels.computeChannelId so a paid and free
 * channel cannot share an ID even if buyer, seller, and salt are identical.
 */
export function computeFreeUsageChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['bytes32', 'address', 'address', 'bytes32'],
    [FREE_USAGE_CHANNEL_DOMAIN, buyer, seller, salt],
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

export function makeFreeUsageDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedFreeUsage',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
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

export async function signFreeUsageOpen(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: FreeUsageOpenMessage,
): Promise<string> {
  return signer.signTypedData(domain, FREE_USAGE_OPEN_TYPES, msg);
}

export async function signFreeUsageAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: FreeUsageAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, FREE_USAGE_AUTH_TYPES, msg);
}
