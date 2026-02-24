import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  loadOrCreateIdentity,
  signData,
  verifySignature,
  hexToBytes,
  bytesToHex,
  signUtf8Ed25519,
  verifyUtf8Ed25519,
} from '../src/p2p/identity.js';

function tmpDir(): string {
  return path.join(os.tmpdir(), `antseed-test-${randomBytes(8).toString('hex')}`);
}

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  dirsToClean.length = 0;
});

describe('hexToBytes / bytesToHex', () => {
  it('should round-trip bytes', () => {
    const original = new Uint8Array([0, 1, 127, 255, 16]);
    const hex = bytesToHex(original);
    const back = hexToBytes(hex);
    expect(back).toEqual(original);
  });

  it('should produce lowercase hex', () => {
    const hex = bytesToHex(new Uint8Array([0xab, 0xcd]));
    expect(hex).toBe('abcd');
  });

  it('should throw for odd-length hex string', () => {
    expect(() => hexToBytes('abc')).toThrow('even length');
  });
});

describe('loadOrCreateIdentity', () => {
  it('should create a new identity when config dir does not exist', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);

    expect(identity.peerId).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey.length).toBe(32);
  });

  it('should persist and reload the same identity', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const first = await loadOrCreateIdentity(dir);
    const second = await loadOrCreateIdentity(dir);

    expect(second.peerId).toBe(first.peerId);
    expect(bytesToHex(second.privateKey)).toBe(bytesToHex(first.privateKey));
    expect(bytesToHex(second.publicKey)).toBe(bytesToHex(first.publicKey));
  });
});

describe('signData / verifySignature', () => {
  it('should sign and verify data', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const data = new TextEncoder().encode('hello world');
    const signature = await signData(identity.privateKey, data);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);

    const valid = await verifySignature(identity.publicKey, signature, data);
    expect(valid).toBe(true);
  });

  it('should fail verification with wrong data', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const data = new TextEncoder().encode('hello');
    const signature = await signData(identity.privateKey, data);

    const wrongData = new TextEncoder().encode('world');
    const valid = await verifySignature(identity.publicKey, signature, wrongData);
    expect(valid).toBe(false);
  });
});

describe('signUtf8Ed25519 / verifyUtf8Ed25519', () => {
  it('should sign and verify a UTF-8 message', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const message = 'receipt|data|12345';
    const sig = signUtf8Ed25519(identity.privateKey, message);

    expect(sig).toMatch(/^[0-9a-f]+$/);
    expect(sig.length).toBe(128); // 64 bytes = 128 hex chars

    const valid = verifyUtf8Ed25519(identity.peerId, message, sig);
    expect(valid).toBe(true);
  });

  it('should fail verification with wrong message', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const sig = signUtf8Ed25519(identity.privateKey, 'correct');
    const valid = verifyUtf8Ed25519(identity.peerId, 'wrong', sig);
    expect(valid).toBe(false);
  });

  it('should fail verification with invalid public key', () => {
    const valid = verifyUtf8Ed25519('invalidhex', 'msg', 'ab'.repeat(64));
    expect(valid).toBe(false);
  });
});
