import type { PeerConnection } from '../p2p/connection-manager.js';
import { encodeFrame } from '../p2p/message-protocol.js';
import {
  MessageType,
  type AuditRelayJobPayload,
  type AuditRelayResultPayload,
  type FramedMessage,
  type RelayHelloPayload,
  type RelayWelcomePayload,
} from '../types/protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import {
  decodeAuditRelayJob,
  decodeAuditRelayResult,
  decodeRelayHello,
  decodeRelayWelcome,
  encodeAuditRelayJob,
  encodeAuditRelayResult,
  encodeRelayHello,
  encodeRelayWelcome,
} from './relay-codec.js';

const DEFAULT_WELCOME_TIMEOUT_MS = 15_000;
const WELCOME_KEY = 'welcome';

export type RelayMessageHandler<T> = (payload: T) => void | Promise<void>;

export class RelayMux {
  private _messageIdCounter = 0;
  private _onHello?: RelayMessageHandler<RelayHelloPayload>;
  private _onJob?: RelayMessageHandler<AuditRelayJobPayload>;
  private _onWelcome?: (payload: RelayWelcomePayload) => void;
  private readonly _pendingResults = new Map<string, Pending<AuditRelayResultPayload>>();
  private readonly _pendingWelcome = new Map<string, Pending<RelayWelcomePayload>>();

  constructor(private readonly _connection: PeerConnection) {}

  onHello(handler: RelayMessageHandler<RelayHelloPayload>): void { this._onHello = handler; }
  onJob(handler: RelayMessageHandler<AuditRelayJobPayload>): void { this._onJob = handler; }
  onWelcome(handler: (payload: RelayWelcomePayload) => void): void { this._onWelcome = handler; }
  sendHello(payload: RelayHelloPayload): void { this._send(MessageType.RelayHello, encodeRelayHello(payload)); }
  sendWelcome(payload: RelayWelcomePayload): void { this._send(MessageType.RelayWelcome, encodeRelayWelcome(payload)); }
  sendJob(payload: AuditRelayJobPayload): void { this._send(MessageType.AuditRelayJob, encodeAuditRelayJob(payload)); }
  sendResult(payload: AuditRelayResultPayload): void { this._send(MessageType.AuditRelayResult, encodeAuditRelayResult(payload)); }

  waitForWelcome(timeoutMs = DEFAULT_WELCOME_TIMEOUT_MS): Promise<RelayWelcomePayload> {
    return this._registerPending(this._pendingWelcome, WELCOME_KEY, timeoutMs, 'RelayWelcome timed out');
  }

  runJob(payload: AuditRelayJobPayload, timeoutMs: number): Promise<AuditRelayResultPayload> {
    return this._runCorrelated(
      this._pendingResults,
      payload.jobId,
      timeoutMs,
      `Audit relay job ${payload.jobId} timed out after ${timeoutMs}ms`,
      () => this.sendJob(payload),
    );
  }

  close(): void {
    for (const map of [this._pendingResults, this._pendingWelcome] as const) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('RelayMux closed'));
      }
      map.clear();
    }
  }

  async handleFrame(frame: FramedMessage): Promise<boolean> {
    switch (frame.type) {
      case MessageType.RelayHello:
        await this._onHello?.(decodeRelayHello(frame.payload));
        return true;
      case MessageType.RelayWelcome: {
        const payload = decodeRelayWelcome(frame.payload);
        this._onWelcome?.(payload);
        this._takePending(this._pendingWelcome, WELCOME_KEY)?.resolve(payload);
        return true;
      }
      case MessageType.AuditRelayJob: {
        const payload = decodeAuditRelayJob(frame.payload);
        if (!this._onJob) {
          this.sendResult({ version: 1, jobId: payload.jobId, status: 'error', error: 'no_job_handler' });
          return true;
        }
        await this._onJob(payload);
        return true;
      }
      case MessageType.AuditRelayResult: {
        const payload = decodeAuditRelayResult(frame.payload);
        const pending = this._takePending(this._pendingResults, payload.jobId);
        if (pending) pending.resolve(payload);
        else debugWarn(`[RelayMux] Unmatched result for ${payload.jobId}`);
        return true;
      }
      default:
        return false;
    }
  }

  static isRelayMessage(type: number): boolean {
    return type >= 0x90 && type <= 0x9f;
  }

  private _registerPending<T>(
    map: Map<string, Pending<T>>,
    key: string,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    const existing = map.get(key);
    if (existing) return existing.promise;
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      map.delete(key);
      reject(new Error(timeoutMessage));
    }, Math.max(1, timeoutMs));
    map.set(key, { promise, resolve, reject, timer });
    return promise;
  }

  private _takePending<T>(map: Map<string, Pending<T>>, key: string): Pending<T> | undefined {
    const pending = map.get(key);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    map.delete(key);
    return pending;
  }

  private _runCorrelated<T>(
    map: Map<string, Pending<T>>,
    key: string,
    timeoutMs: number,
    timeoutMessage: string,
    send: () => void,
  ): Promise<T> {
    const existing = map.get(key);
    if (existing) return existing.promise;
    const promise = this._registerPending(map, key, timeoutMs, timeoutMessage);
    try { send(); } catch (error) {
      this._takePending(map, key)?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    debugLog(`[RelayMux] → send 0x${type.toString(16)} (${payload.length}b)`);
    this._connection.send(encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    }));
  }
}

interface Pending<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
