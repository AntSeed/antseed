import assert from 'node:assert/strict';
import test from 'node:test';
import { ants, epochDate, explorerTx, parseIds, pct, usdc } from './shared.js';

test('parseIds turns positional strings into numbers', () => {
  assert.deepEqual(parseIds(['1', '7']), [1, 7]);
});

test('pct trims trailing zeros from basis points', () => {
  assert.equal(pct(2916), '29.16%');
  assert.equal(pct(5000), '50%');
  assert.equal(pct(0), '0%');
});

test('epochDate resolves an epoch boundary to a UTC timestamp', () => {
  assert.equal(epochDate(1_775_728_461, 604_800, 22), '2026-09-10 09:54 UTC');
});

test('ants and usdc format base units with their unit', () => {
  assert.equal(ants('1500000000000000000'), '1.5 ANTS');
  assert.equal(usdc('1234567'), '$1.23');
  assert.equal(usdc('1234567', 0), '$1');
});

test('explorerTx links Base mainnet and Sepolia, and falls back to the raw hash', () => {
  assert.equal(explorerTx(8453, '0xabc'), 'https://basescan.org/tx/0xabc');
  assert.equal(explorerTx(84532, '0xabc'), 'https://sepolia.basescan.org/tx/0xabc');
  assert.equal(explorerTx(31337, '0xabc'), '0xabc');
});
