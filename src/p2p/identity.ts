import * as ed from "@noble/ed25519";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

export interface Identity {
  peerId: PeerId;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Load an existing identity from disk, or create and persist a new one.
 * The private key is stored as hex in ~/.antseed/identity.key.
 */
export async function loadOrCreateIdentity(configDir?: string): Promise<Identity> {
  const dir = configDir ?? CONFIG_DIR;
  const keyPath = join(dir, PRIVATE_KEY_FILE);

  try {
    const hexKey = (await readFile(keyPath, "utf-8")).trim();
    const privateKey = hexToBytes(hexKey);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const peerId = toPeerId(bytesToHex(publicKey));
    return { peerId, privateKey, publicKey };
  } catch {
    // Key doesn't exist — generate a new one.
    const privateKey = ed.utils.randomPrivateKey();
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    const peerId = toPeerId(bytesToHex(publicKey));

    await mkdir(dir, { recursive: true });
    await writeFile(keyPath, bytesToHex(privateKey), { mode: 0o600 });

    return { peerId, privateKey, publicKey };
  }
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
