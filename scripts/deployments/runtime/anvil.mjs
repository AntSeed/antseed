import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cast } from './chain.mjs';

export async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitForAnvil(rpcUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Anvil exited with status ${child.exitCode}`);
    if (spawnSync('cast', ['chain-id', '--rpc-url', rpcUrl], { encoding: 'utf8' }).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Anvil');
}

/** Sends a transaction as an arbitrary account by impersonating and funding it. */
export function impersonatedSend(rpcUrl, from, contract, signature, args) {
  cast(rpcUrl, ['rpc', 'anvil_impersonateAccount', from]);
  cast(rpcUrl, ['rpc', 'anvil_setBalance', from, '0x3635C9ADC5DEA00000']);
  cast(rpcUrl, ['send', contract, signature, ...args, '--from', from, '--unlocked']);
}

export function advanceTimeTo(rpcUrl, timestamp) {
  cast(rpcUrl, ['rpc', 'anvil_setNextBlockTimestamp', String(timestamp)]);
  cast(rpcUrl, ['rpc', 'evm_mine']);
}

/** Boots a forked Anvil node, optionally advances time, and always tears it down. */
export async function withAnvilFork({ forkUrl, forkBlockNumber, chainId, timestamp }, body, dependencies = {}) {
  const allocatePort = dependencies.availablePort ?? availablePort;
  const spawnProcess = dependencies.spawn ?? spawn;
  const waitForProcess = dependencies.waitForAnvil ?? waitForAnvil;
  const advance = dependencies.advanceTimeTo ?? advanceTimeTo;
  const port = await allocatePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const args = [
    '--fork-url', forkUrl,
    '--chain-id', String(chainId),
    '--port', String(port),
    '--silent',
  ];
  if (forkBlockNumber != null) args.push('--fork-block-number', String(forkBlockNumber));
  const child = spawnProcess('anvil', args, { stdio: 'inherit' });
  try {
    await waitForProcess(rpcUrl, child);
    if (timestamp != null) advance(rpcUrl, timestamp);
    return await body({ rpcUrl });
  } finally {
    child.kill('SIGTERM');
  }
}
