import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Wallet, hashMessage, getBytes, hexlify, verifyMessage } from "ethers";
import { toPeerId, type PeerId } from "../types/peer.js";
import { hexToBytes, bytesToHex } from "../utils/hex.js";

export { hexToBytes, bytesToHex };

/**
 * Domain prefixes for signing contexts.
 * Prevents cross-domain signature replay between different parts of the protocol.
 */
const DOMAIN_DATA = new TextEncoder().encode("antseed-data-v1:");
const DOMAIN_MSG = "antseed-msg-v1:";

const CONFIG_DIR = join(homedir(), ".antseed");
const PRIVATE_KEY_FILE = "identity.key";

export interface Identity {
  peerId: PeerId;
  privateKey: Uint8Array;
  wallet: Wallet;
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

export function identityFromPrivateKeyHex(hex: string): Identity {
  const privateKey = hexToBytes(hex);
  const wallet = new Wallet('0x' + hex);
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());
  return { peerId, privateKey, wallet };
}

/**
 * Load an existing identity or create and persist a new one.
 *
 * The identity is a secp256k1 private key stored as 64 hex chars.
 * The peerId is derived as the EVM address (lowercase, no 0x prefix).
 */
export async function loadOrCreateIdentity(configDirOrStore?: string | IdentityStore): Promise<Identity> {
  // Check for identity injected via environment (desktop → CLI child process).
  const envHex = process.env[IDENTITY_HEX_ENV]?.trim();
  if (envHex && envHex.length === 64) {
    delete process.env[IDENTITY_HEX_ENV];
    return identityFromPrivateKeyHex(envHex);
  }

  const store: IdentityStore =
    configDirOrStore === undefined || typeof configDirOrStore === 'string'
      ? new FileIdentityStore(configDirOrStore)
      : configDirOrStore;

  const existingHex = await store.load();
  if (existingHex && existingHex.length === 64) {
    return identityFromPrivateKeyHex(existingHex);
  }

  // Key doesn't exist — generate a new secp256k1 private key.
  const privateKey = randomBytes(32);
  const hex = bytesToHex(privateKey);

  await store.save(hex);

  return identityFromPrivateKeyHex(hex);
}

/**
 * Sign arbitrary binary data with the identity's secp256k1 private key.
 * Domain-tagged with "antseed-data-v1:" prefix to prevent cross-domain replay.
 * Uses EIP-191 personal_sign. Returns a 65-byte signature (r + s + v).
 */
export function signData(
  wallet: Wallet,
  data: Uint8Array
): Uint8Array {
  const tagged = new Uint8Array(DOMAIN_DATA.length + data.length);
  tagged.set(DOMAIN_DATA, 0);
  tagged.set(data, DOMAIN_DATA.length);
  const digest = hashMessage(tagged);
  const sig = wallet.signingKey.sign(digest);
  return getBytes(sig.serialized);
}

/**
 * Verify a binary data signature from a remote peer using ecrecover.
 * The expectedAddress is the 40-char hex peerId (no 0x prefix).
 */
export function verifySignature(
  expectedAddress: string,
  signature: Uint8Array,
  data: Uint8Array
): boolean {
  try {
    const tagged = new Uint8Array(DOMAIN_DATA.length + data.length);
    tagged.set(DOMAIN_DATA, 0);
    tagged.set(data, DOMAIN_DATA.length);
    const recovered = verifyMessage(tagged, hexlify(signature));
    return recovered.slice(2).toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Sign a UTF-8 message and return a hex-encoded secp256k1 signature (130 hex chars = 65 bytes).
 * Domain-tagged with "antseed-msg-v1:" prefix to prevent cross-domain replay.
 */
export function signUtf8(wallet: Wallet, message: string): string {
  const tagged = DOMAIN_MSG + message;
  const msgBytes = new TextEncoder().encode(tagged);
  const digest = hashMessage(msgBytes);
  const sig = wallet.signingKey.sign(digest);
  return sig.serialized.slice(2);
}

/**
 * Verify a UTF-8 message against a hex-encoded secp256k1 signature.
 * Returns true if the recovered address matches the expected address.
 */
export function verifyUtf8(
  address: string,
  message: string,
  signatureHex: string
): boolean {
  try {
    const tagged = DOMAIN_MSG + message;
    const msgBytes = new TextEncoder().encode(tagged);
    const recovered = verifyMessage(msgBytes, '0x' + signatureHex);
    return recovered.slice(2).toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
