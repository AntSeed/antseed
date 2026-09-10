import { describe, expect, it } from 'vitest';
import { RotatingJsonRpcProvider, type RpcTransportResponse } from './rpc-provider.js';

const ok = (id: unknown, result: string): RpcTransportResponse => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const throttled: RpcTransportResponse = { status: 429, body: null };
const rateLimitBody: RpcTransportResponse = { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } } };

function build(responses: Record<string, RpcTransportResponse[]>, clock: { now: number }) {
  const sent: string[] = [];
  const provider = new RotatingJsonRpcProvider(Object.keys(responses), 8453, {
    now: () => clock.now,
    transport: async (url, body) => {
      sent.push(url);
      const next = responses[url]!.shift();
      if (!next) throw new Error(`${url} unreachable`);
      const id = (JSON.parse(body) as { id: unknown }).id;
      return next.status === 200 && next.body && typeof next.body === 'object' && 'result' in (next.body as object) ? ok(id, (next.body as { result: string }).result) : next;
    },
  });
  return { provider, sent };
}

describe('RotatingJsonRpcProvider', () => {
  it('moves to the next endpoint on 429, cools the throttled one down, and returns to it later', async () => {
    const clock = { now: 1_000_000 };
    const { provider, sent } = build({ 'https://a': [throttled, ok(1, '0x2')], 'https://b': [ok(1, '0x1'), ok(1, '0x1')] }, clock);
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
    expect(sent).toEqual(['https://a', 'https://b']);
    expect(provider.activeUrl).toBe('https://b');
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
    expect(sent).toEqual(['https://a', 'https://b', 'https://b']);
    clock.now += 25_000;
    expect(provider.activeUrl).toBe('https://a');
    expect(await provider.send('eth_blockNumber', [])).toBe('0x2');
  });

  it('treats a JSON-RPC rate-limit error and a transport failure as throttling too', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [rateLimitBody], 'https://b': [], 'https://c': [ok(1, '0x3')] }, clock);
    expect(await provider.send('eth_blockNumber', [])).toBe('0x3');
    expect(sent).toEqual(['https://a', 'https://b', 'https://c']);
  });

  it('fails fast when every endpoint throttles, and again while they cool down', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [throttled, ok(1, '0x1')], 'https://b': [throttled] }, clock);
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(/rate limiting/);
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(/rate limiting/);
    expect(sent).toEqual(['https://a', 'https://b']);
    clock.now += 25_000;
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
  });

  it('surfaces other HTTP errors instead of rotating', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [{ status: 500, body: null }], 'https://b': [ok(1, '0x1')] }, clock);
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(/HTTP 500/);
    expect(sent).toEqual(['https://a']);
  });
});
