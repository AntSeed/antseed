import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../../packages/node/src/p2p/identity.js';

const execFile = promisify(execFileCallback);
const existingSandboxOut = process.env.M001_SANDBOX_OUT;
const enabled = Boolean(
  process.env.M001_SANDBOX_RPC
  && process.env.ANTS_HOLDER
  && (process.env.BASE_MAINNET_RPC_URL || existingSandboxOut),
);
const root = resolve(__dirname, '../..');
const cli = join(root, 'apps/cli/dist/cli/index.js');

describe.skipIf(!enabled)('M001 CLI sandbox', () => {
  let out: string;
  let dataDir: string;
  let config: string;
  let walletAddress: string;
  let ownsSandbox = false;

  async function run(command: string[], expectFailure = false): Promise<string> {
    try {
      const result = await execFile(process.execPath, [cli, '--config', config, '--data-dir', dataDir, ...command], {
        cwd: root,
        env: process.env,
      });
      if (expectFailure) throw new Error(`Expected failure: ${command.join(' ')}`);
      return `${result.stdout}${result.stderr}`;
    } catch (error) {
      if (!expectFailure) throw error;
      const failure = error as Error & { stdout?: string; stderr?: string };
      return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
  }

  async function runJson(command: string[]): Promise<unknown> {
    const result = await execFile(process.execPath, [cli, '--config', config, '--data-dir', dataDir, ...command], {
      cwd: root,
      env: process.env,
    });
    return JSON.parse(result.stdout);
  }

  async function sandbox(command: string[]) {
    return execFile('pnpm', ['m001:sandbox', ...command, '--out', out], { cwd: root, env: process.env });
  }

  beforeAll(async () => {
    ownsSandbox = !existingSandboxOut;
    out = existingSandboxOut ? resolve(existingSandboxOut) : await mkdtemp(join(tmpdir(), 'antseed-m001-sandbox-'));
    dataDir = await mkdtemp(join(tmpdir(), 'antseed-m001-cli-'));
    config = join(out, 'cli-config.json');
    await execFile('pnpm', ['--filter', '@antseed/cli', 'build'], { cwd: root, env: process.env });
    const identity = await loadOrCreateIdentity(dataDir);
    walletAddress = identity.wallet.address;
    if (ownsSandbox) {
      const port = new URL(process.env.M001_SANDBOX_RPC!).port || '8545';
      await execFile('pnpm', ['m001:sandbox', 'up', '--port', port, '--out', out], { cwd: root, env: process.env });
    }
    await sandbox(['fund-seller', walletAddress]);
  }, 900_000);

  afterAll(async () => {
    if (ownsSandbox) {
      try { await sandbox(['down']); } catch {}
      await rm(out, { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rehearses legacy, cutover, pools, dual emissions, and mismatch rejection', async () => {
    const registration = await run(['seller', 'register']);
    const agentId = registration.match(/Agent ID:\s*(\d+)/)?.[1];
    expect(agentId).toBeTruthy();
    await run(['seller', 'legacy', 'stake', '10', '--agent-id', agentId!]);
    expect(await run(['seller', 'emissions', 'info'])).toContain('legacy');
    expect(await run(['seller', 'pool', 'bootstrap'], true)).toContain('recognized-usage');
    expect(await run(['network', 'contracts'])).toContain('✓');

    await sandbox(['cutover']);
    expect(await run(['network', 'contracts'])).toContain('recognized-usage');
    expect(await run(['seller', 'legacy', 'stake', '10'], true)).toContain('antseed seller stake');
    expect(await run(['seller', 'stake', '10'], true)).toContain('--epochs');
    await sandbox(['fund-position-init', '5']);
    await run(['seller', 'pool', 'bootstrap']);
    expect(await run(['seller', 'pool', 'positions'])).toContain('pending');
    await run(['seller', 'register', '--agent-id', agentId!]);
    await run(['seller', 'register', '--agent-id', agentId!]);

    await sandbox(['advance-epoch', '2']);
    await sandbox(['fund-ants', walletAddress, '100']);
    await run(['seller', 'stake', '100', '--epochs', '4', '--agent-id', agentId!]);
    const positionsJson = await runJson(['seller', 'pool', 'positions', '--json']) as Array<{ id: number }>;
    expect(positionsJson.length).toBeGreaterThanOrEqual(2);
    await run(['seller', 'pool', 'rewards', '--json']);
    await run(['seller', 'pool', 'rewards', 'claim']);
    const newestId = String(positionsJson.at(-1).id);
    expect(await run(['seller', 'pool', 'withdraw', newestId], true)).toContain('--force');
    await sandbox(['advance-epoch', '1']);
    await run(['seller', 'pool', 'withdraw', newestId, '--force']);

    const sellerInfo = await runJson(['seller', 'emissions', 'info', '--json']) as {
      mode: string;
      legacy: unknown;
      recognizedUsage: unknown;
    };
    expect(sellerInfo.mode).toBe('recognized-usage');
    expect(sellerInfo).toHaveProperty('legacy');
    expect(sellerInfo).toHaveProperty('recognizedUsage');
    await run(['seller', 'emissions', 'claim', '--legacy-only']);
    await run(['seller', 'emissions', 'claim', '--new-only']);
    await run(['buyer', 'emissions', 'info']);

    const broken = JSON.parse(await readFile(config, 'utf8'));
    broken.payments.crypto.usageAccountingAddress = '0x0000000000000000000000000000000000000001';
    const brokenConfig = join(out, 'broken-cli-config.json');
    await writeFile(brokenConfig, JSON.stringify(broken, null, 2));
    const original = config;
    config = brokenConfig;
    expect(await run(['network', 'contracts'], true)).toContain('ContractStackMismatchError');
    config = original;
  }, 900_000);
});
