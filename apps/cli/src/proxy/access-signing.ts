import type { BuyerPaymentManager, ChannelsClient, FlatFeeSigningConfig, PaymentMux } from '@antseed/node'
import { log } from './request-utils.js'

async function flushGap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

export interface AccessSigningOptions {
  serviceId: string
  resolveDiscoveredPriceUsdc: (sellerPeerId: string) => Promise<bigint | null>
  isEnabled?: () => boolean | Promise<boolean>
}

export interface AccessSigningNode {
  readonly buyerPaymentManager: BuyerPaymentManager | null
  readonly channelsClient: ChannelsClient | null
  getOrConnectPaymentMux(peerId: string): Promise<PaymentMux>
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_PREEMPTIVE_TOPUPS = 5
const RESERVE_DEADLINE_RENEWAL_MARGIN_MS = 5 * 60 * 1000

const TOPUP_POLL_INTERVAL_MS = 500
const TOPUP_CONFIRMATION_TIMEOUT_MS = 30_000

async function topUpAndReconcile(
  node: AccessSigningNode,
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
  buyer: BuyerPaymentManager,
  options: AccessSigningOptions,
  sellerPeerId: string,
): Promise<bigint> {
  const agreement = buyer.getAccessAgreement(sellerPeerId, options.serviceId)
  const agreedPrice = agreement ? BigInt(agreement.amountMicroUsdc) : null
  if (!agreement?.enabled || agreedPrice === null || agreedPrice < 0n) {
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
  if (discovered !== agreedPrice || agreement.durationSeconds !== 86_400) {
    buyer.pauseAccess(sellerPeerId, options.serviceId, 'terms_changed')
    throw new Error('BILLING_TERMS_CHANGED: review and accept the updated service terms')
  }
  return discovered
}

export function createSignAccessIfNeeded(
  node: AccessSigningNode,
  options: AccessSigningOptions,
): (sellerPeerId: string, request?: { purchase: boolean; signal?: AbortSignal }) => Promise<void> {
  const inFlight = new Map<string, Promise<void>>()
  const sign = async (sellerPeerId: string, request?: { purchase: boolean; signal?: AbortSignal }): Promise<void> => {
    request?.signal?.throwIfAborted()
    if (await options.isEnabled?.() === false) throw new Error('ROUTER_DISABLED')
    const buyer = node.buyerPaymentManager
    if (!buyer) throw new Error('Payments are not configured')
    if (!buyer.getAccessAgreement(sellerPeerId, options.serviceId)?.enabled) {
      throw new Error('BILLING_APPROVAL_REQUIRED: access purchases are not enabled')
    }
    const purchase = buyer.getAccessPurchase(sellerPeerId, options.serviceId)
    const active = purchase !== null && Date.now() < purchase.authorizedAtMs + purchase.durationSeconds * 1000
    const dailyAmountUsdc = active ? BigInt(purchase.amountMicroUsdc) : await resolveDailyAmountUsdc(buyer, options, sellerPeerId)
    const flatFeeConfig: FlatFeeSigningConfig = { dailyAmountUsdc, serviceId: options.serviceId }
    const paymentMux = await node.getOrConnectPaymentMux(sellerPeerId)

    let existingSession = buyer.getActiveSession(sellerPeerId)
    if (existingSession && node.channelsClient) {
      const onChainStatus = await buyer.reconcileOnChainChannelStatus(sellerPeerId, node.channelsClient, paymentMux)
      if (onChainStatus === 'retired') {
        log(`day-pass channel with routing peer ${sellerPeerId.slice(0, 12)}... was closed on-chain -- retired locally, opening a fresh one`)
        existingSession = buyer.getActiveSession(sellerPeerId)
      }
    }
    if (!existingSession) {
      log(`opening day-pass channel with routing peer ${sellerPeerId.slice(0, 12)}...`)
      request?.signal?.throwIfAborted()
      await buyer.authorizeSpending(sellerPeerId, paymentMux, 0n, dailyAmountUsdc)
      await flushGap()
      buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)
      return
    }

    buyer.configureFlatFeeSigning(sellerPeerId, flatFeeConfig)
    const currentCumulative = BigInt(existingSession.authMax || '0')
    const daysSinceLastSign = purchase ? Math.floor((Date.now() - purchase.authorizedAtMs) / MS_PER_DAY) : 0
    const trueTarget = currentCumulative + (active || request?.purchase === false ? 0n : dailyAmountUsdc)

    let ceiling = buyer.getReserveCeiling(sellerPeerId)
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
    if (await options.isEnabled?.() === false) throw new Error('ROUTER_DISABLED')
    const { payload, topUpNeeded } = await buyer.signCumulativeAuth(sellerPeerId, trueTarget, request?.signal)
    paymentMux.sendSpendingAuth(payload)
    log(`signed daily cumulative for ${sellerPeerId.slice(0, 12)}...: ${payload.cumulativeAmount}`)

    if (topUpNeeded) {
      await topUpAndReconcile(node, sellerPeerId, dailyAmountUsdc)
    }
  }
  return (sellerPeerId, request) => {
    const current = inFlight.get(sellerPeerId)
    const operation = (current ? current.catch(() => {}).then(() => sign(sellerPeerId, request)) : sign(sellerPeerId, request))
      .finally(() => { if (inFlight.get(sellerPeerId) === operation) inFlight.delete(sellerPeerId) })
    inFlight.set(sellerPeerId, operation)
    return operation
  }
}
