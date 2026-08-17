// Local demo seller: real @antseed/node ConnectionManager listener (WebRTC
// signaling included) that streams a canned OpenAI-style chat completion for
// any proxied request, no payment demanded. Pair with the relay via
// RELAY_STATIC_SELLERS=<peerId>@127.0.0.1:7799.
import { Wallet } from 'ethers';
import { ConnectionManager, FrameDecoder } from '@antseed/node/p2p';
import { ProxyMux, toPeerId } from '@antseed/node';

const wallet = new Wallet('0x' + '33'.repeat(32));
const peerId = wallet.address.slice(2).toLowerCase();

const manager = await ConnectionManager.init();
manager.setLocalIdentity({ peerId: toPeerId(peerId), wallet });
manager.on('error', (err) => console.log('[mock-seller] error:', err.message));
manager.on('connection', (conn) => {
  console.log('[mock-seller] connection from', conn.remotePeerId?.slice(0, 12));
  const decoder = new FrameDecoder();
  const mux = new ProxyMux(conn);
  const timers = new Set();
  let alive = true;
  const stop = () => {
    alive = false;
    for (const t of timers) clearInterval(t);
    timers.clear();
  };
  conn.on('stateChange', (s) => { if (s === 'closed' || s === 'failed') stop(); });

  // node-datachannel aborts the process if you send on a destroyed socket, so
  // never send after the connection drops.
  const safeSend = (fn) => {
    if (!alive || conn.state === 'closed' || conn.state === 'failed') return false;
    try { fn(); return true; } catch (err) {
      console.log('[mock-seller] send aborted:', err.message);
      stop();
      return false;
    }
  };

  mux.onProxyRequest((request) => {
    console.log('[mock-seller] request', request.method, request.path);
    const sse = (obj) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
    safeSend(() => mux.sendProxyResponse({
      requestId: request.requestId,
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' },
      body: new Uint8Array(0),
    }));
    const words = 'Hello from the local AntSeed mock seller — the browser SDK, relay bridge, and WebRTC DataChannel are all working. '.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        safeSend(() => mux.sendProxyChunk({
          requestId: request.requestId,
          done: false,
          data: sse({ choices: [{ delta: { content: words[i++] + ' ' } }] }),
        }));
      } else {
        clearInterval(timer);
        timers.delete(timer);
        safeSend(() => mux.sendProxyChunk({
          requestId: request.requestId,
          done: true,
          data: new TextEncoder().encode('data: [DONE]\n\n'),
        }));
      }
    }, 80);
    timers.add(timer);
  });

  conn.on('message', (bytes) => {
    for (const frame of decoder.feed(bytes)) void mux.handleFrame(frame);
  });
});

// Last-resort guard: never let a stray native send abort the demo process.
process.on('uncaughtException', (err) => console.log('[mock-seller] uncaught (ignored):', err.message));

await manager.startListening({ peerId: toPeerId(peerId), port: 7799, host: '127.0.0.1' });
console.log(`[mock-seller] READY ${peerId} on 127.0.0.1:7799`);
