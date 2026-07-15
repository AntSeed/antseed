import { describe, expect, it } from 'vitest';
import { DelegationMux } from '../src/verification/delegation-mux.js';
import {
  decodeDelegateHello,
  decodeProbeJobRequest,
  decodeProbeJobResult,
  decodeTargetQuery,
  decodeTargetSuggestion,
  encodeDelegateHello,
  encodeProbeJobRequest,
  encodeProbeJobResult,
  encodeTargetQuery,
  encodeTargetSuggestion,
} from '../src/verification/delegation-codec.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type {
  ProbeJobRequestPayload,
  ProbeJobResultPayload,
  TargetSuggestionPayload,
} from '../src/types/protocol.js';
import { MessageType } from '../src/types/protocol.js';

function jobPayload(overrides?: Partial<ProbeJobRequestPayload>): ProbeJobRequestPayload {
  return {
    version: 1,
    jobId: 'job-1',
    targetPeerId: 'b'.repeat(40),
    service: 'kimi-k2',
    request: {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{"model":"kimi-k2"}').toString('base64'),
    },
    timeoutMs: 30_000,
    ...overrides,
  };
}

/** Two muxes wired back-to-back through in-memory frame delivery. */
function muxPair(): { verifier: DelegationMux; delegate: DelegationMux } {
  let verifier!: DelegationMux;
  let delegate!: DelegationMux;
  const pipeTo = (target: () => DelegationMux) => (data: Uint8Array): void => {
    const decoded = decodeFrame(data);
    if (!decoded) throw new Error('incomplete frame in test pipe');
    void target().handleFrame(decoded.message);
  };
  verifier = new DelegationMux({ send: pipeTo(() => delegate) } as unknown as PeerConnection);
  delegate = new DelegationMux({ send: pipeTo(() => verifier) } as unknown as PeerConnection);
  return { verifier, delegate };
}

describe('delegation codec', () => {
  it('round-trips hello, job, and result payloads', () => {
    const hello = { version: 1 as const, maxConcurrentJobs: 3 };
    expect(decodeDelegateHello(encodeDelegateHello(hello))).toEqual(hello);

    const job = jobPayload();
    expect(decodeProbeJobRequest(encodeProbeJobRequest(job))).toEqual(job);

    const result: ProbeJobResultPayload = {
      version: 1,
      jobId: 'job-1',
      status: 'ok',
      response: {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"choices":[]}').toString('base64'),
      },
      responseAuth: {
        version: 1,
        requestId: 'req-1',
        buyerPeerId: 'a'.repeat(40),
        sellerPeerId: 'b'.repeat(40),
        advertisedService: 'kimi-k2',
        provider: 'openai',
        statusCode: 200,
        requestHash: '0x' + '1'.repeat(64),
        responseHash: '0x' + '2'.repeat(64),
        responseStartedAt: 1,
        responseCompletedAt: 2,
        signature: '0x' + '3'.repeat(130),
      },
    };
    expect(decodeProbeJobResult(encodeProbeJobResult(result))).toEqual(result);
  });

  it('rejects malformed payloads', () => {
    expect(() => decodeDelegateHello(new TextEncoder().encode('{"version":2}'))).toThrow(/version/);
    expect(() => decodeProbeJobResult(new TextEncoder().encode('{"version":1,"jobId":"j","status":"maybe"}'))).toThrow(/status/);
    expect(() => decodeProbeJobRequest(new TextEncoder().encode('{"version":1,"jobId":"j"}'))).toThrow();
  });

  it('round-trips target query and suggestion payloads', () => {
    const query = { version: 1 as const, queryId: 'q-1', service: 'kimi-k2' };
    expect(decodeTargetQuery(encodeTargetQuery(query))).toEqual(query);

    const suggestion: TargetSuggestionPayload = {
      version: 1,
      queryId: 'q-1',
      service: 'kimi-k2',
      sellers: [
        { peerId: 'b'.repeat(40), agentId: 7 },
        { peerId: 'c'.repeat(40), agentId: 42 },
      ],
    };
    expect(decodeTargetSuggestion(encodeTargetSuggestion(suggestion))).toEqual(suggestion);

    const empty: TargetSuggestionPayload = { version: 1, queryId: 'q-2', service: 'kimi-k2', sellers: [] };
    expect(decodeTargetSuggestion(encodeTargetSuggestion(empty))).toEqual(empty);
  });

  it('rejects malformed target query and suggestion payloads', () => {
    const encode = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

    expect(() => decodeTargetQuery(encode({ version: 2, queryId: 'q', service: 's' }))).toThrow(/version/);
    expect(() => decodeTargetQuery(encode({ version: 1, service: 's' }))).toThrow(/queryId/);
    expect(() => decodeTargetQuery(encode({ version: 1, queryId: 'q' }))).toThrow(/service/);

    expect(() => decodeTargetSuggestion(encode({ version: 1, queryId: 'q', service: 's' }))).toThrow(/sellers/);
    expect(() => decodeTargetSuggestion(encode({ version: 1, queryId: 'q', service: 's', sellers: 'nope' }))).toThrow(/sellers/);
    expect(() => decodeTargetSuggestion(encode({
      version: 1, queryId: 'q', service: 's', sellers: ['nope'],
    }))).toThrow(/sellers\[0\]/);
    expect(() => decodeTargetSuggestion(encode({
      version: 1, queryId: 'q', service: 's', sellers: [{ peerId: 'p' }],
    }))).toThrow(/agentId/);
    expect(() => decodeTargetSuggestion(encode({
      version: 1, queryId: 'q', service: 's', sellers: [{ peerId: 'p', agentId: 'not-a-number' }],
    }))).toThrow(/agentId/);
    expect(() => decodeTargetSuggestion(encode({
      version: 1, queryId: 'q', service: 's', sellers: [{ agentId: 3 }],
    }))).toThrow(/peerId/);
  });

  it('rejects oversize target payloads at encode and decode (control-size cap)', () => {
    const sellers = Array.from({ length: 400 }, (_, i) => ({ peerId: 'a'.repeat(40) + String(i), agentId: i }));
    const oversize: TargetSuggestionPayload = { version: 1, queryId: 'q', service: 's', sellers };
    expect(() => encodeTargetSuggestion(oversize)).toThrow(/too large/);
    expect(() => decodeTargetSuggestion(new TextEncoder().encode(JSON.stringify(oversize)))).toThrow(/too large/);
  });

  it('rejects oversize control payloads at decode', () => {
    const oversize = new TextEncoder().encode(JSON.stringify({
      version: 1,
      queryId: '9'.repeat(17 * 1024),
      service: 'kimi-k2',
    }));
    expect(oversize.length).toBeGreaterThan(16 * 1024);
    expect(() => decodeTargetQuery(oversize)).toThrow(/too large/);
    expect(() => decodeDelegateHello(oversize)).toThrow(/too large/);
  });

  it('claims the 0x90-0x9F range', () => {
    expect(DelegationMux.isDelegationMessage(MessageType.DelegateHello)).toBe(true);
    expect(DelegationMux.isDelegationMessage(MessageType.ProbeJobResult)).toBe(true);
    expect(DelegationMux.isDelegationMessage(MessageType.TargetQuery)).toBe(true);
    expect(DelegationMux.isDelegationMessage(MessageType.TargetSuggestion)).toBe(true);
    expect(DelegationMux.isDelegationMessage(MessageType.VerificationResponseAuth)).toBe(false);
    expect(DelegationMux.isDelegationMessage(MessageType.HttpRequest)).toBe(false);
  });
});

describe('DelegationMux', () => {
  it('registers a delegate via hello/welcome', async () => {
    const { verifier, delegate } = muxPair();
    const hellos: number[] = [];
    verifier.onHello((hello) => {
      hellos.push(hello.maxConcurrentJobs ?? 0);
      verifier.sendWelcome({ version: 1, accepted: true });
    });

    const welcomePromise = delegate.waitForWelcome(1_000);
    delegate.sendHello({ version: 1, maxConcurrentJobs: 3 });
    const welcome = await welcomePromise;

    expect(hellos).toEqual([3]);
    expect(welcome.accepted).toBe(true);
  });

  it('invokes the onWelcome observer synchronously, before the waitForWelcome microtask', async () => {
    const { verifier, delegate } = muxPair();
    const order: string[] = [];
    delegate.onWelcome((welcome) => order.push(`observer:${welcome.accepted}`));
    const waited = delegate.waitForWelcome(1_000).then(() => order.push('waiter'));

    verifier.sendWelcome({ version: 1, accepted: true });
    // The observer must have fired during the synchronous frame dispatch;
    // the promise waiter only resumes on a later microtask.
    order.push('after-send');
    await waited;

    expect(order).toEqual(['observer:true', 'after-send', 'waiter']);
  });

  it('correlates job results by jobId', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onJob((job) => {
      delegate.sendResult({ version: 1, jobId: job.jobId, status: 'error', error: `echo:${job.jobId}` });
    });

    const [a, b] = await Promise.all([
      verifier.runJob(jobPayload({ jobId: 'job-a' }), 1_000),
      verifier.runJob(jobPayload({ jobId: 'job-b' }), 1_000),
    ]);
    expect(a.error).toBe('echo:job-a');
    expect(b.error).toBe('echo:job-b');
  });

  it('correlates target suggestions by queryId', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onTargetQuery((query) => {
      delegate.sendTargetSuggestion({
        version: 1,
        queryId: query.queryId,
        service: query.service,
        sellers: [{ peerId: 'b'.repeat(40), agentId: 7 }],
      });
    });

    const [a, b] = await Promise.all([
      verifier.runTargetQuery({ version: 1, queryId: 'q-a', service: 'kimi-k2' }, 1_000),
      verifier.runTargetQuery({ version: 1, queryId: 'q-b', service: 'kimi-k2' }, 1_000),
    ]);
    expect(a.queryId).toBe('q-a');
    expect(b.queryId).toBe('q-b');
    expect(a.sellers).toEqual([{ peerId: 'b'.repeat(40), agentId: 7 }]);
  });

  it('times out target queries the delegate never answers', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onTargetQuery(() => { /* swallow */ });
    await expect(verifier.runTargetQuery({ version: 1, queryId: 'q-slow', service: 's' }, 50))
      .rejects.toThrow(/timed out/);
  });

  it('answers with an empty suggestion when no target-query handler is registered', async () => {
    const { verifier } = muxPair();
    const suggestion = await verifier.runTargetQuery({ version: 1, queryId: 'q-x', service: 'kimi-k2' }, 1_000);
    expect(suggestion.queryId).toBe('q-x');
    expect(suggestion.service).toBe('kimi-k2');
    expect(suggestion.sellers).toEqual([]);
  });

  it('rejects pending target queries on close', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onTargetQuery(() => { /* never answers */ });
    const pending = verifier.runTargetQuery({ version: 1, queryId: 'q-c', service: 's' }, 60_000);
    verifier.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it('times out jobs the delegate never answers', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onJob(() => { /* swallow */ });
    await expect(verifier.runJob(jobPayload({ jobId: 'job-slow' }), 50)).rejects.toThrow(/timed out/);
  });

  it('reports an error result when no job handler is registered', async () => {
    const { verifier } = muxPair();
    const result = await verifier.runJob(jobPayload({ jobId: 'job-x' }), 1_000);
    expect(result.status).toBe('error');
    expect(result.error).toBe('no_job_handler');
  });

  it('rejects pending jobs on close', async () => {
    const { verifier, delegate } = muxPair();
    delegate.onJob(() => { /* never answers */ });
    const pending = verifier.runJob(jobPayload({ jobId: 'job-c' }), 60_000);
    verifier.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
