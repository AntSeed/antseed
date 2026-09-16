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

test('setConfigValue parses boolean fields without coercing strings or payment amounts', () => {
  const config = createDefaultConfig() as unknown as Record<string, unknown>;
  setConfigValue(config, 'buyer.routingPreferences.routerEnabled', 'true');
  setConfigValue(config, 'buyer.autoSweep', 'false');
  setConfigValue(config, 'identity.displayName', '000123');
  setConfigValue(config, 'buyer.routingService.billing.maxAmountMicroUsdc', '5000');
  setConfigValue(config, 'buyer.routingService.maxAdditionalAuthorizationUsdc', '9007199254740993');
  const buyer = config['buyer'] as ReturnType<typeof createDefaultConfig>['buyer'];
  assert.equal(buyer.routingPreferences.routerEnabled, true);
  assert.equal(buyer.autoSweep, false);
  assert.equal((config['identity'] as { displayName: string }).displayName, '000123');
  assert.equal((buyer.routingService!.billing as { maxAmountMicroUsdc: string }).maxAmountMicroUsdc, '5000');
  assert.equal(buyer.routingService!.maxAdditionalAuthorizationUsdc, '9007199254740993');
  assert.throws(() => setConfigValue(config, 'buyer.routingPreferences.routerEnabled', 'yes'), /true or false/);
});

test('setConfigValue rejects unsafe paths before modifying prototypes', () => {
  for (const key of ['seller.providers.__proto__.polluted', 'seller.providers.constructor.prototype.polluted', 'seller..providers']) {
    assert.throws(() => setConfigValue({}, key, '1'), /Invalid config key/);
  }
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

const routingService = {
  routerKey: 'plugin:example-router',
  peerId: 'a'.repeat(40),
  provider: 'classifier',
  serviceId: 'model-selector',
  allowPromptSharing: true,
  billing: { kind: 'per_call', maxAmountMicroUsdc: '5000' },
  maxAdditionalAuthorizationUsdc: '5000',
  maxRequestsPerMinute: 10,
  maxInputBytes: 32768,
  maxOutputTokens: 256,
};

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
  test(`${scope} config commands initialize optional routing fields from defaults`, async () => {
    await withConfigCommands(async (invoke, read) => {
      const set = (key: string, value: string) => invoke(scope === 'global' ? ['set', `buyer.${key}`, value] : ['buyer', 'set', key, value]);
      for (const [key, value] of [
        ['routingPreferences.routerEnabled', 'true'],
        ['routingPreferences.routerSettings', JSON.stringify({ 'plugin:@example/router.v1': { policy: 'true', threshold: '001' } })],
        ['routingService', JSON.stringify(routingService)],
        ['routerTimeoutMs', '15000'],
        ['routerFailureFallback', 'default'],
      ]) {
        const result = await set(key!, value!);
        assert.equal(result.status, 0, result.output);
      }
      let config = await read();
      assert.equal(config.buyer.routingPreferences.routerEnabled, true);
      assert.deepEqual(config.buyer.routingPreferences.routerSettings, { 'plugin:@example/router.v1': { policy: 'true', threshold: '001' } });
      assert.deepEqual(config.buyer.routingService, routingService);
      assert.equal(config.buyer.routerTimeoutMs, 15000);
      assert.equal(config.buyer.routerFailureFallback, 'default');
      assert.equal((await set('routingPreferences.routerEnabled', 'false')).status, 0);
      assert.equal((await set('routingService.billing.maxAmountMicroUsdc', '6000')).status, 0);
      assert.equal((await set('routingService.maxAdditionalAuthorizationUsdc', '6000')).status, 0);
      config = await read();
      assert.equal(config.buyer.routingPreferences.routerEnabled, false);
      assert.deepEqual(config.buyer.routingService!.billing, { kind: 'per_call', maxAmountMicroUsdc: '6000' });
      assert.equal(config.buyer.routingService!.maxAdditionalAuthorizationUsdc, '6000');
    });
  });
}

test('routing command validation fails atomically without corrupting a valid file', async () => {
  await withConfigCommands(async (invoke, read) => {
    assert.equal((await invoke(['buyer', 'set', 'routingService', JSON.stringify(routingService)])).status, 0);
    const before = await read();
    for (const [key, value] of [
      ['routingPreferences.routerEnabled', 'yes'],
      ['routingPreferences.routerSettings', '{"plugin:test":{"policy":true}}'],
      ['routingPreferences.routerSettings', '{"badNamespace":{"policy":"balanced"}}'],
      ['routingPreferences.routerSettings', '[]'],
      ['routingPreferences.routerSettings', '{broken'],
      ['routingService', JSON.stringify({ ...routingService, allowPromptSharing: false })],
      ['routingService.billing.maxAmountMicroUsdc', '0.005'],
      ['routingService.billing.maxAmountMicroUsdc', '5000000000'],
      ['routingService.allowPromptSharing', 'false'],
      ['routingService.maxInputBytes', '-1'],
      ['routingService.nonexistent', 'true'],
      ['routerTimeoutMs', '0'],
      ['routerFailureFallback', 'anything'],
      ['routerTimoutMs', '15000'],
    ]) {
      const result = await invoke(['buyer', 'set', key!, value!]);
      assert.equal(result.status, 1, `${key}: ${result.output}`);
      assert.deepEqual(await read(), before, `failed ${key} must not save`);
    }
  });
});

test('token classifier JSON and optional seller health booleans can be configured', async () => {
  await withConfigCommands(async (invoke, read) => {
    const tokenService = { ...routingService, billing: { kind: 'token' }, maxInputUsdPerMillion: 1,
      maxOutputUsdPerMillion: 2, maxCachedInputUsdPerMillion: 0.5 };
    assert.equal((await invoke(['buyer', 'set', 'routingService', JSON.stringify(tokenService)])).status, 0);
    assert.equal((await invoke(['seller', 'set', 'healthCheck.enabled', 'false'])).status, 0);
    assert.equal((await invoke(['set', 'seller.gasCheck.enabled', 'true'])).status, 0);
    assert.equal((await invoke(['buyer', 'set', 'autoSweep', 'false'])).status, 0);
    const config = await read();
    assert.deepEqual(config.buyer.routingService, tokenService);
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
