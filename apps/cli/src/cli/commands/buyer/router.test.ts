import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuyerRouterCommand } from './router.js';

test('router describe reads local metadata without a paid request', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'router-describe-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'buyer.state.json'), JSON.stringify({ state: 'connected', port: 12345 }));
  const expected = { metadata: { preferencesSchema: { type: 'object' } }, preferences: { value: true, nested: { count: 2 } } };
  const calls: string[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(url); return new Response(JSON.stringify(expected)); });
  const output: string[] = [];
  context.mock.method(console, 'log', (value: string) => output.push(value));
  const program = new Command().option('--data-dir <path>');
  registerBuyerRouterCommand(program.command('buyer'));
  await program.parseAsync(['--data-dir', directory, 'buyer', 'router', 'describe', '--json'], { from: 'user' });
  assert.deepEqual(calls, ['http://127.0.0.1:12345/_antseed/router/metadata']);
  assert.deepEqual(JSON.parse(output[0]!), expected);
});
