import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  TopUpRequestPayload,
} from '../types/protocol.js';
import { encodeFrame } from './message-protocol.js';
import type { FramedMessage } from '../types/protocol.js';
import * as codec from './payment-codec.js';

export type PaymentMessageHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Multiplexes bilateral payment messages over a PeerConnection.
 * Register handlers for each message type, then call handleFrame()
 * when a payment-range frame arrives.
 */
export class PaymentMux {
  private _connection: PeerConnection;
  private _messageIdCounter = 0;

  // Handler registrations
  private _onSpendingAuth?: PaymentMessageHandler<SpendingAuthPayload>;
  private _onAuthAck?: PaymentMessageHandler<AuthAckPayload>;
  private _onSellerReceipt?: PaymentMessageHandler<SellerReceiptPayload>;
  private _onBuyerAck?: PaymentMessageHandler<BuyerAckPayload>;
  private _onTopUpRequest?: PaymentMessageHandler<TopUpRequestPayload>;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  // --- Handler registration ---
  onSpendingAuth(handler: PaymentMessageHandler<SpendingAuthPayload>): void {
    this._onSpendingAuth = handler;
  }
  onAuthAck(handler: PaymentMessageHandler<AuthAckPayload>): void {
    this._onAuthAck = handler;
  }
  onSellerReceipt(handler: PaymentMessageHandler<SellerReceiptPayload>): void {
    this._onSellerReceipt = handler;
  }
  onBuyerAck(handler: PaymentMessageHandler<BuyerAckPayload>): void {
    this._onBuyerAck = handler;
  }
  onTopUpRequest(handler: PaymentMessageHandler<TopUpRequestPayload>): void {
    this._onTopUpRequest = handler;
  }

  // --- Sending ---
  sendSpendingAuth(payload: SpendingAuthPayload): void {
    this._send(MessageType.SpendingAuth, codec.encodeSpendingAuth(payload));
  }
  sendAuthAck(payload: AuthAckPayload): void {
    this._send(MessageType.AuthAck, codec.encodeAuthAck(payload));
  }
  sendSellerReceipt(payload: SellerReceiptPayload): void {
    this._send(MessageType.SellerReceipt, codec.encodeSellerReceipt(payload));
  }
  sendBuyerAck(payload: BuyerAckPayload): void {
    this._send(MessageType.BuyerAck, codec.encodeBuyerAck(payload));
  }
  sendTopUpRequest(payload: TopUpRequestPayload): void {
    this._send(MessageType.TopUpRequest, codec.encodeTopUpRequest(payload));
  }

  // --- Receiving ---
  /**
   * Returns true if this frame is a payment message and was handled.
   */
  async handleFrame(frame: FramedMessage): Promise<boolean> {
    switch (frame.type) {
      case MessageType.SpendingAuth:
        await this._onSpendingAuth?.(codec.decodeSpendingAuth(frame.payload));
        return true;
      case MessageType.AuthAck:
        await this._onAuthAck?.(codec.decodeAuthAck(frame.payload));
        return true;
      case MessageType.SellerReceipt:
        await this._onSellerReceipt?.(codec.decodeSellerReceipt(frame.payload));
        return true;
      case MessageType.BuyerAck:
        await this._onBuyerAck?.(codec.decodeBuyerAck(frame.payload));
        return true;
      case MessageType.TopUpRequest:
        await this._onTopUpRequest?.(codec.decodeTopUpRequest(frame.payload));
        return true;
      default:
        return false;
    }
  }

  /** Check if a message type is in the payment range (0x50-0x5F). */
  static isPaymentMessage(type: number): boolean {
    return type >= 0x50 && type <= 0x5f;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}
