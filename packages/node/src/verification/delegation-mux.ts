import {
  MessageType,
  type DelegateHelloPayload,
  type DelegateWelcomePayload,
  type FramedMessage,
  type ProbeJobRequestPayload,
  type ProbeJobResultPayload,
  type TargetQueryPayload,
  type TargetSuggestionPayload,
} from '../types/protocol.js';
import type { PeerConnection } from '../p2p/connection-manager.js';
import { encodeFrame } from '../p2p/message-protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import {
  decodeDelegateHello,
  decodeDelegateWelcome,
  decodeProbeJobRequest,
  decodeProbeJobResult,
  decodeTargetQuery,
  decodeTargetSuggestion,
  encodeDelegateHello,
  encodeDelegateWelcome,
  encodeProbeJobRequest,
  encodeProbeJobResult,
  encodeTargetQuery,
  encodeTargetSuggestion,
} from './delegation-codec.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.DelegateHello]: 'DelegateHello',
  [MessageType.DelegateWelcome]: 'DelegateWelcome',
  [MessageType.ProbeJobRequest]: 'ProbeJobRequest',
  [MessageType.ProbeJobResult]: 'ProbeJobResult',
  [MessageType.TargetQuery]: 'TargetQuery',
  [MessageType.TargetSuggestion]: 'TargetSuggestion',
};

const DEFAULT_WELCOME_TIMEOUT_MS = 15_000;

/** Single-slot key for the welcome waiter (only one welcome is ever pending). */
const WELCOME_KEY = 'welcome';

export type DelegationMessageHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Frame plumbing for the probe delegation protocol (0x90-0x9F).
 *
 * One mux serves both roles: a verifier host registers `onHello` and awaits
 * job results; a delegate registers `onJob`, awaits the welcome, and sends
 * results. Jobs are correlated by `jobId`.
 */
export class DelegationMux {
  private readonly _connection: PeerConnection;
  private _messageIdCounter = 0;
  private _onHello?: DelegationMessageHandler<DelegateHelloPayload>;
  private _onJob?: DelegationMessageHandler<ProbeJobRequestPayload>;
  private _onTargetQuery?: DelegationMessageHandler<TargetQueryPayload>;
  private _onWelcome?: (payload: DelegateWelcomePayload) => void;
  private readonly _pendingResults = new Map<string, Pending<ProbeJobResultPayload>>();
  private readonly _pendingSuggestions = new Map<string, Pending<TargetSuggestionPayload>>();
  private readonly _pendingWelcome = new Map<string, Pending<DelegateWelcomePayload>>();

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  onHello(handler: DelegationMessageHandler<DelegateHelloPayload>): void {
    this._onHello = handler;
  }

  onJob(handler: DelegationMessageHandler<ProbeJobRequestPayload>): void {
    this._onJob = handler;
  }

  onTargetQuery(handler: DelegationMessageHandler<TargetQueryPayload>): void {
    this._onTargetQuery = handler;
  }

  /**
   * Synchronous observer invoked from the welcome frame's dispatch path,
   * BEFORE the `waitForWelcome` promise resolves. Frames coalesced into one
   * network read are dispatched back-to-back without awaiting each other, so
   * a waiter resumed on a microtask sees any frame behind the welcome first —
   * callers use this hook to flip accept-state synchronously (deliberately
   * sync-only: an async handler would reintroduce that ordering gap).
   */
  onWelcome(handler: (payload: DelegateWelcomePayload) => void): void {
    this._onWelcome = handler;
  }

  sendHello(payload: DelegateHelloPayload): void {
    this._send(MessageType.DelegateHello, encodeDelegateHello(payload));
  }

  sendWelcome(payload: DelegateWelcomePayload): void {
    this._send(MessageType.DelegateWelcome, encodeDelegateWelcome(payload));
  }

  sendJob(payload: ProbeJobRequestPayload): void {
    this._send(MessageType.ProbeJobRequest, encodeProbeJobRequest(payload));
  }

  sendResult(payload: ProbeJobResultPayload): void {
    this._send(MessageType.ProbeJobResult, encodeProbeJobResult(payload));
  }

  sendTargetQuery(payload: TargetQueryPayload): void {
    this._send(MessageType.TargetQuery, encodeTargetQuery(payload));
  }

  sendTargetSuggestion(payload: TargetSuggestionPayload): void {
    this._send(MessageType.TargetSuggestion, encodeTargetSuggestion(payload));
  }

  waitForWelcome(timeoutMs = DEFAULT_WELCOME_TIMEOUT_MS): Promise<DelegateWelcomePayload> {
    return this._registerPending(
      this._pendingWelcome,
      WELCOME_KEY,
      timeoutMs,
      'DelegateWelcome timed out',
    );
  }

  /** Dispatch a job and await its correlated result. */
  runJob(payload: ProbeJobRequestPayload, timeoutMs: number): Promise<ProbeJobResultPayload> {
    return this._runCorrelated(
      this._pendingResults,
      payload.jobId,
      timeoutMs,
      `Probe job ${payload.jobId} timed out after ${timeoutMs}ms`,
      () => this.sendJob(payload),
    );
  }

  /** Dispatch a target query and await its correlated suggestion. */
  runTargetQuery(payload: TargetQueryPayload, timeoutMs: number): Promise<TargetSuggestionPayload> {
    return this._runCorrelated(
      this._pendingSuggestions,
      payload.queryId,
      timeoutMs,
      `Target query ${payload.queryId} timed out after ${timeoutMs}ms`,
      () => this.sendTargetQuery(payload),
    );
  }

  close(): void {
    for (const map of [this._pendingResults, this._pendingSuggestions, this._pendingWelcome] as const) {
      for (const pending of map.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('DelegationMux closed'));
      }
      map.clear();
    }
  }

  /**
   * Register a correlated waiter: an existing entry's promise is returned
   * as-is (idempotent per key), otherwise a new pending entry is created that
   * rejects with `timeoutMessage` and removes itself after `timeoutMs`.
   */
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
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      map.delete(key);
      reject(new Error(timeoutMessage));
    }, Math.max(1, timeoutMs));
    map.set(key, { promise, resolve, reject, timer });
    return promise;
  }

  /** Remove and return a pending entry, clearing its timeout (no-op when absent). */
  private _takePending<T>(map: Map<string, Pending<T>>, key: string): Pending<T> | undefined {
    const pending = map.get(key);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    map.delete(key);
    return pending;
  }

  /** Register a waiter for `key`, then send — a synchronous send failure rejects it. */
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
    try {
      send();
    } catch (err) {
      this._takePending(map, key)?.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }

  async handleFrame(frame: FramedMessage): Promise<boolean> {
    const name = MESSAGE_TYPE_NAME[frame.type];
    if (!name) return false;
    debugLog(`[DelegationMux] ← recv ${name} (${frame.payload.length}b)`);

    switch (frame.type) {
      case MessageType.DelegateHello: {
        const payload = decodeDelegateHello(frame.payload);
        await this._onHello?.(payload);
        return true;
      }
      case MessageType.DelegateWelcome: {
        const payload = decodeDelegateWelcome(frame.payload);
        // Observer first, synchronously: frames behind this welcome in the
        // same batch dispatch before any `waitForWelcome` microtask resumes.
        this._onWelcome?.(payload);
        this._takePending(this._pendingWelcome, WELCOME_KEY)?.resolve(payload);
        return true;
      }
      case MessageType.ProbeJobRequest: {
        const payload = decodeProbeJobRequest(frame.payload);
        if (!this._onJob) {
          debugWarn(`[DelegationMux] ProbeJobRequest ${payload.jobId} dropped — no job handler registered`);
          this.sendResult({ version: 1, jobId: payload.jobId, status: 'error', error: 'no_job_handler' });
          return true;
        }
        await this._onJob(payload);
        return true;
      }
      case MessageType.ProbeJobResult: {
        const payload = decodeProbeJobResult(frame.payload);
        const pending = this._takePending(this._pendingResults, payload.jobId);
        if (pending) {
          pending.resolve(payload);
        } else {
          debugWarn(`[DelegationMux] Unmatched ProbeJobResult for job ${payload.jobId}`);
        }
        return true;
      }
      case MessageType.TargetQuery: {
        const payload = decodeTargetQuery(frame.payload);
        if (!this._onTargetQuery) {
          debugWarn(`[DelegationMux] TargetQuery ${payload.queryId} dropped — no target-query handler registered`);
          this.sendTargetSuggestion({ version: 1, queryId: payload.queryId, service: payload.service, sellers: [] });
          return true;
        }
        await this._onTargetQuery(payload);
        return true;
      }
      case MessageType.TargetSuggestion: {
        const payload = decodeTargetSuggestion(frame.payload);
        const pending = this._takePending(this._pendingSuggestions, payload.queryId);
        if (pending) {
          pending.resolve(payload);
        } else {
          debugWarn(`[DelegationMux] Unmatched TargetSuggestion for query ${payload.queryId}`);
        }
        return true;
      }
      default:
        return false;
    }
  }

  static isDelegationMessage(type: number): boolean {
    return type >= 0x90 && type <= 0x9f;
  }

  private _send(type: MessageType, payload: Uint8Array): void {
    debugLog(`[DelegationMux] → send ${MESSAGE_TYPE_NAME[type] ?? `0x${type.toString(16)}`} (${payload.length}b)`);
    const frame = encodeFrame({
      type,
      messageId: this._messageIdCounter++ & 0xffffffff,
      payload,
    });
    this._connection.send(frame);
  }
}

/** One correlated in-flight wait: resolved by its frame, rejected on timeout/close. */
interface Pending<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
