/** Configuration for the reconnection strategy. */
export interface ReconnectConfig {
  /** Base delay in milliseconds before the first reconnect attempt. */
  baseDelayMs?: number;
  /** Maximum delay in milliseconds between reconnect attempts. */
  maxDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up. */
  maxAttempts?: number;
  /** Jitter factor (0-1) to randomize the delay. */
  jitterFactor?: number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_JITTER_FACTOR = 0.3;

export interface ReconnectCallbacks {
  /** Called when a reconnect attempt should be made. */
  onReconnect: (attempt: number) => Promise<boolean>;
  /** Called when all attempts are exhausted. */
  onGiveUp: (totalAttempts: number) => void;
  /** Called when reconnection succeeds. */
  onSuccess: (attempt: number) => void;
}

/**
 * Manages reconnection with exponential backoff and jitter.
 *
 * Delay formula: min(baseDelay * 2^attempt + jitter, maxDelay)
 */
export class ReconnectManager {
  private _baseDelay: number;
  private _maxDelay: number;
  private _maxAttempts: number;
  private _jitterFactor: number;
  private _attempt = 0;
  private _callbacks: ReconnectCallbacks;
  private _timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _active = false;

  constructor(callbacks: ReconnectCallbacks, config?: ReconnectConfig) {
    this._callbacks = callbacks;
    this._baseDelay = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this._maxDelay = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this._maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this._jitterFactor = config?.jitterFactor ?? DEFAULT_JITTER_FACTOR;
  }

  get attempt(): number {
    return this._attempt;
  }

  get isActive(): boolean {
    return this._active;
  }

  /** Calculate delay for the current attempt with exponential backoff + jitter. */
  calculateDelay(attempt: number): number {
    const exponentialDelay = this._baseDelay * Math.pow(2, attempt);
    const jitter = exponentialDelay * this._jitterFactor * Math.random();
    return Math.min(exponentialDelay + jitter, this._maxDelay);
  }

  /** Start the reconnection process. */
  start(): void {
    if (this._active) return;
    this._active = true;
    this._attempt = 0;
    this._scheduleAttempt();
  }

  /** Stop the reconnection process. */
  stop(): void {
    this._active = false;
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  /** Reset the attempt counter (e.g., after a successful connection). */
  reset(): void {
    this._attempt = 0;
    this.stop();
  }

  /** Schedule the next reconnect attempt. */
  private _scheduleAttempt(): void {
    if (!this._active) return;

    if (this._attempt >= this._maxAttempts) {
      this._active = false;
      this._callbacks.onGiveUp(this._attempt);
      return;
    }

    const delay = this.calculateDelay(this._attempt);

    this._timeoutHandle = setTimeout(async () => {
      if (!this._active) return;

      this._attempt++;
      try {
        const success = await this._callbacks.onReconnect(this._attempt);
        if (success) {
          this._active = false;
          this._callbacks.onSuccess(this._attempt);
        } else {
          this._scheduleAttempt();
        }
      } catch {
        this._scheduleAttempt();
      }
    }, delay);
  }
}
