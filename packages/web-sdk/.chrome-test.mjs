// Drive the example page in real headless Chrome over raw CDP: list sellers,
// connect to the local demo seller, and dump the page's debug trace.
import { WebSocket } from 'ws';

const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
await new Promise((resolve) => ws.on('open', resolve));

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8974/example.html' });
await sleep(1500);

await evaluate(`document.getElementById('listSellers').click()`);
await sleep(2500);
console.log('[chrome] status:', await evaluate(`document.getElementById('status').textContent`));

const clicked = await evaluate(`(() => {
  for (const row of document.querySelectorAll('.seller')) {
    if (row.textContent.includes('127.0.0.1:7799')) { row.querySelector('button').click(); return row.textContent.slice(0, 60); }
  }
  return null;
})()`);
console.log('[chrome] clicked:', clicked);

for (let i = 0; i < 8; i++) {
  await sleep(5000);
  const out = await evaluate(`document.getElementById('output').textContent`);
  const st = await evaluate(`document.getElementById('status').textContent`);
  console.log(`[chrome] t+${(i + 1) * 5}s status: ${st}`);
  console.log(out.split('\n').map((l) => '   | ' + l).join('\n'));
  if (/connected|failed/i.test(st + out)) break;
}
process.exit(0);
