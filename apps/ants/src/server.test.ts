import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet, type TransactionReceipt } from 'ethers';
import { AntsContext } from './service/context.js';
import { createAntsServer, type AntsServer } from './server.js';
import { BrowserSigning } from './browser-signer.js';
import { JobRunner } from './jobs.js';
import * as routes from './routes.js';

const directories: string[] = [];
const servers: AntsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

it('persists monotonic per-wallet position checkpoints across local server restarts', async () => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const registration = vi.spyOn(routes, 'registerRoutes');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-checkpoint-test-'));
  directories.push(dataDir);
  const address = Wallet.createRandom().address;
  const options = { port: 0, dataDir, address, chain: { chainId: 'base-local' as const, evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [], explorerApiUrl: '' } };
  const server = await createAntsServer(options);
  servers.push(server);
  const receipt = { from: address, status: 1, blockNumber: 100, logs: [] } as unknown as TransactionReceipt;
  const getReceipt = vi.spyOn(server.context.provider(), 'getTransactionReceipt').mockResolvedValue(receipt);
  const rememberTransaction = registration.mock.calls[0]![1].rememberTransaction!;
  await rememberTransaction(`0x${'ab'.repeat(32)}`);
  getReceipt.mockResolvedValue({ ...receipt, blockNumber: 90 } as TransactionReceipt);
  await rememberTransaction(`0x${'cd'.repeat(32)}`);
  getReceipt.mockResolvedValue({ ...receipt, status: 0, blockNumber: 110 } as TransactionReceipt);
  await rememberTransaction(`0x${'ef'.repeat(32)}`);
  const barrier = server.context.positionReadBarriers.get(address.toLowerCase());
  expect(barrier).toEqual({ block: 100, at: expect.any(Number) });
  await server.close();
  servers.pop();
  const restarted = await createAntsServer(options);
  servers.push(restarted);
  expect([...restarted.context.positionReadBarriers]).toEqual([[address.toLowerCase(), barrier]]);
});

it.each([true, false])('correlates a wallet request only with its running owner job (active=%s)', async active => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-wallet-job-test-'));
  directories.push(dataDir);
  const address = Wallet.createRandom().address;
  const transaction = { id: 'request-1', from: address, to: address, data: '0x', value: '0', chainId: 31337 };
  vi.spyOn(BrowserSigning.prototype, 'request', 'get').mockReturnValue(transaction);
  const list = vi.spyOn(JobRunner.prototype, 'list').mockReturnValue([{ id: 'job-1', kind: 'move', owner: address, status: active ? 'running' : 'done', steps: [], startedAt: Date.now() }]);
  const server = await createAntsServer({ port: 0, dataDir, address, chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [] } });
  servers.push(server);
  const response = await server.app.inject({ method: 'GET', url: '/api/wallet/request', headers: { authorization: `Bearer ${server.token}` } });
  expect(response.json()).toEqual({ ok: true, data: { ...transaction, ...(active ? { jobId: 'job-1' } : {}) } });
  expect(list).toHaveBeenCalledWith(address);
  expect(transaction).not.toHaveProperty('jobId');
});

describe('explicit local service harness', () => {
  it('uses the host signer/config and an assigned local port with authenticated same-origin access', async () => {
    vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-host-test-'));
    directories.push(dataDir);
    const signer = Wallet.createRandom();
    const chain = { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [], explorerApiUrl: '' };
    const server = await createAntsServer({ port: 0, dataDir, browserWallet: false, signer, address: signer.address, chain });
    servers.push(server);
    const url = await server.listen();
    expect(new URL(url).port).not.toBe('0');
    expect(server.url).toBe(url);
    expect(server.context.signer).toBe(signer);
    expect(server.context.chain).toEqual(chain);
    const origin = new URL(url).origin;
    const unauthorized = await fetch(`${origin}/api/config`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${server.token}`, Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(JSON.stringify(await response.json())).toContain(signer.address);
    const foreign = await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${server.token}`, Origin: 'https://untrusted.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    server.pauseWrites();
    expect(server.busy).toBe(false);
    await server.close();
    servers.pop();
    await expect(fetch(`${origin}/api/config`)).rejects.toThrow();
  });
});

it('browser sessions ignore host signing keys and retain the original buyer across wallet changes', async () => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-browser-test-'));
  directories.push(dataDir);
  const buyer = Wallet.createRandom();
  const external = Wallet.createRandom();
  const server = await createAntsServer({ port: 0, dataDir, signer: buyer, address: buyer.address,
    chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545', fallbackRpcUrls: [], explorerApiUrl: '' } });
  servers.push(server);
  const invalidate = vi.spyOn(server.context, 'invalidate');
  const noChange = await server.app.inject({ method: 'POST', url: '/api/wallet', headers: { authorization: `Bearer ${server.token}` }, payload: {} });
  expect(noChange.json().data).toEqual({ changed: false });
  expect(invalidate).not.toHaveBeenCalled();
  await server.app.inject({ method: 'POST', url: '/api/wallet', headers: { authorization: `Bearer ${server.token}` }, payload: { refresh: true } });
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(server.context.signer).toBeUndefined();
  expect(server.context.buyerAddress).toBe(buyer.address);
  const headers = { authorization: `Bearer ${server.token}` };
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', payload: { address: external.address, chainId: 31337 } })).statusCode).toBe(401);
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address: external.address, chainId: 8453 } })).statusCode).toBe(400);
  expect(server.context.signer).toBeUndefined();
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address: external.address, chainId: 31337 } })).statusCode).toBe(200);
  expect(await server.context.signer?.getAddress()).toBe(external.address);
  expect(server.context.buyerAddress).toBe(buyer.address);
  expect(server.context.signer).not.toBe(buyer);
  // A wallet-less sync (second tab, extension still reconnecting) keeps the connected signer.
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: {} })).json().data).toEqual({ changed: false });
  expect(await server.context.signer?.getAddress()).toBe(external.address);
  await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { disconnect: true } });
  expect(server.context.signer).toBeUndefined();
});
