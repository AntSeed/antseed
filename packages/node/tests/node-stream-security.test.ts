import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuyerRequestHandler, type BuyerRequestHandlerConfig } from '../src/buyer-request-handler.js';
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from '../src/types/http.js';
import type { PeerInfo } from '../src/types/peer.js';

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
