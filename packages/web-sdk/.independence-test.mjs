// Proof that the relay is signaling-only: connect through it, KILL the relay,
// then run a full streaming request over the direct browser↔seller DataChannel.
import { execSync } from 'node:child_process';
import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { AntseedWebClient } from './dist/index.js';

const client = new AntseedWebClient({
  relayUrl: 'http://127.0.0.1:8917',
  privateKey: Wallet.createRandom().privateKey,
  env: { RTCPeerConnection, WebSocket },
  connection: { onConnectionInfo: (i) => console.log('[proof] WebRTC path:', i.path) },
});

const sellers = await client.sellers();
const target = sellers.find((s) => s.peerId.startsWith('5cbd'));
console.log('[proof] 1. discovered seller via relay HTTP:', target.peerId.slice(0, 12));

const session = await client.connect(target.peerId, target);
console.log('[proof] 2. WebRTC DataChannel open (relay bridge already closed by SDK)');

// -sTCP:LISTEN so we kill the relay server, not our own client socket.
execSync('lsof -ti tcp:8917 -sTCP:LISTEN | xargs kill 2>/dev/null || true');
await new Promise((r) => setTimeout(r, 1500));
let relayDead = false;
try {
  await fetch('http://127.0.0.1:8917/sellers', { signal: AbortSignal.timeout(2000) });
} catch {
  relayDead = true;
}
console.log('[proof] 3. relay process KILLED — reachable:', !relayDead ? 'still up (!)' : 'no, dead');

const decoder = new TextDecoder();
let text = '';
const res = await session.request(
  {
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: 'demo', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  },
  { onChunk: (d) => { text += decoder.decode(d, { stream: true }); } },
);
const reply = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('').trim();
console.log('[proof] 4. request with relay DEAD → status', res.status ?? res.statusCode);
console.log('[proof]    streamed reply:', reply);
client.closeAll();
process.exit(0);
