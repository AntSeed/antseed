/**
 * Provider plugin verification script.
 *
 * Checks that:
 *  1. The plugin default export satisfies AntseedProviderPlugin
 *  2. createProvider() returns a valid Provider
 *  3. handleRequest returns a valid SerializedHttpResponse
 *  4. getCapacity returns the correct shape
 */
import type { AntseedProviderPlugin } from '@antseed/node';
import plugin from '../src/index.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log('Verifying provider plugin...\n');

  // --- 1. Plugin shape ---
  console.log('1. Plugin shape (AntseedProviderPlugin)');
  const p = plugin as AntseedProviderPlugin;
  assert(p.type === 'provider', 'plugin.type is "provider"');
  assert(typeof p.name === 'string' && p.name.length > 0, 'plugin.name is a non-empty string');
  assert(typeof p.displayName === 'string', 'plugin.displayName is a string');
  assert(typeof p.version === 'string', 'plugin.version is a string');
  assert(typeof p.description === 'string', 'plugin.description is a string');
  assert(typeof p.createProvider === 'function', 'plugin.createProvider is a function');

  // --- 2. createProvider ---
  console.log('\n2. createProvider()');
  const provider = await p.createProvider({});
  assert(typeof provider.name === 'string' && provider.name.length > 0, 'provider.name is a non-empty string');
  assert(Array.isArray(provider.models) && provider.models.length > 0, 'provider.models is non-empty array');
  assert(
    typeof provider.pricing?.defaults?.inputUsdPerMillion === 'number',
    'provider.pricing.defaults.inputUsdPerMillion is a number',
  );
  assert(
    typeof provider.pricing?.defaults?.outputUsdPerMillion === 'number',
    'provider.pricing.defaults.outputUsdPerMillion is a number',
  );
  assert(typeof provider.maxConcurrency === 'number' && provider.maxConcurrency > 0, 'provider.maxConcurrency > 0');
  assert(typeof provider.handleRequest === 'function', 'provider.handleRequest is a function');
  assert(typeof provider.getCapacity === 'function', 'provider.getCapacity is a function');

  // --- 3. handleRequest ---
  console.log('\n3. handleRequest()');
  const testReq = {
    requestId: 'test-001',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ prompt: 'hello' })),
  };
  const response = await provider.handleRequest(testReq);
  assert(response.requestId === 'test-001', 'response.requestId matches');
  assert(response.statusCode === 200, 'response.statusCode is 200');
  assert(typeof response.headers === 'object', 'response.headers is an object');
  assert(response.body instanceof Uint8Array, 'response.body is Uint8Array');

  // --- 4. getCapacity ---
  console.log('\n4. getCapacity()');
  const capacity = provider.getCapacity();
  assert(typeof capacity.current === 'number', 'capacity.current is a number');
  assert(typeof capacity.max === 'number', 'capacity.max is a number');
  assert(capacity.current >= 0, 'capacity.current >= 0');
  assert(capacity.max > 0, 'capacity.max > 0');
  assert(Array.isArray(p.configKeys), 'plugin.configKeys is an array');

  // --- Summary ---
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All checks passed!');
  }
}

main().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
