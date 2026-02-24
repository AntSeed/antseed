import { describe, it, expect } from 'vitest'
import { encryptValue, decryptValue, deriveMachineKey, generateSalt } from './encryption.js'

describe('encryption', () => {
  it('should round-trip encrypt and decrypt', () => {
    const salt = generateSalt()
    const key = deriveMachineKey(salt)
    const plaintext = 'sk-ant-api03-secret-key-value'
    const encrypted = encryptValue(plaintext, key)
    expect(encrypted).not.toBe(plaintext)
    const decrypted = decryptValue(encrypted, key)
    expect(decrypted).toBe(plaintext)
  })

  it('should produce different ciphertexts for same input (random IV)', () => {
    const salt = generateSalt()
    const key = deriveMachineKey(salt)
    const plaintext = 'test-secret'
    const a = encryptValue(plaintext, key)
    const b = encryptValue(plaintext, key)
    expect(a).not.toBe(b)
  })

  it('should fail to decrypt with wrong key', () => {
    const salt1 = generateSalt()
    const salt2 = generateSalt()
    const key1 = deriveMachineKey(salt1)
    const key2 = deriveMachineKey(salt2)
    const encrypted = encryptValue('secret', key1)
    expect(() => decryptValue(encrypted, key2)).toThrow()
  })

  it('should handle empty string', () => {
    const salt = generateSalt()
    const key = deriveMachineKey(salt)
    const encrypted = encryptValue('', key)
    const decrypted = decryptValue(encrypted, key)
    expect(decrypted).toBe('')
  })

  it('should handle unicode', () => {
    const salt = generateSalt()
    const key = deriveMachineKey(salt)
    const plaintext = 'héllo wörld 🔑'
    const encrypted = encryptValue(plaintext, key)
    const decrypted = decryptValue(encrypted, key)
    expect(decrypted).toBe(plaintext)
  })
})
