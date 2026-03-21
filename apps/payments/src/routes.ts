import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import { BaseEscrowClient, type ChainConfig } from '@antseed/node';

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  cryptoConfig: PaymentCryptoConfig;
  chainConfig: ChainConfig;
}

function formatUsdc6(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

/** Parse a decimal USDC string to base units (6 decimals) without floating-point. */
function parseUsdc6(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = frac.slice(0, 6).padEnd(6, '0');
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

function createClient(config: PaymentCryptoConfig): BaseEscrowClient {
  return new BaseEscrowClient({
    rpcUrl: config.rpcUrl,
    contractAddress: config.escrowContractAddress,
    usdcAddress: config.usdcContractAddress,
  });
}

export function registerRoutes(fastify: FastifyInstance, ctx: RouteContext): void {
  // Shared escrow client — reused across requests (stateless, only holds RPC URL + ABI)
  let escrowClient: BaseEscrowClient | null = null;
  function getClient(): BaseEscrowClient | null {
    if (!escrowClient) escrowClient = createClient(ctx.cryptoConfig);
    return escrowClient;
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
      escrowContractAddress: ctx.cryptoConfig.escrowContractAddress,
      usdcContractAddress: ctx.cryptoConfig.usdcContractAddress,
      crossmintConfigured: Boolean(process.env['ANTSEED_CROSSMINT_API_KEY']),
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
      const txHash = await client.requestWithdrawal(ctx.cryptoCtx.wallet, baseUnits);
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
      const txHash = await client.executeWithdrawal(ctx.cryptoCtx.wallet);
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
      const txHash = await client.cancelWithdrawal(ctx.cryptoCtx.wallet);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
