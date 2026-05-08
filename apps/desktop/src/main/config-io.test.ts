import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
  DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
  ensureConfig,
  readConfig,
} from './config-io.js';

async function makeTempConfigPath(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-desktop-config-'));
  return { dir, configPath: join(dir, 'config.json') };
}

function readBuyerMaxPricing(config: Record<string, unknown>): { input: unknown; output: unknown } {
  const buyer = config.buyer as { maxPricing?: { defaults?: Record<string, unknown> } } | undefined;
  const defaults = buyer?.maxPricing?.defaults ?? {};
  return {
    input: defaults.inputUsdPerMillion,
    output: defaults.outputUsdPerMillion,
  };
}

test('ensureConfig creates config with desktop buyer max pricing defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
});

test('ensureConfig clamps buyer max pricing above desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    identity: { displayName: 'Existing User' },
    buyer: {
      proxyPort: 8377,
      minPeerReputation: 50,
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
  assert.equal((config.identity as { displayName?: string }).displayName, 'Existing User');
});

test('ensureConfig clamps only buyer max pricing values above desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 90,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, 4);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
});

test('ensureConfig fills missing buyer max pricing defaults for existing configs', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    identity: { displayName: 'Missing Pricing' },
    buyer: {
      proxyPort: 9123,
      minPeerReputation: 42,
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
  assert.equal((config.buyer as { proxyPort?: number }).proxyPort, 9123);
  assert.equal((config.buyer as { minPeerReputation?: number }).minPeerReputation, 42);
});

test('ensureConfig preserves buyer max pricing at or below desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 20,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, 4);
  assert.equal(pricing.output, 20);
});
