import { describe, expect, it } from 'vitest';
import { ProxyMux } from '../src/proxy/proxy-mux.js';
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
});
