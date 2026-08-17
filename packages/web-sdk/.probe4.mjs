// Control probe: send a normal TCP `intro` (node-buyer path) to a seller.
// If intro survives where hello dies, the rejection is hello-specific.
import net from 'node:net';
import { Wallet } from 'ethers';

const [host, port] = (process.argv[2] ?? '127.0.0.1:7788').split(':');
const type = process.argv[3] ?? 'intro';
const wallet = Wallet.createRandom();
const peerId = wallet.address.slice(2).toLowerCase();
const ts0 = Date.now();
const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const payload = `${type}|${peerId}|${ts0}|${nonce}`;
const sig = (await wallet.signMessage('antseed-msg-v1:' + payload)).slice(2).toLowerCase();
const envelope = { type, auth: { peerId, ts: ts0, nonce, sig }, capabilities: [] };

const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;
const sock = net.connect({ host, port: Number(port) }, () => {
  console.log(ts(), `tcp open — sending ${type}`);
  sock.write(JSON.stringify(envelope) + '\n');
});
sock.on('data', (d) => console.log(ts(), '<<', JSON.stringify(d.toString().slice(0, 80))));
sock.on('close', () => { console.log(ts(), 'tcp closed'); process.exit(0); });
sock.on('error', (e) => console.log(ts(), 'tcp error', e.message));
setTimeout(() => { console.log(ts(), `still open after 8s (${type} accepted)`); process.exit(0); }, 8_000);
