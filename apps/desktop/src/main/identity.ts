// ── Secure Identity (Electron safeStorage) ──
// Uses Electron's safeStorage API to encrypt the identity private key at rest.
// The encrypted blob is stored in a file; the OS keychain protects the encryption key.

import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Identity } from '@antseed/node';
import { hexToBytes, bytesToHex, toPeerId } from '@antseed/node';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const ENCRYPTED_IDENTITY_PATH = path.join(homedir(), '.antseed', 'identity.enc');
const PLAINTEXT_IDENTITY_PATH = path.join(homedir(), '.antseed', 'identity.key');

let secureIdentity: Identity | null = null;
let secureIdentityPromise: Promise<void> | null = null;
let _safeStorageReady: boolean | null = null;

function safeStorageAvailable(): boolean {
  if (_safeStorageReady === null) {
    try {
      _safeStorageReady = safeStorage.isEncryptionAvailable();
    } catch {
      _safeStorageReady = false;
    }
  }
  return _safeStorageReady;
}

function identityFromHex(hex: string): Identity {
  const privateKey = hexToBytes(hex);
  const publicKey = ed.getPublicKey(privateKey);
  return { peerId: toPeerId(bytesToHex(publicKey)), privateKey, publicKey };
}

async function loadEncryptedIdentity(): Promise<string | null> {
  try {
    const encrypted = await readFile(ENCRYPTED_IDENTITY_PATH);
    const decrypted = safeStorage.decryptString(encrypted);
    const trimmed = decrypted.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function saveEncryptedIdentity(hexKey: string): Promise<void> {
  const encrypted = safeStorage.encryptString(hexKey);
  const dir = path.dirname(ENCRYPTED_IDENTITY_PATH);
  const tmpPath = ENCRYPTED_IDENTITY_PATH + '.tmp';
  await mkdir(dir, { recursive: true });
  await writeFile(tmpPath, encrypted, { mode: 0o600 });
  await rename(tmpPath, ENCRYPTED_IDENTITY_PATH);
}

export function secureIdentityEnv(): Record<string, string> {
  if (!secureIdentity) return {};
  return { ANTSEED_IDENTITY_HEX: bytesToHex(secureIdentity.privateKey) };
}

const MAX_IDENTITY_RETRIES = 3;
let identityRetryCount = 0;

export async function ensureSecureIdentity(): Promise<void> {
  if (secureIdentity) return;
  if (secureIdentityPromise) {
    await secureIdentityPromise;
    return;
  }
  if (identityRetryCount >= MAX_IDENTITY_RETRIES) return;

  const attempt = (async () => {
    try {
      if (!safeStorageAvailable()) {
        console.warn('[desktop] safeStorage not available — skipping secure identity');
        return;
      }

      // 1. Try loading from encrypted store
      const encHex = await loadEncryptedIdentity();
      if (encHex) {
        secureIdentity = identityFromHex(encHex);
        console.log(`[desktop] secure identity loaded from encrypted store: ${secureIdentity.peerId.slice(0, 12)}...`);
        return;
      }

      // 2. Migrate existing plaintext file identity into encrypted store
      let migratedHex: string | null = null;
      try {
        const raw = await readFile(PLAINTEXT_IDENTITY_PATH, 'utf-8');
        const trimmed = raw.trim();
        if (trimmed.length === 64) {
          migratedHex = trimmed;
        } else if (trimmed.length > 0) {
          console.warn(`[desktop] Plaintext identity file has unexpected length (${trimmed.length} chars, expected 64); skipping migration.`);
        }
      } catch {
        // No existing file identity.
      }

      if (migratedHex) {
        await saveEncryptedIdentity(migratedHex);
        secureIdentity = identityFromHex(migratedHex);
        await unlink(PLAINTEXT_IDENTITY_PATH).catch((unlinkErr) => {
          console.warn(`[desktop] Failed to delete plaintext identity after migration: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}. Delete ${PLAINTEXT_IDENTITY_PATH} manually.`);
        });
        console.log(`[desktop] secure identity migrated from plaintext: ${secureIdentity.peerId.slice(0, 12)}...`);
        return;
      }

      // 3. No identity anywhere — create fresh and encrypt
      const privateKey = ed.utils.randomPrivateKey();
      const newHex = bytesToHex(privateKey);
      await saveEncryptedIdentity(newHex);
      secureIdentity = identityFromHex(newHex);
      console.log(`[desktop] secure identity created: ${secureIdentity.peerId.slice(0, 12)}...`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[desktop] secure identity init failed: ${message}`);
    }
  })();

  secureIdentityPromise = attempt;
  try {
    await attempt;
  } finally {
    // Reset on transient failure so a subsequent call can retry (up to MAX_IDENTITY_RETRIES).
    // If safeStorage is permanently unavailable, keep the promise so we don't re-warn.
    if (!secureIdentity && safeStorageAvailable() && secureIdentityPromise === attempt) {
      identityRetryCount++;
      secureIdentityPromise = null;
    }
  }
}

export function getSecureIdentity(): Identity | null {
  return secureIdentity;
}
