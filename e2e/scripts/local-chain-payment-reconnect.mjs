import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'],
  { stdio: ['ignore', 'ignore', 'inherit'] });
let failure;
anvil.on('error', (error) => { failure = error; });

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    try {
      const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      ready = (await response.json()).result === '0x7a69';
      if (ready) break;
    } catch {}
    await sleep(100);
  }
  assert.ok(ready, 'fresh local Anvil is ready');
  const deployment = spawnSync('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl,
    '--broadcast', '--slow', '--non-interactive', '--skip', 'test', '--skip', 'Upgrade',
    '--skip', 'DeployBaseMainnet', '--skip', 'DeployBaseSepolia', '--skip', 'DeployDiemStakingProxy'], {
    cwd: join(root, 'packages/contracts'), encoding: 'utf8', timeout: 600_000,
    env: { ...process.env,
      DEPLOYER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      PROTOCOL_RESERVE: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    },
  });
  assert.equal(deployment.status, 0, `${deployment.stdout}\n${deployment.stderr}`);
  const address = (name) => {
    const match = deployment.stdout.match(new RegExp(`${name}:\\s+(0x[0-9a-fA-F]{40})`));
    assert.ok(match, `${name} deployed`);
    return match[1];
  };
  const config = { rpcUrl, usdc: address('MockUSDC'), registry: address('MockERC8004Registry'),
    staking: address('AntseedStaking'), deposits: address('AntseedDeposits'), channels: address('AntseedChannels') };
  console.log('Fresh local-chain reproduction:', JSON.stringify(config));
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run',
    'tests/payment-reconnect.test.ts', '--reporter=verbose'], {
    cwd: join(root, 'packages/node'), stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, PAYMENT_RECONNECT_CHAIN_CONFIG: JSON.stringify(config) },
  });
  process.exitCode = result.status ?? 1;
} finally {
  if (anvil.exitCode === null && !failure) {
    const exited = once(anvil, 'exit');
    anvil.kill('SIGTERM');
    await exited;
  }
}
