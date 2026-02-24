/** Default keepalive interval in milliseconds. */
export const DEFAULT_PING_INTERVAL_MS = 15_000;

/** Default timeout waiting for a pong response. */
export const DEFAULT_PONG_TIMEOUT_MS = 5_000;

/** Maximum consecutive missed pongs before declaring connection dead. */
export const MAX_MISSED_PONGS = 3;

export interface KeepaliveConfig {
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  maxMissedPongs?: number;
}

export interface KeepaliveCallbacks {
  sendPing: (payload: Uint8Array) => void;
  onDead: () => void;
}

/**
 * Manages the keepalive (ping/pong) cycle for a peer connection.
 *
 * The initiator sends Ping messages at a regular interval. If no Pong
 * is received within pongTimeoutMs, it increments the missed counter.
 * After maxMissedPongs consecutive misses, the connection is declared dead.
 */
export class KeepaliveManager {
  private _pingInterval: number;
  private _pongTimeout: number;
  private _maxMissedPongs: number;
  private _missedPongs = 0;
  private _intervalHandle: ReturnType<typeof setInterval> | null = null;
  private _pongTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _callbacks: KeepaliveCallbacks;
  private _lastPingTime = 0;
  private _latencyMs = 0;
  private _running = false;

  constructor(callbacks: KeepaliveCallbacks, config?: KeepaliveConfig) {
    this._callbacks = callbacks;
    this._pingInterval = config?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this._pongTimeout = config?.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this._maxMissedPongs = config?.maxMissedPongs ?? MAX_MISSED_PONGS;
  }

  get missedPongs(): number {
    return this._missedPongs;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  get isRunning(): boolean {
    return this._running;
  }

  /** Start the keepalive ping cycle. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._missedPongs = 0;
    this._sendPing();
    this._intervalHandle = setInterval(() => this._sendPing(), this._pingInterval);
  }

  /** Stop the keepalive cycle. */
  stop(): void {
    this._running = false;
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
    if (this._pongTimeoutHandle) {
      clearTimeout(this._pongTimeoutHandle);
      this._pongTimeoutHandle = null;
    }
  }

  /** Handle a received Pong message. */
  handlePong(_payload: Uint8Array): void {
    this._missedPongs = 0;
    this._latencyMs = Date.now() - this._lastPingTime;

    if (this._pongTimeoutHandle) {
      clearTimeout(this._pongTimeoutHandle);
      this._pongTimeoutHandle = null;
    }
  }

  /** Send a ping and set up the pong timeout. */
  private _sendPing(): void {
    this._lastPingTime = Date.now();

    // Payload is the timestamp as 8 bytes (BigUint64)
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(this._lastPingTime), false);

    this._callbacks.sendPing(payload);

    // Set timeout for pong response
    this._pongTimeoutHandle = setTimeout(() => {
      this._missedPongs++;
      if (this._missedPongs >= this._maxMissedPongs) {
        this.stop();
        this._callbacks.onDead();
      }
    }, this._pongTimeout);
  }
}

/** Build a Pong payload echoing the Ping payload. */
export function buildPongPayload(pingPayload: Uint8Array): Uint8Array {
  // Echo the same payload back
  return new Uint8Array(pingPayload);
}
