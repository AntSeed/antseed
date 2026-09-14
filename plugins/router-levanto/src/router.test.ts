import { describe, expect, it, vi } from 'vitest';
import type { ConversationIdentity, ModelRoutingPreferences, PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LEVANTO_AUTO_SERVICE_ID, LevantoRouter } from './router.js';

/**
 * Explicit consent to the daily day pass -- `signDayPassOnDemand`
 * requires this to be true before it will ever call `signDailyIfNeeded`.
 * Most signing tests below pass this explicitly, since `null`/absent must
 * mean "no consent seen yet," not "assume yes."
 */
function enabledPreferences(): ModelRoutingPreferences {
  return {
    preferFreePeers: false,
    maxInputUsdPerMillion: 25,
    minTrustScore: 60,
    allowedPeerIds: [],
    blockedPeerIds: [],
    cqt: 5,
    dayPassOnDemandEnabled: true,
  };
}

function conversation(sessionKey = 'sess-1'): ConversationIdentity {
  return { tool: 'claude-code', sessionKey, parentSessionKey: null, isUserThread: true };
}

function rankedResponse(overrides?: Partial<{ ranked: unknown[] }>) {
  return {
    v: 1,
    ranked: overrides?.ranked ?? [
      { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
        price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
    ],
    router: 'mock',
  };
}

function req(model: string, lastUserText = 'hello'): SerializedHttpRequest {
  return {
    requestId: 'r1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: {},
    body: new TextEncoder().encode(JSON.stringify({
      model,
      messages: [{ role: 'user', content: lastUserText }],
    })),
  };
}

function peer(peerId: string): PeerInfo {
  return { peerId } as PeerInfo;
}

/**
 * A fetchImpl for the reactive-signing tests: the actual routing call
 * ('inputMessage' in the body -- distinguishes it from the separate digest
 * submission, which shares the same fetchImpl in every test here) 402s
 * exactly `unpaidCount` times, then succeeds on every call after that.
 * Defaults to 402ing once, modeling "the seller says pay me" on the very
 * next routing call -- exactly the trigger signDayPassOnDemand reacts
 * to.
 */
function fetchWithPaymentRequired(unpaidCount = 1) {
  let routeCalls = 0;
  return vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if ('inputMessage' in body) {
      routeCalls += 1;
      if (routeCalls <= unpaidCount) {
        return { ok: false, status: 402, json: async () => ({ error: { message: 'No current day pass.' } }) };
      }
    }
    return { ok: true, json: async () => rankedResponse() };
  });
}

describe('LevantoRouter.selectRoute', () => {
  it('uses its namespaced setting instead of the legacy universal preference', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl });
    await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences(), null,
      { signal: new AbortController().signal, deadlineMs: Date.now() + 1000, settings: { costQuality: '9' } });
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.find((body) => 'inputMessage' in body).cqt).toBe(9);
  });
  it('declines immediately for a concretely-chosen model, without calling the routing peer', async () => {
    const fetchImpl = vi.fn();
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl });
    const result = await router.selectRoute(req('gpt-4o'), [], null, null);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls the routing peer for the levanto-auto sentinel and maps ranked candidates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        ranked: [
          {
            model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 },
          },
        ],
        router: 'mock',
      }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const peers = [peer('0xAAA'), peer('0xCCC')];
    const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), peers, null, null);

    expect(fetchImpl).toHaveBeenCalledWith('http://x/_antseed/route', expect.objectContaining({ method: 'POST' }));
    expect(result).toHaveLength(1);
    expect(result?.[0]?.serviceId).toBe('gpt-5.6-luna');
    expect(result?.[0]?.peerId).toBe('0xAAA');
    expect(result?.[0]?.inputUsdPerMillion).toBe(0.2);
  });

  it('attaches route-auth headers when configureRouteAuthSigning is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
    const router = new LevantoRouter({
      routingPeerUrl: 'http://x',
      sellerPeerId: 'bb'.repeat(20),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const signRouteAuth = vi.fn().mockResolvedValue({
      buyer: '0x' + 'cc'.repeat(20),
      issuedAt: 1_700_000_000,
      nonce: '0x' + 'dd'.repeat(32),
      signature: '0xsig',
    });
    router.configureRouteAuthSigning(signRouteAuth);

    await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

    expect(signRouteAuth).toHaveBeenCalledWith('bb'.repeat(20));
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['x-antseed-route-auth-buyer']).toBe('0x' + 'cc'.repeat(20));
    expect(init.headers['x-antseed-route-auth-issued-at']).toBe('1700000000');
    expect(init.headers['x-antseed-route-auth-nonce']).toBe('0x' + 'dd'.repeat(32));
    expect(init.headers['x-antseed-route-auth-signature']).toBe('0xsig');
  });

  it('binds the route-auth signature to this plugin\'s own default seller peer id when sellerPeerId isn\'t explicitly configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const signRouteAuth = vi.fn().mockResolvedValue({
      buyer: '0x' + 'cc'.repeat(20), issuedAt: 1, nonce: '0x2', signature: '0x3',
    });
    router.configureRouteAuthSigning(signRouteAuth);

    await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

    // This plugin's own real mainnet routing peer (DEFAULT_SELLER_PEER_ID) --
    // a signature must be bound to whichever peer is actually being called,
    // and that's the same default selectRoute itself would discover a URL
    // for, not "no one."
    expect(signRouteAuth).toHaveBeenCalledWith('4c63288576d1befdbdd5f4734b4c9d4c3d8791be');
    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['x-antseed-route-auth-signature']).toBe('0x3');
  });

  it('omits route-auth headers (not a hard failure) when no signing is configured or signing itself throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });

    // No configureRouteAuthSigning call at all.
    const noAuthRouter = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: 'bb'.repeat(20), fetchImpl: fetchImpl as unknown as typeof fetch });
    await noAuthRouter.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
    let [, init] = fetchImpl.mock.calls.at(-1) as [string, { headers: Record<string, string> }];
    expect(init.headers['x-antseed-route-auth-signature']).toBeUndefined();

    // Configured, sellerPeerId present, but signing itself rejects.
    const throwingRouter = new LevantoRouter({ routingPeerUrl: 'http://x', sellerPeerId: 'bb'.repeat(20), fetchImpl: fetchImpl as unknown as typeof fetch });
    throwingRouter.configureRouteAuthSigning(vi.fn().mockRejectedValue(new Error('signer unavailable')));
    const result = await throwingRouter.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
    expect(result).toHaveLength(1); // routing still succeeds -- signing is lenient, not a hard gate
    ;[, init] = fetchImpl.mock.calls.at(-1) as [string, { headers: Record<string, string> }];
    expect(init.headers['x-antseed-route-auth-signature']).toBeUndefined();
  });

  it('drops ranked candidates whose peer is not in the current peer set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        v: 1,
        ranked: [
          { model: 'gpt-5.6-luna', peer: '0xNOT-A-PEER', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
            price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
        ],
        router: 'mock',
      }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
    expect(result).toEqual([]);
  });

  describe('routing peer URL discovery', () => {
    it('discovers the URL via resolveRoutingPeerHost, using this plugin\'s own default port, when no routingPeerUrl is configured', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const resolveRoutingPeerHost = vi.fn().mockResolvedValue('203.0.113.5');
      const router = new LevantoRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      // This plugin's own real mainnet routing peer -- the default seller
      // peer id discovery looks up when the host doesn't configure one.
      expect(resolveRoutingPeerHost).toHaveBeenCalledWith('4c63288576d1befdbdd5f4734b4c9d4c3d8791be');
      expect(fetchImpl).toHaveBeenCalledWith('http://203.0.113.5:8787/_antseed/route', expect.anything());
    });

    it('an explicit routingPeerUrl always wins -- discovery is never even attempted', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const resolveRoutingPeerHost = vi.fn().mockResolvedValue('203.0.113.5');
      const router = new LevantoRouter({ routingPeerUrl: 'http://explicit.example', fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(resolveRoutingPeerHost).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledWith('http://explicit.example/_antseed/route', expect.anything());
    });

    it('caches a discovered host across calls -- a second selectRoute does not re-discover', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const resolveRoutingPeerHost = vi.fn().mockResolvedValue('203.0.113.5');
      const router = new LevantoRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'first'), [peer('0xAAA')], null, null);
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'second'), [peer('0xAAA')], null, null);

      expect(resolveRoutingPeerHost).toHaveBeenCalledTimes(1);
    });

    it('clears the cache and re-discovers after an unreachable failure -- the seller may have moved', async () => {
      let call = 0;
      const fetchImpl = vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) throw new Error('ECONNREFUSED');
        return { ok: true, json: async () => rankedResponse() };
      });
      const resolveRoutingPeerHost = vi.fn()
        .mockResolvedValueOnce('203.0.113.5')
        .mockResolvedValueOnce('198.51.100.9');
      const router = new LevantoRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'first'), [peer('0xAAA')], null, null))
        .rejects.toMatchObject({ kind: 'unreachable' });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'second'), [peer('0xAAA')], null, null);

      expect(resolveRoutingPeerHost).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenLastCalledWith('http://198.51.100.9:8787/_antseed/route', expect.anything());
    });

    it('throws a clear error when neither routingPeerUrl nor resolveRoutingPeerHost is configured', async () => {
      const fetchImpl = vi.fn();
      const router = new LevantoRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });

      await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null))
        .rejects.toMatchObject({ kind: 'unreachable' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('throws a clear error when discovery finds nothing (null)', async () => {
      const fetchImpl = vi.fn();
      const resolveRoutingPeerHost = vi.fn().mockResolvedValue(null);
      const router = new LevantoRouter({ fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null))
        .rejects.toMatchObject({ kind: 'unreachable' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('on base-local, routes straight to this plugin\'s own local devnet peer -- no discovery attempted, even when a resolver is wired in', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const resolveRoutingPeerHost = vi.fn().mockResolvedValue('203.0.113.5');
      const router = new LevantoRouter({ chainId: 'base-local', fetchImpl: fetchImpl as unknown as typeof fetch });
      router.configureRoutingPeerHostResolution(resolveRoutingPeerHost);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(resolveRoutingPeerHost).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8787/_antseed/route', expect.anything());
    });

    it('an explicit routingPeerUrl still wins over the base-local default', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({
        chainId: 'base-local',
        routingPeerUrl: 'http://explicit.example',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(fetchImpl).toHaveBeenCalledWith('http://explicit.example/_antseed/route', expect.anything());
    });
  });

  describe('devnet defaults', () => {
    it('signs the route-auth to this plugin\'s own devnet seller peer id when chainId is base-local and sellerPeerId isn\'t explicit', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ chainId: 'base-local', fetchImpl: fetchImpl as unknown as typeof fetch });
      const signRouteAuth = vi.fn().mockResolvedValue({
        buyer: '0x' + 'cc'.repeat(20), issuedAt: 1, nonce: '0x2', signature: '0x3',
      });
      router.configureRouteAuthSigning(signRouteAuth);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(signRouteAuth).toHaveBeenCalledWith('c199453fd6b1c6823634ef9b3702eb5aeca71265');
    });

    it('an explicit sellerPeerId still wins over the base-local default', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({
        chainId: 'base-local',
        sellerPeerId: 'bb'.repeat(20),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const signRouteAuth = vi.fn().mockResolvedValue({
        buyer: '0x' + 'cc'.repeat(20), issuedAt: 1, nonce: '0x2', signature: '0x3',
      });
      router.configureRouteAuthSigning(signRouteAuth);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(signRouteAuth).toHaveBeenCalledWith('bb'.repeat(20));
    });

    it('a non-local chainId behaves exactly like no chainId at all -- the real mainnet default applies', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ chainId: 'base-mainnet', fetchImpl: fetchImpl as unknown as typeof fetch });
      const signRouteAuth = vi.fn().mockResolvedValue({
        buyer: '0x' + 'cc'.repeat(20), issuedAt: 1, nonce: '0x2', signature: '0x3',
      });
      router.configureRouteAuthSigning(signRouteAuth);
      router.configureRoutingPeerHostResolution(vi.fn().mockResolvedValue('203.0.113.5'));

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(signRouteAuth).toHaveBeenCalledWith('4c63288576d1befdbdd5f4734b4c9d4c3d8791be');
      expect(fetchImpl).toHaveBeenCalledWith('http://203.0.113.5:8787/_antseed/route', expect.anything());
    });
  });

  it('throws RoutingPeerError("unreachable") instead of silently declining when the routing peer is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      name: 'RoutingPeerError',
      kind: 'unreachable',
    });
  });

  it('throws RoutingPeerError("rejected") when the routing peer returns a non-OK status (e.g. 402 no current day pass)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: { message: 'No current day pass, or today\'s signature is not yet on file.' } }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      name: 'RoutingPeerError',
      kind: 'rejected',
      statusCode: 402,
      message: 'No current day pass, or today\'s signature is not yet on file.',
    });
  });

  it('does not retry a "no current day pass" 402 when no signing capability is configured at all -- nothing to self-heal with', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 402,
      json: async () => ({ error: { message: 'No current day pass, or today\'s signature is not yet on file.' } }),
    });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic message when a non-OK response has no JSON error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({
      kind: 'rejected',
      statusCode: 500,
    });
  });

  it('aborts and throws RoutingPeerError("unreachable") if the routing peer never responds within routeTimeoutMs', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const router = new LevantoRouter({
      routingPeerUrl: 'http://x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      routeTimeoutMs: 20,
    });
    await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(fetchImpl).toHaveBeenCalledWith('http://x/_antseed/route', expect.objectContaining({ signal: expect.any(Object) }));
  });

  describe('new-user-message gate', () => {
    it('a tool-loop continuation (same last user message) skips the network call and reuses the pinned decision', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xBBB')];
      const conv = conversation();

      const first = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), peers, conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(first?.[0]?.serviceId).toBe('gpt-5.6-luna');

      // Same last user message -- e.g. a tool-call/tool-result round trip.
      const second = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), peers, conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1 -- no new network call
      expect(second).toHaveLength(1);
      expect(second?.[0]?.serviceId).toBe('gpt-5.6-luna');
      expect(second?.[0]?.peerId).toBe('0xAAA');
    });

    it('a genuinely new user message re-routes with a fresh network call', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA')];
      const conv = conversation();

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), peers, conv, null);
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'a different message'), peers, conv, null);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('gates independently per conversation (different sessionKey never shares a pin)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA')];

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), peers, conversation('sess-1'), null);
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), peers, conversation('sess-2'), null);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('routes every call when there is no ConversationIdentity to key on (safe default)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), [peer('0xAAA')], null, null);
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), [peer('0xAAA')], null, null);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('reactive on-demand signing', () => {
    it('signs only when the seller asks for it (a 402), not on a call that needed nothing', async () => {
      const fetchImpl = fetchWithPaymentRequired(1); // 402s once, then always succeeds
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'first'), [peer('0xAAA')], conversation('a'), enabledPreferences());
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'second'), [peer('0xAAA')], conversation('b'), enabledPreferences());

      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    it('signs fire-and-forget when a successful response flags renewalDue, without waiting for it before returning', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        if ('inputMessage' in JSON.parse(init.body)) {
          return { ok: true, json: async () => ({ ...rankedResponse(), renewalDue: true }) };
        }
        return { ok: true, json: async () => rankedResponse() };
      });
      // Deliberately left pending until after the assertions below -- if
      // selectRoute incorrectly awaited this before returning, `result`
      // would never be reached within the test's own timeout.
      let resolveSign!: () => void;
      const signDailyIfNeeded = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveSign = resolve; }));
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences());

      expect(result).not.toBeNull();
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
      resolveSign();
    });

    it('does not sign when the response has no renewalDue flag', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences());

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('gates renewalDue-triggered signing on dayPassOnDemandEnabled, same as the 402 path', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        if ('inputMessage' in JSON.parse(init.body)) {
          return { ok: true, json: async () => ({ ...rankedResponse(), renewalDue: true }) };
        }
        return { ok: true, json: async () => rankedResponse() };
      });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('signs after a 402, then retries the exact same call once -- never signs ahead of one', async () => {
      const order: string[] = [];
      let routeCalls = 0;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        // Only the routing call (carries inputMessage) is the "fetch" this
        // test cares about ordering against sign -- the digest submission
        // fires alongside it but isn't part of what this test verifies.
        if ('inputMessage' in JSON.parse(init.body)) {
          routeCalls += 1;
          order.push(`fetch${routeCalls}`);
          if (routeCalls === 1) return { ok: false, status: 402, json: async () => ({ error: { message: 'No current day pass.' } }) };
        }
        return { ok: true, json: async () => rankedResponse() };
      });
      const signDailyIfNeeded = vi.fn().mockImplementation(async () => { order.push('sign'); });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences());

      expect(order).toEqual(['fetch1', 'sign', 'fetch2']);
    });

    it('signs a FRESH route-auth nonce for the post-402 retry, not the already-burned one from attempt #1 (real incident: this blocked every brand-new buyer\'s first request)', async () => {
      const fetchImpl = fetchWithPaymentRequired(1); // 402s once, then always succeeds
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      let nonceCounter = 0;
      const signRouteAuth = vi.fn().mockImplementation(async () => ({
        buyer: '0x' + 'cc'.repeat(20),
        issuedAt: 1_700_000_000,
        nonce: '0x' + String(++nonceCounter).padStart(64, '0'),
        signature: '0xsig',
      }));
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      router.configureRouteAuthSigning(signRouteAuth);

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences());

      // A single nonce reused across both attempts is exactly the bug: the
      // routing peer's replay check burns it on the first (402-rejected)
      // attempt, so the retry -- sent right after signing the day pass for
      // real -- gets rejected as a replay before the now-passing day-pass
      // gate is ever reached. (signRouteAuth is also called once more for
      // the unrelated fire-and-forget daily digest request, which shares
      // the same buildRouteAuthHeaders() helper -- not asserted here.)
      const routeFetchCalls = fetchImpl.mock.calls.filter(([, init]: [string, { body: string }]) => (
        'inputMessage' in JSON.parse(init.body)
      ));
      expect(routeFetchCalls).toHaveLength(2);
      const nonce1 = (routeFetchCalls[0]![1] as { headers: Record<string, string> }).headers['x-antseed-route-auth-nonce'];
      const nonce2 = (routeFetchCalls[1]![1] as { headers: Record<string, string> }).headers['x-antseed-route-auth-nonce'];
      expect(nonce1).not.toBe(nonce2);
    });

    it('does not attempt to sign for a non-402 rejection (nothing about it implies a lapsed day pass)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false, status: 500,
        json: async () => ({ error: { message: 'Internal error.' } }),
      });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences())).rejects.toMatchObject({ statusCode: 500 });

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('signs exactly once and retries exactly once on a persistent 402, then throws if still unpaid', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false, status: 402,
        json: async () => ({ error: { message: 'No current day pass.' } }),
      });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences())).rejects.toMatchObject({ statusCode: 402 });

      expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
    });

    it('does not sign at all for a pinned tool-loop continuation (no network call to gate)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const conv = conversation();

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), [peer('0xAAA')], conv, enabledPreferences());
      signDailyIfNeeded.mockClear();
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'hello'), [peer('0xAAA')], conv, enabledPreferences()); // same message -- pinned

      expect(signDailyIfNeeded).not.toHaveBeenCalled();
    });

    it('does nothing when signDailyIfNeeded is not configured (no payment wiring yet)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
      expect(result).not.toBeNull();
    });
  });

  describe('configureDailySigning', () => {
    it('configureDailySigning wires a callback that was never provided at construction', async () => {
      const fetchImpl = fetchWithPaymentRequired(0); // never 402s -- proves the "not wired" call really can't sign
      const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, enabledPreferences());
      expect(signDailyIfNeeded).not.toHaveBeenCalled(); // not wired yet

      router.configureDailySigning(signDailyIfNeeded);
      const fetchImpl402 = fetchWithPaymentRequired(1);
      const router2 = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl402 as unknown as typeof fetch,
      });
      router2.configureDailySigning(signDailyIfNeeded);
      await router2.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'a new message'), [peer('0xAAA')], null, enabledPreferences());
      expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
    });

    describe('day-pass-enable gate', () => {
      it('selectRoute never signs when dayPassOnDemandEnabled is false, even though the seller asked for payment', async () => {
        const fetchImpl = fetchWithPaymentRequired(Infinity); // always 402s -- signing is blocked, so it never clears
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await expect(router.selectRoute(
          req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null,
          { ...enabledPreferences(), dayPassOnDemandEnabled: false },
        )).rejects.toMatchObject({ statusCode: 402 }); // never retried, so the 402 surfaces as-is

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('selectRoute never signs when routingPreferences is null (no consent ever seen -- must not default to "yes")', async () => {
        const fetchImpl = fetchWithPaymentRequired(Infinity); // always 402s -- signing is blocked, so it never clears
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('selectRoute never signs when dayPassOnDemandEnabled is false via a cached updateRoutingPreferences push (not just a direct parameter)', async () => {
        const fetchImpl = fetchWithPaymentRequired(Infinity); // always 402s -- signing is blocked, so it never clears
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        router.updateRoutingPreferences({ ...enabledPreferences(), dayPassOnDemandEnabled: false });

        await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('turning the toggle on via updateRoutingPreferences unblocks signing for a subsequent selectRoute call', async () => {
        // Calls 1-2: the first selectRoute (blocked) 402s, retries, 402s again.
        // Call 3: the second selectRoute's first attempt also 402s, this time
        // triggering a real sign; call 4 (its retry) succeeds.
        const fetchImpl = fetchWithPaymentRequired(3);
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        router.updateRoutingPreferences({ ...enabledPreferences(), dayPassOnDemandEnabled: false });
        await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });
        expect(signDailyIfNeeded).not.toHaveBeenCalled();

        router.updateRoutingPreferences({ ...enabledPreferences(), dayPassOnDemandEnabled: true });
        await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
        expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
        expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
      });

      // Regression: a buyer trying to stop billing reasonably reached for
      // the standing "Auto select seller" switch instead of the separate
      // control that actually owns dayPassOnDemandEnabled, and billing
      // kept running because nothing checked it. autoRouting must now stop
      // signing too, same as dayPassOnDemandEnabled itself.
      it('selectRoute never signs when autoRouting is explicitly false, even with dayPassOnDemandEnabled true, pushed via updateRoutingPreferences', async () => {
        const fetchImpl = fetchWithPaymentRequired(Infinity); // always 402s -- signing is blocked, so it never clears
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        router.updateRoutingPreferences({ ...enabledPreferences(), autoRouting: false });

        await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('selectRoute never signs when autoRouting is explicitly false', async () => {
        const fetchImpl = fetchWithPaymentRequired(Infinity); // always 402s -- signing is blocked, so it never clears
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await expect(router.selectRoute(
          req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null,
          { ...enabledPreferences(), autoRouting: false },
        )).resolves.toEqual([]);

        expect(signDailyIfNeeded).not.toHaveBeenCalled();
      });

      it('autoRouting absent (a caller that never sends it) does not block signing -- only an explicit false does', async () => {
        const fetchImpl = fetchWithPaymentRequired(1);
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const { autoRouting: _omit, ...prefsWithoutAutoRouting } = { ...enabledPreferences(), autoRouting: true };
        router.updateRoutingPreferences(prefsWithoutAutoRouting);

        await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);

        expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
      });

      it('turning autoRouting back on via updateRoutingPreferences unblocks signing for a subsequent selectRoute call', async () => {
        // Calls 1-2: the first selectRoute (blocked) 402s, retries, 402s again.
        // Call 3: the second selectRoute's first attempt also 402s, this time
        // triggering a real sign; call 4 (its retry) succeeds.
        const fetchImpl = fetchWithPaymentRequired(3);
        const signDailyIfNeeded = vi.fn().mockResolvedValue(undefined);
        const router = new LevantoRouter({
          routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', signDailyIfNeeded,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        router.updateRoutingPreferences({ ...enabledPreferences(), autoRouting: false });
        await expect(router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null)).rejects.toMatchObject({ statusCode: 402 });
        expect(signDailyIfNeeded).not.toHaveBeenCalled();

        router.updateRoutingPreferences({ ...enabledPreferences(), autoRouting: true });
        await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
        expect(signDailyIfNeeded).toHaveBeenCalledTimes(1);
        expect(signDailyIfNeeded).toHaveBeenCalledWith('0xSELLER');
      });
    });
  });

  describe('daily digest', () => {
    function digestAwareFetch(routeHandler: () => unknown) {
      return vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) {
          return { ok: true, json: async () => routeHandler() };
        }
        return { ok: true, json: async () => ({ accepted: true }) };
      });
    }

    it('sends a digest as its own request, once per calendar day, alongside signing', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'first'), [peer('0xAAA')], conversation('a'), null);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // one digest submission, one routing call

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'second'), [peer('0xAAA')], conversation('b'), null);
      expect(fetchImpl).toHaveBeenCalledTimes(3); // no repeat digest send same day
    });

    it('sends the digest to the explicit /_antseed/route/digest suffix path, not the routing path', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], conversation('a'), null);

      const calledUrls = fetchImpl.mock.calls.map((call: unknown[]) => call[0]);
      expect(calledUrls).toContain('http://x/_antseed/route'); // the routing call
      expect(calledUrls).toContain('http://x/_antseed/route/digest'); // the digest, at its own path
    });

    it('does not send a digest when there is no sellerPeerId to send it to', async () => {
      const fetchImpl = digestAwareFetch(rankedResponse);
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // routing call only
    });

    it('a failed digest send never blocks or fails the routing call itself', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) return { ok: true, json: async () => rankedResponse() };
        throw new Error('digest endpoint unreachable');
      });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
      expect(result).not.toBeNull();
      expect(result?.[0]?.serviceId).toBe('gpt-5.6-luna');
    });

    it('retries the digest send on a later call if the earlier attempt failed', async () => {
      let digestCalls = 0;
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        const parsedBody = JSON.parse(init.body);
        if ('inputMessage' in parsedBody) return { ok: true, json: async () => rankedResponse() };
        digestCalls += 1;
        if (digestCalls === 1) throw new Error('digest endpoint unreachable');
        return { ok: true, json: async () => ({ accepted: true }) };
      });
      const router = new LevantoRouter({
        routingPeerUrl: 'http://x', sellerPeerId: '0xSELLER', fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'first'), [peer('0xAAA')], conversation('a'), null);
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'second'), [peer('0xAAA')], conversation('b'), null);
      expect(digestCalls).toBe(2); // first attempt failed, second call retried it
    });
  });

  describe('routing_decisions ledger', () => {
    it('writes a row once onResult reports the resolved decision, joining predicted and actual', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
      expect(router.getLedgerRows()).toHaveLength(0); // nothing until onResult

      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 250, tokens: 140,
        freshInputTokens: 90, cachedInputTokens: 18, outputTokens: 42, estimatedCostUsd: 0.0011,
        requestId: 'r1', // matches req()'s fixed requestId
      });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actualModel: 'gpt-5.6-luna',
        actualPeer: '0xAAA',
        actualPromptTokens: 108, // fresh + cached
        actualCachedTokens: 18,
        actualCompletionTokens: 42,
        actualUsdcPaid: 0.0011,
        predictedCostUsd: 0.0012,
        predictedInputTokens: 100,
        predictedCachedInputTokens: 20,
        predictedOutputTokens: 45,
        cqt: 5,
      });
      expect(rows[0]?.routingLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('populates baselinePrices for every ranked model, collapsed across peers to the cheapest input price', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
            // Two sellers of the same model -- the cheaper one (0xCCC) should win.
            { model: 'claude-opus-5', peer: '0xBBB', estimate: { costUsd: 0.02, inputTokens: 100, cachedInputTokens: 0, outputTokens: 45 },
              price: { inUsdPerM: 16, outUsdPerM: 80, cachedInUsdPerM: 1.6 } },
            { model: 'claude-opus-5', peer: '0xCCC', estimate: { costUsd: 0.018, inputTokens: 100, cachedInputTokens: 0, outputTokens: 45 },
              price: { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: 0 } },
            // gpt-5.6-sol is NOT offered at all this call.
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA'), peer('0xBBB'), peer('0xCCC')], null, null);
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 10, tokens: 10, requestId: 'r1' });

      const row = router.getLedgerRows()[0];
      // Every distinct model actually ranked gets a snapshot -- not a curated
      // subset -- so a future comparison dropdown can price any of them.
      expect(row?.baselinePrices).toEqual({
        'gpt-5.6-luna': { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 },
        'claude-opus-5': { inUsdPerM: 15, outUsdPerM: 75, cachedInUsdPerM: null }, // 0xCCC wins (cheaper), 0 -> null
      });
      expect(row?.baselinePrices['gpt-5.6-sol']).toBeUndefined(); // never offered -- absent, not fabricated
    });

    it('records the top considered candidates in the peer\'s own ranked order, and a trimmed input-message preview', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 5, outUsdPerM: 20, cachedInUsdPerM: 1.25 } },
            { model: 'kimi-k3', peer: '0xBBB', estimate: { costUsd: 0.0002, inputTokens: 100, cachedInputTokens: 0, outputTokens: 45 },
              price: { inUsdPerM: 0.6, outUsdPerM: 2.5, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID, 'what is the capital of France?'), [peer('0xAAA'), peer('0xBBB')], null, null);
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 10, tokens: 10, requestId: 'r1' });

      const row = router.getLedgerRows()[0];
      // Peer's own order preserved, not re-sorted by price (0xAAA first even
      // though its input price is higher than 0xBBB's).
      expect(row?.consideredCandidates).toEqual([
        { model: 'gpt-5.6-luna', peer: '0xAAA', inUsdPerM: 5, outUsdPerM: 20, cachedInUsdPerM: 1.25 },
        { model: 'kimi-k3', peer: '0xBBB', inUsdPerM: 0.6, outUsdPerM: 2.5, cachedInUsdPerM: null }, // 0 -> null
      ]);
      expect(row?.inputMessagePreview).toBe('what is the capital of France?');
    });

    it('does not write a row for a failed dispatch', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => rankedResponse() });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), [peer('0xAAA')], null, null);
      router.onResult(peer('0xAAA'), { success: false, latencyMs: 100, tokens: 0 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('does not write a row for an onResult carrying no requestId at all (nothing to correlate against)', () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      router.onResult(peer('0xUNRELATED'), { success: true, latencyMs: 10, tokens: 5 });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('does not write a row for an onResult whose requestId matches no pending decision', () => {
      const router = new LevantoRouter({ routingPeerUrl: 'http://x' });
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 10, tokens: 5, requestId: 'never-routed' });
      expect(router.getLedgerRows()).toHaveLength(0);
    });

    it('correctly pairs two concurrent requests to the same peer by requestId, not peer alone', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => ({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: JSON.parse(init.body).inputMessage === 'first' ? 0.001 : 0.002, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      }));
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });

      // Two different conversations, both routed to peer 0xAAA, before either resolves.
      const reqA: SerializedHttpRequest = { ...req(LEVANTO_AUTO_SERVICE_ID, 'first'), requestId: 'req-A' };
      const reqB: SerializedHttpRequest = { ...req(LEVANTO_AUTO_SERVICE_ID, 'second'), requestId: 'req-B' };
      await router.selectRoute(reqA, [peer('0xAAA')], conversation('conv-a'), null);
      await router.selectRoute(reqB, [peer('0xAAA')], conversation('conv-b'), null);

      // Resolve out of order: B's real outcome arrives before A's.
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 50, tokens: 10, estimatedCostUsd: 0.0025, requestId: 'req-B' });
      router.onResult(peer('0xAAA'), { success: true, latencyMs: 40, tokens: 10, estimatedCostUsd: 0.0015, requestId: 'req-A' });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(2);
      const rowA = rows.find((r) => r.actualUsdcPaid === 0.0015);
      const rowB = rows.find((r) => r.actualUsdcPaid === 0.0025);
      // Each result must be paired with ITS OWN request's predicted cost, not the other's.
      expect(rowA?.predictedCostUsd).toBe(0.001);
      expect(rowB?.predictedCostUsd).toBe(0.002);
    });

    it('writes a pinned continuation without reusing stale token and cost predictions', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.0012, inputTokens: 100, cachedInputTokens: 20, outputTokens: 45 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0.02 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const conv = conversation('sess-1');

      // Real decision: a genuine new user message, network call fires.
      const realReq: SerializedHttpRequest = { ...req(LEVANTO_AUTO_SERVICE_ID, 'hello'), requestId: 'req-real' };
      await router.selectRoute(realReq, [peer('0xAAA')], conv, null);
      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 250, tokens: 140,
        freshInputTokens: 90, cachedInputTokens: 18, outputTokens: 42, estimatedCostUsd: 0.0011,
        requestId: 'req-real',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Tool-loop continuation: same last user message, no new network call,
      // but a real dispatch with its own requestId and its own eventual outcome.
      const pinnedReq: SerializedHttpRequest = { ...req(LEVANTO_AUTO_SERVICE_ID, 'hello'), requestId: 'req-pinned' };
      const candidates = await router.selectRoute(pinnedReq, [peer('0xAAA')], conv, null);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // still no new network call
      expect(candidates).toHaveLength(1);

      router.onResult(peer('0xAAA'), {
        success: true, latencyMs: 5, tokens: 30,
        freshInputTokens: 0, cachedInputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.0003,
        requestId: 'req-pinned',
      });

      const rows = router.getLedgerRows();
      expect(rows).toHaveLength(2);
      const pinnedRow = rows.find((r) => r.actualUsdcPaid === 0.0003);
      expect(pinnedRow).toBeDefined();
      // Reuses the real decision's predicted fields (same model/cost/cqt prediction)...
      expect(pinnedRow?.actualModel).toBe('gpt-5.6-luna');
      expect(pinnedRow?.predictedCostUsd).toBeNull();
      expect(pinnedRow?.predictedInputTokens).toBeNull();
      expect(pinnedRow?.cqt).toBe(5);
      // ...but records its OWN actual outcome, and null latency (gate skipped the call).
      expect(pinnedRow?.actualUsdcPaid).toBe(0.0003);
      expect(pinnedRow?.routingLatencyMs).toBeNull();
      // No fresh routing call to draw candidates from -- honest empty, not a
      // stale copy of the real decision's ranked response.
      expect(pinnedRow?.consideredCandidates).toEqual([]);
      // The prompt itself is still known (same last user message, no network
      // call needed to read it), so the preview is still recorded.
      expect(pinnedRow?.inputMessagePreview).toBe('hello');
    });
  });

  describe('allowedPeerIds re-filter', () => {
    it('keeps only ranked candidates inside the allowlist', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
            { model: 'kimi-k3', peer: '0xBBB', estimate: { costUsd: 0.0005, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.1, outUsdPerM: 0.5, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xBBB')];

      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), peers, null, { allowedPeerIds: ['0xBBB'] });

      expect(result).toHaveLength(1);
      expect(result?.[0]?.peerId).toBe('0xBBB');
    });

    it('falls back to the allowed peers directly, paired with defaultRoutedModel, when the walk exhausts the ranked list', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      // 0xCCC is allowed but never appeared in the ranked list.
      const peers = [peer('0xAAA'), peer('0xCCC')];

      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), peers, null, { allowedPeerIds: ['0xCCC'] }, 'gpt-4o');

      expect(result).toHaveLength(1);
      expect(result?.[0]?.peerId).toBe('0xCCC');
      expect(result?.[0]?.serviceId).toBe('gpt-4o'); // defaultRoutedModel, the buyer's own fallback target
      expect(result?.[0]?.inputUsdPerMillion).toBeNull(); // no real price data for this synthesized pair
    });

    it('returns an unavailable selection when no eligible ranked route exists', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => rankedResponse({
          ranked: [
            { model: 'gpt-5.6-luna', peer: '0xAAA', estimate: { costUsd: 0.001, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 },
              price: { inUsdPerM: 0.2, outUsdPerM: 1.1, cachedInUsdPerM: 0 } },
          ],
        }),
      });
      const router = new LevantoRouter({ routingPeerUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
      const peers = [peer('0xAAA'), peer('0xCCC')];

      // No 5th arg -- no default route configured for this buyer.
      const result = await router.selectRoute(req(LEVANTO_AUTO_SERVICE_ID), peers, null, { allowedPeerIds: ['0xCCC'] });

      expect(result).toEqual([]);
    });
  });
});
