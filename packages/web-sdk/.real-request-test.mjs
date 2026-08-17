// Full path against a REAL deployed seller: connect over WebRTC via the relay,
// then send a chat request. With no deposits we expect a 402 payment_required —
// which still proves request→response flows over the real DataChannel.
import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { AntseedWebClient } from './dist/index.js';

const prefix = process.argv[2] ?? 'c228';
const model = process.argv[3] ?? 'medical-reasoning-r1';
const client = new AntseedWebClient({
  relayUrl: 'http://127.0.0.1:8917',
  privateKey: Wallet.createRandom().privateKey,
  env: { RTCPeerConnection, WebSocket },
  connection: { onConnectionInfo: (i) => console.log('[real] WebRTC path:', i.path) },
});
const sellers = await client.sellers();
const target = sellers.find((s) => s.peerId.startsWith(prefix));
console.log('[real] connecting to', target.displayName, '—', target.publicAddress);
const services = [...new Set((target.providers ?? []).flatMap((p) => p.services ?? []))];
console.log('[real] advertised services:', services.slice(0, 8));

const session = await client.connect(target.peerId, target);
console.log('[real] WebRTC connected — sending request for model', model);
const decoder = new TextDecoder();
let streamed = '';
const res = await session.request(
  {
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  },
  { onChunk: (d) => { streamed += decoder.decode(d, { stream: true }); } },
);
console.log('[real] response status:', res.status ?? res.statusCode);
const bodyText = res.body ? decoder.decode(res.body) : '';
console.log('[real] response body:', (bodyText || streamed).slice(0, 300));
client.closeAll();
process.exit(0);
