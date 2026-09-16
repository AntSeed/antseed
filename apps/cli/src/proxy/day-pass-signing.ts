/**
 * Host-side implementation of a `Router`'s `signDailyIfNeeded` callback --
 * the routing plugin never holds a BuyerPaymentManager or PaymentMux
 * reference directly (that would let plugin code, including third-party
 * routers, sign arbitrary messages), so the host builds and owns the
 * actual signing closure and hands it to whichever router requests one via
 * the optional `Router.configureDailySigning` capability.
 *
 * Handles three cases with a single real `BuyerPaymentManager`:
 *  - Bootstrap: no channel with this seller yet -- open one sized to
 *    exactly one day's charge, reserve only, and return. Signing day 1's
 *    real charge is deliberately NOT done here: it must happen after the
 *    seller serves this buyer's first routing response, same postpaid
 *    shape as every later day, not before it. The seller's day-pass gate
 *    flags that first response as owing (a reserved but never-charged
 *    channel), which triggers this function again -- that second call
 *    takes the `existingSession` branch below and signs the real day-1
 *    amount then.
 *  - Ordinary day (also covers day 1's actual signature): sign today's
 *    cumulative; top up for tomorrow if the ceiling is now past its 65%
 *    trigger.
 *  - Reconnect after a toggle-on gap: the ceiling was never topped up
 *    while the buyer was away, so it's raised by exactly one day's worth
 *    (and reconciled from a real on-chain read) BEFORE signing --
 *    signCumulativeAuth itself never grants more than one day per call
 *    regardless of how long the gap was (see its own doc comment), so
 *    however many days are actually owed get caught up one per cycle
 *    rather than all at once.
 */
import type { BuyerPaymentManager, ChannelsClient, FlatFeeSigningConfig, PaymentMux } from '@antseed/node'
import { log } from './request-utils.js'

/**
 * A signing cycle can fire two or more PaymentMux SpendingAuth sends close
 * together with no gap (e.g. a day's signCumulativeAuth immediately
 * followed by topUpReserve's next-day prepare, or bootstrap's own
 * authorizeSpending send followed shortly by the day-1 signature sent on
 * the NEXT cycle this triggers). sendSpendingAuth() is fire-and-forget --
 * no ack is awaited -- and there is no seller->buyer rejection signal on
 * the wire at all (payment:auth-rejected is a seller-local event only, per
 * node.ts), so a corrupted/dropped frame here fails silent: the seller
 * later logs "Invalid ReserveAuth signature: recovered=<garbage>
 * expected=<real address>" and the buyer has no idea anything went wrong
 * until a later request 402s. A higher-latency transport is more exposed to
 * this than loopback. A short flush gap between sends is a real, bounded
 * mitigation for an infrequent, per-seller operation -- not a fix for
 * whatever the underlying transport race actually is, which still needs a
 * real seller->buyer rejection signal and retry to be handled properly.
 */
async function flushGap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

export interface DayPassSigningOptions {
  serviceId?: string
  resolveDiscoveredPriceUsdc: (sellerPeerId: string) => Promise<bigint | null>
  resolveAgreedPriceUsdc: (sellerPeerId: string) => Promise<bigint | null>
  onPriceCappedChange?: (sellerPeerId: string, notice: { agreedUsdc: bigint; discoveredUsdc: bigint } | null) => void
  resolveLastFlatFeeSignedAtMs?: (sellerPeerId: string) => Promise<number | null>
  /**
   * Persists the moment a flat-fee cumulative signing attempt completed for
   * this seller (whether or not it actually granted a new day -- mirrors
   * `BuyerPaymentManager`'s own in-memory `_lastFlatFeeSignedAt`, which is
   * set unconditionally on every successful `signCumulativeAuth` call), so
   * `resolveLastFlatFeeSignedAtMs` above can restore it after a restart.
   */
  recordFlatFeeSignedAtMs?: (sellerPeerId: string, atMs: number) => Promise<void>
}

/**
 * The exact slice of `AntseedNode` this module actually uses -- narrower
 * than depending on the concrete class, so tests can supply a lightweight
 * object wrapping real `BuyerPaymentManager`/`ChannelsClient` instances
 * without needing a full P2P node stack. `AntseedNode` itself satisfies
 * this structurally; no adapter needed at the real call site.
 */
export interface DailySigningNode {
  readonly buyerPaymentManager: BuyerPaymentManager | null
  readonly channelsClient: ChannelsClient | null
  getOrConnectPaymentMux(peerId: string): Promise<PaymentMux>
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Bounds the preemptive top-up loop below -- normally needs at most one pass (a ceiling top-up or a deadline renewal), never a multi-day backlog. */
const MAX_PREEMPTIVE_TOPUPS = 5
/**
 * Renew the reserve deadline once less than this much validity remains, not
 * only once it has already lapsed -- a real signing cycle (this function
 * plus its own async work) takes nonzero time, and the whole point is to
 * never let signCumulativeAuth produce a signature the seller can no longer
 * settle by the time it lands.
 */
const RESERVE_DEADLINE_RENEWAL_MARGIN_MS = 5 * 60 * 1000

/**
 * How long, and how often, to poll for a top-up's on-chain confirmation
 * before giving up for this cycle (see topUpAndReconcile's own doc comment
 * for why polling is necessary at all here). Mirrors the poll/timeout shape
 * of `BuyerPaymentNegotiator._waitForLockConfirmation` (same file's sibling
 * concern -- waiting for a seller-side on-chain action to land -- though
 * that one polls a local ack flag; this one has no ack to poll, so it polls
 * the chain directly).
 */
const TOPUP_POLL_INTERVAL_MS = 500
const TOPUP_CONFIRMATION_TIMEOUT_MS = 30_000

/**
 * Raise the reserve ceiling and resync the client's cached copy from a real
 * on-chain read. Unlike the initial reserve, a top-up gets no dedicated
 * wire acknowledgement at all -- confirmed by reading
 * `BuyerPaymentManager.handleAuthAck`'s own comment: "top-ups remain
 * pending until an on-chain session read observes their ceiling." So this
 * polls the real chain for the seller's `topUp()` to land before
 * reconciling; reading immediately after sending would very likely
 * observe the pre-top-up deposit and reconcile to a stale value, leaving
 * the client's cached ceiling exactly as wrong as if reconcile were never
 * called. A timeout without confirmation is not fatal -- the next signing
 * cycle sees the ceiling still exhausted and retries the whole sequence.
 */
async function topUpAndReconcile(
  node: DailySigningNode,
  sellerPeerId: string,
  incrementUsdc: bigint,
): Promise<void> {
  const buyer = node.buyerPaymentManager
  const channelsClient = node.channelsClient
  if (!buyer) return
  const session = buyer.getActiveSession(sellerPeerId)
  if (!session) return
  const ceilingBeforeTopUp = buyer.getReserveCeiling(sellerPeerId)

  const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)
  // The day pass's own daily amount, never BuyerPaymentManager's generic
  // per-request reserve default -- omitting the increment here would
  // silently substitute that default, letting the ceiling balloon to the
  // wrong amount and making an over-large signCumulativeAuth call
  // signable. See buyer-payment-manager.ts's topUpReserve doc comment.
  //
  // Best-effort, like every other caller of topUpReserve (see its own doc
  // comment: it deliberately throws on a failed deposit-verification read,
  // to stop an RPC outage from stacking a fresh top-up on the same stale
  // ceiling on every retry). This caller has the same "next natural
  // trigger retries" property that doc comment assumes -- signDailyIfNeeded
  // runs again on the next real prompt -- so swallowing here is exactly as
  // safe as the caller that comment already accounts for.
  try {
    await buyer.topUpReserve(sellerPeerId, paymentMux, incrementUsdc)
  } catch (err) {
    log(`top-up failed for ${sellerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err} -- will retry on the next signing cycle`)
    return
  }

  if (!channelsClient) {
    log(`no channelsClient available -- cannot confirm or reconcile the top-up for ${sellerPeerId.slice(0, 12)}...`)
    return
  }
  const deadline = Date.now() + TOPUP_CONFIRMATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const onChain = await channelsClient.getSession(session.sessionId)
    if (onChain.deposit > ceilingBeforeTopUp) {
      await buyer.reconcileReserveAmount(sellerPeerId, onChain.deposit)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, TOPUP_POLL_INTERVAL_MS))
  }
  log(`top-up confirmation timed out for ${sellerPeerId.slice(0, 12)}... -- will retry on the next signing cycle`)
}

async function resolveDailyAmountUsdc(
  options: DayPassSigningOptions,
  sellerPeerId: string,
): Promise<bigint> {
  const agreedPrice = await options.resolveAgreedPriceUsdc(sellerPeerId)
  if (agreedPrice === null || agreedPrice < 0n) {
    throw new Error('BILLING_APPROVAL_REQUIRED: accept the service terms before purchasing access')
  }
  let discovered: bigint | null
  try {
    discovered = await options.resolveDiscoveredPriceUsdc(sellerPeerId)
  } catch {
    throw new Error('PRICING_UNAVAILABLE: cannot verify current access pricing')
  }
  if (discovered === null || discovered < 0n) {
    throw new Error('PRICING_UNAVAILABLE: cannot verify current access pricing')
  }
  if (discovered !== agreedPrice) {
    options.onPriceCappedChange?.(sellerPeerId, { agreedUsdc: agreedPrice, discoveredUsdc: discovered })
    throw new Error('BILLING_TERMS_CHANGED: review and accept the updated service terms')
  }
  options.onPriceCappedChange?.(sellerPeerId, null)
  return discovered
}

/**
 * Builds a `signDailyIfNeeded(sellerPeerId)` closure for a real running
 * buyer process. Generic across any router that needs day-pass-style
 * daily signing, not specific to any one router package -- `node` is a real
 * `AntseedNode`, already started, with payments configured.
 */
export function createSignDailyIfNeeded(
  node: DailySigningNode,
  options: DayPassSigningOptions,
): (sellerPeerId: string) => Promise<void> {
  // Seeded at most once per seller per process -- seedFlatFeeSignedAt is
  // itself idempotent (never overwrites), but this avoids a redundant disk
  // read on every single call once a real signature has already happened
  // this run.
  const flatFeeSeededSellers = new Set<string>()
  return async function signDailyIfNeeded(sellerPeerId: string): Promise<void> {
    // Resolved once per cycle, not per call site below -- every amount used
    // in this one signing pass (bootstrap reserve, the day's signature, any
    // top-up) must agree, or a mid-cycle price change could size the
    // reserve for one amount and sign a different one.
    const dailyAmountUsdc = await resolveDailyAmountUsdc(options, sellerPeerId)
    const flatFeeConfig: FlatFeeSigningConfig = {
      dailyAmountUsdc,
      serviceId: options.serviceId,
    }
    const buyer = node.buyerPaymentManager
    if (!buyer) {
      log('daily signing skipped: payments are not configured on this node')
      return
    }
    if (options.resolveLastFlatFeeSignedAtMs && !flatFeeSeededSellers.has(sellerPeerId)) {
      flatFeeSeededSellers.add(sellerPeerId)
      const persistedSignedAtMs = await options.resolveLastFlatFeeSignedAtMs(sellerPeerId)
      if (persistedSignedAtMs != null) buyer.seedFlatFeeSignedAt(sellerPeerId, persistedSignedAtMs)
    }
    const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)

    let existingSession = buyer.getActiveSession(sellerPeerId)
    if (existingSession && node.channelsClient) {
      // The local store can say ACTIVE long after the channel was
      // cooperatively closed, settled, or timed out on-chain -- checked
      // before ever signing into it, or a dead channel gets signed into
      // forever with no self-heal.
      const onChainStatus = await buyer.reconcileOnChainChannelStatus(sellerPeerId, node.channelsClient, paymentMux)
      if (onChainStatus === 'retired') {
        log(`day-pass channel with routing peer ${sellerPeerId.slice(0, 12)}... was closed on-chain -- retired locally, opening a fresh one`)
        existingSession = buyer.getActiveSession(sellerPeerId)
      }
    }
    if (!existingSession) {
      // Bootstrap: reserve exactly one day's charge, not maxed at
      // FIRST_SIGN_CAP -- settling 100% of a one-day deposit clears the 85%
      // top-up gate after a single day instead of two.
      //
      // Reserve only -- do NOT sign the real day-1 charge here. This must
      // mirror ordinary per-request metered billing's own shape exactly:
      // open capacity, let the seller serve the response, sign what's owed
      // AFTER. A real charge landing before any response is served is
      // pay-first, not postpaid, no matter how quickly it happens.
      // day-pass-gate.ts's checkRenewalGate flags renewalDue for a
      // just-reserved-but-never-charged channel (authMax === '0')
      // regardless of freshness, precisely so the seller's very next
      // response after this reserve still asks for day 1 -- this function
      // gets called again for that, taking the `existingSession` branch
      // below, which signs the real amount then.
      log(`opening day-pass channel with routing peer ${sellerPeerId.slice(0, 12)}...`)
      await buyer.authorizeSpending(sellerPeerId, paymentMux, 0n, dailyAmountUsdc)
      await flushGap()
      buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)
      return
    }

    buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)

    // Predict whether the upcoming sign would be ceiling-clamped below
    // what's genuinely owed, using the SAME elapsed-day math
    // signCumulativeAuth applies internally: session.updatedAt mirrors its
    // private _lastFlatFeeSignedAt (confirmed by reading
    // buyer-payment-manager.ts -- both are set together, unconditionally,
    // at the end of every successful signCumulativeAuth call). This can't
    // be decided from topUpNeeded (the POST-sign 65%-threshold flag)
    // instead: signing first, when the ceiling is already exhausted from a
    // prior gap, would still "succeed" as a same-tick no-op that silently
    // resets the elapsed-day clock without ever capturing that one day's
    // charge -- the ceiling needs raising BEFORE that one real sign, not
    // after.
    const currentCumulative = BigInt(existingSession.authMax || '0')
    // Purely informational -- logged below so a long real gap is visible,
    // but never used to size a target or an increment. signCumulativeAuth
    // hard-caps a single call to at most one more day's charge regardless
    // of how many calendar days have actually elapsed (see its own doc
    // comment for why), so the preemptive top-up below only ever needs to
    // cover one more day, never a multi-day backlog.
    const daysSinceLastSign = Math.floor((Date.now() - existingSession.updatedAt) / MS_PER_DAY)
    const trueTarget = currentCumulative + dailyAmountUsdc

    let ceiling = buyer.getReserveCeiling(sellerPeerId)
    // The ceiling and the reserve's on-chain deadline are independent -- the
    // ceiling can be perfectly sufficient (no top-up ever triggered by the
    // check below) while the deadline covering it has quietly lapsed, since
    // nothing else refreshes the deadline for a channel with no other
    // per-request activity. signCumulativeAuth has no notion of this at all,
    // so left unchecked it "succeeds" locally while the seller can no longer
    // settle the result.
    let reserveDeadlineExpiring = typeof existingSession.deadline === 'number'
      && existingSession.deadline * 1000 <= Date.now() + RESERVE_DEADLINE_RENEWAL_MARGIN_MS
    let preemptiveTopUps = 0
    while ((trueTarget > ceiling || reserveDeadlineExpiring) && preemptiveTopUps < MAX_PREEMPTIVE_TOPUPS) {
      if (reserveDeadlineExpiring) {
        log(`reserve deadline for ${sellerPeerId.slice(0, 12)}... has lapsed or is about to -- renewing before signing`)
        await buyer.renewReserveDeadline(sellerPeerId, paymentMux)
        reserveDeadlineExpiring = false
      } else {
        log(`ceiling too low to cover one more day for ${sellerPeerId.slice(0, 12)}... (need ${trueTarget}, have ${ceiling}, ${daysSinceLastSign} day(s) since last sign) -- topping up before signing`)
        await topUpAndReconcile(node, sellerPeerId, dailyAmountUsdc)
      }
      ceiling = buyer.getReserveCeiling(sellerPeerId)
      preemptiveTopUps += 1
    }

    // Request exactly one more day than what's already on file --
    // signCumulativeAuth would clamp to this anyway even if asked for more
    // (see its own doc comment), but asking honestly for what's actually
    // wanted beats relying on a downstream clamp to hide a wrong request.
    const { payload, topUpNeeded } = await buyer.signCumulativeAuth(sellerPeerId, trueTarget)
    paymentMux.sendSpendingAuth(payload)
    log(`signed daily cumulative for ${sellerPeerId.slice(0, 12)}...: ${payload.cumulativeAmount}`)
    await options.recordFlatFeeSignedAtMs?.(sellerPeerId, Date.now())

    if (topUpNeeded) {
      // Prepare for next time -- not a re-sign; today's cumulative is
      // already on file above.
      await topUpAndReconcile(node, sellerPeerId, dailyAmountUsdc)
    }
  }
}
