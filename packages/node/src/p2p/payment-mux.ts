import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type {
  SpendingAuthPayload,
  AuthAckPayload,
  PaymentRequiredPayload,
  NeedAuthPayload,
} from '../types/protocol.js';
import { encodeFrame } from './message-protocol.js';
import type { FramedMessage } from '../types/protocol.js';
import * as codec from './payment-codec.js';
import { debugLog } from '../utils/debug.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.SpendingAuth]: 'SpendingAuth',
  [MessageType.AuthAck]: 'AuthAck',
  [MessageType.PaymentRequired]: 'PaymentRequired',
  [MessageType.NeedAuth]: 'NeedAuth',
};

export type PaymentMessageHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Multiplexes payment messages over a PeerConnection.
 * Register handlers for each message type, then call handleFrame()
 * when a payment-range frame arrives.
 */
export class PaymentMux {
  private _connection: PeerConnection;
  private _messageIdCounter = 0;

  // Handler registrations
  private _onSpendingAuth?: PaymentMessageHandler<SpendingAuthPayload>;
  private _onAuthAck?: PaymentMessageHandler<AuthAckPayload>;
  private _onPaymentRequired?: PaymentMessageHandler<PaymentRequiredPayload>;
  private _onNeedAuth?: PaymentMessageHandler<NeedAuthPayload>;

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
  onPaymentRequired(handler: PaymentMessageHandler<PaymentRequiredPayload>): void {
    this._onPaymentRequired = handler;
  }
  onNeedAuth(handler: PaymentMessageHandler<NeedAuthPayload>): void {
    this._onNeedAuth = handler;
  }

  // --- Sending ---
  sendSpendingAuth(payload: SpendingAuthPayload): void {
    this._send(MessageType.SpendingAuth, codec.encodeSpendingAuth(payload));
  }
  sendAuthAck(payload: AuthAckPayload): void {
    this._send(MessageType.AuthAck, codec.encodeAuthAck(payload));
  }
  sendPaymentRequired(payload: PaymentRequiredPayload): void {
    this._send(MessageType.PaymentRequired, codec.encodePaymentRequired(payload));
  }
  sendNeedAuth(payload: NeedAuthPayload): void {
    this._send(MessageType.NeedAuth, codec.encodeNeedAuth(payload));
  }

  // --- Receiving ---
  /**
   * Returns true if this frame is a payment message and was handled.
   */
  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[PaymentMux] ← recv ${name} (${frame.payload.length}b)`);
    switch (frame.type) {
      case MessageType.SpendingAuth:
        await this._onSpendingAuth?.(codec.decodeSpendingAuth(frame.payload));
        return true;
      case MessageType.AuthAck:
        await this._onAuthAck?.(codec.decodeAuthAck(frame.payload));
        return true;
      case MessageType.PaymentRequired:
        await this._onPaymentRequired?.(codec.decodePaymentRequired(frame.payload));
        return true;
      case MessageType.NeedAuth:
        await this._onNeedAuth?.(codec.decodeNeedAuth(frame.payload));
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
    debugLog(`[PaymentMux] → send ${MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`} (${payload.length}b)`);
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}
