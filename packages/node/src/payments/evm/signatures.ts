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

// =========================================================================
// Metadata encoding
//
// v1 layout (4 × uint256):
//   word[0] = 1                           (version)
//   word[1] = cumulativeInputTokens
//   word[2] = cumulativeOutputTokens
//   word[3] = cumulativeRequestCount
//
// v2 layout (5 × uint256):
//   word[0] = 2                           (version)
//   word[1] = cumulativeInputTokens
//   word[2] = cumulativeOutputTokens
//   word[3] = cumulativeRequestCount
//   word[4] = keccak256(abi.encodePacked(serviceName)) — bytes32 cast to uint256
//             Zero if the service name is unknown.
//
// Indexers can derive the human-readable model name by reversing the hash
// against the known service catalog in provider_directory.
// =========================================================================

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  /** keccak256 of the UTF-8 service/model name, cast to uint256. Zero = unknown. */
  serviceHash?: bigint;
}

export const METADATA_VERSION_V1 = 1n;
export const METADATA_VERSION_V2 = 2n;

/** @deprecated Use METADATA_VERSION_V2. Kept for consumers that reference the old name. */
export const METADATA_VERSION = METADATA_VERSION_V1;

/** Compute the keccak256 service hash from a UTF-8 service name string. */
export function hashServiceName(serviceName: string): bigint {
  return BigInt(keccak256(toUtf8Bytes(serviceName)));
}

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  if (metadata.serviceHash != null && metadata.serviceHash !== 0n) {
    return coder.encode(
      ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
      [METADATA_VERSION_V2, metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeRequestCount, metadata.serviceHash],
    );
  }
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256'],
    [METADATA_VERSION_V1, metadata.cumulativeInputTokens, metadata.cumulativeOutputTokens, metadata.cumulativeRequestCount],
  );
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

/** Decode a hex-encoded metadata blob emitted by a ChannelSettled event. */
export function decodeMetadata(hex: string): SpendingAuthMetadata & { version: number } | null {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length < 64 * 4) return null;
  const word = (i: number): bigint => BigInt('0x' + raw.slice(i * 64, (i + 1) * 64));
  try {
    const version = Number(word(0));
    const base = {
      version,
      cumulativeInputTokens: word(1),
      cumulativeOutputTokens: word(2),
      cumulativeRequestCount: word(3),
    };
    if (version >= 2 && raw.length >= 64 * 5) {
      return { ...base, serviceHash: word(4) };
    }
    return base;
  } catch {
    return null;
  }
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
