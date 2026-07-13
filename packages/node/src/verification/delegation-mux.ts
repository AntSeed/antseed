import {
  MessageType,
  type DelegateHelloPayload,
  type DelegateVoucherPayload,
  type DelegateWelcomePayload,
  type FramedMessage,
  type ProbeJobRequestPayload,
  type ProbeJobResultPayload,
} from '../types/protocol.js';
import type { PeerConnection } from '../p2p/connection-manager.js';
import { encodeFrame } from '../p2p/message-protocol.js';
import { debugLog, debugWarn } from '../utils/debug.js';
import {
  decodeDelegateHello,
  decodeDelegateVoucher,
  decodeDelegateWelcome,
  decodeProbeJobRequest,
  decodeProbeJobResult,
  encodeDelegateHello,
  encodeDelegateVoucher,
  encodeDelegateWelcome,
  encodeProbeJobRequest,
  encodeProbeJobResult,
} from './delegation-codec.js';

const MESSAGE_TYPE_NAME: Record<number, string> = {
  [MessageType.DelegateHello]: 'DelegateHello',
  [MessageType.DelegateWelcome]: 'DelegateWelcome',
  [MessageType.ProbeJobRequest]: 'ProbeJobRequest',
  [MessageType.ProbeJobResult]: 'ProbeJobResult',
  [MessageType.DelegateVoucher]: 'DelegateVoucher',
};

const DEFAULT_WELCOME_TIMEOUT_MS = 15_000;

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
  private _onVoucher?: DelegationMessageHandler<DelegateVoucherPayload>;
  private _onWelcome?: (payload: DelegateWelcomePayload) => void;
  private readonly _pendingResults = new Map<string, PendingResult>();
  private _pendingWelcome: PendingWelcome | null = null;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  onHello(handler: DelegationMessageHandler<DelegateHelloPayload>): void {
    this._onHello = handler;
  }

  onJob(handler: DelegationMessageHandler<ProbeJobRequestPayload>): void {
    this._onJob = handler;
  }

  onVoucher(handler: DelegationMessageHandler<DelegateVoucherPayload>): void {
    this._onVoucher = handler;
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

  sendVoucher(payload: DelegateVoucherPayload): void {
    this._send(MessageType.DelegateVoucher, encodeDelegateVoucher(payload));
  }

  waitForWelcome(timeoutMs = DEFAULT_WELCOME_TIMEOUT_MS): Promise<DelegateWelcomePayload> {
    if (this._pendingWelcome) return this._pendingWelcome.promise;

    let resolve!: (payload: DelegateWelcomePayload) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<DelegateWelcomePayload>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this._pendingWelcome = null;
      reject(new Error('DelegateWelcome timed out'));
    }, Math.max(1, timeoutMs));
    this._pendingWelcome = { promise, resolve, reject, timer };
    return promise;
  }

  /** Dispatch a job and await its correlated result. */
  runJob(payload: ProbeJobRequestPayload, timeoutMs: number): Promise<ProbeJobResultPayload> {
    const existing = this._pendingResults.get(payload.jobId);
    if (existing) return existing.promise;

    let resolve!: (result: ProbeJobResultPayload) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ProbeJobResultPayload>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this._pendingResults.delete(payload.jobId);
      reject(new Error(`Probe job ${payload.jobId} timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));
    this._pendingResults.set(payload.jobId, { promise, resolve, reject, timer });

    try {
      this.sendJob(payload);
    } catch (err) {
      clearTimeout(timer);
      this._pendingResults.delete(payload.jobId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }

  close(): void {
    for (const pending of this._pendingResults.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DelegationMux closed'));
    }
    this._pendingResults.clear();
    if (this._pendingWelcome) {
      clearTimeout(this._pendingWelcome.timer);
      this._pendingWelcome.reject(new Error('DelegationMux closed'));
      this._pendingWelcome = null;
    }
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
        if (this._pendingWelcome) {
          clearTimeout(this._pendingWelcome.timer);
          const pending = this._pendingWelcome;
          this._pendingWelcome = null;
          pending.resolve(payload);
        }
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
        const pending = this._pendingResults.get(payload.jobId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingResults.delete(payload.jobId);
          pending.resolve(payload);
        } else {
          debugWarn(`[DelegationMux] Unmatched ProbeJobResult for job ${payload.jobId}`);
        }
        return true;
      }
      case MessageType.DelegateVoucher: {
        const payload = decodeDelegateVoucher(frame.payload);
        if (!this._onVoucher) {
          debugWarn('[DelegationMux] DelegateVoucher dropped — no voucher handler registered');
          return true;
        }
        await this._onVoucher(payload);
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

interface PendingResult {
  promise: Promise<ProbeJobResultPayload>;
  resolve: (result: ProbeJobResultPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingWelcome {
  promise: Promise<DelegateWelcomePayload>;
  resolve: (payload: DelegateWelcomePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
