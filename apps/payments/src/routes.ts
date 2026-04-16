import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import { ChannelsClient, DepositsClient, formatUsdc, parseUsdc, signSetOperator, makeDepositsDomain, type ChainConfig } from '@antseed/node';

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  cryptoConfig: PaymentCryptoConfig;
  chainConfig: ChainConfig;
  proxyPort: number;
}

// Use shared utilities from @antseed/node
const formatUsdc6 = formatUsdc;
const parseUsdc6 = parseUsdc;

function createClient(config: PaymentCryptoConfig): DepositsClient {
  return new DepositsClient({
    rpcUrl: config.rpcUrl,
    ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
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

  let channelsClient: ChannelsClient | null = null;
  function getChannelsClient(): ChannelsClient | null {
    if (!channelsClient) {
      channelsClient = new ChannelsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: ctx.cryptoConfig.channelsContractAddress,
      });
    }
    return channelsClient;
  }

  fastify.get('/api/balance', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
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
      channelsContractAddress: ctx.cryptoConfig.channelsContractAddress,
      usdcContractAddress: ctx.cryptoConfig.usdcContractAddress,
      evmAddress: ctx.cryptoCtx?.evmAddress ?? null,
    };
  });

  fastify.get('/api/transactions', async () => {
    // TODO: Read deposit/withdrawal events from on-chain logs
    return { transactions: [] };
  });

  fastify.post('/api/withdraw', async (request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
    }

    const body = request.body as { amount?: string } | null;
    const amount = body?.amount;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return reply.status(400).send({ ok: false, error: 'Invalid amount' });
    }

    try {
      const baseUnits = parseUsdc6(amount);
      const client = getClient()!;
      const txHash = await client.withdraw(ctx.cryptoCtx.wallet, ctx.cryptoCtx.evmAddress, baseUnits);
      return { ok: true, txHash };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/channels', async (_request, _reply) => {
    if (!ctx.cryptoCtx) {
      return { channels: [], history: [] };
    }

    // Fetch channels from the buyer proxy's local ChannelStore via its
    // control-plane endpoint (source of truth for the list). Avoids
    // eth_getLogs scans which are capped on public RPCs. Then enrich each
    // channel with a point-read against channels(bytes32) to get the
    // authoritative on-chain status + closeRequestedAt, and split into
    // active vs history based on on-chain state.
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/channels?all=1`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/channels] buyer proxy returned ${resp.status}`);
        return { channels: [], history: [] };
      }
      const body = await resp.json() as {
        ok: boolean;
        channels: Array<{
          channelId: string;
          seller: string;
          reserveMax: string;
          cumulativeSigned: string;
          deadline: number;
          status: string;
        }>;
      };
      // Initialize the channels client outside the enrichment loop and catch
      // init failures independently — a bad RPC URL must not discard the
      // channel list we already have from the buyer proxy.
      let cc: ChannelsClient | null = null;
      try {
        cc = getChannelsClient();
      } catch (err) {
        fastify.log.warn(`[/api/channels] channels client init failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const rawChannels = body.channels ?? [];
      // Cap concurrent eth_call fan-out. Public RPCs rate-limit concurrent
      // reads — the default wagmi primary (publicnode) was picked for 3/3
      // reliability at 3 concurrent eth_calls; more than that and responses
      // start coming back stale, which would resurrect the exact bug this
      // PR fixes (status=1 / closeRequestedAt=0 placeholders).
      const ON_CHAIN_READ_CONCURRENCY = 3;
      const enriched: Array<{
        channelId: string;
        seller: string;
        deposit: string;
        settled: string;
        deadline: number;
        closeRequestedAt: number;
        status: number;
      }> = new Array(rawChannels.length);
      let cursor = 0;
      async function worker() {
        while (true) {
          const i = cursor++;
          if (i >= rawChannels.length) return;
          const c = rawChannels[i]!;
          let closeRequestedAt = 0;
          let onchainStatus = 0; // 0=None, 1=Active, 2=Settled, 3=TimedOut
          let onchainSettled: bigint | null = null;
          if (cc) {
            try {
              const onchain = await cc.getSession(c.channelId);
              closeRequestedAt = Number(onchain.closeRequestedAt);
              onchainStatus = onchain.status;
              onchainSettled = onchain.settled;
            } catch (err) {
              fastify.log.warn(`[/api/channels] on-chain read failed for ${c.channelId.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          enriched[i] = {
            channelId: c.channelId,
            seller: c.seller,
            deposit: formatUsdc6(BigInt(c.reserveMax)),
            settled: formatUsdc6(onchainSettled ?? BigInt(c.cumulativeSigned)),
            deadline: c.deadline,
            closeRequestedAt,
            status: onchainStatus,
          };
        }
      }
      const workers = Array.from(
        { length: Math.min(ON_CHAIN_READ_CONCURRENCY, rawChannels.length) },
        () => worker(),
      );
      await Promise.all(workers);
      // Active = on-chain status Active (1). Everything else is history
      // (Settled=2, TimedOut=3, None=0 means the channel no longer exists
      // on-chain — e.g., withdrawn and cleared).
      const channels = enriched.filter((c) => c.status === 1);
      const history = enriched.filter((c) => c.status !== 1);
      return { channels, history };
    } catch (err) {
      fastify.log.warn(`[/api/channels] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return { channels: [], history: [] };
    }
  });

  fastify.get('/api/operator', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
    }

    try {
      const client = getClient();
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

  fastify.post('/api/operator/sign', async (request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured' });
    }

    const body = request.body as { operator?: string } | null;
    const operator = body?.operator?.trim();
    if (!operator || !/^0x[0-9a-fA-F]{40}$/.test(operator)) {
      return reply.status(400).send({ ok: false, error: 'Invalid operator address' });
    }

    try {
      const dc = getClient();
      if (!dc) {
        return reply.status(503).send({ ok: false, error: 'Deposits contract not configured' });
      }
      const nonce = await dc.getOperatorNonce(ctx.cryptoCtx.evmAddress);
      const domain = makeDepositsDomain(ctx.chainConfig.evmChainId, ctx.cryptoConfig.depositsContractAddress);
      const signature = await signSetOperator(ctx.cryptoCtx.wallet, domain, {
        operator,
        nonce,
      });
      return { ok: true, signature, nonce: Number(nonce), buyer: ctx.cryptoCtx.evmAddress };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
