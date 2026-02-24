import { describe, it, expect } from 'vitest';
import {
  encodeHttpRequest,
  decodeHttpRequest,
  encodeHttpResponse,
  decodeHttpResponse,
  encodeHttpResponseChunk,
  decodeHttpResponseChunk,
} from '../src/proxy/request-codec.js';
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from '../src/types/http.js';

describe('HTTP Request codec', () => {
  it('should round-trip a basic request', () => {
    const req: SerializedHttpRequest = {
      requestId: 'req-123',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: new TextEncoder().encode('{"model":"gpt-4"}'),
    };

    const encoded = encodeHttpRequest(req);
    const decoded = decodeHttpRequest(encoded);

    expect(decoded.requestId).toBe(req.requestId);
    expect(decoded.method).toBe(req.method);
    expect(decoded.path).toBe(req.path);
    expect(decoded.headers).toEqual(req.headers);
    expect(new TextDecoder().decode(decoded.body)).toBe('{"model":"gpt-4"}');
  });

  it('should handle empty headers', () => {
    const req: SerializedHttpRequest = {
      requestId: 'r',
      method: 'GET',
      path: '/',
      headers: {},
      body: new Uint8Array(0),
    };
    const decoded = decodeHttpRequest(encodeHttpRequest(req));
    expect(decoded.headers).toEqual({});
  });

  it('should handle empty body', () => {
    const req: SerializedHttpRequest = {
      requestId: 'r',
      method: 'GET',
      path: '/health',
      headers: {},
      body: new Uint8Array(0),
    };
    const decoded = decodeHttpRequest(encodeHttpRequest(req));
    expect(decoded.body.length).toBe(0);
  });

  it('should handle large body', () => {
    const largeBody = new Uint8Array(100_000);
    largeBody.fill(0x42);
    const req: SerializedHttpRequest = {
      requestId: 'big',
      method: 'POST',
      path: '/upload',
      headers: {},
      body: largeBody,
    };
    const decoded = decodeHttpRequest(encodeHttpRequest(req));
    expect(decoded.body.length).toBe(100_000);
    expect(decoded.body[0]).toBe(0x42);
  });
});

describe('HTTP Response codec', () => {
  it('should round-trip a basic response', () => {
    const resp: SerializedHttpResponse = {
      requestId: 'req-123',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"result":"ok"}'),
    };

    const decoded = decodeHttpResponse(encodeHttpResponse(resp));

    expect(decoded.requestId).toBe(resp.requestId);
    expect(decoded.statusCode).toBe(200);
    expect(decoded.headers).toEqual(resp.headers);
    expect(new TextDecoder().decode(decoded.body)).toBe('{"result":"ok"}');
  });

  it('should handle 500 status code', () => {
    const resp: SerializedHttpResponse = {
      requestId: 'err',
      statusCode: 500,
      headers: {},
      body: new TextEncoder().encode('Internal Server Error'),
    };
    const decoded = decodeHttpResponse(encodeHttpResponse(resp));
    expect(decoded.statusCode).toBe(500);
  });
});

describe('HTTP Response Chunk codec', () => {
  it('should round-trip a chunk with done=false', () => {
    const chunk: SerializedHttpResponseChunk = {
      requestId: 'req-123',
      data: new TextEncoder().encode('data: {"text":"hello"}'),
      done: false,
    };

    const decoded = decodeHttpResponseChunk(encodeHttpResponseChunk(chunk));

    expect(decoded.requestId).toBe('req-123');
    expect(decoded.done).toBe(false);
    expect(new TextDecoder().decode(decoded.data)).toBe('data: {"text":"hello"}');
  });

  it('should round-trip a chunk with done=true', () => {
    const chunk: SerializedHttpResponseChunk = {
      requestId: 'req-123',
      data: new Uint8Array(0),
      done: true,
    };

    const decoded = decodeHttpResponseChunk(encodeHttpResponseChunk(chunk));

    expect(decoded.requestId).toBe('req-123');
    expect(decoded.done).toBe(true);
    expect(decoded.data.length).toBe(0);
  });

  it('should handle empty data with done=false', () => {
    const chunk: SerializedHttpResponseChunk = {
      requestId: 'x',
      data: new Uint8Array(0),
      done: false,
    };
    const decoded = decodeHttpResponseChunk(encodeHttpResponseChunk(chunk));
    expect(decoded.done).toBe(false);
    expect(decoded.data.length).toBe(0);
  });
});
