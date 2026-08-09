/**
 * Browser transport to one seller: relay-signaled WebRTC DataChannel carrying
 * AntSeed protocol frames. Satisfies @antseed/buyer-core's BuyerConnection
 * interface; all request/payment logic lives in the shared buyer machinery.
 */

import type { Signer } from 'ethers';
import {
  ConnectionState,
  FrameDecoder,
  MessageType,
  encodeFrame,
  type FramedMessage,
} from '@antseed/protocol';
import { buildHelloEnvelope } from './identity.js';
import { SignalingSocket, type WebSocketCtor } from './signaling.js';

export interface RtcEnvironment {
  RTCPeerConnection: typeof RTCPeerConnection;
  WebSocket: WebSocketCtor;
}

export interface ConnectionOptions {
  connectTimeoutMs?: number;
  iceServers?: string[];
  capabilities?: string[];
}

const DATA_CHANNEL_LABEL = 'antseed-data';
const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_PONGS = 3;
const DEFAULT_ICE_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
];

type StateListener = (state: ConnectionState) => void;

export class SellerConnection {
  private decoder = new FrameDecoder();
  private messageId = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private awaitingPong = false;
  private _state: ConnectionState = ConnectionState.Open;
  private stateListeners = new Set<StateListener>();

  /** Set by the session wiring; receives every non-keepalive inbound frame. */
  onFrame: (frame: FramedMessage) => void = () => {};
  onClose: (reason: string) => void = () => {};

  private constructor(
    private readonly pc: RTCPeerConnection,
    private readonly dc: RTCDataChannel,
    private readonly signaling: SignalingSocket,
  ) {}

  static async connect(
    relayBridgeUrl: string,
    signer: Signer,
    env: RtcEnvironment,
    options: ConnectionOptions = {},
  ): Promise<SellerConnection> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
    const signaling = await SignalingSocket.connect(relayBridgeUrl, env.WebSocket);

    const hello = await buildHelloEnvelope(signer);
    signaling.sendHello({
      type: 'hello',
      auth: hello,
      capabilities: options.capabilities ?? [],
    });

    const pc = new env.RTCPeerConnection({
      iceServers: (options.iceServers ?? DEFAULT_ICE_SERVERS).map((urls) => ({ urls })),
    });
    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    dc.binaryType = 'arraybuffer';

    const conn = new SellerConnection(pc, dc, signaling);

    pc.onicecandidate = (event) => {
      if (event.candidate?.candidate) {
        signaling.sendSignal({
          type: 'candidate',
          candidate: event.candidate.candidate,
          mid: event.candidate.sdpMid ?? '0',
        });
      }
    };
    // Serialize application: the answer and trickled candidates can arrive in
    // one WebSocket frame, and addIceCandidate before setRemoteDescription
    // settles throws InvalidStateError.
    let applyQueue: Promise<void> = Promise.resolve();
    signaling.onMessage = (msg) => {
      applyQueue = applyQueue
        .then(async () => {
          if (msg.type === 'sdp') {
            await pc.setRemoteDescription({
              type: msg.descriptionType as RTCSdpType,
              sdp: msg.sdp,
            });
          } else if (msg.type === 'candidate') {
            await pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid });
          }
        })
        .catch((err: unknown) => conn.fail(`signaling apply failed: ${String(err)}`));
    };
    signaling.onClose = (reason) => {
      if (dc.readyState !== 'open') conn.fail(`signaling closed: ${reason}`);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.sendSignal({ type: 'sdp', sdp: offer.sdp ?? '', descriptionType: 'offer' });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`connection timeout after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
      dc.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      dc.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`datachannel error: ${String((event as ErrorEvent).message ?? event)}`));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          clearTimeout(timer);
          reject(new Error(`peer connection ${pc.connectionState}`));
        }
      };
    });

    dc.onmessage = (event) => conn.handleMessage(event.data as ArrayBuffer | string);
    dc.onclose = () => conn.fail('datachannel closed');
    conn.startKeepalive();

    // The bridge is only needed for signaling; free the relay slot (it counts
    // against the per-IP cap). The seller keeps the session alive — its
    // signaling-close handler only tears down connections still connecting.
    // There is no re-signaling/ICE-restart path that would need it later.
    signaling.onClose = () => {};
    signaling.close();
    return conn;
  }

  // ── BuyerConnection surface ─────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  on(event: 'stateChange', listener: StateListener): this {
    if (event === 'stateChange') this.stateListeners.add(listener);
    return this;
  }

  off(event: 'stateChange', listener: StateListener): this {
    if (event === 'stateChange') this.stateListeners.delete(listener);
    return this;
  }

  send(data: Uint8Array): void {
    if (this._state !== ConnectionState.Open) {
      throw new Error(`cannot send in state ${this._state}`);
    }
    // Copy into an exact-size buffer: callers may hand us views.
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.dc.send(copy.buffer as ArrayBuffer);
  }

  // ── Lifecycle ───────────────────────────────────────────────

  get isOpen(): boolean {
    return this._state === ConnectionState.Open && this.dc.readyState === 'open';
  }

  close(): void {
    if (this._state === ConnectionState.Closed) return;
    this.setState(ConnectionState.Closed);
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.dc.close();
    } catch { /* already closed */ }
    try {
      this.pc.close();
    } catch { /* already closed */ }
    this.signaling.close();
  }

  private fail(reason: string): void {
    if (this._state === ConnectionState.Closed) return;
    this.close();
    this.onClose(reason);
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private sendFrame(type: MessageType, payload: Uint8Array): void {
    this.messageId = (this.messageId + 1) & 0xffffffff;
    this.send(encodeFrame({ type, messageId: this.messageId, payload }));
  }

  private handleMessage(data: ArrayBuffer | string): void {
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    let frames: FramedMessage[];
    try {
      frames = this.decoder.feed(bytes);
    } catch (err) {
      this.fail(`frame decode error: ${String(err)}`);
      return;
    }
    for (const frame of frames) {
      if (frame.type === MessageType.Ping) {
        this.send(encodeFrame({ type: MessageType.Pong, messageId: frame.messageId, payload: frame.payload }));
      } else if (frame.type === MessageType.Pong) {
        this.awaitingPong = false;
        this.missedPongs = 0;
      } else {
        this.onFrame(frame);
      }
    }
  }

  private startKeepalive(): void {
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return;
      if (this.awaitingPong) {
        this.missedPongs++;
        if (this.missedPongs >= MAX_MISSED_PONGS) {
          this.fail('keepalive timeout');
          return;
        }
      }
      const payload = new Uint8Array(8);
      new DataView(payload.buffer).setBigUint64(0, BigInt(Date.now()));
      this.awaitingPong = true;
      this.sendFrame(MessageType.Ping, payload);
    }, PING_INTERVAL_MS);
  }
}
