import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type {
  SessionLockAuthPayload,
  SessionLockConfirmPayload,
  SessionLockRejectPayload,
  SellerReceiptPayload,
  BuyerAckPayload,
  SessionEndPayload,
  TopUpRequestPayload,
  TopUpAuthPayload,
  DisputeNotifyPayload,
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
  private _onSessionLockAuth?: PaymentMessageHandler<SessionLockAuthPayload>;
  private _onSessionLockConfirm?: PaymentMessageHandler<SessionLockConfirmPayload>;
  private _onSessionLockReject?: PaymentMessageHandler<SessionLockRejectPayload>;
  private _onSellerReceipt?: PaymentMessageHandler<SellerReceiptPayload>;
  private _onBuyerAck?: PaymentMessageHandler<BuyerAckPayload>;
  private _onSessionEnd?: PaymentMessageHandler<SessionEndPayload>;
  private _onTopUpRequest?: PaymentMessageHandler<TopUpRequestPayload>;
  private _onTopUpAuth?: PaymentMessageHandler<TopUpAuthPayload>;
  private _onDisputeNotify?: PaymentMessageHandler<DisputeNotifyPayload>;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  // --- Handler registration ---
  onSessionLockAuth(handler: PaymentMessageHandler<SessionLockAuthPayload>): void {
    this._onSessionLockAuth = handler;
  }
  onSessionLockConfirm(handler: PaymentMessageHandler<SessionLockConfirmPayload>): void {
    this._onSessionLockConfirm = handler;
  }
  onSessionLockReject(handler: PaymentMessageHandler<SessionLockRejectPayload>): void {
    this._onSessionLockReject = handler;
  }
  onSellerReceipt(handler: PaymentMessageHandler<SellerReceiptPayload>): void {
    this._onSellerReceipt = handler;
  }
  onBuyerAck(handler: PaymentMessageHandler<BuyerAckPayload>): void {
    this._onBuyerAck = handler;
  }
  onSessionEnd(handler: PaymentMessageHandler<SessionEndPayload>): void {
    this._onSessionEnd = handler;
  }
  onTopUpRequest(handler: PaymentMessageHandler<TopUpRequestPayload>): void {
    this._onTopUpRequest = handler;
  }
  onTopUpAuth(handler: PaymentMessageHandler<TopUpAuthPayload>): void {
    this._onTopUpAuth = handler;
  }
  onDisputeNotify(handler: PaymentMessageHandler<DisputeNotifyPayload>): void {
    this._onDisputeNotify = handler;
  }

  // --- Sending ---
  sendSessionLockAuth(payload: SessionLockAuthPayload): void {
    this._send(MessageType.SessionLockAuth, codec.encodeSessionLockAuth(payload));
  }
  sendSessionLockConfirm(payload: SessionLockConfirmPayload): void {
    this._send(MessageType.SessionLockConfirm, codec.encodeSessionLockConfirm(payload));
  }
  sendSessionLockReject(payload: SessionLockRejectPayload): void {
    this._send(MessageType.SessionLockReject, codec.encodeSessionLockReject(payload));
  }
  sendSellerReceipt(payload: SellerReceiptPayload): void {
    this._send(MessageType.SellerReceipt, codec.encodeSellerReceipt(payload));
  }
  sendBuyerAck(payload: BuyerAckPayload): void {
    this._send(MessageType.BuyerAck, codec.encodeBuyerAck(payload));
  }
  sendSessionEnd(payload: SessionEndPayload): void {
    this._send(MessageType.SessionEnd, codec.encodeSessionEnd(payload));
  }
  sendTopUpRequest(payload: TopUpRequestPayload): void {
    this._send(MessageType.TopUpRequest, codec.encodeTopUpRequest(payload));
  }
  sendTopUpAuth(payload: TopUpAuthPayload): void {
    this._send(MessageType.TopUpAuth, codec.encodeTopUpAuth(payload));
  }
  sendDisputeNotify(payload: DisputeNotifyPayload): void {
    this._send(MessageType.DisputeNotify, codec.encodeDisputeNotify(payload));
  }

  // --- Receiving ---
  /**
   * Returns true if this frame is a payment message and was handled.
   */
  async handleFrame(frame: FramedMessage): Promise<boolean> {
    switch (frame.type) {
      case MessageType.SessionLockAuth:
        await this._onSessionLockAuth?.(codec.decodeSessionLockAuth(frame.payload));
        return true;
      case MessageType.SessionLockConfirm:
        await this._onSessionLockConfirm?.(codec.decodeSessionLockConfirm(frame.payload));
        return true;
      case MessageType.SessionLockReject:
        await this._onSessionLockReject?.(codec.decodeSessionLockReject(frame.payload));
        return true;
      case MessageType.SellerReceipt:
        await this._onSellerReceipt?.(codec.decodeSellerReceipt(frame.payload));
        return true;
      case MessageType.BuyerAck:
        await this._onBuyerAck?.(codec.decodeBuyerAck(frame.payload));
        return true;
      case MessageType.SessionEnd:
        await this._onSessionEnd?.(codec.decodeSessionEnd(frame.payload));
        return true;
      case MessageType.TopUpRequest:
        await this._onTopUpRequest?.(codec.decodeTopUpRequest(frame.payload));
        return true;
      case MessageType.TopUpAuth:
        await this._onTopUpAuth?.(codec.decodeTopUpAuth(frame.payload));
        return true;
      case MessageType.DisputeNotify:
        await this._onDisputeNotify?.(codec.decodeDisputeNotify(frame.payload));
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
