import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes, verifyTypedData, TypedDataEncoder, Wallet } from 'ethers';
import {
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  makeUsdcDomain,
  buildReceiveAuthorization,
} from '../src/payments/evm/signatures.js';
import {
  encodeSweepRequest,
  decodeSweepRequest,
  encodeSweepReceipt,
  decodeSweepReceipt,
} from '../src/p2p/sweep-codec.js';
import type { SweepRequestPayload, SweepReceiptPayload } from '../src/types/protocol.js';

const BUYER = new Wallet('0x' + 'a1'.repeat(32));
const RELAY = '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318';
const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

describe('EIP-3009 sweep compatibility', () => {
  it('RECEIVE_WITH_AUTHORIZATION_TYPES typehash matches Circle FiatTokenV2', () => {
    // Circle's published RECEIVE_WITH_AUTHORIZATION_TYPEHASH constant.
    const CIRCLE_TYPEHASH = '0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8';
    const fields = RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization;
    const tsTypeString = `ReceiveWithAuthorization(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(keccak256(toUtf8Bytes(tsTypeString))).toBe(CIRCLE_TYPEHASH);
  });

  it('makeUsdcDomain reproduces the deployed Base mainnet USDC domain separator', () => {
    // Read from the deployed token (0x8335...2913) via DOMAIN_SEPARATOR() on 2026-07-12.
    const ONCHAIN_SEPARATOR = '0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f';
    const domain = makeUsdcDomain(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(TypedDataEncoder.hashDomain(domain)).toBe(ONCHAIN_SEPARATOR);
  });

  it('buildReceiveAuthorization signs and recovers, generating a random nonce', async () => {
    const domain = makeUsdcDomain(31337, USDC);
    const { message, signature } = await buildReceiveAuthorization(BUYER, domain, {
      to: RELAY,
      value: 5_000_000n,
      validAfter: 0n,
      validBefore: 2_000_000_000n,
    });
    expect(message.from.toLowerCase()).toBe(BUYER.address.toLowerCase());
    expect(message.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    const recovered = verifyTypedData(domain, RECEIVE_WITH_AUTHORIZATION_TYPES, message, signature);
    expect(recovered.toLowerCase()).toBe(BUYER.address.toLowerCase());

    const second = await buildReceiveAuthorization(BUYER, domain, {
      to: RELAY,
      value: 5_000_000n,
      validAfter: 0n,
      validBefore: 2_000_000_000n,
    });
    expect(second.message.nonce).not.toBe(message.nonce);
  });
});

describe('sweep codec', () => {
  const validRequest: SweepRequestPayload = {
    version: 1,
    evmChainId: 31337,
    relayAddress: RELAY,
    from: BUYER.address,
    amount: '5000000',
    validAfter: 0,
    validBefore: 2_000_000_000,
    nonce: '0x' + '11'.repeat(32),
    sig3009: '0x' + 'ab'.repeat(65),
  };

  it('roundtrips a SweepRequest', () => {
    expect(decodeSweepRequest(encodeSweepRequest(validRequest))).toEqual(validRequest);
  });

  it('roundtrips a SweepReceipt', () => {
    const receipt: SweepReceiptPayload = {
      version: 1,
      authNonce: '0x' + '11'.repeat(32),
      status: 'confirmed',
      txHash: '0x' + '22'.repeat(32),
    };
    expect(decodeSweepReceipt(encodeSweepReceipt(receipt))).toEqual(receipt);
  });

  it('rejects unsupported versions', () => {
    const bad = { ...validRequest, version: 2 };
    expect(() => decodeSweepRequest(encodeSweepRequest(bad as unknown as SweepRequestPayload))).toThrow(/version/);
  });

  it('rejects malformed addresses', () => {
    const bad = { ...validRequest, relayAddress: 'not-an-address' };
    expect(() => decodeSweepRequest(encodeSweepRequest(bad))).toThrow(/relayAddress/);
  });

  it('rejects non-decimal amounts', () => {
    const bad = { ...validRequest, amount: '0xff' };
    expect(() => decodeSweepRequest(encodeSweepRequest(bad))).toThrow(/amount/);
  });

  it('rejects malformed nonces and signatures', () => {
    expect(() => decodeSweepRequest(encodeSweepRequest({ ...validRequest, nonce: '0x1234' }))).toThrow(/nonce/);
    expect(() => decodeSweepRequest(encodeSweepRequest({ ...validRequest, sig3009: '0xzz' }))).toThrow(/sig3009/);
  });

  it('rejects missing fields and non-objects', () => {
    const { sig3009: _sig3009, ...missing } = validRequest;
    expect(() => decodeSweepRequest(encodeSweepRequest(missing as SweepRequestPayload))).toThrow(/sig3009/);
    expect(() => decodeSweepRequest(new TextEncoder().encode('[1,2,3]'))).toThrow(/object/i);
  });

  it('rejects oversized payloads', () => {
    const bloated = { ...validRequest, reason: 'x'.repeat(10_000) };
    expect(() => decodeSweepRequest(encodeSweepRequest(bloated as SweepRequestPayload))).toThrow(/too large/);
  });

  it('rejects invalid receipt statuses', () => {
    const bad = { version: 1, authNonce: '0x' + '11'.repeat(32), status: 'maybe' };
    expect(() => decodeSweepReceipt(new TextEncoder().encode(JSON.stringify(bad)))).toThrow(/status/);
  });

  it('drops malformed optional receipt fields instead of failing', () => {
    const raw = {
      version: 1,
      authNonce: '0x' + '11'.repeat(32),
      status: 'rejected',
      txHash: 'garbage',
      reason: 'x'.repeat(1000),
    };
    const decoded = decodeSweepReceipt(new TextEncoder().encode(JSON.stringify(raw)));
    expect(decoded.txHash).toBeUndefined();
    expect(decoded.reason).toBeUndefined();
  });
});
