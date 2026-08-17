import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { buildHelloEnvelope } from './dist/identity.js';

const peerPrefix = process.argv[2] ?? 'dc56';
const { peers } = await (await fetch('http://127.0.0.1:8917/sellers')).json();
const target = peers.find((p) => p.peerId.startsWith(peerPrefix) && p.publicAddress);
console.log('[probe2] target', target.displayName, target.publicAddress);

const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);
const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;

const ws = new WebSocket(`ws://127.0.0.1:8917/bridge/${target.peerId}`);
ws.on('open', () => {
  console.log(ts(), 'ws open — sending hello ONLY');
  ws.send(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');
  setTimeout(async () => {
    if (ws.readyState !== 1) return;
    console.log(ts(), 'still open after hello — sending offer');
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('antseed-data', { ordered: true });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sdp', sdp: offer.sdp, descriptionType: 'offer' }) + '\n');
    console.log(ts(), 'offer sent');
  }, 5000);
});
ws.on('message', (d) => console.log(ts(), '<<', d.toString().slice(0, 100)));
ws.on('close', (code, reason) => { console.log(ts(), 'ws closed', code, reason.toString()); process.exit(0); });
ws.on('error', (e) => console.log(ts(), 'ws error', e.message));
setTimeout(() => { console.log(ts(), 'done'); process.exit(0); }, 20_000);
