import { Signature, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import { DelegationMux } from '../src/verification/delegation-mux.js';
import {
  decodeDelegateHello,
  decodeDelegateVoucher,
  decodeProbeJobRequest,
  decodeProbeJobResult,
  encodeDelegateHello,
  encodeDelegateVoucher,
  encodeProbeJobRequest,
  encodeProbeJobResult,
} from '../src/verification/delegation-codec.js';
import {
  makeVerifierRegistryDomain,
  recoverDelegateVoucherSigner,
  signDelegateVoucher,
  type DelegateVoucherMessage,
} from '../src/payments/evm/verifier-client.js';
import { decodeFrame } from '../src/p2p/message-protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';
import type { ProbeJobRequestPayload, ProbeJobResultPayload } from '../src/types/protocol.js';
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
  it('round-trips hello, voucher, job, and result payloads', () => {
    const hello = { version: 1 as const, maxConcurrentJobs: 3 };
    expect(decodeDelegateHello(encodeDelegateHello(hello))).toEqual(hello);

    const voucher = {
      version: 1 as const,
      chainId: 8453,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 7,
      nonce: '12345678901234567890',
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(128) + '1b',
    };
    expect(decodeDelegateVoucher(encodeDelegateVoucher(voucher))).toEqual(voucher);

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
    expect(() => decodeDelegateVoucher(new TextEncoder().encode('{"version":1,"buyer":"0xabc"}'))).toThrow();
  });

  it('shape-validates voucher hex fields at decode', () => {
    const voucher = {
      version: 1 as const,
      chainId: 8453,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 7,
      nonce: '1',
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(128) + '1b',
    };
    const encode = (over: Record<string, unknown>): Uint8Array =>
      new TextEncoder().encode(JSON.stringify({ ...voucher, ...over }));

    expect(decodeDelegateVoucher(encode({}))).toEqual(voucher);
    // EIP-2098 compact (64-byte) signatures are accepted on the wire but
    // always come back in canonical 65-byte (r,s,v) form.
    const fromCompact = decodeDelegateVoucher(encode({ signature: '0x' + '5'.repeat(128) }));
    expect((fromCompact.signature.length - 2) / 2).toBe(65);

    expect(() => decodeDelegateVoucher(encode({ registry: '0x' + 'e'.repeat(38) }))).toThrow(/registry/);
    expect(() => decodeDelegateVoucher(encode({ buyer: 'a'.repeat(42) }))).toThrow(/buyer/);
    expect(() => decodeDelegateVoucher(encode({ probeCommitment: '0xcafe' }))).toThrow(/probeCommitment/);
    expect(() => decodeDelegateVoucher(encode({ probeCommitment: '0x' + 'g'.repeat(64) }))).toThrow(/probeCommitment/);
    expect(() => decodeDelegateVoucher(encode({ signature: '0x' + '5'.repeat(131) }))).toThrow(/signature/);
    // Signatures the on-chain claim would reject fail at decode: malleable
    // high-s (top bit of s set) and an invalid v byte.
    expect(() => decodeDelegateVoucher(encode({
      signature: '0x' + '1'.repeat(64) + 'f' + '5'.repeat(63) + '1b',
    }))).toThrow(/signature/);
    expect(() => decodeDelegateVoucher(encode({ signature: '0x' + '5'.repeat(128) + '05' }))).toThrow(/signature/);
  });

  it('normalizes an EIP-2098 compact voucher signature to the on-chain-claimable form', async () => {
    // A greedy verifier could sign vouchers in compact form: ethers'
    // verifyTypedData recovers the right signer from it, so the voucher
    // passes every delegate-side check — but the contract's
    // ECDSA.recover(bytes32,bytes) reverts on 64-byte signatures, making the
    // persisted voucher worthless at claim time. Decode must therefore hand
    // the caller the canonical 65-byte serialization.
    const wallet = new Wallet('0x' + '7'.repeat(64));
    const registry = '0x' + 'e'.repeat(40);
    const domain = makeVerifierRegistryDomain(8453, registry);
    const msg: DelegateVoucherMessage = {
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 7,
      nonce: 1n,
      deadline: 1_800_000_000,
    };
    const canonical = await signDelegateVoucher(wallet, domain, msg);
    const compact = Signature.from(canonical).compactSerialized;
    expect((compact.length - 2) / 2).toBe(64);
    // The delegate-side recovery helper refuses the compact form outright —
    // it must never bless a signature the contract would revert on.
    expect(() => recoverDelegateVoucherSigner(domain, msg, compact)).toThrow(/65-byte/);

    const decoded = decodeDelegateVoucher(encodeDelegateVoucher({
      version: 1,
      chainId: 8453,
      registry,
      buyer: msg.buyer,
      probeCommitment: msg.probeCommitment,
      credits: msg.credits,
      nonce: '1',
      deadline: msg.deadline,
      signature: compact,
    }));

    expect(decoded.signature).toBe(canonical);
    expect((decoded.signature.length - 2) / 2).toBe(65);
    // The normalized form still recovers the verifier that signed it.
    expect(recoverDelegateVoucherSigner(domain, msg, decoded.signature)).toBe(wallet.address);
  });

  it('rejects oversize control payloads at decode', () => {
    const oversize = new TextEncoder().encode(JSON.stringify({
      version: 1,
      chainId: 8453,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 7,
      nonce: '9'.repeat(17 * 1024),
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(128) + '1b',
    }));
    expect(oversize.length).toBeGreaterThan(16 * 1024);
    expect(() => decodeDelegateVoucher(oversize)).toThrow(/too large/);
    expect(() => decodeDelegateHello(oversize)).toThrow(/too large/);
  });

  it('rejects oversize control payloads at encode (symmetric with decode)', () => {
    const hugeNonce = '9'.repeat(17 * 1024);
    expect(() => encodeDelegateVoucher({
      version: 1,
      chainId: 8453,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + '4'.repeat(64),
      credits: 7,
      nonce: hugeNonce,
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(128) + '1b',
    })).toThrow(/too large/);
    expect(() => encodeDelegateHello({ version: 1, maxConcurrentJobs: 1 })).not.toThrow();
  });

  it('claims the 0x90-0x9F range', () => {
    expect(DelegationMux.isDelegationMessage(MessageType.DelegateHello)).toBe(true);
    expect(DelegationMux.isDelegationMessage(MessageType.ProbeJobResult)).toBe(true);
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

  it('delivers vouchers to the delegate handler', async () => {
    const { verifier, delegate } = muxPair();
    const received: string[] = [];
    delegate.onVoucher((voucher) => {
      received.push(`${voucher.probeCommitment}:${voucher.credits}`);
    });

    verifier.sendVoucher({
      version: 1,
      chainId: 8453,
      registry: '0x' + 'e'.repeat(40),
      buyer: '0x' + 'a'.repeat(40),
      probeCommitment: '0x' + 'ca'.repeat(32),
      credits: 2,
      nonce: '1',
      deadline: 1_800_000_000,
      signature: '0x' + '5'.repeat(128) + '1b',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(received).toEqual(['0x' + 'ca'.repeat(32) + ':2']);
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
