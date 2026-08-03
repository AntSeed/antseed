/**
 * Fault attribution for request failures.
 *
 * The buyer's dispatch path collapses almost every error into one catch, where
 * a dead seller looks exactly like a dead chain RPC, an empty wallet, or one of
 * our own state-machine bugs. Consumers that act on failures — cooling a peer
 * down, choosing a status code, deciding whether to retry elsewhere — need to
 * know whose fault it was, and a message string is not a contract.
 *
 * Errors carry that judgement from the site that raises them. Anything
 * untagged is `unknown`, and callers must treat `unknown` as "not proven to be
 * the peer's fault".
 */

export type FaultAttribution =
  /** Our own wallet, deposits, config, transport or state machine. */
  | 'buyer'
  /** The remote peer misbehaved or went away. */
  | 'peer'
  /** Genuinely ambiguous — most timeouts and dropped connections land here. */
  | 'unknown'

export type AntseedErrorCode =
  | 'node-not-started'
  | 'node-stopped'
  | 'invalid-request'
  | 'buyer-stream-limit'
  | 'buyer-budget-too-low'
  | 'buyer-reserve-misconfigured'
  | 'buyer-session-state'
  | 'buyer-deposits-insufficient'
  | 'buyer-transport-closed'
  | 'invalid-spending-auth-header'
  | 'chain-rpc-unavailable'
  | 'peer-not-authorized'
  | 'peer-protocol-violation'

export interface AntseedRequestErrorOptions {
  cause?: unknown
}

/** An error that knows whose fault it is. */
export class AntseedRequestError extends Error {
  readonly attribution: FaultAttribution
  readonly code: AntseedErrorCode

  constructor(
    message: string,
    code: AntseedErrorCode,
    attribution: FaultAttribution,
    options?: AntseedRequestErrorOptions,
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AntseedRequestError'
    this.code = code
    this.attribution = attribution
  }
}

/** Convenience constructor for the common "this one is on us" case. */
export function buyerFault(
  message: string,
  code: AntseedErrorCode,
  options?: AntseedRequestErrorOptions,
): AntseedRequestError {
  return new AntseedRequestError(message, code, 'buyer', options)
}

/** Convenience constructor for a proven peer fault. */
export function peerFault(
  message: string,
  code: AntseedErrorCode,
  options?: AntseedRequestErrorOptions,
): AntseedRequestError {
  return new AntseedRequestError(message, code, 'peer', options)
}

/**
 * Read the attribution off an error, following `cause` chains so a wrapped
 * error does not lose its verdict. Defaults to `unknown`, never to `peer` —
 * blaming a peer requires evidence.
 */
export function faultAttributionOf(err: unknown, depth = 0): FaultAttribution {
  if (depth > 5) return 'unknown'
  // Duck-typed rather than `instanceof AntseedRequestError`: other error
  // classes carry the same verdict (e.g. SellerAuthorizationError), and a
  // duplicated module instance would defeat a prototype check.
  const attribution = (err as { attribution?: unknown } | null)?.attribution
  if (attribution === 'buyer' || attribution === 'peer' || attribution === 'unknown') {
    return attribution
  }
  if (err instanceof Error && err.cause !== undefined && err.cause !== err) {
    return faultAttributionOf(err.cause, depth + 1)
  }
  return 'unknown'
}

/** Read the machine-readable code off an error, if it carries one. */
export function faultCodeOf(err: unknown, depth = 0): AntseedErrorCode | null {
  if (depth > 5) return null
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && ANTSEED_ERROR_CODES.has(code as AntseedErrorCode)) {
    return code as AntseedErrorCode
  }
  if (err instanceof Error && err.cause !== undefined && err.cause !== err) {
    return faultCodeOf(err.cause, depth + 1)
  }
  return null
}

/** Guards `faultCodeOf` against unrelated `code` fields, e.g. ethers' NETWORK_ERROR. */
const ANTSEED_ERROR_CODES: ReadonlySet<AntseedErrorCode> = new Set<AntseedErrorCode>([
  'node-not-started', 'node-stopped', 'invalid-request', 'buyer-stream-limit',
  'buyer-budget-too-low', 'buyer-reserve-misconfigured', 'buyer-session-state',
  'buyer-deposits-insufficient', 'buyer-transport-closed', 'invalid-spending-auth-header',
  'chain-rpc-unavailable', 'peer-not-authorized', 'peer-protocol-violation',
])
