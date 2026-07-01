import type { FastifyInstance, FastifyReply } from 'fastify';
import { getAddress } from 'ethers';
import type { QuoteResult, RejectCode, TopupOutcome, TopupService } from './service.js';
import type { TopupRow } from './store.js';
import { parsePaymentHeader, validatePaymentPayload, type X402PaymentPayload } from './x402.js';

export interface RouteHealthInfo {
  chainId: string;
  network: string;
  asset: string;
  facilitator: string;
  depositsContractAddress: string;
  relayer: string;
}

const REJECT_STATUS: Record<RejectCode, number> = {
  invalid_request: 400,
  wrong_network: 400,
  wrong_recipient: 400,
  invalid_signature: 400,
  authorization_expired: 400,
  authorization_not_yet_valid: 400,
  amount_mismatch: 400,
  buyer_mismatch: 400,
  amount_too_low: 400,
  amount_too_high: 400,
  authorization_reused: 409,
  credit_limit_reached: 409,
};

function publicRow(row: TopupRow): Record<string, unknown> {
  // Never expose the signature: until settled it is a bearer instrument that
  // anyone with a Meridian organization could redirect to their own recipient.
  return {
    topupId: row.id,
    state: row.state,
    buyer: row.buyer,
    payer: row.payer,
    network: row.network,
    grossAmount: row.grossAmount,
    netAmount: row.netAmount,
    settlementTx: row.settleTx,
    depositTx: row.depositTx,
    refundTx: row.refundTx,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function sendReject(
  reply: FastifyReply,
  code: RejectCode,
  message: string,
  details?: Record<string, string>,
): FastifyReply {
  return reply.status(REJECT_STATUS[code]).send({
    success: false,
    errorReason: code,
    error: message,
    ...(details ?? {}),
  });
}

function paymentChallenge(
  reply: FastifyReply,
  quote: Extract<QuoteResult, { ok: true }>,
  buyer: string,
  error: string,
): FastifyReply {
  return reply.status(402).send({
    x402Version: 1,
    error,
    accepts: [quote.requirements],
    topup: {
      buyer,
      amount: quote.amount.toString(),
      minAmount: quote.minTopup.toString(),
      maxAmount: quote.maxTopup.toString(),
      note: 'The credited deposit is the settled amount net of Meridian facilitator fees.',
    },
  });
}

async function sendOutcome(
  reply: FastifyReply,
  service: TopupService,
  outcome: TopupOutcome,
  buyer: string,
  amount: bigint | undefined,
): Promise<FastifyReply> {
  switch (outcome.kind) {
    case 'deposited': {
      const row = outcome.row;
      const settleResponse = Buffer.from(
        JSON.stringify({ success: true, transaction: row.settleTx, network: row.network, payer: row.payer }),
      ).toString('base64');
      return reply
        .status(200)
        .header('X-PAYMENT-RESPONSE', settleResponse)
        .send({ success: true, ...publicRow(row) });
    }
    case 'refunded':
      return reply.status(409).send({
        ...publicRow(outcome.row),
        success: false,
        errorReason: 'deposit_failed',
        error: outcome.row.error ?? 'Deposit could not be credited; the settled amount was refunded to the payer',
      });
    case 'pending':
      return reply
        .status(503)
        .header('Retry-After', '5')
        .send({ ...publicRow(outcome.row), success: false, errorReason: 'pending', error: outcome.message });
    case 'rejected':
      return sendReject(reply, outcome.code, outcome.message, outcome.details);
    case 'failed': {
      if (outcome.code === 'settlement_failed') {
        // Offer a fresh challenge so x402 clients can retry with a new payment.
        const quote = await service.quote(buyer, amount).catch(() => null);
        return reply.status(402).send({
          ...publicRow(outcome.row),
          x402Version: 1,
          error: `Settlement failed: ${outcome.message}`,
          accepts: quote?.ok ? [quote.requirements] : [],
        });
      }
      return reply.status(500).send({
        ...publicRow(outcome.row),
        success: false,
        errorReason: outcome.code,
        error: outcome.message,
      });
    }
  }
}

export function registerRoutes(
  fastify: FastifyInstance,
  ctx: { service: TopupService; health: RouteHealthInfo },
): void {
  const { service } = ctx;

  fastify.post('/v1/topup', async (request, reply) => {
    const body = (request.body ?? {}) as { buyer?: string; amount?: string; paymentPayload?: unknown };

    let payload: X402PaymentPayload | null = null;
    try {
      const header = request.headers['x-payment'];
      if (typeof header === 'string' && header.length > 0) {
        payload = parsePaymentHeader(header);
      } else if (body.paymentPayload !== undefined) {
        payload = validatePaymentPayload(body.paymentPayload);
      }
    } catch (err) {
      return sendReject(reply, 'invalid_request', err instanceof Error ? err.message : String(err));
    }

    let buyer: string;
    try {
      buyer = getAddress((body.buyer ?? payload?.payload.authorization.from ?? '').trim());
    } catch {
      return sendReject(reply, 'invalid_request', 'body.buyer must be a valid address (defaults to the payer)');
    }

    let amount: bigint | undefined;
    if (body.amount !== undefined) {
      if (typeof body.amount !== 'string' || !/^\d+$/.test(body.amount)) {
        return sendReject(reply, 'invalid_request', 'body.amount must be a USDC base-unit decimal string');
      }
      amount = BigInt(body.amount);
    }

    if (!payload) {
      const quote = await service.quote(buyer, amount);
      if (!quote.ok) return sendReject(reply, quote.code, quote.message, quote.details);
      return paymentChallenge(reply, quote, buyer, 'X-PAYMENT header required');
    }

    const outcome = await service.submitPayment({ payload, buyer, requestedAmount: amount });
    return sendOutcome(reply, service, outcome, buyer, amount);
  });

  fastify.get('/v1/topup/quote', async (request, reply) => {
    const query = request.query as { buyer?: string; amount?: string };
    let buyer: string;
    try {
      buyer = getAddress((query.buyer ?? '').trim());
    } catch {
      return sendReject(reply, 'invalid_request', 'query.buyer must be a valid address');
    }
    let amount: bigint | undefined;
    if (query.amount !== undefined) {
      if (!/^\d+$/.test(query.amount)) {
        return sendReject(reply, 'invalid_request', 'query.amount must be a USDC base-unit decimal string');
      }
      amount = BigInt(query.amount);
    }
    const quote = await service.quote(buyer, amount);
    if (!quote.ok) return sendReject(reply, quote.code, quote.message, quote.details);
    return {
      buyer,
      amount: quote.amount.toString(),
      minAmount: quote.minTopup.toString(),
      maxAmount: quote.maxTopup.toString(),
      balance: quote.headroom.balanceTotal.toString(),
      creditLimit: quote.headroom.creditLimit.toString(),
      headroom: quote.headroom.headroom.toString(),
      minBuyerDeposit: quote.headroom.minBuyerDeposit.toString(),
      requirements: quote.requirements,
    };
  });

  fastify.get('/v1/topup/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = service.getTopup(id);
    if (!row) return reply.status(404).send({ success: false, errorReason: 'not_found', error: 'Unknown top-up id' });
    return publicRow(row);
  });

  fastify.get('/healthz', async () => ({ ok: true, ...ctx.health }));
}
