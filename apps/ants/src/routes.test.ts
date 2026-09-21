import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from './routes.js';
import { JobRunner } from './jobs.js';
import { ViewCache } from './view-cache.js';
import type { AntsContext } from './service/context.js';

const service = vi.hoisted(() => ({
  previewWithdraw: vi.fn(), registerBinding: vi.fn(), rewards: vi.fn(),
}));
vi.mock('./service/index.js', async (original) => ({
  ...await original<typeof import('./service/index.js')>(), ...service,
}));

const apps: ReturnType<typeof Fastify>[] = [];
function setup(readOnly = false, chainOverrides: Partial<AntsContext['chain']> = {}) {
  const app = Fastify();
  apps.push(app);
  const ctx = { signer: readOnly ? undefined : {}, address: '0x123', chain: { chainId: 'base-local', evmChainId: 31337, ...chainOverrides }, invalidate: vi.fn() } as unknown as AntsContext;
  registerRoutes(app, { ctx, jobs: new JobRunner(), views: new ViewCache(), readOnly, dataDir: null });
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('dashboard API', () => {
  it.each(['https://antscan.co', ''])('uses the configured explorer for models: %s', async explorerApiUrl => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetchImpl);
    const app = setup(true, { explorerApiUrl });
    await app.inject('/api/sellers/0x0000000000000000000000000000000000000001/models');
    if (explorerApiUrl === '') expect(fetchImpl).not.toHaveBeenCalled();
    else {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [url] of vi.mocked(fetch).mock.calls) expect(String(url).startsWith(`${explorerApiUrl}/api/`)).toBe(true);
    }
  });
  it('allows read-only model information and rejects invalid seller addresses', async () => {
    const app = setup(true);
    const response = await app.inject('/api/sellers/0x0000000000000000000000000000000000000001/models');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.catalogStatus).toBe('unavailable');
    expect((await app.inject('/api/sellers/not-an-address/models')).statusCode).toBe(400);
  });
  it('allows withdrawal estimates in read-only mode but blocks signing', async () => {
    const app = setup(true);
    const estimate = { burned: '500000000000000000', returned: '500000000000000000' };
    service.previewWithdraw.mockResolvedValue(estimate);
    const preview = await app.inject({ method: 'POST', url: '/api/positions/withdraw/preview', payload: { positionIds: [14] } });
    expect(preview.json()).toEqual({ ok: true, data: estimate });
    expect(service.previewWithdraw).toHaveBeenCalledWith(expect.anything(), [14]);
    for (const url of ['/api/positions/withdraw', '/api/seller/register', '/api/rewards/claim']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    }
    expect(service.registerBinding).not.toHaveBeenCalled();
    expect((await app.inject('/api/jobs')).json().data).toEqual([]);
  });

  it('exposes partial registration progress and failure through job polling', async () => {
    service.registerBinding.mockImplementation(async (_ctx, _agentId, report) => {
      await report('Identity created: agent 77');
      throw new Error('Binding failed; retry with agent 77');
    });
    const app = setup();
    const started = await app.inject({ method: 'POST', url: '/api/seller/register', payload: {} });
    const id = started.json().data.id;
    await vi.waitFor(async () => {
      const response = await app.inject(`/api/jobs/${id}`);
      expect(response.json().data).toMatchObject({
        status: 'failed', error: 'Binding failed; retry with agent 77',
        steps: [{ label: 'Identity created: agent 77' }],
      });
    });
    expect(service.registerBinding).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(Function));
  });

  it('invalidates shared reads before actions, after confirmed steps, and on failure', async () => {
    service.registerBinding.mockImplementation(async (ctx, _agentId, report) => {
      expect(ctx.invalidate).toHaveBeenCalledTimes(1);
      await report('Confirmed registration', '0x1234');
      expect(ctx.invalidate).toHaveBeenCalledTimes(2);
      throw new Error('subsequent step failed');
    });
    const app = setup();
    const started = await app.inject({ method: 'POST', url: '/api/seller/register', payload: {} });
    await vi.waitFor(async () => {
      expect((await app.inject(`/api/jobs/${started.json().data.id}`)).json().data).toMatchObject({ status: 'failed', error: 'subsequent step failed' });
    });
    expect(service.registerBinding.mock.calls[0]![0].invalidate).toHaveBeenCalledTimes(3);
  });

  it('returns a read error rather than a successful zero rewards response', async () => {
    service.rewards.mockRejectedValue(new Error('RPC temporarily unavailable'));
    const response = await setup().inject('/api/rewards');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'RPC temporarily unavailable' });
  });
});
