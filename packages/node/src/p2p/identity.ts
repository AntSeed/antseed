import * as ed from "@noble/ed25519";
import { readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { toPeerId, type PeerId } from "../types/peer.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";

export { hexToBytes, bytesToHex };

/** Directory where identity keys are stored. */
const CONFIG_DIR = join(homedir(), ".antseed");
const PRIVATE_KEY_FILE = "identity.key";
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function ensureSecurePermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const stats = await stat(filePath);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600) {
      await chmod(filePath, 0o600);
      console.warn(`[security] Fixed identity file permissions to 0600: ${filePath}`);
    }
  } catch {
    // File might not exist yet
  }
}

export interface Identity {
  peerId: PeerId;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Pluggable storage backend for identity private keys.
 */
export interface IdentityStore {
  /** Load the private key hex string, or return null if not found. */
  load(): Promise<string | null>;
  /** Persist the private key hex string. */
  save(hexKey: string): Promise<void>;
}

/**
 * Stores identity private key as a hex file on disk (default behavior).
 */
export class FileIdentityStore implements IdentityStore {
  private readonly keyPath: string;
  private readonly dir: string;

  constructor(configDir?: string) {
    this.dir = configDir ?? CONFIG_DIR;
    this.keyPath = join(this.dir, PRIVATE_KEY_FILE);
  }

  async load(): Promise<string | null> {
    try {
      const hexKey = (await readFile(this.keyPath, "utf-8")).trim();
      return hexKey.length > 0 ? hexKey : null;
    } catch {
      return null;
    }
  }

  async save(hexKey: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.keyPath, hexKey, { mode: 0o600 });
  }
}

/** Environment variable for passing identity hex from a parent process (e.g. desktop → CLI). */
const IDENTITY_HEX_ENV = 'ANTSEED_IDENTITY_HEX';

/**
 * Load an existing identity or create and persist a new one.
 *
 * Accepts either a config directory path (legacy file-based storage)
 * or an IdentityStore instance for pluggable backends (e.g. keytar).
 *
 * If the ANTSEED_IDENTITY_HEX env var is set, it is used directly
 * (e.g. when the desktop app injects identity from the keychain).
 */
export async function loadOrCreateIdentity(configDirOrStore?: string | IdentityStore): Promise<Identity> {
  // Check for identity injected via environment (desktop → CLI child process).
  // The CLI clears the variable after reading to limit exposure in /proc/<pid>/environ.
  const envHex = process.env[IDENTITY_HEX_ENV]?.trim();
  if (envHex && envHex.length === 64) {
    delete process.env[IDENTITY_HEX_ENV];
    const privateKey = hexToBytes(envHex);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const peerId = toPeerId(bytesToHex(publicKey));
    return { peerId, privateKey, publicKey };
  }

  const store: IdentityStore =
    configDirOrStore === undefined || typeof configDirOrStore === 'string'
      ? new FileIdentityStore(configDirOrStore)
      : configDirOrStore;

  const existingHex = await store.load();
  if (existingHex) {
    const privateKey = hexToBytes(existingHex);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const peerId = toPeerId(bytesToHex(publicKey));
    return { peerId, privateKey, publicKey };
  }

  // Key doesn't exist — generate a new one.
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const peerId = toPeerId(bytesToHex(publicKey));

  await store.save(bytesToHex(privateKey));

  return { peerId, privateKey, publicKey };
}

/** Sign arbitrary data with the local identity's private key. */
export async function signData(
  privateKey: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  return ed.signAsync(data, privateKey);
}

/** Verify a signature from a remote peer. */
export async function verifySignature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  return ed.verifyAsync(signature, data, publicKey);
}

/**
 * Sign a UTF-8 message and return a hex-encoded Ed25519 signature.
 * Uses Node's crypto implementation for synchronous signing.
 */
export function signUtf8Ed25519(privateKeySeed: Uint8Array, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(privateKeySeed)]),
    format: "der",
    type: "pkcs8",
  });
  const signature = nodeSign(null, Buffer.from(message, "utf-8"), key);
  return signature.toString("hex");
}

/**
 * Verify a UTF-8 message against a hex-encoded Ed25519 signature.
 */
export function verifyUtf8Ed25519(
  publicKeyHex: string,
  message: string,
  signatureHex: string
): boolean {
  try {
    const publicKeyBytes = hexToBytes(publicKeyHex);
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PUBLIC_PREFIX, Buffer.from(publicKeyBytes)]),
      format: "der",
      type: "spki",
    });
    return nodeVerify(
      null,
      Buffer.from(message, "utf-8"),
      key,
      Buffer.from(signatureHex, "hex")
    );
  } catch {
    return false;
  }
}
