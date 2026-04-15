import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';

function mockCtx(overrides: Partial<Parameters<typeof registerRoutes>[1]> = {}): Parameters<typeof registerRoutes>[1] {
  return {
    cryptoCtx: null,
    cryptoConfig: {
      rpcUrl: 'http://localhost:8545',
      depositsContractAddress: '0x' + '0'.repeat(40),
      channelsContractAddress: '0x' + '1'.repeat(40),
      usdcContractAddress: '0x' + '2'.repeat(40),
    } as any,
    chainConfig: {
      chainId: 'base-local',
      evmChainId: 31337,
      emissionsContractAddress: '0x' + '3'.repeat(40),
    } as any,
    proxyPort: 3000,
    ...overrides,
  };
}

describe('GET /api/config', () => {
  it('includes emissionsContractAddress', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    const body = res.json();
    expect(body).toHaveProperty('emissionsContractAddress');
    expect(body.emissionsContractAddress).toBe('0x' + '3'.repeat(40));
    await app.close();
  });

  it('includes networkStatsUrl when the chain config has it', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: {
        chainId: 'base-mainnet',
        evmChainId: 8453,
        networkStatsUrl: 'https://network.antseed.com',
      } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json().networkStatsUrl).toBe('https://network.antseed.com');
    await app.close();
  });

  it('returns networkStatsUrl: null when the chain config has none', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: {
        chainId: 'base-local',
        evmChainId: 31337,
      } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json().networkStatsUrl).toBeNull();
    await app.close();
  });
});

describe('GET /api/emissions/pending', () => {
  it('rejects malformed addresses with 400', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/emissions/pending?address=not-an-address' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 503 when emissions contract is not configured', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: { chainId: 'base-local', evmChainId: 31337 } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/emissions/pending?address=0x' + '4'.repeat(40) });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /api/emissions/transfers-enabled', () => {
  it('returns configured:false when ANTS token address is missing', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/emissions/transfers-enabled' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(false);
    await app.close();
  });
});
