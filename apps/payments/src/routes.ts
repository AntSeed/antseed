import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import { DepositsClient, SessionsClient, formatUsdc, parseUsdc, type ChainConfig } from '@antseed/node';

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

  let sessionsClient: SessionsClient | null = null;
  function getSessionsClient(): SessionsClient | null {
    if (!sessionsClient && ctx.cryptoConfig.sessionsContractAddress) {
      sessionsClient = new SessionsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        contractAddress: ctx.cryptoConfig.sessionsContractAddress,
      });
    }
    return sessionsClient;
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
      sessionsContractAddress: ctx.cryptoConfig.sessionsContractAddress,
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

  fastify.get('/api/sessions', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return { sessions: [] };
    }

    try {
      const client = getSessionsClient();
      if (!client) return { sessions: [] };

      const buyerAddress = ctx.cryptoCtx.evmAddress;
      // Pad buyer address to 32 bytes for topic filter (indexed address in events)
      const buyerTopic = '0x' + buyerAddress.slice(2).toLowerCase().padStart(64, '0');

      // Reserved event signature: Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)
      const { ethers } = await import('ethers');
      const iface = new ethers.Interface([
        'event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)',
      ]);
      const eventTopic = iface.getEvent('Reserved')!.topicHash;

      const logs = await client.provider.getLogs({
        address: ctx.cryptoConfig.sessionsContractAddress,
        topics: [eventTopic, null, buyerTopic],
        fromBlock: 0,
        toBlock: 'latest',
      });

      // Collect unique channelIds from events
      const channelIds = new Set<string>();
      for (const log of logs) {
        // channelId is topic1
        if (log.topics[1]) channelIds.add(log.topics[1]);
      }

      // Fetch session details for each channelId
      const sessions = [];
      for (const channelId of channelIds) {
        try {
          const session = await client.getSession(channelId);
          // Only include Active sessions (status === 1)
          if (session.status === 1) {
            sessions.push({
              channelId,
              seller: session.seller,
              deposit: formatUsdc6(session.deposit),
              settled: formatUsdc6(session.settled),
              deadline: Number(session.deadline),
              closeRequestedAt: Number(session.closeRequestedAt),
              status: session.status,
            });
          }
        } catch {
          // Skip sessions that fail to fetch
        }
      }

      return { sessions };
    } catch (err) {
      return { sessions: [] };
    }
  });

  fastify.get('/api/operator', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — run antseed init' });
    }

    try {
      const client = getSessionsClient();
      if (!client) {
        return { operator: '0x0000000000000000000000000000000000000000', nonce: 0 };
      }

      const buyerAddress = ctx.cryptoCtx.evmAddress;
      const [operator, nonce] = await Promise.all([
        client.getOperator(buyerAddress),
        client.getOperatorNonce(buyerAddress),
      ]);

      return { operator, nonce: Number(nonce) };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
