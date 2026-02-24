import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { hostname, homedir } from 'node:os'

const ALGORITHM = 'aes-256-gcm'
const SALT_LENGTH = 32
const IV_LENGTH = 16
const TAG_LENGTH = 16
const KEY_LENGTH = 32

/**
 * Derive an encryption key from a machine-specific seed.
 */
export function deriveMachineKey(salt: Buffer): Buffer {
  const seed = [
    process.env['USER'] ?? process.env['USERNAME'] ?? '',
    hostname(),
    homedir(),
  ].join(':')
  return scryptSync(seed, salt, KEY_LENGTH)
}

/**
 * Encrypt a string value. Returns base64-encoded ciphertext with IV and auth tag prepended.
 */
export function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const combined = Buffer.concat([iv, tag, encrypted])
  return combined.toString('base64')
}

/**
 * Decrypt a base64-encoded value produced by encryptValue.
 */
export function decryptValue(encoded: string, key: Buffer): string {
  const combined = Buffer.from(encoded, 'base64')
  const iv = combined.subarray(0, IV_LENGTH)
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf-8')
}

/**
 * Generate a fresh random salt for key derivation.
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH)
}
