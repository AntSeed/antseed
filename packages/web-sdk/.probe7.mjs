// Does a browser `hello` CRASH a deployed seller (process dies + restarts),
// or is it merely rejected (process stays up)? Send hello, then poll the TCP
// port every 200ms for 12s looking for a window where it stops accepting.
import net from 'node:net';
import { Wallet } from 'ethers';
import { buildHelloEnvelope } from './dist/identity.js';

const [host, port] = (process.argv[2] ?? '157.230.221.235:6882').split(':');
const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;

const probePort = () =>
  new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) });
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve('open'); });
    s.once('timeout', () => { s.destroy(); resolve('timeout'); });
    s.once('error', (e) => { s.destroy(); resolve(e.code ?? 'error'); });
  });

console.log(ts(), 'baseline port state:', await probePort());

const wallet = Wallet.createRandom();
const hello = await buildHelloEnvelope(wallet);
const sock = net.connect({ host, port: Number(port) }, () => {
  console.log(ts(), 'sending hello');
  sock.write(JSON.stringify({ type: 'hello', auth: hello, capabilities: [] }) + '\n');
});
sock.on('data', (d) => console.log(ts(), '<<', d.toString().slice(0, 60)));
sock.on('close', () => console.log(ts(), 'hello socket closed by seller'));
sock.on('error', (e) => console.log(ts(), 'hello socket error', e.code));

const results = [];
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 200));
  results.push(await probePort());
}
const summary = results.reduce((acc, r) => ((acc[r] = (acc[r] ?? 0) + 1), acc), {});
console.log(ts(), 'port over 12s after hello:', JSON.stringify(summary));
const firstBad = results.findIndex((r) => r !== 'open');
console.log(firstBad === -1
  ? '=> port NEVER stopped accepting: seller did NOT crash — hello is being REJECTED'
  : `=> port stopped accepting at sample ${firstBad} (~${firstBad * 200}ms): consistent with a CRASH+restart`);
process.exit(0);
