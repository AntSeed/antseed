import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CAManager } from './ca-manager.js'

test('CAManager.exists() returns false before generation', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    assert.equal(await mgr.exists(), false)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.generate() creates cert and key files', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const keys = await mgr.generate()
    assert.ok(keys.certPem.includes('BEGIN CERTIFICATE'), 'cert should be PEM')
    assert.ok(keys.privateKeyPem.includes('BEGIN PRIVATE KEY'), 'key should be PKCS8 PEM')
    assert.equal(await mgr.exists(), true)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.load() returns the same PEM that was generated', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const generated = await mgr.generate()
    const loaded = await mgr.load()
    assert.equal(loaded.certPem, generated.certPem)
    assert.equal(loaded.privateKeyPem, generated.privateKeyPem)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})

test('CAManager.certFilePath points into the system-proxy subdirectory', () => {
  const mgr = new CAManager('/some/data/dir')
  assert.ok(mgr.certFilePath.includes('system-proxy'), 'cert path should be under system-proxy/')
  assert.ok(mgr.certFilePath.endsWith('.crt'), 'cert file should have .crt extension')
})

test('CAManager.generate() is idempotent — second call overwrites cleanly', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'antseed-ca-test-'))
  try {
    const mgr = new CAManager(tmpDir)
    const first = await mgr.generate()
    const second = await mgr.generate()
    // Both should be valid PEMs; they won't be identical (fresh keys each time)
    assert.ok(second.certPem.includes('BEGIN CERTIFICATE'))
    assert.ok(second.privateKeyPem.includes('BEGIN PRIVATE KEY'))
    // Different runs produce different keys
    assert.notEqual(first.certPem, second.certPem)
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
})
