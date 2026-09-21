import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const scenarioFile = process.argv.find(argument => argument.startsWith('--scenario='))?.slice('--scenario='.length);
const scenario = scenarioFile ? JSON.parse(await readFile(scenarioFile, 'utf8')) : null;
if (scenario) {
  assert.equal(scenario.chainId, 31337);
  assert(['127.0.0.1', 'localhost'].includes(new URL(scenario.rpcUrl).hostname));
  const network = await fetch(scenario.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }).then(response => response.json());
  assert.equal(network.result, '0x7a69');
}
const root = path.resolve(process.argv.find(argument => argument.startsWith('--root='))?.slice('--root='.length) ?? 'apps/ants/dist/ants-hosted');
const requests = [];
const errors = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    assert(!pathname.startsWith('/api/'), 'A static site must not receive local API calls');
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    assert(file.startsWith(`${root}${path.sep}`));
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
let page;

try {
  page = await browser.newPage();
  const openMenu = async () => {
    const trigger = page.locator('[aria-controls="hosted-account-menu"]');
    await trigger.waitFor();
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(scenario => {
    const address = scenario?.address ?? '0x0000000000000000000000000000000000000001';
    const listeners = new Map();
    const provider = {
      on(event, callback) { listeners.set(event, [...(listeners.get(event) ?? []), callback]); },
      removeListener(event, callback) { listeners.set(event, (listeners.get(event) ?? []).filter(listener => listener !== callback)); },
      async request({ method, params = [] }) {
        if (method === 'eth_requestAccounts') { sessionStorage.setItem('test.connected', '1'); return [address]; }
        if (method === 'eth_accounts') return sessionStorage.getItem('test.connected') ? [address] : [];
        if (method === 'eth_chainId') return scenario ? '0x7a69' : '0x2105';
        if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
        if (method === 'wallet_revokePermissions') { sessionStorage.removeItem('test.connected'); return null; }
        if (scenario && ['eth_sendTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_estimateGas', 'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call'].includes(method)) {
          if (method === 'eth_sendTransaction') {
            if (params[0].from?.toLowerCase() !== address.toLowerCase()) throw new Error('Unexpected test sender');
            params[0].gas = '0x7a1200';
          }
          const response = await fetch(scenario.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then(response => response.json());
          if (response.error) throw new Error(response.error.message);
          return response.result;
        }
        throw new Error(`Smoke wallet cannot sign or broadcast: ${method}`);
      },
    };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: '00b15368-4985-4919-ab44-777aad2f5481', name: 'Hosted smoke wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.antseed.hosted' }, provider } }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, scenario);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().waitFor();
  await page.getByRole('link', { name: 'My positions', exact: true }).click();
  await page.getByText('Connect your wallet to view and manage your staking positions. Adding a buyer account is optional.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Rewards', exact: true }).click();
  await page.getByText('Your rewards', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
  await page.getByRole('button', { name: 'Hosted smoke wallet', exact: true }).click();
  await page.locator('[aria-controls="hosted-account-menu"]').waitFor();
  await page.locator('[aria-controls="hosted-account-menu"]').click();
  await page.getByRole('button', { name: 'Add buyer account', exact: true }).click();
  await page.getByRole('textbox', { name: /^Buyer address/ }).fill(scenario?.buyerAddress ?? '0x0000000000000000000000000000000000000002');
  await page.getByLabel('Local label (optional)', { exact: true }).fill('Work laptop');
  await page.getByRole('button', { name: 'Save buyer account', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await openMenu();
  await page.getByRole('button', { name: /Work laptop/ }).waitFor();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const menu = await page.locator('#hosted-account-menu').boundingBox();
    assert(menu && menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height, 'Buyer menu must remain inside the viewport');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Dashboard must not overflow horizontally');
    await page.screenshot({ path: `/tmp/ants-1045-hosted-${viewport.width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (scenario) {
    await page.locator('[aria-controls="hosted-account-menu"]').click();
    await page.getByText('Authorized · rewards are paid to your connected wallet.').waitFor({ timeout: 60000 });
    const card = page.locator('.hero').filter({ has: page.getByText('Buyer rewards', { exact: true }) });
    const restake = process.argv.includes('--restake');
    const claim = card.getByRole('button', { name: restake ? 'Stake rewards' : 'Claim to wallet', exact: true }).first();
    await claim.waitFor({ timeout: 60000 });
    await claim.click({ timeout: 60000 });
    if (restake) await page.getByRole('dialog').getByRole('button', { name: 'Stake rewards', exact: true }).click();
    await page.waitForFunction(kind => Object.keys(localStorage).some(key => key.includes(':jobs.v1:') && JSON.parse(localStorage.getItem(key)).some(job => job.kind === kind && job.status === 'done')), restake ? 'stake-usage' : 'claim', { timeout: 120000 });
    console.log(`PASS: buyer ${restake ? 'restake' : 'claim'} signed by the Anvil operator wallet from the static hosted app.`);
    await page.locator('[aria-controls="hosted-account-menu"]').click();
  }
  await page.reload();
  for (let attempt = 0; attempt < 3; attempt++) {
    await openMenu();
    try {
      await page.getByRole('button', { name: /Work laptop/ }).waitFor({ timeout: 10000 });
      break;
    } catch (error) {
      if (attempt === 2 || await page.locator('[aria-controls="hosted-account-menu"]').getAttribute('aria-expanded') === 'true') throw error;
    }
  }
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Local label (optional)', { exact: true }).fill('Renamed laptop');
  await page.getByRole('button', { name: 'Save buyer account', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await openMenu();
  await page.getByRole('button', { name: /Renamed laptop/ }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved buyer', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Renamed laptop/ }).count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.filter(url => url.startsWith(`${origin}/api/`)), []);
  console.log(`PASS: static launch, wallet connection, buyer add/rename/remove/reload, no browser errors, no local API calls; ${scenario ? 'Anvil-only transaction' : 'no transactions signed'}.`);
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Page:', await page?.locator('body').innerText());
  await page?.screenshot({ path: '/tmp/ants-hosted-smoke-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
