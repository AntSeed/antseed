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
    it('returns true for 0x50-0x55', () => {
      for (let type = 0x50; type <= 0x55; type++) {
        expect(PaymentMux.isPaymentMessage(type)).toBe(true);
      }
    });

    it('returns true for 0x56-0x5F (rest of payment range)', () => {
      for (let type = 0x56; type <= 0x5f; type++) {
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
    it('dispatches SpendingAuth', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onSpendingAuth(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        cumulativeAmount: '1000000',
        cumulativeInputTokens: '500',
        cumulativeOutputTokens: '200',
        nonce: 1,
        deadline: 1700000000,
        buyerSig: 'b'.repeat(128),
        buyerEvmAddr: '0x' + 'ab'.repeat(20),
      };
      const frame: FramedMessage = {
        type: MessageType.SpendingAuth,
        messageId: 1,
        payload: codec.encodeSpendingAuth(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches AuthAck', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onAuthAck(handler);

      const payload = { sessionId: 'a'.repeat(64), nonce: 42 };
      const frame: FramedMessage = {
        type: MessageType.AuthAck,
        messageId: 1,
        payload: codec.encodeAuthAck(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches PaymentRequired', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onPaymentRequired(handler);

      const payload = {
        sellerEvmAddr: '0x' + 'ab'.repeat(20),
        minBudgetPerRequest: '10000',
        suggestedAmount: '100000',
        requestId: 'req-123',
      };
      const frame: FramedMessage = {
        type: MessageType.PaymentRequired,
        messageId: 2,
        payload: codec.encodePaymentRequired(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it('dispatches NeedAuth', async () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);
      const handler = vi.fn();
      mux.onNeedAuth(handler);

      const payload = {
        sessionId: 'a'.repeat(64),
        requiredCumulativeAmount: '500000',
        currentAcceptedCumulative: '200000',
        deposit: '1000000',
      };
      const frame: FramedMessage = {
        type: MessageType.NeedAuth,
        messageId: 3,
        payload: codec.encodeNeedAuth(payload),
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
        cumulativeAmount: '1000000',
        cumulativeInputTokens: '0',
        cumulativeOutputTokens: '0',
        nonce: 1,
        deadline: 1700000000,
        buyerSig: 'b'.repeat(128),
        buyerEvmAddr: '0x' + 'ab'.repeat(20),
      };
      const frame: FramedMessage = {
        type: MessageType.SpendingAuth,
        messageId: 1,
        payload: codec.encodeSpendingAuth(payload),
      };

      const result = await mux.handleFrame(frame);
      expect(result).toBe(true);
    });
  });

  describe('send methods encode and write to transport', () => {
    it('sendNeedAuth writes encoded frame', () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);

      const payload = {
        sessionId: 'a'.repeat(64),
        requiredCumulativeAmount: '500000',
        currentAcceptedCumulative: '200000',
        deposit: '1000000',
      };
      mux.sendNeedAuth(payload);

      expect(conn.send).toHaveBeenCalledOnce();
      // The send receives a framed binary message
      const sentFrame = (conn.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sentFrame).toBeInstanceOf(Uint8Array);
      expect(sentFrame.length).toBeGreaterThan(0);
    });

    it('sendSpendingAuth writes encoded frame', () => {
      const conn = mockConnection();
      const mux = new PaymentMux(conn);

      const payload = {
        sessionId: 'a'.repeat(64),
        cumulativeAmount: '1000000',
        cumulativeInputTokens: '0',
        cumulativeOutputTokens: '0',
        nonce: 1,
        deadline: 1700000000,
        buyerSig: 'b'.repeat(128),
        buyerEvmAddr: '0x' + 'ab'.repeat(20),
      };
      mux.sendSpendingAuth(payload);

      expect(conn.send).toHaveBeenCalledOnce();
      const sentFrame = (conn.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sentFrame).toBeInstanceOf(Uint8Array);
    });
  });
});
