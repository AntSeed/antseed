// Does an mDNS (.local) ICE candidate kill the seller's signaling connection?
// Send hello + offer + an mDNS candidate in one write, then watch.
import net from 'node:net';
import { Wallet } from 'ethers';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { buildHelloEnvelope } from './dist/identity.js';

const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);
const pc = new RTCPeerConnection({ iceServers: [] });
pc.createDataChannel('antseed-data', { ordered: true });
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const withMdns = process.argv[2] !== 'clean';
const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;
const sock = net.connect({ host: '127.0.0.1', port: 7799 }, () => {
  console.log(ts(), `sending hello+offer${withMdns ? '+mDNS-candidate' : ''} in one write`);
  let payload =
    JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n' +
    JSON.stringify({ type: 'sdp', sdp: offer.sdp, descriptionType: 'offer' }) + '\n';
  if (withMdns) {
    payload += JSON.stringify({
      type: 'candidate',
      candidate: 'a=candidate:2230659787 1 udp 2122260223 8b3c0e2b-3f6a-4a89-a807-3d7a1e9f21aa.local 54321 typ host generation 0',
      mid: '0',
    }) + '\n';
  }
  sock.write(payload);
});
sock.on('data', (d) => console.log(ts(), '<<', d.toString().slice(0, 90)));
sock.on('close', () => { console.log(ts(), 'tcp closed'); process.exit(0); });
sock.on('error', (e) => console.log(ts(), 'tcp error', e.message));
setTimeout(() => { console.log(ts(), 'still open after 8s'); process.exit(0); }, 8_000);
