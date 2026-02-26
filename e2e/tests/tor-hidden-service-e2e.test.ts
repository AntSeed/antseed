import { afterEach, describe, expect, it } from 'vitest';
import net, { type AddressInfo, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AntseedNode } from '@antseed/node';
import type { SerializedHttpRequest } from '@antseed/node';
import { MockAnthropicProvider } from './helpers/mock-provider.js';

interface FakeSocksProxy {
  host: string;
  port: number;
  connectionCount: number;
  lastTarget: { host: string; port: number } | null;
  close: () => Promise<void>;
}

function createSocketReader(socket: Socket): {
  readExact: (bytes: number) => Promise<Buffer>;
  readRemaining: () => Buffer;
} {
  let buffer = Buffer.alloc(0);
  return {
    readExact: (bytes: number): Promise<Buffer> =>
      new Promise<Buffer>((resolve, reject) => {
        if (buffer.length >= bytes) {
          const out = buffer.subarray(0, bytes);
          buffer = buffer.subarray(bytes);
          resolve(out);
          return;
        }

        const onData = (chunk: Buffer): void => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= bytes) {
            cleanup();
            const out = buffer.subarray(0, bytes);
            buffer = buffer.subarray(bytes);
            resolve(out);
          }
        };

        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };

        const onClose = (): void => {
          cleanup();
          reject(new Error('SOCKET_CLOSED'));
        };

        const cleanup = (): void => {
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
        };

        socket.on('data', onData);
        socket.once('error', onError);
        socket.once('close', onClose);
      }),
    readRemaining: (): Buffer => {
      const out = buffer;
      buffer = Buffer.alloc(0);
      return out;
    },
  };
}

async function startFakeSocksProxy(
  resolveTarget: (targetHost: string, targetPort: number) => { host: string; port: number } | null,
): Promise<FakeSocksProxy> {
  let connectionCount = 0;
  let lastTarget: { host: string; port: number } | null = null;

  const server = net.createServer((clientSocket) => {
    void (async () => {
      connectionCount += 1;
      const reader = createSocketReader(clientSocket);

      try {
        const greetingHeader = await reader.readExact(2);
        const version = greetingHeader[0];
        const methodsCount = greetingHeader[1];
        if (version !== 0x05 || methodsCount === 0) {
          clientSocket.destroy();
          return;
        }

        const methods = await reader.readExact(methodsCount);
        const supportsNoAuth = methods.includes(0x00);
        if (!supportsNoAuth) {
          clientSocket.write(Buffer.from([0x05, 0xff]));
          clientSocket.end();
          return;
        }
        clientSocket.write(Buffer.from([0x05, 0x00]));

        const requestHead = await reader.readExact(4);
        if (requestHead[0] !== 0x05 || requestHead[1] !== 0x01) {
          clientSocket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.end();
          return;
        }

        const atyp = requestHead[3];
        let targetHost = '';
        if (atyp === 0x01) {
          const addr = await reader.readExact(4);
          targetHost = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
        } else if (atyp === 0x03) {
          const domainLen = (await reader.readExact(1))[0] ?? 0;
          const domain = await reader.readExact(domainLen);
          targetHost = domain.toString('utf8');
        } else if (atyp === 0x04) {
          const ipv6 = await reader.readExact(16);
          const segments: string[] = [];
          for (let i = 0; i < 8; i += 1) {
            segments.push(ipv6.readUInt16BE(i * 2).toString(16));
          }
          targetHost = segments.join(':');
        } else {
          clientSocket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.end();
          return;
        }

        const targetPort = (await reader.readExact(2)).readUInt16BE(0);
        lastTarget = { host: targetHost, port: targetPort };
        const resolved = resolveTarget(targetHost, targetPort);
        if (!resolved) {
          clientSocket.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          clientSocket.end();
          return;
        }

        const upstream = net.connect({ host: resolved.host, port: resolved.port });
        await once(upstream, 'connect');

        clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        const remaining = reader.readRemaining();
        if (remaining.length > 0) {
          upstream.write(remaining);
        }

        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);

        const closeBoth = (): void => {
          if (!clientSocket.destroyed) clientSocket.destroy();
          if (!upstream.destroyed) upstream.destroy();
        };
        clientSocket.on('error', closeBoth);
        upstream.on('error', closeBoth);
        clientSocket.on('close', closeBoth);
        upstream.on('close', closeBoth);
      } catch {
        if (!clientSocket.destroyed) {
          clientSocket.destroy();
        }
      }
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port: address.port,
    get connectionCount() {
      return connectionCount;
    },
    get lastTarget() {
      return lastTarget;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('Tor hidden-service e2e flow', () => {
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;
  let socksProxy: FakeSocksProxy | null = null;

  afterEach(async () => {
    try { if (buyerNode) { await buyerNode.stop(); buyerNode = null; } } catch {}
    try { if (sellerNode) { await sellerNode.stop(); sellerNode = null; } } catch {}
    try { if (socksProxy) { await socksProxy.close(); socksProxy = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
  });

  it('buyer connects to seller via manual onion peer over SOCKS proxy in tor mode', async () => {
    const onionHost = 'abcdefghijklmnop.onion';
    const onionPort = 443;

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-tor-seller-'));
    const provider = new MockAnthropicProvider();

    let torReadyPayload: { peerId: string; manualPeer: string } | null = null;
    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      signalingPort: 0,
      tor: {
        enabled: true,
        onionAddress: onionHost,
        onionPort,
      },
    });
    sellerNode.on('tor:ready', (payload) => {
      torReadyPayload = payload as { peerId: string; manualPeer: string };
    });
    sellerNode.registerProvider(provider);
    await sellerNode.start();

    expect(sellerNode.dhtPort).toBe(0);
    expect(sellerNode.signalingPort).toBeGreaterThan(0);
    expect(torReadyPayload?.peerId).toBe(sellerNode.peerId);
    expect(torReadyPayload?.manualPeer).toBe(`${sellerNode.peerId}@${onionHost}:${onionPort}`);

    socksProxy = await startFakeSocksProxy((targetHost) => {
      if (targetHost !== onionHost) return null;
      return { host: '127.0.0.1', port: sellerNode!.signalingPort };
    });

    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-tor-buyer-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      tor: {
        enabled: true,
        manualPeers: [`${sellerNode.peerId}@${onionHost}:${onionPort}`],
        socksProxy: { host: socksProxy.host, port: socksProxy.port },
      },
    });
    await buyerNode.start();

    expect(buyerNode.dhtPort).toBe(0);
    const peers = await buyerNode.discoverPeers();
    const sellerPeer = peers.find((peer) => peer.peerId === sellerNode!.peerId);
    expect(sellerPeer).toBeDefined();

    const request: SerializedHttpRequest = {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hello tor e2e' }],
      })),
    };

    const response = await buyerNode.sendRequest(sellerPeer!, request);
    expect(response.statusCode).toBe(200);
    expect(provider.requestCount).toBe(1);
    expect(socksProxy.connectionCount).toBeGreaterThan(0);
    expect(socksProxy.lastTarget).toEqual({ host: onionHost, port: onionPort });
  }, 30_000);
});
