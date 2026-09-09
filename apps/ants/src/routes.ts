import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AntsContext } from './service/context.js';
import { JobRunner, describeError } from './jobs.js';
import type { ViewCache } from './view-cache.js';
import type { StepReporter } from './service/steps.js';
import {
  overview, positions, stake, move, split, merge, extend, maxLock, previewWithdraw, withdraw,
  rewards, claim, restake, stakeUsageRewards, compound, poolsView, singlePool, usage, emissions,
  verification, proofStatus, submitProof, seller, registerBinding, claimStarter,
} from './service/index.js';
import type {
  StakeRequest, MoveRequest, SplitRequest, MergeRequest, ExtendRequest, MaxLockRequest, WithdrawRequest,
  ClaimRequest, RestakeRequest, StakeUsageRequest, SubmitProofRequest, CompoundRequest,
} from './api-types.js';

export interface RouteContext {
  ctx: AntsContext;
  jobs: JobRunner;
  views: ViewCache;
  readOnly: boolean;
  dataDir: string | null;
}

async function respond(reply: FastifyReply, read: () => Promise<unknown>): Promise<void> {
  try {
    reply.send({ ok: true, data: await read() });
  } catch (error) {
    reply.status(400).send({ ok: false, error: describeError(error) });
  }
}

export function registerRoutes(app: FastifyInstance, context: RouteContext): void {
  const { ctx, jobs, views } = context;
  const cached = <T>(key: string, load: () => Promise<T>) => views.read(key, load);

  app.get('/api/config', async () => ({
    ok: true,
    data: { address: ctx.address, chainId: ctx.chain.chainId, evmChainId: ctx.chain.evmChainId, readOnly: context.readOnly, dataDir: context.dataDir },
  }));

  app.get('/api/overview', (_request, reply) => respond(reply, () => cached('overview', () => overview(ctx))));
  app.get('/api/positions', (_request, reply) => respond(reply, () => cached('positions', () => positions(ctx))));
  app.get('/api/rewards', (_request, reply) => respond(reply, () => cached('rewards', () => rewards(ctx))));
  app.get('/api/pools', (_request, reply) => respond(reply, () => cached('pools', () => poolsView(ctx))));
  app.get<{ Params: { agentId: string } }>('/api/pools/:agentId', (request, reply) => respond(reply, () => cached(`pool:${request.params.agentId}`, () => singlePool(ctx, Number(request.params.agentId)))));
  app.get<{ Querystring: { epochs?: string } }>('/api/usage', (request, reply) => respond(reply, () => cached(`usage:${request.query.epochs ?? ''}`, () => usage(ctx, { epochs: request.query.epochs ? Number(request.query.epochs) : undefined }))));
  app.get('/api/emissions', (_request, reply) => respond(reply, () => cached('emissions', () => emissions(ctx))));
  app.get<{ Querystring: { seller?: string } }>('/api/verification', (request, reply) => respond(reply, () => cached(`verification:${(request.query.seller ?? '').toLowerCase()}`, () => verification(ctx, request.query.seller || undefined))));
  app.get<{ Params: { proofId: string } }>('/api/verification/proofs/:proofId', (request, reply) => respond(reply, () => proofStatus(ctx, request.params.proofId)));
  app.get('/api/seller', (_request, reply) => respond(reply, () => cached('seller', () => seller(ctx))));
  app.post<{ Body: { positionIds: number[] } }>('/api/positions/withdraw/preview', (request, reply) => respond(reply, () => previewWithdraw(ctx, request.body?.positionIds ?? [])));

  app.get('/api/jobs', async () => ({ ok: true, data: jobs.list() }));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.status(404).send({ ok: false, error: 'Unknown job' });
    return { ok: true, data: job };
  });

  const action = <Body>(path: string, kind: string, run: (body: Body, report: StepReporter) => Promise<unknown>) => {
    app.post(path, async (request, reply) => {
      if (context.readOnly) return reply.status(403).send({ ok: false, error: 'The dashboard is running in read-only mode (no wallet available).' });
      try {
        const job = jobs.start(kind, (report) => run((request.body ?? {}) as Body, report));
        return { ok: true, data: job };
      } catch (error) {
        return reply.status(409).send({ ok: false, error: describeError(error) });
      }
    });
  };

  action<StakeRequest>('/api/positions/stake', 'stake', (body, report) => stake(ctx, body, report));
  action<MoveRequest>('/api/positions/move', 'move', (body, report) => move(ctx, body, report));
  action<SplitRequest>('/api/positions/split', 'split', (body, report) => split(ctx, body, report));
  action<MergeRequest>('/api/positions/merge', 'merge', (body, report) => merge(ctx, body, report));
  action<ExtendRequest>('/api/positions/extend', 'extend', (body, report) => extend(ctx, body, report));
  action<MaxLockRequest>('/api/positions/max-lock', 'max-lock', (body, report) => maxLock(ctx, body, report));
  action<WithdrawRequest>('/api/positions/withdraw', 'withdraw', (body, report) => withdraw(ctx, body, report));
  action<ClaimRequest>('/api/rewards/claim', 'claim', (body, report) => claim(ctx, body, report));
  action<RestakeRequest>('/api/rewards/restake', 'restake', (body, report) => restake(ctx, body, report));
  action<StakeUsageRequest>('/api/rewards/stake-usage', 'stake-usage', (body, report) => stakeUsageRewards(ctx, body, report));
  action<CompoundRequest>('/api/rewards/compound', 'compound', (body, report) => compound(ctx, body, report));
  action<SubmitProofRequest>('/api/verification/submit', 'verify-submit', (body, report) => submitProof(ctx, body.artifact, report));
  action<{ agentId?: number }>('/api/seller/register', 'seller-register', (body, report) => registerBinding(ctx, body?.agentId, report));
  action<Record<string, never>>('/api/seller/claim-starter', 'claim-starter', (_body, report) => claimStarter(ctx, report));
}
