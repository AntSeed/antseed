import type { FastifyInstance } from 'fastify';
import type { CryptoContext, PaymentCryptoConfig } from './crypto-context.js';
import {
  ChannelsClient,
  DepositsClient,
  EmissionsClient,
  ANTSTokenClient,
  formatUsdc,
  parseUsdc,
  signSetOperator,
  makeDepositsDomain,
  type ChainConfig,
} from '@antseed/node';

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
        contractAddress: ctx.cryptoConfig.channelsContractAddress,
      });
    }
    return channelsClient;
  }

  let emissionsClient: EmissionsClient | null = null;
  function getEmissionsClient(): EmissionsClient | null {
    if (!ctx.chainConfig.emissionsContractAddress) return null;
    if (!emissionsClient) {
      emissionsClient = new EmissionsClient({
        rpcUrl: ctx.cryptoConfig.rpcUrl,
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
          let onchainDeposit: bigint | null = null;
          if (cc) {
            try {
              const onchain = await cc.getSession(c.channelId);
              closeRequestedAt = Number(onchain.closeRequestedAt);
              onchainStatus = onchain.status;
              onchainSettled = onchain.settled;
              onchainDeposit = onchain.deposit;
            } catch (err) {
              fastify.log.warn(`[/api/channels] on-chain read failed for ${c.channelId.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          enriched[i] = {
            channelId: c.channelId,
            seller: c.seller,
            // Prefer the authoritative on-chain deposit (USDC actually locked
            // in the Channels contract). Fall back to the local proxy's
            // reserveMax only if the on-chain read failed.
            deposit: formatUsdc6(onchainDeposit ?? BigInt(c.reserveMax)),
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

  fastify.get('/api/buyer-usage', async (_request, _reply) => {
    // Sourced from the buyer proxy's local ChannelStore — fully answerable
    // from the local DB, no network aggregator required.
    try {
      const url = `http://127.0.0.1:${ctx.proxyPort}/_antseed/buyer-usage`;
      const resp = await fetch(url);
      if (!resp.ok) {
        fastify.log.warn(`[/api/buyer-usage] buyer proxy returned ${resp.status}`);
        return {
          totalRequests: 0,
          totalInputTokens: '0',
          totalOutputTokens: '0',
          totalSettlements: 0,
          uniqueSellers: 0,
          activeChannels: 0,
          channels: [],
        };
      }
      const body = await resp.json() as {
        ok: boolean;
        totals: {
          totalRequests: number;
          totalInputTokens: string;
          totalOutputTokens: string;
          totalSettlements: number;
          uniqueSellers: number;
          activeChannels: number;
          channels: Array<{
            reservedAt: number;
            updatedAt: number;
            requestCount: number;
            inputTokens: string;
            outputTokens: string;
          }>;
        };
      };
      return body.totals;
    } catch (err) {
      fastify.log.warn(`[/api/buyer-usage] buyer proxy unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return {
        totalRequests: 0,
        totalInputTokens: '0',
        totalOutputTokens: '0',
        totalSettlements: 0,
        uniqueSellers: 0,
        activeChannels: 0,
      };
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

  fastify.get('/api/emissions', async (_request, reply) => {
    const client = getEmissionsClient();
    if (!client) {
      return reply.status(503).send({ ok: false, error: 'Emissions contract not configured for this chain' });
    }
    try {
      const [info, genesis, halving, emission] = await Promise.all([
        client.getEpochInfo(),
        client.getGenesis(),
        client.getHalvingInterval(),
        // current epoch emission budget
        (async () => {
          const epochInfo = await client.getEpochInfo();
          return client.getEpochEmission(epochInfo.epoch);
        })(),
      ]);
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
      const info = await client.getEpochInfo();
      const current = info.epoch;
      const startEpoch = Math.max(0, current - (scanN - 1));
      const epochList = Array.from({ length: current - startEpoch + 1 }, (_, i) => startEpoch + i);

      // Per-epoch pending (so we can render a row per epoch), not just totals.
      // For each epoch, we need: user points, total points, claimed flag, and
      // the pending delta. We derive per-epoch amounts by calling pendingEmissions
      // with a single-element epoch array.
      const rows = await Promise.all(
        epochList.map(async (epoch) => {
          const [pending, userSP, userBP, sellerClaimed, buyerClaimed] = await Promise.all([
            client.pendingEmissions(address, [epoch]),
            client.userSellerPoints(address, epoch),
            client.userBuyerPoints(address, epoch),
            client.sellerEpochClaimed(address, epoch),
            client.buyerEpochClaimed(address, epoch),
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
      return await client.getShares();
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
