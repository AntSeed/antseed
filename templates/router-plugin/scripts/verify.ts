/**
 * Router plugin verification script.
 *
 * Checks that:
 *  1. The plugin default export satisfies AntseedRouterPlugin
 *  2. createRouter() returns a valid Router
 *  3. selectPeer returns null for empty peer list, a peer for non-empty
 *  4. onResult completes without error
 */
import type { AntseedRouterPlugin } from '@antseed/node';
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
  console.log('Verifying router plugin...\n');

  // --- 1. Plugin shape ---
  console.log('1. Plugin shape (AntseedRouterPlugin)');
  const p = plugin as AntseedRouterPlugin;
  assert(p.type === 'router', 'plugin.type is "router"');
  assert(typeof p.name === 'string' && p.name.length > 0, 'plugin.name is a non-empty string');
  assert(typeof p.displayName === 'string', 'plugin.displayName is a string');
  assert(typeof p.version === 'string', 'plugin.version is a string');
  assert(typeof p.description === 'string', 'plugin.description is a string');
  assert(typeof p.createRouter === 'function', 'plugin.createRouter is a function');

  // --- 2. createRouter ---
  console.log('\n2. createRouter()');
  const router = await p.createRouter({});
  assert(typeof router.selectPeer === 'function', 'router.selectPeer is a function');
  assert(typeof router.onResult === 'function', 'router.onResult is a function');

  // --- 3. selectPeer ---
  console.log('\n3. selectPeer()');
  const fakeReq = {
    requestId: 'test-001',
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: new Uint8Array(),
  };

  const noPeer = router.selectPeer(fakeReq, []);
  assert(noPeer === null, 'returns null for empty peer list');

  const fakePeer = {
    peerId: 'a'.repeat(64),
    providers: ['anthropic'],
    defaultInputUsdPerMillion: 1,
    defaultOutputUsdPerMillion: 3,
    providerPricing: {
      anthropic: {
        defaults: {
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 3,
        },
      },
    },
    maxConcurrency: 5,
    reputationScore: 80,
    lastSeen: Date.now(),
  };

  const selected = router.selectPeer(fakeReq, [fakePeer]);
  assert(selected !== null, 'returns a peer for non-empty list');
  assert(selected?.peerId === 'a'.repeat(64), 'returns the only peer when one is available');

  // --- 4. onResult ---
  console.log('\n4. onResult()');
  router.onResult(fakePeer, { success: true, latencyMs: 45, tokens: 100 });
  assert(true, 'onResult() completed without error');

  // Verify subsequent selection uses updated latency info
  const secondPeer = { ...fakePeer, peerId: 'b'.repeat(64) };
  const selectedAfterResult = router.selectPeer(fakeReq, [fakePeer, secondPeer]);
  assert(selectedAfterResult?.peerId === 'a'.repeat(64), 'selects lower-latency peer after onResult');

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
