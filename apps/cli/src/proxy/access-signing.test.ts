import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { Wallet } from 'ethers'
import { BuyerPaymentManager, ChannelStore } from '@antseed/node'
import type { BuyerPaymentConfig, ChannelsClient, Identity, PaymentMux, SpendingAuthPayload } from '@antseed/node'
import { createSignAccessIfNeeded, type AccessSigningNode } from './access-signing.js'

/**
 * Real BuyerPaymentManager throughout -- all the clamping/elapsed-day/
 * ceiling logic under test is genuine, not mocked. Only the network-facing
 * edges are faked: an unreachable RPC URL (getBalance()/deposit checks
 * degrade to a logged warning, confirmed by reading topUpReserve's own
 * try/catch -- never blocks), a scripted PaymentMux that just records what
 * was sent instead of transmitting it, and a scripted ChannelsClient whose
 * getSession() reports a controlled "on-chain deposit" this test drives
 * directly, standing in for a real seller's topUp()/reserve() landing.
 */

const SERVICE_ID = 'example-access'
const DAILY_AMOUNT = 10_000n // matches other test suites' convention
const SELLER_PEER_ID = 'cc'.repeat(20)
const DAY_MS = 24 * 60 * 60 * 1000

function createTestIdentity(): Identity {
  const privateKeyBytes = randomBytes(32)
  const privateKey = ('0x' + Buffer.from(privateKeyBytes).toString('hex')) as `0x${string}`
  const wallet = new Wallet(privateKey)
  const peerId = wallet.address.slice(2).toLowerCase()
  return { peerId, privateKey: privateKeyBytes, wallet } as unknown as Identity
}

function makeBuyerConfig(dataDir: string, maxReserveAmountUsdc: bigint): BuyerPaymentConfig {
  return {
    rpcUrl: 'http://127.0.0.1:1', // deliberately unreachable -- see file header comment
    depositsContractAddress: '0x' + 'dd'.repeat(20),
    channelsContractAddress: '0x' + 'cc'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'ff'.repeat(20),
    chainId: 31337,
    defaultAuthDurationSecs: 3600,
    maxPerRequestUsdc: 500_000n,
    maxReserveAmountUsdc,
    dataDir,
  }
}

/** Records every SpendingAuth sent -- the only PaymentMux method this module calls. */
function createRecordingMux(): PaymentMux & { sent: SpendingAuthPayload[] } {
  const sent: SpendingAuthPayload[] = []
  const mux = {
    sent,
    sendSpendingAuth: (payload: SpendingAuthPayload) => { sent.push(payload) },
  }
  return mux as unknown as PaymentMux & { sent: SpendingAuthPayload[] }
}

/**
 * Scripted on-chain deposit, standing in for a real seller's reserve()/
 * topUp() landing. `bumpTo` simulates the seller's transaction confirming;
 * `bumpAfterOneRead` simulates a real confirmation delay (one poll cycle)
 * to prove topUpAndReconcile's polling retry actually retries.
 */
function createScriptedChannelsClient(initialDeposit: bigint) {
  let deposit = initialDeposit
  let pendingBump: bigint | null = null
  let readsSincePendingBump = 0
  // status 1 = ACTIVE (classifyOnChainChannel) -- a genuinely existing,
  // active on-chain channel by default, since reconcileOnChainChannelStatus
  // now consults this on every signDailyIfNeeded call. buyer/seller must be
  // real-looking (non-zero-address) too, or classifyOnChainChannel reads the
  // channel as not existing at all regardless of `status`.
  let status = 1
  const client = {
    getSession: async (_id: string) => {
      if (pendingBump !== null) {
        readsSincePendingBump += 1
        if (readsSincePendingBump > 1) {
          deposit = pendingBump
          pendingBump = null
        }
      }
      return {
        buyer: '0x' + '11'.repeat(20),
        seller: '0x' + '22'.repeat(20),
        deposit,
        settled: 0n,
        metadataHash: '0x0',
        deadline: 0n,
        settledAt: 0n,
        closeRequestedAt: 0n,
        status,
      }
    },
  }
  return {
    client: client as unknown as ChannelsClient,
    bumpTo: (value: bigint) => { deposit = value },
    bumpAfterOneRead: (value: bigint) => { pendingBump = value; readsSincePendingBump = 0 },
    /** Simulate the channel being cooperatively/seller closed on-chain (status 2 = SETTLED). */
    settleOnChain: () => { status = 2 },
    /** Simulate a freshly-opened channel reading back as genuinely active on-chain (e.g. after a rebootstrap). */
    reactivate: () => { status = 1 },
  }
}

async function withBuyer(
  maxReserveAmountUsdc: bigint,
  fn: (ctx: { buyer: BuyerPaymentManager; store: ChannelStore; identity: Identity }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-daily-signing-'))
  const store = new ChannelStore(dir)
  const identity = createTestIdentity()
  const buyer = new BuyerPaymentManager(identity, makeBuyerConfig(dir, maxReserveAmountUsdc), store)
  buyer.setSigner(identity.wallet)
  buyer.acceptAccessTerms(SELLER_PEER_ID, SERVICE_ID, { amountMicroUsdc: DAILY_AMOUNT.toString(), durationSeconds: 86_400 })
  // topUpReserve now deliberately verifies real buyer deposits before
  // signing a top-up (see its own doc comment: a real incident during a
  // chain-RPC outage let unverified top-ups stack days of fee on a stale
  // ceiling) -- that read hits the same deliberately-unreachable RPC URL
  // this file's header comment already accounts for everywhere else, so it
  // needs the same treatment: stubbed to report ample funds, restoring this
  // suite's original "network-facing edges are faked" design rather than
  // actually reaching the network for a balance check unrelated to what
  // these tests exercise.
  buyer.getBalance = async () => ({ available: maxReserveAmountUsdc * 10n, reserved: 0n })
  try {
    await fn({ buyer, store, identity })
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('bootstrap: first call only reserves (no charge yet); the response-triggered second call signs day 1 and tops up to prepare tomorrow', async () => {
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: AccessSigningNode = {
      buyerPaymentManager: buyer,
      channelsClient: scripted.client,
      getOrConnectPaymentMux: async () => mux,
    }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    // Call 1 (reacting to the seller's "no session" 402): reserve only.
    // Day 1's real charge must not be signed before the buyer has ever been
    // served a routing response. The scripted deposit stays at 0 through
    // this call -- authorizeSpending never reads the chain at all.
    await signDailyIfNeeded(SELLER_PEER_ID)
    assert.equal(mux.sent.length, 1, 'only the reserve proof went out -- nothing charged yet')
    assert.equal(BigInt(mux.sent[0]!.cumulativeAmount), 0n, 'reserve proof')
    // The reserve step (authorizeSpending) opened the channel sized to
    // exactly one day, not the buyer-wide default -- asserted directly
    // against what was actually sent (sent[0].reserveMaxAmount) rather than
    // session.initialReserveAmount, which this test found does not
    // round-trip through ChannelStore the way its own field doc implies (a
    // pre-existing BuyerPaymentManager/ChannelStore behavior, out of scope
    // for this module).
    assert.equal(mux.sent[0]!.reserveMaxAmount, DAILY_AMOUNT.toString())
    assert.equal(BigInt(buyer.getActiveSession(SELLER_PEER_ID)!.authMax), 0n, 'nothing owed on file yet')

    // Now that a session exists, call 2's own reconcileOnChainChannelStatus
    // check (which only runs once a session is already on file) will read
    // the chain once before signing -- match it to the real reserve exactly
    // (DAILY_AMOUNT), not something inflated, or it would reconcile the
    // local ceiling to a value the topUpNeeded threshold check below was
    // never meant to see. bumpAfterOneRead then raises it for the second
    // read, which is topUpAndReconcile's own confirmation poll after day
    // 1's signature triggers the real top-up -- keeping that poll's
    // confirmation instant, same as this suite's other tests.
    scripted.bumpTo(DAILY_AMOUNT)
    scripted.bumpAfterOneRead(DAILY_AMOUNT * 2n)

    // Call 2 (reacting to the seller's renewalDue flag on that first served
    // response): the real day-1 signature, plus the "prepare tomorrow"
    // top-up now that day 1's ceiling is fully consumed.
    await signDailyIfNeeded(SELLER_PEER_ID)
    const afterBootstrap = mux.sent.slice(1)
    assert.equal(afterBootstrap.length, 2)
    assert.equal(BigInt(afterBootstrap[0]!.cumulativeAmount), DAILY_AMOUNT, 'day 1 real signature')
    assert.ok(afterBootstrap[1]!.reserveMaxAmount, 'the top-up carries reserve fields')

    const session = buyer.getActiveSession(SELLER_PEER_ID)
    assert.ok(session, 'a session now exists')
    assert.equal(BigInt(session!.authMax), DAILY_AMOUNT)
  })
})

for (const scenario of [
  { name: 'missing approval', agreed: null, discovered: DAILY_AMOUNT, error: 'BILLING_APPROVAL_REQUIRED' },
  { name: 'missing discovery', agreed: DAILY_AMOUNT, discovered: null, error: 'PRICING_UNAVAILABLE' },
  { name: 'failed discovery', agreed: DAILY_AMOUNT, discovered: DAILY_AMOUNT, throws: true, error: 'PRICING_UNAVAILABLE' },
  { name: 'price increase', agreed: DAILY_AMOUNT, discovered: DAILY_AMOUNT + 1n, error: 'BILLING_TERMS_CHANGED' },
  { name: 'price decrease', agreed: DAILY_AMOUNT, discovered: DAILY_AMOUNT - 1n, error: 'BILLING_TERMS_CHANGED' },
  { name: 'negative price', agreed: DAILY_AMOUNT, discovered: -1n, error: 'PRICING_UNAVAILABLE' },
]) {
  test(`pricing fails closed before reserve or signing: ${scenario.name}`, async () => {
    await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
      const mux = createRecordingMux()
      const scripted = createScriptedChannelsClient(0n)
      const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
      const sign = createSignAccessIfNeeded(node, {
        serviceId: SERVICE_ID,
        resolveDiscoveredPriceUsdc: async () => {
          if (scenario.throws) throw new Error('discovery failed')
          return scenario.discovered
        },
      })
      if (scenario.agreed === null) buyer.pauseAccess(SELLER_PEER_ID, SERVICE_ID)
      await assert.rejects(sign(SELLER_PEER_ID), new RegExp(scenario.error))
      assert.equal(mux.sent.length, 0)
      assert.equal(buyer.getActiveSession(SELLER_PEER_ID), null)
    })
  })
}

test('changed terms stay paused even if discovery returns the old price again', async () => {
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    let price = DAILY_AMOUNT + 1n
    const node: AccessSigningNode = {
      buyerPaymentManager: buyer, channelsClient: null,
      getOrConnectPaymentMux: async () => { throw new Error('must not connect') },
    }
    const sign = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => price })
    await assert.rejects(sign(SELLER_PEER_ID), /BILLING_TERMS_CHANGED/)
    price = DAILY_AMOUNT
    await assert.rejects(sign(SELLER_PEER_ID), /BILLING_APPROVAL_REQUIRED/)
    assert.equal(buyer.getAccessAgreement(SELLER_PEER_ID, SERVICE_ID)?.enabled, false)
  })
})

test('a reserve-only request cannot buy an expired access period', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    await buyer.authorizeSpending(SELLER_PEER_ID, mux, 0n, DAILY_AMOUNT * 5n)
    buyer.configureFlatFeeSigning(SELLER_PEER_ID, { dailyAmountUsdc: DAILY_AMOUNT, serviceId: SERVICE_ID })
    await buyer.signCumulativeAuth(SELLER_PEER_ID, DAILY_AMOUNT)
    const first = buyer.getAccessPurchase(SELLER_PEER_ID, SERVICE_ID)
    t.mock.timers.tick(DAY_MS * 2)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: null, getOrConnectPaymentMux: async () => mux }
    const sign = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })
    await sign(SELLER_PEER_ID, { purchase: false })
    assert.equal(buyer.getActiveSession(SELLER_PEER_ID)?.authMax, DAILY_AMOUNT.toString())
    assert.deepEqual(buyer.getAccessPurchase(SELLER_PEER_ID, SERVICE_ID), first)
  })
})

test('pausing an active pass prevents opening or topping up a payment channel', async () => {
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    await buyer.authorizeSpending(SELLER_PEER_ID, mux, 0n, DAILY_AMOUNT * 5n)
    buyer.configureFlatFeeSigning(SELLER_PEER_ID, { dailyAmountUsdc: DAILY_AMOUNT, serviceId: SERVICE_ID })
    await buyer.signCumulativeAuth(SELLER_PEER_ID, DAILY_AMOUNT)
    buyer.pauseAccess(SELLER_PEER_ID, SERVICE_ID)
    const node: AccessSigningNode = {
      buyerPaymentManager: buyer, channelsClient: null,
      getOrConnectPaymentMux: async () => { throw new Error('must not connect while paused') },
    }
    const sign = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })
    await assert.rejects(sign(SELLER_PEER_ID, { purchase: false }), /BILLING_APPROVAL_REQUIRED/)
    assert.equal(buyer.getActiveSession(SELLER_PEER_ID)?.authMax, DAILY_AMOUNT.toString())
  })
})

test('ordinary day: signs exactly one more day\'s increment, no top-up when there is comfortable headroom', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only
    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature
    const afterDay1 = mux.sent.length

    // Real elapsed time, not just an immediate second call -- BuyerPaymentManager
    // computes signCumulativeAuth's elapsed-day window from its own private
    // _lastFlatFeeSignedAt map (wall-clock Date.now(), not anything this
    // module can read or mutate directly), so genuinely advancing the fake
    // clock is the only correct way to simulate "a day later."
    t.mock.timers.tick(DAY_MS)

    await signDailyIfNeeded(SELLER_PEER_ID)

    const newAuths = mux.sent.slice(afterDay1)
    // A full day is well past this test's defaultAuthDurationSecs (3600s),
    // so the reserve deadline has genuinely lapsed by "the next day" even
    // though the ceiling itself has comfortable headroom -- the renewal
    // this now correctly triggers is a second, legitimate message
    // alongside the real day-2 sign, not a bug.
    const renewals = newAuths.filter((a) => a.reserveMaxAmount)
    const realSigns = newAuths.filter((a) => !a.reserveMaxAmount)
    assert.equal(renewals.length, 1, 'the lapsed reserve deadline is renewed once')
    assert.equal(realSigns.length, 1, 'ordinary day signs exactly once, no extra ceiling top-up round')
    assert.equal(BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT * 2n, 'exactly one more day, not a bonus day from calling twice')
  })
})

test('repeated same-day calls never ratchet authMax up, even across many retries with zero real usage', async (t) => {
  // Regression for a real bug found live on mainnet: a channel with
  // request_count=0/tokens_delivered=0 throughout (nothing ever actually
  // served) reached an $11.21 authMax purely from ~20 retries of
  // signDailyIfNeeded within about 30 minutes -- each retry's Math.max(1, ...)
  // elapsed-day floor let it grant itself another full day's increment on
  // top of the last, regardless of how little real time had passed. Root
  // cause and full narrative: buyer-payment-manager.ts's signCumulativeAuth.
  t.mock.timers.enable({ apis: ['Date'] })
  // Generous headroom (matches the "ordinary day" test above), and a scripted
  // deposit already at that headroom -- the point of this test is the
  // elapsed-day math, not top-up polling, so nothing here should ever need a
  // real top-up (real setTimeout is NOT mocked; only Date is).
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 10n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only
    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature
    const afterDay1 = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(BigInt(afterDay1.authMax), DAILY_AMOUNT)

    // No clock advance between calls -- the exact shape of the live failure:
    // many retries in quick succession, no real elapsed time, no usage.
    for (let i = 0; i < 20; i++) {
      await signDailyIfNeeded(SELLER_PEER_ID)
    }

    const finalSession = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(
      BigInt(finalSession.authMax), DAILY_AMOUNT,
      'authMax must not grow beyond one real day\'s worth no matter how many times this is retried on the same day',
    )
  })
})

test('catch-up: a multi-day gap tops up and signs exactly one more day, never the whole backlog at once', async (t) => {
  // Regression for a real live incident: a channel open under four hours
  // signed 3.54 (six days' worth) in a single call, because the old
  // catch-up design let one signature capture an unbounded backlog once a
  // channel survived long enough for a real multi-day gap to accumulate.
  // A day pass must be structurally incapable of charging more than
  // dailyAmountUsdc per calendar day, regardless of how large the real gap
  // is -- see signCumulativeAuth's own doc comment.
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    // Bootstrap's own top-up raises the ceiling by exactly one day's
    // increment (the fixed topUpReserve call, not the generic per-request
    // default) -- keep that step's confirmation instant.
    scripted.bumpTo(DAILY_AMOUNT * 2n)
    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only
    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature, plus a prepare-tomorrow top-up
    const ceilingAfterDay1 = buyer.getReserveCeiling(SELLER_PEER_ID)
    assert.equal(ceilingAfterDay1, DAILY_AMOUNT * 2n, 'day 1\'s own top-up raised the ceiling by exactly one day\'s increment, not the generic per-request default')

    // App closed for 9 more days -- toggle never switched off, nothing signed.
    t.mock.timers.tick(9 * DAY_MS)
    scripted.bumpTo(DAILY_AMOUNT * 100n)

    const beforeCatchUp = mux.sent.length
    await signDailyIfNeeded(SELLER_PEER_ID)
    const catchUpAuths = mux.sent.slice(beforeCatchUp)

    const realSigns = catchUpAuths.filter((a) => !a.reserveMaxAmount)
    assert.equal(realSigns.length, 1, 'exactly one real signature, not split or duplicated')
    assert.equal(
      BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT * 2n,
      'a 9-day gap still grants only ONE more day beyond day 1 -- the remaining 8 days are written off, not chased in a lump sum',
    )

    // The next tick, further along, catches up exactly one more day --
    // proving the backlog is recovered gradually (one day per cycle) when
    // real ticks keep happening, not permanently lost after the first catch-up.
    t.mock.timers.tick(DAY_MS)
    const beforeSecondTick = mux.sent.length
    await signDailyIfNeeded(SELLER_PEER_ID)
    const secondTickAuths = mux.sent.slice(beforeSecondTick).filter((a) => !a.reserveMaxAmount)
    assert.equal(secondTickAuths.length, 1)
    assert.equal(BigInt(secondTickAuths[0]!.cumulativeAmount), DAILY_AMOUNT * 3n, 'the next real day advances by exactly one more day again')
  })
})

test('on-chain settlement: a channel closed on-chain (local store still says active) is retired and re-bootstrapped', async (t) => {
  // Regression for a real bug found live: signDailyIfNeeded only ever
  // consulted the LOCAL store (getActiveSession), which still says ACTIVE
  // long after the channel was cooperatively closed on-chain -- it kept
  // signing fresh cumulative amounts into a dead channel forever, with no
  // self-heal, no matter how many retries.
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only
    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature
    const firstSessionId = buyer.getActiveSession(SELLER_PEER_ID)!.sessionId
    const sentBeforeClose = mux.sent.length

    // The seller settles/closes the channel on-chain (cooperative close,
    // seller-side close, or timeout) -- the local store still says ACTIVE
    // until the next on-chain reconcile notices.
    scripted.settleOnChain()

    await signDailyIfNeeded(SELLER_PEER_ID) // detects the closure, retires, rebootstraps: reserve only

    const rebootstrapped = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.notEqual(rebootstrapped.sessionId, firstSessionId, 'a fresh channel was bootstrapped, not the dead one reused')
    assert.equal(BigInt(rebootstrapped.authMax), 0n, 'the fresh channel starts at zero, like any ordinary bootstrap -- nothing signed yet')

    const newMessages = mux.sent.slice(sentBeforeClose)
    assert.ok(newMessages.length > 0, 'the rebootstrap actually sent something, not a silent no-op that leaves the buyer stuck')
    assert.equal(BigInt(newMessages[0]!.cumulativeAmount), 0n, 'the rebootstrap starts with a fresh reserve proof, like any ordinary bootstrap')

    // The scripted client's on-chain status is a single global flag, not
    // tied to a specific sessionId -- reactivate it before the next call, or
    // reconcileOnChainChannelStatus would see the OLD "settled" status again
    // and retire the just-rebootstrapped channel too, rather than signing
    // day 1 for it as a genuinely new buyer would experience.
    scripted.reactivate()
    await signDailyIfNeeded(SELLER_PEER_ID) // no real time has passed since the original day-1 sign

    const sessionRightAfterRebootstrap = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(sessionRightAfterRebootstrap.sessionId, rebootstrapped.sessionId, 'still the rebootstrapped channel, not another new one')
    // The elapsed-day clock is per-SELLER, not per-session -- it survives
    // the retirement above. The seller was already paid for today moments
    // ago via the now-closed channel, so the rebootstrapped channel must NOT
    // get an immediate second day-1 charge just because it's a fresh
    // session. Closing and reopening the channel must never be a lever for
    // extracting more than one day's charge per real 24h.
    assert.equal(BigInt(sessionRightAfterRebootstrap.authMax), 0n, 'no new charge yet -- this seller was already paid for today')

    t.mock.timers.tick(24 * 60 * 60 * 1000) // a real day genuinely passes
    await signDailyIfNeeded(SELLER_PEER_ID) // now the rebootstrapped channel's day-1 charge is due

    const session = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.equal(session.sessionId, rebootstrapped.sessionId, 'still the rebootstrapped channel, not another new one')
    assert.equal(BigInt(session.authMax), DAILY_AMOUNT, 'paid for day 1 once a real day has actually passed since the last real charge')
  })
})

test('reserve deadline renewal: an expired deadline with a healthy ceiling renews before signing, without re-charging the already-signed day', async (t) => {
  // Regression for a real bug found live on mainnet: the reserve ceiling and
  // its on-chain deadline are independent, and only the ceiling was checked
  // before signing. A channel with comfortable ceiling headroom but a
  // lapsed deadline never got the deadline refreshed at all -- signCumulativeAuth
  // has no notion of the reserve deadline, so it "succeeded" locally while
  // the seller could no longer settle the result. This must renew the
  // reserve WITHOUT re-charging the day that was already correctly signed.
  t.mock.timers.enable({ apis: ['Date'] })
  await withBuyer(DAILY_AMOUNT * 5n, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(DAILY_AMOUNT * 20n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only
    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature
    const sentAfterDay1 = mux.sent.length
    assert.equal(BigInt(buyer.getActiveSession(SELLER_PEER_ID)!.authMax), DAILY_AMOUNT)
    const ceilingAfterDay1 = buyer.getReserveCeiling(SELLER_PEER_ID)

    // Past the reserve's defaultAuthDurationSecs (3600s in this test config)
    // but nowhere near a full day -- the ceiling has 5x headroom, so the
    // pre-existing ceiling-only check would never trigger anything here.
    t.mock.timers.tick(2 * 60 * 60 * 1000) // 2 hours
    const sessionWithLapsedDeadline = buyer.getActiveSession(SELLER_PEER_ID)!
    assert.ok(
      sessionWithLapsedDeadline.deadline * 1000 <= Date.now(),
      'sanity: the reserve deadline has genuinely lapsed by now',
    )

    await signDailyIfNeeded(SELLER_PEER_ID)

    const newMessages = mux.sent.slice(sentAfterDay1)
    const renewalMessages = newMessages.filter((m) => m.reserveMaxAmount)
    const realSigns = newMessages.filter((m) => !m.reserveMaxAmount)

    assert.equal(renewalMessages.length, 1, 'exactly one reserve renewal went out')
    assert.equal(
      renewalMessages[0]!.reserveMaxAmount, ceilingAfterDay1.toString(),
      'the renewal keeps the ceiling unchanged -- only the deadline moves, this is not a top-up',
    )

    assert.equal(realSigns.length, 1, 'signCumulativeAuth still runs exactly once')
    assert.equal(
      BigInt(realSigns[0]!.cumulativeAmount), DAILY_AMOUNT,
      'still exactly one day\'s worth -- renewing the reserve must not re-charge or double-count the day already signed',
    )

    assert.ok(
      buyer.getActiveSession(SELLER_PEER_ID)!.deadline * 1000 > Date.now(),
      'the deadline is valid again after renewal',
    )
  })
})

test('topUpAndReconcile genuinely waits for on-chain confirmation before reconciling (does not reconcile to a stale deposit)', async () => {
  await withBuyer(DAILY_AMOUNT, async ({ buyer }) => {
    const mux = createRecordingMux()
    const scripted = createScriptedChannelsClient(0n)
    const node: AccessSigningNode = { buyerPaymentManager: buyer, channelsClient: scripted.client, getOrConnectPaymentMux: async () => mux }
    const signDailyIfNeeded = createSignAccessIfNeeded(node, { serviceId: SERVICE_ID, resolveDiscoveredPriceUsdc: async () => DAILY_AMOUNT })

    // Bootstrap's reserve alone never calls topUpAndReconcile -- only day
    // 1's real signature (below) does, once its own ceiling is fully
    // consumed. Nothing scripted yet; this call must not touch the chain at all.
    await signDailyIfNeeded(SELLER_PEER_ID) // bootstrap: reserve only

    // The first getSession() read during day 1's own "prepare tomorrow"
    // top-up will see the OLD deposit (bumpAfterOneRead delays the raise by
    // one read) -- proving the poll loop retries rather than reconciling
    // prematurely.
    scripted.bumpAfterOneRead(DAILY_AMOUNT * 2n)

    await signDailyIfNeeded(SELLER_PEER_ID) // real day-1 signature + prepare-tomorrow top-up

    const ceiling = buyer.getReserveCeiling(SELLER_PEER_ID)
    assert.ok(ceiling > DAILY_AMOUNT, 'ceiling was raised only after the polled read observed the real increase')
  })
})
