import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePackFetchTarget,
  validatePackFetchUrl,
} from './verify.js'

// The chain-fetch mechanics (anchor/reveal/attestation lookups, calldata
// decoding) live on VerifierRegistryClient in @antseed/node and are tested
// there (packages/node/tests/verifier-client.test.ts). This file covers the
// CLI-side pack-fetch hardening only.

test('validatePackFetchUrl requires explicit public HTTPS destinations', () => {
  assert.equal(validatePackFetchUrl('https://packs.example.com/audit.json').hostname, 'packs.example.com')
  assert.throws(() => validatePackFetchUrl('http://packs.example.com/audit.json'), /HTTPS/)
  assert.throws(() => validatePackFetchUrl('https://localhost/audit.json'), /local hostname/)
  assert.throws(() => validatePackFetchUrl('https://127.0.0.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://10.0.0.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://[::1]/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://192.0.2.1/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://[2001:db8::1]/audit.json'), /private IP/)
  assert.throws(() => validatePackFetchUrl('https://user:pass@packs.example.com/audit.json'), /credentials/)
})

test('resolvePackFetchTarget rejects DNS answers containing private addresses', async () => {
  await assert.rejects(
    resolvePackFetchTarget('https://packs.example.com/audit.json', async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /resolves to a private IP/,
  )
})

test('resolvePackFetchTarget pins a public DNS answer', async () => {
  const target = await resolvePackFetchTarget(
    'https://packs.example.com:8443/audit.json?x=1',
    async () => [{ address: '8.8.8.8', family: 4 }],
  )
  assert.equal(target.address, '8.8.8.8')
  assert.equal(target.family, 4)
  assert.equal(target.url.hostname, 'packs.example.com')
  assert.equal(target.url.port, '8443')
})
