import { describe, it, expect } from 'vitest';
import { isAddress, verifyTypedData } from 'ethers';
import { identityToEvmWallet, identityToEvmAddress } from '../src/payments/evm/keypair.js';
import {
  signSpendingAuth,
  makeEscrowDomain,
  SPENDING_AUTH_TYPES,
  buildReceiptMessage,
  buildAckMessage,
  signMessageEd25519,
  verifyMessageEd25519,
} from '../src/payments/evm/signatures.js';
import type { SpendingAuthMessage } from '../src/payments/evm/signatures.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

describe('EVM keypair from identity', () => {
  it('produces a valid EVM wallet with a valid address', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identityToEvmWallet(identity);

    expect(wallet.address).toBeDefined();
    expect(isAddress(wallet.address)).toBe(true);
    expect(wallet.address.startsWith('0x')).toBe(true);
  });

  it('derived key is deterministic (same identity produces same wallet)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet1 = identityToEvmWallet(identity);
    const wallet2 = identityToEvmWallet(identity);

    expect(wallet1.address).toBe(wallet2.address);
    expect(wallet1.privateKey).toBe(wallet2.privateKey);
  });

  it('different identities produce different wallets', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity1 = await loadOrCreateIdentity(dir1);
    const identity2 = await loadOrCreateIdentity(dir2);
    const wallet1 = identityToEvmWallet(identity1);
    const wallet2 = identityToEvmWallet(identity2);

    expect(wallet1.address).not.toBe(wallet2.address);
  });

  it('identityToEvmAddress returns the same address as the wallet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identityToEvmWallet(identity);
    const address = identityToEvmAddress(identity);

    expect(address).toBe(wallet.address);
  });
});

describe('EIP-712 SpendingAuth signature helpers', () => {
  const CHAIN_ID = 31337; // Hardhat local
  const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  it('signSpendingAuth produces a recoverable EIP-712 signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identityToEvmWallet(identity);
    const domain = makeEscrowDomain(CHAIN_ID, CONTRACT);

    const msg: SpendingAuthMessage = {
      seller: '0x' + 'ab'.repeat(20),
      sessionId: '0x' + '01'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: 1700000000,
      previousConsumption: 0n,
      previousSessionId: '0x' + '00'.repeat(32),
    };

    const sig = await signSpendingAuth(wallet, domain, msg);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);

    // Recover signer via verifyTypedData
    const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('makeEscrowDomain returns correct domain fields', () => {
    const domain = makeEscrowDomain(CHAIN_ID, CONTRACT);
    expect(domain.name).toBe('AntseedEscrow');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(CHAIN_ID);
    expect(domain.verifyingContract).toBe(CONTRACT);
  });

  it('different messages produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identityToEvmWallet(identity);
    const domain = makeEscrowDomain(CHAIN_ID, CONTRACT);

    const msg1: SpendingAuthMessage = {
      seller: '0x' + 'ab'.repeat(20),
      sessionId: '0x' + '01'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: 1700000000,
      previousConsumption: 0n,
      previousSessionId: '0x' + '00'.repeat(32),
    };

    const msg2: SpendingAuthMessage = {
      ...msg1,
      maxAmount: 2_000_000n,
    };

    const sig1 = await signSpendingAuth(wallet, domain, msg1);
    const sig2 = await signSpendingAuth(wallet, domain, msg2);
    expect(sig1).not.toBe(sig2);
  });

  it('different nonces produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identityToEvmWallet(identity);
    const domain = makeEscrowDomain(CHAIN_ID, CONTRACT);

    const msg: SpendingAuthMessage = {
      seller: '0x' + 'ab'.repeat(20),
      sessionId: '0x' + '01'.repeat(32),
      maxAmount: 1_000_000n,
      nonce: 1,
      deadline: 1700000000,
      previousConsumption: 0n,
      previousSessionId: '0x' + '00'.repeat(32),
    };

    const sig1 = await signSpendingAuth(wallet, domain, msg);
    const sig2 = await signSpendingAuth(wallet, domain, { ...msg, nonce: 2 });
    expect(sig1).not.toBe(sig2);
  });
});

describe('Ed25519 off-chain signatures', () => {
  it('buildReceiptMessage produces 76-byte message', () => {
    const sessionId = new Uint8Array(32).fill(1);
    const runningTotal = 1_000_000n;
    const requestCount = 5;
    const responseHash = new Uint8Array(32).fill(0xab);

    const msg = buildReceiptMessage(sessionId, runningTotal, requestCount, responseHash);
    expect(msg.length).toBe(76);
    expect(msg.slice(0, 32)).toEqual(sessionId);
    expect(msg.slice(44, 76)).toEqual(responseHash);
  });

  it('buildAckMessage produces 44-byte message', () => {
    const sessionId = new Uint8Array(32).fill(2);
    const runningTotal = 500_000n;
    const requestCount = 3;

    const msg = buildAckMessage(sessionId, runningTotal, requestCount);
    expect(msg.length).toBe(44);
    expect(msg.slice(0, 32)).toEqual(sessionId);
  });

  it('Ed25519 sign and verify round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);

    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = await signMessageEd25519(identity, message);
    const valid = await verifyMessageEd25519(identity.publicKey, sig, message);
    expect(valid).toBe(true);
  });

  it('Ed25519 verify rejects tampered message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);

    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = await signMessageEd25519(identity, message);
    const tampered = new Uint8Array([1, 2, 3, 4, 6]);
    const valid = await verifyMessageEd25519(identity.publicKey, sig, tampered);
    expect(valid).toBe(false);
  });

  it('Ed25519 verify rejects wrong public key', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity1 = await loadOrCreateIdentity(dir1);
    const identity2 = await loadOrCreateIdentity(dir2);

    const message = new Uint8Array([10, 20, 30]);
    const sig = await signMessageEd25519(identity1, message);
    const valid = await verifyMessageEd25519(identity2.publicKey, sig, message);
    expect(valid).toBe(false);
  });
});
