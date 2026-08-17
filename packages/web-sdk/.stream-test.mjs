import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { AntseedWebClient } from './dist/index.js';

const client = new AntseedWebClient({
  relayUrl: 'http://127.0.0.1:8917',
  privateKey: Wallet.createRandom().privateKey,
  env: { RTCPeerConnection, WebSocket },
});
const sellers = await client.sellers();
const target = sellers.find((s) => s.peerId.startsWith('5cbd'));
const session = await client.connect(target.peerId, target);
const decoder = new TextDecoder();
let text = '';
const res = await session.request(
  {
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'mock', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  },
  { onChunk: (data) => { text += decoder.decode(data, { stream: true }); } },
);
console.log('[stream-test] status', res.status ?? res.statusCode, '| chunks bytes:', text.length);
const deltas = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('');
console.log('[stream-test] assembled:', deltas.trim());
client.closeAll();
process.exit(0);
