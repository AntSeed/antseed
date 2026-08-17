// Direct-TCP hello probe (no relay): send the browser SDK's hello envelope to
// a seller signaling port and dump every line/close event with timing.
import net from 'node:net';
import { Wallet } from 'ethers';
import { buildHelloEnvelope } from './dist/identity.js';

const [host, port] = (process.argv[2] ?? '127.0.0.1:7788').split(':');
const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);
const t0 = Date.now();
const ts = () => `+${Date.now() - t0}ms`;

const sock = net.connect({ host, port: Number(port) }, () => {
  console.log(ts(), 'tcp open — sending hello');
  sock.write(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');
});
sock.on('data', (d) => console.log(ts(), '<<', d.toString().slice(0, 140)));
sock.on('close', () => { console.log(ts(), 'tcp closed'); process.exit(0); });
sock.on('error', (e) => console.log(ts(), 'tcp error', e.message));
setTimeout(() => { console.log(ts(), 'still open after 10s (hello accepted)'); process.exit(0); }, 10_000);
