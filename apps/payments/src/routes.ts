import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import {
  DepositsClient,
  EmissionsClient,
  ANTSTokenClient,
  formatUsdc,
  parseUsdc,
  signSetOperator,
  makeDepositsDomain,
  type ChainConfig,
  type BuyerUsageTotals,
} from '@antseed/node';

const EMPTY_BUYER_USAGE: BuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  channels: [],
};

interface RouteContext {
  cryptoCtx: CryptoContext | null;
  cryptoConfig: PaymentCryptoConfig;
  chainConfig: ChainConfig;
  proxyPort: number;
}

// Use shared utilities from @antseed/node
const formatUsdc6 = formatUsdc;
const parseUsdc6 = parseUsdc;

// Retry helper for on-chain view calls. Base RPC occasionally returns an
// unparseable response (ethers surfaces it as CALL_EXCEPTION with null
// revert data even though the call didn't actually revert); view calls are
// idempotent, so retrying clears these transient failures.
async function retryRead<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

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

  let emissionsClient: EmissionsClient | null = null;
  function getEmissionsClient(): EmissionsClient | null {
    if (!ctx.chainConfig.emissionsContractAddress) return null;
    if (!emissionsClient) {
      emissionsClient = new EmissionsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        ...(ctx.cryptoConfig.fallbackRpcUrls ? { fallbackRpcUrls: ctx.cryptoConfig.fallbackRpcUrls } : {}),
        contractAddress: ctx.chainConfig.emissionsContractAddress,
      });
    }
    return emissionsClient;
  }

  let antsTokenClient: ANTSTokenClient | null = null;
  function getAntsTokenClient(): ANTSTokenClient | null {
    // ANTSToken address is typically fetched via the registry, but for v1 we
    // plumb it through the chain config. Fall back to null if unavailable.
    const addr = (ctx.chainConfig as { antsTokenAddress?: string }).antsTokenAddress;
    if (!addr) return null;
    if (!antsTokenClient) {
      antsTokenClient = new ANTSTokenClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
        contractAddress: addr,
      });
    }
    return antsTokenClient;
  }

  fastify.get('/api/balance', async (_request, reply) => {
    if (!ctx.cryptoCtx) {
      return reply.status(503).send({ ok: false, error: 'Identity not configured — set ANTSEED_IDENTITY_HEX or run antseed seller setup' });
    }

    try {
      const client = getClient()!;
      const buyerAddress = ctx.cryptoCtx.evmAddress;

      const [balance, creditLimit] = await Promise.all([
        retryRead(() => client.getBuyerBalance(buyerAddress)),
        retryRead(() => client.getBuyerCreditLimit(buyerAddress)),
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
      emissionsContractAddress: ctx.chainConfig.emissionsContractAddress ?? null,
      networkStatsUrl: ctx.chainConfig.networkStatsUrl ?? null,
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

  fastify.get('/api/channels', async () => {
    if (!ctx.cryptoCtx) return { channels: [] };
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/channels?all=1`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/channels] buyer proxy returned ${resp.status}`);
        return { channels: [] };
      }
      const body = await resp.json() as { ok: boolean; channels: unknown[] };
      return { channels: body.channels ?? [] };
    } catch (err) {
      fastify.log.warn(`[/api/channels] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return { channels: [] };
    }
  });

  fastify.get('/api/buyer-usage', async (): Promise<BuyerUsageTotals> => {
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/buyer-usage`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/buyer-usage] buyer proxy returned ${resp.status}`);
        return EMPTY_BUYER_USAGE;
      }
      const body = await resp.json() as { ok: boolean; totals: BuyerUsageTotals };
      return body.totals;
    } catch (err) {
      fastify.log.warn(`[/api/buyer-usage] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return EMPTY_BUYER_USAGE;
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
        retryRead(() => client.getOperator(buyerAddress)),
        retryRead(() => client.getOperatorNonce(buyerAddress)),
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

  fastify.get('/api/emissions', async (_request, reply) => {
    const client = getEmissionsClient();
    if (!client) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    try {
      const [info, genesis, halving] = await Promise.all([
        retryRead(() => client.getEpochInfo()),
        retryRead(() => client.getGenesis()),
        retryRead(() => client.getHalvingInterval()),
      ]);
      const emission = await retryRead(() => client.getEpochEmission(info.epoch));
      return {
        currentEpoch: info.epoch,
        epochDuration: info.epochDuration,
        currentRate: info.emission.toString(),
        epochEmission: emission.toString(),
        genesis,
        halvingInterval: halving,
      };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/pending', async (request, reply) => {
    const client = getEmissionsClient();
    if (!client) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    const query = request.query as { address?: string; epochs?: string } | undefined;
    const address = query?.address;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return reply.status(400).send({ ok: false, error: 'Invalid address' });
    }
    const scanN = Math.min(Math.max(parseInt(query?.epochs ?? '10', 10) || 10, 1), 104);
    try {
      const info = await retryRead(() => client.getEpochInfo());
      const current = info.epoch;
      const startEpoch = Math.max(0, current - (scanN - 1));
      const epochList = Array.from({ length: current - startEpoch + 1 }, (_, i) => startEpoch + i);

      const rows = await Promise.all(
        epochList.map(async (epoch) => {
          const [pending, userSP, userBP, sellerClaimed, buyerClaimed] = await Promise.all([
            retryRead(() => client.pendingEmissions(address, [epoch])),
            retryRead(() => client.userSellerPoints(address, epoch)),
            retryRead(() => client.userBuyerPoints(address, epoch)),
            retryRead(() => client.sellerEpochClaimed(address, epoch)),
            retryRead(() => client.buyerEpochClaimed(address, epoch)),
          ]);
          return {
            epoch,
            seller: {
              amount: pending.seller.toString(),
              userPoints: userSP.toString(),
              claimed: sellerClaimed,
            },
            buyer: {
              amount: pending.buyer.toString(),
              userPoints: userBP.toString(),
              claimed: buyerClaimed,
            },
            isCurrent: epoch === current,
          };
        }),
      );

      return { currentEpoch: current, rows };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/shares', async (_request, reply) => {
    const client = getEmissionsClient();
    if (!client) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    try {
      return await retryRead(() => client.getShares());
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/api/emissions/transfers-enabled', async (_request, reply) => {
    const client = getAntsTokenClient();
    if (!client) {
      // When the ANTS token address isn't configured, treat as "not enabled yet"
      // — the UI uses this to decide whether to show the locked banner.
      return { enabled: false, configured: false };
    }
    try {
      const enabled = await client.transfersEnabled();
      return { enabled, configured: true };
    } catch (err) {
      return reply.status(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
