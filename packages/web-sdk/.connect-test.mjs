import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { AntseedWebClient } from './dist/index.js';

const client = new AntseedWebClient({
  relayUrl: 'http://127.0.0.1:8917',
  privateKey: Wallet.createRandom().privateKey,
  env: { RTCPeerConnection, WebSocket },
  connection: {
    connectTimeoutMs: 25_000,
    onConnectionInfo: (info) => console.log('[test] path:', info.path),
  },
});

const sellers = await client.sellers();
const prefix = process.argv[2] ?? 'dc56';
const target = sellers.find((s) => s.peerId.startsWith(prefix) && s.publicAddress);
if (!target) {
  console.log('[test] no seller with prefix', prefix);
  process.exit(2);
}
console.log('[test] connecting to', target.displayName, target.peerId.slice(0, 12), target.publicAddress);
try {
  await client.connect(target.peerId, target);
  console.log('[test] CONNECTED OK');
  client.closeAll();
  process.exit(0);
} catch (err) {
  console.log('[test] FAILED:', err.message);
  process.exit(1);
}
