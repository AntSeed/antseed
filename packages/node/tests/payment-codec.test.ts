import { describe, it, expect } from 'vitest';
import {
  encodeSpendingAuth, decodeSpendingAuth,
  encodeAuthAck, decodeAuthAck,
  encodeSellerReceipt, decodeSellerReceipt,
  encodeBuyerAck, decodeBuyerAck,
  encodeTopUpRequest, decodeTopUpRequest,
} from '../src/p2p/payment-codec.js';

describe('payment codec round-trips', () => {
  it('SpendingAuth', () => {
    const payload = {
      sessionId:     '0x' + 'a'.repeat(64),
      maxAmountUsdc: '2000000',
      nonce:         1,
      deadline:      Math.floor(Date.now() / 1000) + 3600,
      buyerSig:      '0x' + 'b'.repeat(130),
    };
    expect(decodeSpendingAuth(encodeSpendingAuth(payload))).toEqual(payload);
  });

  it('AuthAck', () => {
    const payload = { sessionId: '0x' + 'a'.repeat(64), nonce: 1 };
    expect(decodeAuthAck(encodeAuthAck(payload))).toEqual(payload);
  });

  it('SellerReceipt', () => {
    const payload = {
      sessionId:    '0x' + 'a'.repeat(64),
      runningTotal: '500000',
      requestCount: 5,
      responseHash: 'c'.repeat(64),
      sellerSig:    'd'.repeat(128),
    };
    expect(decodeSellerReceipt(encodeSellerReceipt(payload))).toEqual(payload);
  });

  it('BuyerAck', () => {
    const payload = {
      sessionId:    '0x' + 'a'.repeat(64),
      runningTotal: '500000',
      requestCount: 5,
      buyerSig:     'e'.repeat(128),
    };
    expect(decodeBuyerAck(encodeBuyerAck(payload))).toEqual(payload);
  });

  it('TopUpRequest', () => {
    const payload = {
      sessionId:           '0x' + 'a'.repeat(64),
      currentUsed:         '400000',
      currentMax:          '500000',
      requestedAdditional: '500000',
    };
    expect(decodeTopUpRequest(encodeTopUpRequest(payload))).toEqual(payload);
  });

});
