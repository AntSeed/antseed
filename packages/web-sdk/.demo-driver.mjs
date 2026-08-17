// Drive the web-sdk example in headless Chrome over CDP: list sellers,
// connect, send a prompt, and screenshot the streamed result.
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';

const OUT = process.env.SHOT_DIR ?? '.';
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
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
  console.log('[shot]', name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8974/example.html' });
await sleep(1500);
await shot('1-loaded');

await evaluate(`document.getElementById('listSellers').click()`);
await sleep(2500);
console.log('[status]', await evaluate(`document.getElementById('status').textContent`));
await shot('2-sellers');

const clicked = await evaluate(`(() => {
  for (const row of document.querySelectorAll('.seller')) {
    if (row.textContent.includes('127.0.0.1:7799')) { row.querySelector('button').click(); return row.textContent.slice(0, 60); }
  }
  return null;
})()`);
console.log('[clicked]', clicked);

let connected = false;
for (let i = 0; i < 12 && !connected; i++) {
  await sleep(2000);
  connected = await evaluate(`!document.getElementById('send').disabled`);
  const st = await evaluate(`document.getElementById('status').textContent`);
  if (/failed/i.test(st)) { console.log('[status]', st); break; }
}
console.log('[status]', await evaluate(`document.getElementById('status').textContent`));
await shot('3-connected');
if (!connected) {
  const out = await evaluate(`document.getElementById('output').textContent`);
  console.log(out.split('\n').map((l) => '   | ' + l).join('\n'));
  process.exit(1);
}

await evaluate(`(() => {
  const p = document.getElementById('prompt');
  p.value = 'Hello from the recovered example!';
  document.getElementById('send').click();
})()`);
let lastLen = -1;
for (let i = 0; i < 15; i++) {
  await sleep(2000);
  const out = await evaluate(`document.getElementById('output').textContent`);
  if (out.length === lastLen && out.length > 0) break;
  lastLen = out.length;
}
const out = await evaluate(`document.getElementById('output').textContent`);
console.log('[output]');
console.log(out.split('\n').map((l) => '   | ' + l).join('\n'));
await shot('4-response');
process.exit(0);
