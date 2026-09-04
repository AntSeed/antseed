import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchSellerPrices } from './price-reload.js';
import { loadConfig } from '../../../config/loader.js';

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for price reload');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('price watcher follows atomic file replacement, ignores invalid saves and stops cleanly', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-price-reload-'));
  const path = join(directory, 'config.json');
  const prices = (input: number) => ({ provider: { defaults: { inputUsdPerMillion: input, outputUsdPerMillion: input * 2 } } });
  await writeFile(path, JSON.stringify(prices(1)));
  let active = prices(1);
  let reloads = 0;
  const errors: unknown[] = [];
  const watcher = watchSellerPrices(path, {
    initialPricing: active, debounceMs: 10, pollIntervalMs: 50,
    readPricing: async () => JSON.parse(await readFile(path, 'utf8')) as typeof active,
    applyPricing: async (pricing) => { active = pricing as typeof active; },
    onReload: () => { reloads++; }, onError: (error) => { errors.push(error); },
  });
  context.after(async () => { await watcher.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, 'temporary.json'), JSON.stringify(prices(2)));
  await rename(join(directory, 'temporary.json'), path);
  await waitFor(() => reloads === 1);
  assert.deepEqual(active, prices(2));
  await writeFile(path, '{');
  await waitFor(() => errors.length > 0);
  assert.deepEqual(active, prices(2));
  await unlink(path);
  await writeFile(path, JSON.stringify(prices(3)));
  await waitFor(() => reloads === 2);
  assert.deepEqual(active, prices(3));
  await writeFile(path, JSON.stringify(prices(3)));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloads, 2);
  await watcher.close();
  await writeFile(path, JSON.stringify(prices(4)));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloads, 2);
});

test('closing a price watcher prevents a pending read from applying changes', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-price-close-'));
  const path = join(directory, 'config.json');
  await writeFile(path, '{}');
  let finishRead!: () => void;
  let applied = false;
  const watcher = watchSellerPrices(path, {
    initialPricing: {}, debounceMs: 1,
    readPricing: async () => {
      await new Promise<void>((resolve) => { finishRead = resolve; });
      return { provider: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
    },
    applyPricing: async () => { applied = true; }, onReload: () => {}, onError: () => {},
  });
  context.after(async () => { await watcher.close(); await rm(directory, { recursive: true, force: true }); });
  await waitFor(() => Boolean(finishRead));
  const closing = watcher.close();
  finishRead();
  await closing;
  assert.equal(applied, false);
});

test('strict reload never substitutes startup defaults for unreadable or invalid configuration', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-price-config-'));
  const path = join(directory, 'config.json');
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(loadConfig(path, { strict: true }));
  for (const invalid of ['{', 'null', '[]', JSON.stringify({ seller: { providers: { local: { plugin: 'local-llm', services: { model: { pricing: null } } } } } })]) {
    await writeFile(path, invalid);
    await assert.rejects(loadConfig(path, { strict: true }));
  }
});
