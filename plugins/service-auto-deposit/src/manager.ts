/**
 * Buyer-side auto-deposit loop: sweeps loose USDC from the wallet into
 * AntseedDeposits, capped by the on-chain credit limit, paying gas in USDC via a
 * gasless executor. Monitoring is on by default; the first deposit is gated by
 * the user's one-time approval (consent).
 */
import { debugLog, debugWarn } from './debug.js';

const DEFAULT_POLL_INTERVAL_MS = 45_000;
const DEFAULT_DUST_FLOOR = 500_000n;   // 0.5 USDC; at/above this we consider depositing
const DEFAULT_GAS_RESERVE = 500_000n;  // 0.5 USDC kept back for the paymaster's gas pull
const DEFAULT_MIN_DEPOSIT = 1_000_000n;  // AntseedDeposits MIN_BUYER_DEPOSIT (first deposit only)
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 600_000;

export type AutoDepositState =
  | 'disabled'        // user has not approved
  | 'idle'            // approved, nothing to deposit
  | 'pending'         // a deposit is in flight
  | 'stranded'        // deposited up to the credit limit; remainder left loose
  | 'backoff'         // transient failure; retrying later
  | 'needs_attention'; // deterministic failure; paused until inputs change

export interface AutoDepositReader {
  /** Loose USDC in the wallet (ERC-20 balanceOf). */
  looseUsdc(): Promise<bigint>;
  /** Total USDC credited in AntseedDeposits (available + reserved). */
  totalDeposited(): Promise<bigint>;
  creditLimit(): Promise<bigint>;
  isDelegated(): Promise<boolean>;
}

export interface AutoDepositExecutor {
  deposit(amount: bigint): Promise<{ txHash: string }>;
}

export interface AutoDepositConsentView {
  isEnabled(): boolean;
}

export interface AutoDepositManagerConfig {
  pollIntervalMs?: number;
  dustFloorBaseUnits?: bigint;
  gasReserveBaseUnits?: bigint;
  minDepositBaseUnits?: bigint;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface AutoDepositStatus {
  enabled: boolean;
  delegated: boolean;
  state: AutoDepositState;
  looseBaseUnits: string;
  strandedBaseUnits: string;
  creditLimitBaseUnits: string;
  depositedBaseUnits: string;
  lastDeposit: { txHash: string; amountBaseUnits: string; at: string } | null;
  lastError: string | null;
}

export interface DepositPlan {
  /** Amount to deposit now (0 = nothing). */
  deposit: bigint;
  /** Loose USDC that cannot be deposited because of the credit limit. */
  stranded: bigint;
}

/**
 * Pure planning: how much to deposit and how much is credit-limit-stranded.
 * `reserve` is kept back for gas; `deposited` is the current contract balance.
 */
export function planDeposit(p: {
  loose: bigint;
  reserve: bigint;
  creditLimit: bigint;
  deposited: bigint;
  minDeposit: bigint;
  dustFloor: bigint;
}): DepositPlan {
  if (p.loose < p.dustFloor) return { deposit: 0n, stranded: 0n };
  const depositable = p.loose > p.reserve ? p.loose - p.reserve : 0n;
  const room = p.creditLimit > p.deposited ? p.creditLimit - p.deposited : 0n;
  const capped = depositable < room ? depositable : room;
  const stranded = depositable - capped;
  // The contract enforces MIN_BUYER_DEPOSIT only on the first deposit.
  const min = p.deposited === 0n ? p.minDeposit : 1n;
  const deposit = capped >= min ? capped : 0n;
  return { deposit, stranded };
}

/** Heuristic: a deterministic on-chain/validation failure (don't retry-spin) vs
 *  a transient network/bundler failure (back off and retry). */
export function isDeterministicError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /revert|creditlimit|insufficient|belowmin|paymaster|1271|authorization|signature|aa\d\d/.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AutoDepositManager {
  private readonly _reader: AutoDepositReader;
  private readonly _executor: AutoDepositExecutor;
  private readonly _consent: AutoDepositConsentView;
  private readonly _pollIntervalMs: number;
  private readonly _dustFloor: bigint;
  private readonly _gasReserve: bigint;
  private readonly _minDeposit: bigint;
  private readonly _backoffBaseMs: number;
  private readonly _backoffMaxMs: number;
  private readonly _onAttention?: (message: string) => void;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _inFlight = false;
  private _state: AutoDepositState = 'disabled';
  private _delegated = false;
  private _loose = 0n;
  private _stranded = 0n;
  private _creditLimit = 0n;
  private _deposited = 0n;
  private _lastDeposit: AutoDepositStatus['lastDeposit'] = null;
  private _lastError: string | null = null;
  private _backoffMs: number;
  private _nextAttemptAt = 0;
  private _attentionSnapshot: { loose: bigint; creditLimit: bigint; deposited: bigint } | null = null;

  constructor(deps: {
    reader: AutoDepositReader;
    executor: AutoDepositExecutor;
    consent: AutoDepositConsentView;
    config?: AutoDepositManagerConfig;
    onAttention?: (message: string) => void;
  }) {
    this._reader = deps.reader;
    this._executor = deps.executor;
    this._consent = deps.consent;
    this._onAttention = deps.onAttention;
    const cfg = deps.config ?? {};
    this._pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this._dustFloor = cfg.dustFloorBaseUnits ?? DEFAULT_DUST_FLOOR;
    this._gasReserve = cfg.gasReserveBaseUnits ?? DEFAULT_GAS_RESERVE;
    this._minDeposit = cfg.minDepositBaseUnits ?? DEFAULT_MIN_DEPOSIT;
    this._backoffBaseMs = cfg.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this._backoffMaxMs = cfg.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this._backoffMs = this._backoffBaseMs;
  }

  /** Start the loop: a catch-up sweep now, then on every interval. */
  start(): void {
    if (this._timer) return;
    void this.runOnce();
    this._timer = setInterval(() => void this.runOnce(), this._pollIntervalMs);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getStatus(): AutoDepositStatus {
    return {
      enabled: this._consent.isEnabled(),
      delegated: this._delegated,
      state: this._state,
      looseBaseUnits: this._loose.toString(),
      strandedBaseUnits: this._stranded.toString(),
      creditLimitBaseUnits: this._creditLimit.toString(),
      depositedBaseUnits: this._deposited.toString(),
      lastDeposit: this._lastDeposit,
      lastError: this._lastError,
    };
  }

  /** One evaluation tick. Public so the loop and tests share the same path. */
  async runOnce(): Promise<void> {
    if (!this._consent.isEnabled()) {
      this._state = 'disabled';
      return;
    }
    if (this._inFlight) return;
    if (this._state === 'backoff' && Date.now() < this._nextAttemptAt) return;

    // Claim the in-flight guard synchronously, before the first await, so an
    // immediate runOnce() (e.g. on POST enable) and an interval tick can never
    // both pass the guard and submit two deposits.
    this._inFlight = true;
    try {
      let loose: bigint;
      let deposited: bigint;
      let creditLimit: bigint;
      try {
        [loose, deposited, creditLimit, this._delegated] = await Promise.all([
          this._reader.looseUsdc(),
          this._reader.totalDeposited(),
          this._reader.creditLimit(),
          this._reader.isDelegated(),
        ]);
      } catch (err) {
        this._enterBackoff(err);
        return;
      }
      this._loose = loose;
      this._creditLimit = creditLimit;
      this._deposited = deposited;

      // Circuit breaker: stay paused on a deterministic failure until inputs change
      // in a way worth retrying. A loose DECREASE is just the failed op's own gas
      // burn (a mined revert still pays USDC gas); retrying would burn more, so
      // only a loose INCREASE (new funds) or a credit-limit/deposited change reopens it.
      if (
        this._state === 'needs_attention' &&
        this._attentionSnapshot &&
        loose <= this._attentionSnapshot.loose &&
        this._attentionSnapshot.creditLimit === creditLimit &&
        this._attentionSnapshot.deposited === deposited
      ) {
        return;
      }

      const { deposit, stranded } = planDeposit({
        loose,
        reserve: this._gasReserve,
        creditLimit,
        deposited,
        minDeposit: this._minDeposit,
        dustFloor: this._dustFloor,
      });
      this._stranded = stranded;

      if (deposit === 0n) {
        this._state = stranded > 0n ? 'stranded' : 'idle';
        return;
      }

      this._state = 'pending';
      debugLog(`[AutoDeposit] depositing ${deposit} (loose=${loose}, stranded=${stranded})`);
      try {
        const { txHash } = await this._executor.deposit(deposit);
        this._lastDeposit = { txHash, amountBaseUnits: deposit.toString(), at: new Date().toISOString() };
        this._lastError = null;
        this._backoffMs = this._backoffBaseMs;
        this._attentionSnapshot = null;
        this._state = stranded > 0n ? 'stranded' : 'idle';
        debugLog(`[AutoDeposit] deposited ${deposit} (tx ${txHash})`);
      } catch (err) {
        if (isDeterministicError(err)) {
          this._attentionSnapshot = { loose, creditLimit, deposited };
          this._lastError = errorMessage(err);
          this._state = 'needs_attention';
          debugWarn(`[AutoDeposit] needs attention (paused until inputs change): ${this._lastError}`);
          this._onAttention?.(this._lastError);
        } else {
          this._enterBackoff(err);
        }
      }
    } finally {
      this._inFlight = false;
    }
  }

  private _enterBackoff(err: unknown): void {
    this._lastError = errorMessage(err);
    this._nextAttemptAt = Date.now() + this._backoffMs;
    debugWarn(`[AutoDeposit] transient failure, backing off ${this._backoffMs}ms: ${this._lastError}`);
    this._backoffMs = Math.min(this._backoffMs * 2, this._backoffMaxMs);
    this._state = 'backoff';
  }
}
