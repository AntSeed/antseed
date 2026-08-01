import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type { SweepRequestPayload, SweepReceiptPayload, FramedMessage } from '../types/protocol.js';
import { encodeFrame } from './message-protocol.js';
import * as codec from './sweep-codec.js';
import { debugLog } from '../utils/debug.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.SweepRequest]: 'SweepRequest',
  [MessageType.SweepReceipt]: 'SweepReceipt',
};

export type SweepMessageHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Multiplexes deposit-sweep messages over a PeerConnection.
 * Buyers broadcast SweepRequest to connected peers; relayers (sellers by
 * default) reply with optional SweepReceipt progress reports.
 */
export class SweepMux {
  private _connection: PeerConnection;
  private _messageIdCounter = 0;

  private _onSweepRequest?: SweepMessageHandler<SweepRequestPayload>;
  private _onSweepReceipt?: SweepMessageHandler<SweepReceiptPayload>;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  // --- Handler registration ---
  onSweepRequest(handler: SweepMessageHandler<SweepRequestPayload>): void {
    this._onSweepRequest = handler;
  }
  onSweepReceipt(handler: SweepMessageHandler<SweepReceiptPayload>): void {
    this._onSweepReceipt = handler;
  }

  // --- Sending ---
  sendSweepRequest(payload: SweepRequestPayload): void {
    this._send(MessageType.SweepRequest, codec.encodeSweepRequest(payload));
  }
  sendSweepReceipt(payload: SweepReceiptPayload): void {
    this._send(MessageType.SweepReceipt, codec.encodeSweepReceipt(payload));
  }

  // --- Receiving ---
  /**
   * Returns true if this frame is a sweep message and was handled.
   */
  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[SweepMux] ← recv ${name} (${frame.payload.length}b)`);
    switch (frame.type) {
      case MessageType.SweepRequest:
        await this._onSweepRequest?.(codec.decodeSweepRequest(frame.payload));
        return true;
      case MessageType.SweepReceipt:
        await this._onSweepReceipt?.(codec.decodeSweepReceipt(frame.payload));
        return true;
      default:
        return false;
    }
  }

  /** Check if a message type is in the deposit-sweep range (0xA0-0xAF). */
  static isSweepMessage(type: number): boolean {
    return type >= 0xa0 && type <= 0xaf;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    debugLog(`[SweepMux] → send ${MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`} (${payload.length}b)`);
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}
