import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CAManager } from './ca-manager.js'
import { CertCache } from './cert-cache.js'

async function makeCA(tmpDir: string) {
  const mgr = new CAManager(tmpDir)
  return { mgr, keys: await mgr.generate() }
}

test('CertCache.get() returns PEM cert and key for a hostname', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-cert-test-'))
  try {
    const { keys } = await makeCA(tmpDir)
    const cache = new CertCache(keys)
    const leaf = await cache.get('api-a.example.test')
    assert.ok(leaf.certPem.includes('BEGIN CERTIFICATE'), 'should be PEM cert')
    assert.ok(leaf.privateKeyPem.includes('BEGIN PRIVATE KEY'), 'should be PKCS8 PEM key')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CertCache.get() returns the same cert on repeated calls (cached)', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-cert-test-'))
  try {
    const { keys } = await makeCA(tmpDir)
    const cache = new CertCache(keys)
    const first = await cache.get('api-b.example.test')
    const second = await cache.get('api-b.example.test')
    assert.equal(first.certPem, second.certPem, 'cached cert should be identical')
    assert.equal(first.privateKeyPem, second.privateKeyPem, 'cached key should be identical')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CertCache.get() generates different certs for different hostnames', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-cert-test-'))
  try {
    const { keys } = await makeCA(tmpDir)
    const cache = new CertCache(keys)
    const apiA = await cache.get('api-a.example.test')
    const apiB = await cache.get('api-b.example.test')
    assert.notEqual(apiA.certPem, apiB.certPem, 'different hostnames should get different certs')
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
