// Full direct-TCP handshake against a seller signaling port (no relay):
// hello + offer + candidates, then wait for the seller's SDP answer.
import net from 'node:net';
import { Wallet } from 'ethers';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { buildHelloEnvelope } from './dist/identity.js';

const [host, port] = (process.argv[2] ?? '127.0.0.1:7788').split(':');
const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);
const pc = new RTCPeerConnection({ iceServers: [] });
pc.createDataChannel('antseed-data', { ordered: true });
const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;

const sock = net.connect({ host, port: Number(port) }, async () => {
  console.log(ts(), 'tcp open — hello');
  sock.write(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');
  pc.onicecandidate = (e) => {
    if (e.candidate?.candidate && sock.writable) {
      sock.write(JSON.stringify({ type: 'candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid ?? '0' }) + '\n');
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sock.write(JSON.stringify({ type: 'sdp', sdp: offer.sdp, descriptionType: 'offer' }) + '\n');
  console.log(ts(), 'offer sent');
  pc.onconnectionstatechange = () => console.log(ts(), 'pc:', pc.connectionState);
});
let buf = '';
sock.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    console.log(ts(), '<<', msg.type, msg.type === 'sdp' ? `(${msg.descriptionType})` : msg.candidate?.slice(0, 40));
    if (msg.type === 'sdp') pc.setRemoteDescription({ type: msg.descriptionType, sdp: msg.sdp });
    else if (msg.type === 'candidate') pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid }).catch(() => {});
  }
});
sock.on('close', () => { console.log(ts(), 'tcp closed'); });
sock.on('error', (e) => console.log(ts(), 'tcp error', e.message));
setTimeout(() => { console.log(ts(), 'end, pc =', pc.connectionState); process.exit(0); }, 12_000);
