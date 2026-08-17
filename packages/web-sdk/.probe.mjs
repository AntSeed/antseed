import { Wallet } from 'ethers';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { buildHelloEnvelope } from './dist/identity.js';

const peerPrefix = process.argv[2] ?? 'dc56';
const res = await fetch('http://127.0.0.1:8917/sellers');
const { peers } = await res.json();
const target = peers.find((p) => p.peerId.startsWith(peerPrefix) && p.publicAddress);
console.log('[probe] target', target.displayName, target.publicAddress);

const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);

const ws = new WebSocket(`ws://127.0.0.1:8917/bridge/${target.peerId}`);
ws.on('open', async () => {
  console.log('[probe] ws open, sending hello');
  ws.send(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');

  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.createDataChannel('antseed-data', { ordered: true });
  pc.onicecandidate = (e) => {
    if (e.candidate?.candidate) {
      console.log('[probe] local candidate:', e.candidate.candidate.slice(0, 60));
      ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' }) + '\n');
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'sdp', sdp: offer.sdp, descriptionType: 'offer' }) + '\n');
  console.log('[probe] offer sent (' + offer.sdp.length + ' bytes)');
  pc.onconnectionstatechange = () => console.log('[probe] pc state:', pc.connectionState);
});
ws.on('message', (data) => {
  const text = data.toString();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    console.log('[probe] <<', line.slice(0, 120));
  }
});
ws.on('close', (code, reason) => {
  console.log('[probe] ws closed', code, reason.toString());
  process.exit(0);
});
ws.on('error', (err) => console.log('[probe] ws error', err.message));
setTimeout(() => { console.log('[probe] 30s timeout'); process.exit(0); }, 30_000);
