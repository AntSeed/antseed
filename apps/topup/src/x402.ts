import { getAddress, isAddress, isHexString, keccak256, verifyTypedData } from 'ethers';

/** EIP-3009 TransferWithAuthorization fields, decimal-string encoded. */
export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: string;
    authorization: X402Authorization;
  };
}

export interface X402PaymentRequirements {
  scheme: 'exact';
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: Record<string, string>;
}

const TRANSFER_WITH_AUTHORIZATION_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

/** Deterministic top-up id — the payment signature is unique per payment. */
export function topupId(signature: string): string {
  return keccak256(signature);
}

export function parsePaymentHeader(header: string): X402PaymentPayload {
  let decoded: string;
  try {
    decoded = Buffer.from(header, 'base64').toString('utf-8');
  } catch {
    throw new Error('X-PAYMENT header is not valid base64');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    throw new Error('X-PAYMENT header does not decode to JSON');
  }
  return validatePaymentPayload(raw);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function decimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a decimal string`);
  }
  return value;
}

function addressString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }
  return getAddress(value);
}

/** Structural validation of a buyer-supplied payment payload. Throws on malformed input. */
export function validatePaymentPayload(rawInput: unknown): X402PaymentPayload {
  const raw = asRecord(rawInput, 'paymentPayload');
  if (raw.x402Version !== 1) throw new Error('paymentPayload.x402Version must be 1');
  if (raw.scheme !== 'exact') throw new Error('paymentPayload.scheme must be "exact"');
  if (typeof raw.network !== 'string' || raw.network.length === 0) {
    throw new Error('paymentPayload.network must be a non-empty string');
  }
  const payload = asRecord(raw.payload, 'paymentPayload.payload');
  const signature = payload.signature;
  if (typeof signature !== 'string' || !isHexString(signature) || (signature.length !== 132 && signature.length !== 130)) {
    throw new Error('paymentPayload.payload.signature must be a 64/65-byte hex signature');
  }
  const auth = asRecord(payload.authorization, 'paymentPayload.payload.authorization');
  const nonce = auth.nonce;
  if (typeof nonce !== 'string' || !isHexString(nonce, 32)) {
    throw new Error('authorization.nonce must be a 32-byte hex string');
  }
  const value = decimalString(auth.value, 'authorization.value');
  if (BigInt(value) <= 0n) throw new Error('authorization.value must be positive');

  return {
    x402Version: 1,
    scheme: 'exact',
    network: raw.network,
    payload: {
      signature,
      authorization: {
        from: addressString(auth.from, 'authorization.from'),
        to: addressString(auth.to, 'authorization.to'),
        value,
        validAfter: decimalString(auth.validAfter, 'authorization.validAfter'),
        validBefore: decimalString(auth.validBefore, 'authorization.validBefore'),
        nonce,
      },
    },
  };
}

export interface PaymentDomain {
  asset: string;
  assetName: string;
  assetVersion: string;
  evmChainId: number;
}

/** Recover the EIP-712 signer and compare against `authorization.from`. */
export function verifyPaymentSignature(payment: X402PaymentPayload, domain: PaymentDomain): boolean {
  const auth = payment.payload.authorization;
  try {
    const recovered = verifyTypedData(
      {
        name: domain.assetName,
        version: domain.assetVersion,
        chainId: domain.evmChainId,
        verifyingContract: domain.asset,
      },
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      payment.payload.signature,
    );
    return recovered.toLowerCase() === auth.from.toLowerCase();
  } catch {
    return false;
  }
}

export interface RequirementsContext {
  network: string;
  asset: string;
  assetName: string;
  assetVersion: string;
  facilitator: string;
  /** Wallet that Meridian credits and that relays the deposit on-chain. */
  creditedRecipient: string;
  resourceUrl: string;
}

export function buildPaymentRequirements(
  ctx: RequirementsContext,
  buyer: string,
  amount: bigint,
): X402PaymentRequirements {
  return {
    scheme: 'exact',
    network: ctx.network,
    asset: ctx.asset,
    payTo: ctx.facilitator,
    maxAmountRequired: amount.toString(),
    resource: `${ctx.resourceUrl}?buyer=${buyer}`,
    description:
      `Top up AntSeed buyer deposits for ${buyer}. ` +
      'The credited amount is the settled amount net of Meridian facilitator fees.',
    mimeType: 'application/json',
    maxTimeoutSeconds: 300,
    extra: {
      name: ctx.assetName,
      version: ctx.assetVersion,
      creditedRecipient: ctx.creditedRecipient,
    },
  };
}
