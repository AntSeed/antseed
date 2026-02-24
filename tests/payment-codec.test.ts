import { describe, it, expect } from 'vitest';
import {
  encodeSessionLockAuth, decodeSessionLockAuth,
  encodeSessionLockConfirm, decodeSessionLockConfirm,
  encodeSessionLockReject, decodeSessionLockReject,
  encodeSellerReceipt, decodeSellerReceipt,
  encodeBuyerAck, decodeBuyerAck,
  encodeSessionEnd, decodeSessionEnd,
  encodeTopUpRequest, decodeTopUpRequest,
  encodeTopUpAuth, decodeTopUpAuth,
  encodeDisputeNotify, decodeDisputeNotify,
} from '../src/p2p/payment-codec.js';

describe('payment codec round-trips', () => {
  it('SessionLockAuth', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      lockedAmount: '1000000',
      buyerSig: 'b'.repeat(128),
    };
    const encoded = encodeSessionLockAuth(payload);
    const decoded = decodeSessionLockAuth(encoded);
    expect(decoded).toEqual(payload);
  });

  it('SessionLockConfirm', () => {
    const payload = { sessionId: 'a'.repeat(64), txSignature: 'tx123' };
    expect(decodeSessionLockConfirm(encodeSessionLockConfirm(payload))).toEqual(payload);
  });

  it('SessionLockReject', () => {
    const payload = { sessionId: 'a'.repeat(64), reason: 'Insufficient funds' };
    expect(decodeSessionLockReject(encodeSessionLockReject(payload))).toEqual(payload);
  });

  it('SellerReceipt', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      runningTotal: '500000',
      requestCount: 5,
      responseHash: 'c'.repeat(64),
      sellerSig: 'd'.repeat(128),
    };
    expect(decodeSellerReceipt(encodeSellerReceipt(payload))).toEqual(payload);
  });

  it('BuyerAck', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      runningTotal: '500000',
      requestCount: 5,
      buyerSig: 'e'.repeat(128),
    };
    expect(decodeBuyerAck(encodeBuyerAck(payload))).toEqual(payload);
  });

  it('SessionEnd', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      runningTotal: '500000',
      requestCount: 5,
      score: 85,
      buyerSig: 'f'.repeat(128),
    };
    expect(decodeSessionEnd(encodeSessionEnd(payload))).toEqual(payload);
  });

  it('TopUpRequest', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      additionalAmount: '500000',
      currentRunningTotal: '400000',
      currentLockedAmount: '500000',
    };
    expect(decodeTopUpRequest(encodeTopUpRequest(payload))).toEqual(payload);
  });

  it('TopUpAuth', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      additionalAmount: '500000',
      buyerSig: 'g'.repeat(128),
    };
    expect(decodeTopUpAuth(encodeTopUpAuth(payload))).toEqual(payload);
  });

  it('DisputeNotify', () => {
    const payload = {
      sessionId: 'a'.repeat(64),
      reason: 'Unacknowledged service',
      txSignature: 'tx456',
    };
    expect(decodeDisputeNotify(encodeDisputeNotify(payload))).toEqual(payload);
  });
});
