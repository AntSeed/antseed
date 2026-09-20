import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolvePluginPackage } from '../../../plugins/registry.js';
import {
  redactConfig,
  registerConfigCommand,
  setConfigValue,
} from './index.js';

test('resolvePluginPackage maps trusted plugin aliases to package names', () => {
  assert.equal(resolvePluginPackage('openai'), '@antseed/provider-openai');
  assert.equal(resolvePluginPackage('@custom/provider'), '@custom/provider');
});

test('setConfigValue parses booleans without coercing strings or payment amounts', () => {
  const config = createDefaultConfig() as unknown as Record<string, unknown>;
  setConfigValue(config, 'buyer.autoSweep', 'false');
  setConfigValue(config, 'identity.displayName', '000123');
  setConfigValue(config, 'payments.maxPerRequestUsdc', '9007199254740993');
  assert.equal((config['buyer'] as ReturnType<typeof createDefaultConfig>['buyer']).autoSweep, false);
  assert.equal((config['identity'] as { displayName: string }).displayName, '000123');
  assert.equal((config['payments'] as { maxPerRequestUsdc: string }).maxPerRequestUsdc, '9007199254740993');
  assert.throws(() => setConfigValue(config, 'buyer.autoSweep', 'yes'), /true or false/);
});

test('setConfigValue rejects unsafe paths before modifying prototypes', () => {
  for (const key of ['seller.providers.__proto__.polluted', 'seller.providers.constructor.prototype.polluted', 'seller..providers']) {
    assert.throws(() => setConfigValue({}, key, '1'), /Invalid config key/);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

const selection = { kind: 'router', service: { peerId: 'a'.repeat(40), provider: 'classifier', serviceId: 'model-selector' } };

async function withConfigCommands(run: (invoke: (args: string[]) => Promise<{ status: number; output: string }>, read: () => Promise<ReturnType<typeof createDefaultConfig>>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-config-command-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(createDefaultConfig()));
  try {
    await run(async (args) => {
      const program = new Command();
      program.option('--config <path>').option('--data-dir <path>');
      registerConfigCommand(program);
      const previousExitCode = process.exitCode;
      const previousLog = console.log;
      const previousError = console.error;
      const output: string[] = [];
      process.exitCode = 0;
      console.log = (...values: unknown[]) => { output.push(values.join(' ')); };
      console.error = (...values: unknown[]) => { output.push(values.join(' ')); };
      try {
        await program.parseAsync(['--config', configPath, '--data-dir', directory, 'config', ...args], { from: 'user' });
        return { status: Number(process.exitCode ?? 0), output: output.join('\n') };
      } finally {
        process.exitCode = previousExitCode;
        console.log = previousLog;
        console.error = previousError;
      }
    }, async () => JSON.parse(await readFile(configPath, 'utf8')) as ReturnType<typeof createDefaultConfig>);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const scope of ['global', 'buyer'] as const) {
  test(`${scope} config commands select a router without duplicate settings`, async () => {
    await withConfigCommands(async (invoke, read) => {
      const set = (key: string, value: string) => invoke(scope === 'global' ? ['set', `buyer.${key}`, value] : ['buyer', 'set', key, value]);
      assert.equal((await set('selection', JSON.stringify(selection))).status, 0);
      assert.equal((await set('routingPreferences.routerSettings', '{"plugin:example":{"instructions":"Prefer cheaper models"}}')).status, 0);
      assert.deepEqual((await read()).buyer.selection, selection);
      assert.equal((await set('selection', '{"kind":"model","model":"model-a"}')).status, 0);
      assert.deepEqual((await read()).buyer.selection, { kind: 'model', model: 'model-a' });
    });
  });
}

test('routing command validation fails atomically without corrupting a valid file', async () => {
  await withConfigCommands(async (invoke, read) => {
    assert.equal((await invoke(['buyer', 'set', 'selection', JSON.stringify(selection)])).status, 0);
    const before = await read();
    for (const [key, value] of [
      ['selection', '{"kind":"router","model":"fallback"}'],
      ['selection', '{"kind":"router","service":{"peerId":"invalid"}}'],
      ['selection', '{broken'],
      ['routingPreferences.routerSettings', '{"plugin:test":{"policy":true}}'],
      ['routingMode', 'router'], ['routerFailureFallback', 'default'],
      ['routerTimeoutMs', '1000'], ['routingService', '{}'],
    ]) {
      const result = await invoke(['buyer', 'set', key!, value!]);
      assert.equal(result.status, 1, `${key}: ${result.output}`);
      assert.deepEqual(await read(), before);
    }
  });
});

test('optional seller and buyer booleans remain configurable', async () => {
  await withConfigCommands(async (invoke, read) => {
    assert.equal((await invoke(['seller', 'set', 'healthCheck.enabled', 'false'])).status, 0);
    assert.equal((await invoke(['set', 'seller.gasCheck.enabled', 'true'])).status, 0);
    assert.equal((await invoke(['buyer', 'set', 'autoSweep', 'false'])).status, 0);
    const config = await read();
    assert.equal(config.seller.healthCheck!.enabled, false);
    assert.equal(config.seller.gasCheck!.enabled, true);
    assert.equal(config.buyer.autoSweep, false);
  });
});

test('setConfigValue creates nested seller provider paths for dynamic keys', () => {
  const config = createDefaultConfig() as unknown as Record<string, unknown>;

  setConfigValue(
    config,
    'seller.providers.together.services.kimi-k2_5.pricing.inputUsdPerMillion',
    '0.5',
  );

  const seller = config['seller'] as Record<string, unknown>;
  const providers = seller['providers'] as Record<string, unknown>;
  const together = providers['together'] as Record<string, unknown>;
  const services = together['services'] as Record<string, unknown>;
  const kimi = services['kimi-k2_5'] as Record<string, unknown>;
  const pricing = kimi['pricing'] as Record<string, unknown>;

  assert.equal(pricing['inputUsdPerMillion'], 0.5);
});

test('redactConfig returns a detached clone of the config object', () => {
  const config = createDefaultConfig();
  config.identity.displayName = 'Original';

  const redacted = redactConfig(config);
  (redacted['identity'] as Record<string, unknown>)['displayName'] = 'Mutated';

  assert.equal(config.identity.displayName, 'Original');
});
