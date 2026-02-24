import { describe, expect, it } from 'vitest';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
import { encodeHttpResponse, encodeHttpResponseChunk } from '../src/proxy/request-codec.js';
import { MessageType } from '../src/types/protocol.js';
import type { PeerConnection } from '../src/p2p/connection-manager.js';

function createMux(): ProxyMux {
  const conn = {
    send: () => {},
  } as unknown as PeerConnection;

  return new ProxyMux(conn);
}

describe('ProxyMux security handling', () => {
  it('rejects malformed payloads instead of silently proceeding', async () => {
    const mux = createMux();

    await expect(
      mux.handleFrame({
        type: MessageType.HttpResponse,
        messageId: 1,
        payload: new Uint8Array([0x01]),
      }),
    ).rejects.toThrow('Failed to handle proxy frame type');
  });

  it('ignores unknown frame types', async () => {
    const mux = createMux();

    await expect(
      mux.handleFrame({
        type: 0x99 as MessageType,
        messageId: 2,
        payload: new Uint8Array(),
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps handlers registered after streaming start frame', async () => {
    const mux = createMux();
    const requestId = 'stream-req-1';
    let seenStart = false;
    let seenEnd = false;

    mux.sendProxyRequest(
      {
        requestId,
        method: 'POST',
        path: '/v1/messages',
        headers: {},
        body: new Uint8Array(0),
      },
      (_response, metadata) => {
        seenStart = metadata.streamingStart;
      },
      (chunk) => {
        if (chunk.done) {
          seenEnd = true;
        }
      },
    );

    await mux.handleFrame({
      type: MessageType.HttpResponse,
      messageId: 10,
      payload: encodeHttpResponse({
        requestId,
        statusCode: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-antseed-streaming': '1',
        },
        body: new Uint8Array(0),
      }),
    });

    expect(seenStart).toBe(true);
    expect(mux.activeRequestCount()).toBe(1);

    await mux.handleFrame({
      type: MessageType.HttpResponseEnd,
      messageId: 11,
      payload: encodeHttpResponseChunk({
        requestId,
        data: new Uint8Array(0),
        done: true,
      }),
    });

    expect(seenEnd).toBe(true);
    expect(mux.activeRequestCount()).toBe(0);
  });
});
