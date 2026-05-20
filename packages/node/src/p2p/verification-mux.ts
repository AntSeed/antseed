import type { PeerConnection } from './connection-manager.js';
import { MessageType } from '../types/protocol.js';
import type {
  FramedMessage,
  VerificationCommitProofPayload,
  VerificationCommitRequestPayload,
  VerificationCommitResponsePayload,
  VerificationRevealAckPayload,
  VerificationRevealPackagePayload,
  VerificationRevealResponsePayload,
} from '../types/protocol.js';
import { encodeFrame } from './message-protocol.js';
import * as codec from './verification-codec.js';
import { debugLog } from '../utils/debug.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.VerificationCommitRequest]: 'VerificationCommitRequest',
  [MessageType.VerificationCommitResponse]: 'VerificationCommitResponse',
  [MessageType.VerificationCommitProof]: 'VerificationCommitProof',
  [MessageType.VerificationRevealPackage]: 'VerificationRevealPackage',
  [MessageType.VerificationRevealResponse]: 'VerificationRevealResponse',
  [MessageType.VerificationRevealAck]: 'VerificationRevealAck',
};

export type VerificationMessageHandler<T> = (payload: T) => void | Promise<void>;

export class VerificationMux {
  private readonly _connection: PeerConnection;
  private _messageIdCounter = 0;

  private _onCommitRequest?: VerificationMessageHandler<VerificationCommitRequestPayload>;
  private _onCommitResponse?: VerificationMessageHandler<VerificationCommitResponsePayload>;
  private _onCommitProof?: VerificationMessageHandler<VerificationCommitProofPayload>;
  private _onRevealPackage?: VerificationMessageHandler<VerificationRevealPackagePayload>;
  private _onRevealResponse?: VerificationMessageHandler<VerificationRevealResponsePayload>;
  private _onRevealAck?: VerificationMessageHandler<VerificationRevealAckPayload>;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  onCommitRequest(handler: VerificationMessageHandler<VerificationCommitRequestPayload>): void { this._onCommitRequest = handler; }
  onCommitResponse(handler: VerificationMessageHandler<VerificationCommitResponsePayload>): void { this._onCommitResponse = handler; }
  onCommitProof(handler: VerificationMessageHandler<VerificationCommitProofPayload>): void { this._onCommitProof = handler; }
  onRevealPackage(handler: VerificationMessageHandler<VerificationRevealPackagePayload>): void { this._onRevealPackage = handler; }
  onRevealResponse(handler: VerificationMessageHandler<VerificationRevealResponsePayload>): void { this._onRevealResponse = handler; }
  onRevealAck(handler: VerificationMessageHandler<VerificationRevealAckPayload>): void { this._onRevealAck = handler; }

  sendCommitRequest(payload: VerificationCommitRequestPayload): void {
    this._send(MessageType.VerificationCommitRequest, codec.encodeVerificationCommitRequest(payload));
  }
  sendCommitResponse(payload: VerificationCommitResponsePayload): void {
    this._send(MessageType.VerificationCommitResponse, codec.encodeVerificationCommitResponse(payload));
  }
  sendCommitProof(payload: VerificationCommitProofPayload): void {
    this._send(MessageType.VerificationCommitProof, codec.encodeVerificationCommitProof(payload));
  }
  sendRevealPackage(payload: VerificationRevealPackagePayload): void {
    this._send(MessageType.VerificationRevealPackage, codec.encodeVerificationRevealPackage(payload));
  }
  sendRevealResponse(payload: VerificationRevealResponsePayload): void {
    this._send(MessageType.VerificationRevealResponse, codec.encodeVerificationRevealResponse(payload));
  }
  sendRevealAck(payload: VerificationRevealAckPayload): void {
    this._send(MessageType.VerificationRevealAck, codec.encodeVerificationRevealAck(payload));
  }

  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[VerificationMux] ← recv ${name} (${frame.payload.length}b)`);
    switch (frame.type) {
      case MessageType.VerificationCommitRequest:
        await this._onCommitRequest?.(codec.decodeVerificationCommitRequest(frame.payload));
        return true;
      case MessageType.VerificationCommitResponse:
        await this._onCommitResponse?.(codec.decodeVerificationCommitResponse(frame.payload));
        return true;
      case MessageType.VerificationCommitProof:
        await this._onCommitProof?.(codec.decodeVerificationCommitProof(frame.payload));
        return true;
      case MessageType.VerificationRevealPackage:
        await this._onRevealPackage?.(codec.decodeVerificationRevealPackage(frame.payload));
        return true;
      case MessageType.VerificationRevealResponse:
        await this._onRevealResponse?.(codec.decodeVerificationRevealResponse(frame.payload));
        return true;
      case MessageType.VerificationRevealAck:
        await this._onRevealAck?.(codec.decodeVerificationRevealAck(frame.payload));
        return true;
      default:
        return false;
    }
  }

  static isVerificationMessage(type: number): boolean {
    return type >= 0x80 && type <= 0x8f;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    debugLog(`[VerificationMux] → send ${MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`} (${payload.length}b)`);
    this._connection.send(encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    }));
  }
}
