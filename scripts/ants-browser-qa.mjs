#!/usr/bin/env node
/** Local-only UI test wallet. Proxies an existing --browser Anvil sandbox and injects an EIP-6963 provider.
 * node scripts/ants-browser-qa.mjs /absolute/path/to/scenario.json [port]
 * No private keys, production RPCs, or real wallet extensions are used. Do not publish this proxy.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const scenario = JSON.parse(await readFile(process.argv[2], 'utf8'));
const port = Number(process.argv[3] ?? 3135);
const upstream = new URL(scenario.dashboardUrl);
const rpc = new URL(scenario.rpcUrl);
assert(scenario.browserWallet && scenario.chainId === 31337 && ['127.0.0.1', 'localhost'].includes(upstream.hostname) && ['127.0.0.1', 'localhost'].includes(rpc.hostname));
const chain = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then(r => r.json());
assert.equal(chain.result, '0x7a69');
const shim = `(() => {
  const address = ${JSON.stringify(scenario.address)}, rpc = ${JSON.stringify(scenario.rpcUrl)};
  const buyer = ${JSON.stringify(scenario.buyerAddress)};
  const listeners = new Map(); let connected = false, activeAddress = address, activeChain = '0x7a69', rejectNext = false;
  const emit = (event, value) => (listeners.get(event) || []).forEach(cb => cb(value));
  document.addEventListener('DOMContentLoaded', () => {
    const controls = document.createElement('details'); controls.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:20000;background:#fff;color:#17231c;padding:8px;border:1px solid #aaa;font:12px sans-serif;max-width:240px';
    const label = document.createElement('summary'); label.textContent = 'Anvil test controls'; controls.append(label);
    for (const [text, action] of [
      ['Use buyer account', () => { activeAddress = buyer; emit('accountsChanged', [buyer]); }],
      ['Use authorized wallet', () => { activeAddress = address; emit('accountsChanged', [address]); }],
      ['Wrong network', () => { activeChain = '0x2105'; emit('chainChanged', activeChain); }],
      ['Anvil network', () => { activeChain = '0x7a69'; emit('chainChanged', activeChain); }],
      ['Reject next transaction', () => { rejectNext = true; }],
    ]) { const button = document.createElement('button'); button.textContent = text; button.style.cssText = 'display:block;margin:6px 0'; button.addEventListener('click', action); controls.append(button); }
    document.body.append(controls);
  });
  const provider = {
    isMetaMask: false,
    on(event, cb) { const list = listeners.get(event) || []; list.push(cb); listeners.set(event, list); },
    removeListener(event, cb) { listeners.set(event, (listeners.get(event) || []).filter(v => v !== cb)); },
    async request({method, params = []}) {
      if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') { connected = true; return method === 'eth_requestAccounts' ? [activeAddress] : [{parentCapability: 'eth_accounts'}]; }
      if (method === 'eth_accounts') return connected ? [activeAddress] : [];
      if (method === 'wallet_getPermissions') return connected ? [{parentCapability: 'eth_accounts'}] : [];
      if (method === 'wallet_revokePermissions') { connected = false; return null; }
      if (method === 'eth_chainId') return activeChain;
      if (method === 'wallet_switchEthereumChain') { if (params[0].chainId !== '0x7a69') throw new Error('Anvil only'); activeChain = '0x7a69'; emit('chainChanged', activeChain); return null; }
      if (method === 'eth_sendTransaction' && activeChain !== '0x7a69') throw new Error('Switch to Anvil');
      if (method === 'eth_sendTransaction' && rejectNext) { rejectNext = false; const error = new Error('User rejected the test transaction'); error.code = 4001; throw error; }
      if (method === 'eth_sendTransaction' && params[0].from.toLowerCase() !== address.toLowerCase()) throw new Error('Wrong test sender');
      const allowed = ['eth_chainId','eth_sendTransaction','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_getBlockByNumber','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_call','eth_getBalance','net_version'];
      if (!allowed.includes(method)) throw new Error('Unsupported test wallet method: '+method);
      const reply = await fetch(rpc, {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})}).then(r => r.json());
      if (reply.error) throw new Error(reply.error.message); return reply.result;
    }
  };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info: {uuid:'00b15368-4985-4919-ab44-777aad2f5481', name:'Anvil test wallet', icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%232f7958"/></svg>', rdns:'local.antseed.anvil'}, provider}}));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;
createServer(async (req, res) => {
  try {
    if (req.url === '/_qa-wallet.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(shim); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length']; delete headers['accept-encoding'];
    const response = await fetch(new URL(req.url, upstream.origin), { method: req.method, headers, ...(body.length ? {body} : {}) });
    res.statusCode = response.status;
    for (const [key, value] of response.headers) if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(key)) res.setHeader(key, value);
    // Local display metadata only: seeded sellers have no production indexer profiles.
    // Balances, positions, yields and all transactions remain unchanged Anvil data.
    if (req.url?.split('?')[0] === '/api/pools' && response.ok) {
      const result = await response.json();
      const names = new Map([[scenario.agentId, 'Anvil Seller Alpha'], [scenario.otherAgentId, 'Anvil Seller Beta']]);
      for (const pool of result.data?.pools ?? []) {
        const name = names.get(pool.agentId);
        if (name && !pool.profile?.name) pool.profile = { providers: [], modelsServed: null, uniqueBuyers: null, requestCount: null, lifetimeVolumeUsdc: null, ghostRate: null, lastSettledAt: null, ...(pool.profile ?? {}), name };
      }
      res.end(JSON.stringify(result));
    }
    else if (response.headers.get('content-type')?.includes('text/html')) res.end((await response.text()).replace('<head>', '<head><script src="/_qa-wallet.js"></script>'));
    else res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.statusCode = 502; res.end(String(error)); }
}).listen(port, '127.0.0.1', () => console.log(`Anvil browser QA proxy on port ${port}. Use the sandbox URL with this port; connect Anvil test wallet.`));
