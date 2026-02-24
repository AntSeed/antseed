import { describe, it, expect, vi } from 'vitest';
import { PaymentMux } from '../src/p2p/payment-mux.js';
import { MessageType, type FramedMessage } from '../src/types/protocol.js';
import * as codec from '../src/p2p/payment-codec.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';

function mockConnection(): PeerConnection {
  return { send: vi.fn() } as unknown as PeerConnection;
}

describe('PaymentMux', () => {
  describe('isPaymentMessage correctly identifies range', () => {
    it('returns true for 0x50-0x58', () => {
      for (let type = 0x50; type <= 0x58; type++) {
        expect(PaymentMux.isPaymentMessage(type)).toBe(true);
      }
    });

    it('returns true for 0x59-0x5F (rest of payment range)', () => {
      for (let type = 0x59; type <= 0x5f; type++) {
        expect(PaymentMux.isPaymentMessage(type)).toBe(true);
      }
    });

    it('returns false for non-payment types', () => {
      expect(PaymentMux.isPaymentMessage(0x01)).toBe(false);
      expect(PaymentMux.isPaymentMessage(0x20)).toBe(false);
      expect(PaymentMux.isPaymentMessage(0x4f)).toBe(false);
      expect(PaymentMux.isPaymentMessage(0x60)).toBe(false);
      expect(PaymentMux.isPaymentMessage(0xff)).toBe(false);
    });
  });

  describe('handleFrame returns false for non-payment messages', () => {
    it('returns false for HttpRequest', async () => {
      const mux = new PaymentMux(mockConnection());
      const frame: FramedMessage = {
        type: MessageType.HttpRequest,
        messageId: 1,
        payload: new Uint8Array(0),
      };
      expect(await mux.handleFrame(frame)).toBe(false);
    });

    it('returns false for Ping', async () => {
      const mux = new PaymentMux(mockConnection());
      const frame: FramedMessage = {
        type: MessageType.Ping,
        messageId: 1,
        payload: new Uint8Array(0),
      };
      expect(await mux.handleFrame(frame)).toBe(false);
    });
  });

  describe('handleFrame dispatches to correct handler', () => {
    it('dispatches SessionLockAuth', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onSessionLockAuth(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        lockedAmount: '1000000',
        buyerSig: 'b'.repeat(128),
      };
      const frame: FramedMessage = {
        type: MessageType.SessionLockAuth,
        messageId: 1,
        payload: codec.encodeSessionLockAuth(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches SellerReceipt', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onSellerReceipt(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        runningTotal: '500000',
        requestCount: 5,
        responseHash: 'c'.repeat(64),
        sellerSig: 'd'.repeat(128),
      };
      const frame: FramedMessage = {
        type: MessageType.SellerReceipt,
        messageId: 2,
        payload: codec.encodeSellerReceipt(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches BuyerAck', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onBuyerAck(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        runningTotal: '500000',
        requestCount: 5,
        buyerSig: 'e'.repeat(128),
      };
      const frame: FramedMessage = {
        type: MessageType.BuyerAck,
        messageId: 3,
        payload: codec.encodeBuyerAck(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches SessionEnd', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onSessionEnd(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        runningTotal: '500000',
        requestCount: 5,
        score: 85,
        buyerSig: 'f'.repeat(128),
      };
      const frame: FramedMessage = {
        type: MessageType.SessionEnd,
        messageId: 4,
        payload: codec.encodeSessionEnd(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches DisputeNotify', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onDisputeNotify(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        reason: 'Unacknowledged service',
        txSignature: 'tx456',
      };
      const frame: FramedMessage = {
        type: MessageType.DisputeNotify,
        messageId: 5,
        payload: codec.encodeDisputeNotify(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('returns true even with no handler registered', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);

      const payload = {
        sessionId: 'a'.repeat(64),
        lockedAmount: '1000000',
        buyerSig: 'b'.repeat(128),
      };
      const frame: FramedMessage = {
        type: MessageType.SessionLockAuth,
        messageId: 1,
        payload: codec.encodeSessionLockAuth(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
    });
  });
});
