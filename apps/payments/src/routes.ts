import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import { DepositsClient, formatUsdc, parseUsdc, type ChainConfig } from '@antseed/node';

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  cryptoConfig: PaymentCryptoConfig;
  chainConfig: ChainConfig;
}

// Use shared utilities from @antseed/node
const formatUsdc6 = formatUsdc;
const parseUsdc6 = parseUsdc;

function createClient(config: PaymentCryptoConfig): DepositsClient {
  return new DepositsClient({
    rpcUrl: config.rpcUrl,
    contractAddress: config.depositsContractAddress,
    usdcAddress: config.usdcContractAddress,
  });
}

export function registerRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  // Shared deposits client — reused across requests (stateless, only holds RPC URL + ABI)
  let depositsClient: DepositsClient | null = null;
  function getClient(): DepositsClient | null {
    if (!depositsClient) depositsClient = createClient(ctx.cryptoConfig);
    return depositsClient;
  }

  fastify.get('/api/balance', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — run antseed init' });
    }

    try {
      const client = getClient()!;

      const [balance, creditLimit] = await Promise.all([
        client.getBuyerBalance(ctx.cryptoCtx.evmAddress),
        client.getBuyerCreditLimit(ctx.cryptoCtx.evmAddress),
      ]);

      return {
        evmAddress: ctx.cryptoCtx.evmAddress,
        available: formatUsdc6(balance.available),
        reserved: formatUsdc6(balance.reserved),
        total: formatUsdc6(balance.available + balance.reserved),
        pendingWithdrawal: formatUsdc6(balance.pendingWithdrawal),
        creditLimit: formatUsdc6(creditLimit),
      };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/config', async () => {
    return {
      chainId: ctx.chainConfig.chainId,
      evmChainId: ctx.chainConfig.evmChainId,
      rpcUrl: ctx.cryptoConfig.rpcUrl,
      depositsContractAddress: ctx.cryptoConfig.depositsContractAddress,
      usdcContractAddress: ctx.cryptoConfig.usdcContractAddress,
      evmAddress: ctx.cryptoCtx?.evmAddress ?? null,
    };
  });

  fastify.get('/api/transactions', async () => {
    // TODO: Read deposit/withdrawal events from on-chain logs
    return { transactions: [] };
  });

  fastify.post('/api/withdraw/request', async (request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — run antseed init' });
    }

    const body = request.body as { amount?: string } | null;
    const amount = body?.amount;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return reply.status(400).send({ ok: false, error: 'Invalid amount' });
    }

    try {
      const baseUnits = parseUsdc6(amount);
      const client = getClient()!;
      const txHash = await client.requestWithdrawal(ctx.cryptoCtx.wallet, ctx.cryptoCtx.evmAddress, baseUnits);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post('/api/withdraw/execute', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — run antseed init' });
    }

    try {
      const client = getClient()!;
      const txHash = await client.executeWithdrawal(ctx.cryptoCtx.wallet, ctx.cryptoCtx.evmAddress);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post('/api/withdraw/cancel', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — run antseed init' });
    }

    try {
      const client = getClient()!;
      const txHash = await client.cancelWithdrawal(ctx.cryptoCtx.wallet, ctx.cryptoCtx.evmAddress);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
