import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, type BuyerRequestHandlerConfig } from '../src/buyer-request-handler.js';
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

const STREAM_COST_TRAILER_MAGIC = new TextEncoder().encode('ANTSEED_COST_TRAILER_V1');

function frameCostTrailer(payload: Uint8Array, trailerHeaders: Record<string, string>): Uint8Array {
  const trailer = new TextEncoder().encode(JSON.stringify(trailerHeaders));
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, trailer.length, false);

  const framed = new Uint8Array(payload.length + trailer.length + STREAM_COST_TRAILER_MAGIC.length + 4);
  let offset = 0;
  framed.set(payload, offset);
  offset += payload.length;
  framed.set(trailer, offset);
  offset += trailer.length;
  framed.set(STREAM_COST_TRAILER_MAGIC, offset);
  offset += STREAM_COST_TRAILER_MAGIC.length;
  framed.set(lengthBytes, offset);
  return framed;
}

interface StreamingHarness {
  readonly mux: { cancelProxyRequest: ReturnType<typeof vi.fn> };
  waitUntilRegistered: () => Promise<void>;
  emitStreamingStart: () => void;
  emitChunk: (chunk: SerializedHttpResponseChunk) => void;
}

function createHandler(config: BuyerRequestHandlerConfig): { handler: BuyerRequestHandler; harness: StreamingHarness } {
  let onResponse: ((response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void) | null = null;
  let onChunk: ((chunk: SerializedHttpResponseChunk) => void) | null = null;
  let resolveRegistered: (() => void) | null = null;
  const registered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });

  const mux = {
    sendProxyRequest: vi.fn(
      (
        _request: SerializedHttpRequest,
        responseHandler: (response: SerializedHttpResponse, metadata: { streamingStart: boolean }) => void,
        chunkHandler: (chunk: SerializedHttpResponseChunk) => void,
      ) => {
        onResponse = responseHandler;
        onChunk = chunkHandler;
        resolveRegistered?.();
      },
    ),
    cancelProxyRequest: vi.fn(),
  };

  const handler = new BuyerRequestHandler(config, {
    negotiator: null,
    getConnection: vi.fn(async () => ({ state: 'open' })) as any,
    getMux: vi.fn(() => mux) as any,
    registerPaymentMux: vi.fn(),
  });

  const harness: StreamingHarness = {
    mux,
    waitUntilRegistered: () => registered,
    emitStreamingStart: () => {
      if (!onResponse) throw new Error('stream response handler is not registered');
      onResponse(
        {
          requestId: '',
          statusCode: 200,
          headers: {
            [ANTSEED_STREAMING_RESPONSE_HEADER]: '1',
            'content-type': 'text/event-stream',
          },
          body: new Uint8Array(0),
        },
        { streamingStart: true },
      );
    },
    emitChunk: (chunk) => {
      if (!onChunk) throw new Error('stream chunk handler is not registered');
      onChunk(chunk);
    },
  };

  return { handler, harness };
}

describe('BuyerRequestHandler streaming security guards', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects streaming responses that exceed max buffered size', async () => {
    const requestId = 'stream-size-limit';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 4,
      maxStreamDurationMs: 60_000,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'text/event-stream' },
      body: new Uint8Array(0),
    };

    const promise = handler.sendRequest(peer, request);
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    harness.emitChunk({
      requestId,
      data: new Uint8Array([1, 2, 3, 4, 5]),
      done: false,
    });

    await expect(promise).rejects.toThrow('exceeded max buffered size');
    expect(harness.mux.cancelProxyRequest).toHaveBeenCalledWith(requestId);
  });

  it('rejects streaming responses that exceed max stream duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const requestId = 'stream-duration-limit';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 1024,
      maxStreamDurationMs: 100,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'text/event-stream' },
      body: new Uint8Array(0),
    };

    const promise = handler.sendRequest(peer, request);
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.200Z'));
    harness.emitChunk({
      requestId,
      data: new Uint8Array([1]),
      done: false,
    });

    await expect(promise).rejects.toThrow('exceeded max duration');
    expect(harness.mux.cancelProxyRequest).toHaveBeenCalledWith(requestId);
  });

  it('still reconstructs streamed responses under configured limits', async () => {
    const requestId = 'stream-success';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 1024,
      maxStreamDurationMs: 60_000,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'text/event-stream' },
      body: new Uint8Array(0),
    };

    const promise = handler.sendRequest(peer, request);
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    harness.emitChunk({
      requestId,
      data: new Uint8Array([1, 2]),
      done: false,
    });
    harness.emitChunk({
      requestId,
      data: new Uint8Array([3]),
      done: true,
    });

    const response = await promise;
    expect([...response.body]).toEqual([1, 2, 3]);
  });

  it('preserves binary terminal chunk payload when a framed trailer is appended', async () => {
    const requestId = 'stream-terminal-binary';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 1024,
      maxStreamDurationMs: 60_000,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'application/octet-stream' },
      body: new Uint8Array(0),
    };

    const payload = new Uint8Array([1, 0, 2, 3]);
    const framedDoneChunk = frameCostTrailer(payload, {
      'x-antseed-cost': '42',
      'x-antseed-input-tokens': '7',
    });

    const chunks: Uint8Array[] = [];
    const promise = handler.sendRequest(peer, request, {
      onResponseStart: () => {},
      onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
        if (chunk.data.length > 0) chunks.push(chunk.data);
      },
    });
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    harness.emitChunk({
      requestId,
      data: framedDoneChunk,
      done: true,
    });

    const response = await promise;
    expect([...response.body]).toEqual([1, 0, 2, 3]);
    expect([...chunks[0]!]).toEqual([1, 0, 2, 3]);
    expect(response.headers['x-antseed-cost']).toBe('42');
    expect(response.headers['x-antseed-input-tokens']).toBe('7');
  });

  it('does not treat an unframed final JSON chunk as a trailer', async () => {
    const requestId = 'stream-json-final';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 1024,
      maxStreamDurationMs: 60_000,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'application/json' },
      body: new Uint8Array(0),
    };

    const rawJson = new TextEncoder().encode(JSON.stringify({
      'x-antseed-cost': 'should-stay-in-body',
      ok: true,
    }));

    const promise = handler.sendRequest(peer, request);
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    harness.emitChunk({
      requestId,
      data: rawJson,
      done: true,
    });

    const response = await promise;
    expect(new TextDecoder().decode(response.body)).toBe(new TextDecoder().decode(rawJson));
    expect(response.headers['x-antseed-cost']).toBeUndefined();
  });

  it('does not enforce buffer limit in streaming callback mode', async () => {
    const requestId = 'stream-no-limit';
    const { handler, harness } = createHandler({
      maxStreamBufferBytes: 4,
      maxStreamDurationMs: 60_000,
    });
    const peer = { peerId: 'b'.repeat(40) } as PeerInfo;
    const request: SerializedHttpRequest = {
      requestId,
      method: 'POST',
      path: '/v1/messages',
      headers: { accept: 'text/event-stream' },
      body: new Uint8Array(0),
    };

    const chunks: Uint8Array[] = [];
    const promise = handler.sendRequest(peer, request, {
      onResponseStart: () => {},
      onResponseChunk: (chunk: SerializedHttpResponseChunk) => {
        if (chunk.data.length > 0) chunks.push(chunk.data);
      },
    });
    await harness.waitUntilRegistered();
    harness.emitStreamingStart();
    harness.emitChunk({
      requestId,
      data: new Uint8Array([1, 2, 3, 4, 5]),
      done: false,
    });
    harness.emitChunk({
      requestId,
      data: new Uint8Array([6, 7, 8, 9, 10]),
      done: true,
    });

    const response = await promise;
    expect(response.statusCode).toBe(200);
    expect(chunks.length).toBe(2);
  });
});
