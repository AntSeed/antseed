import { describe, it, expect } from 'vitest';
import { isAddress, verifyTypedData } from 'ethers';
import {
  signSpendingAuth,
  makeChannelsDomain,
  SPENDING_AUTH_TYPES,
  computeMetadataHash,
  ZERO_METADATA_HASH,
} from '../src/payments/evm/signatures.js';
import { signData, verifySignature } from '../src/p2p/identity.js';
import type { SpendingAuthMessage } from '../src/payments/evm/signatures.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

describe('EVM keypair from identity', () => {
  it('produces a valid EVM wallet with a valid address', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identity.wallet;

    expect(wallet.address).toBeDefined();
    expect(isAddress(wallet.address)).toBe(true);
    expect(wallet.address.startsWith('0x')).toBe(true);
  });

  it('derived key is deterministic (same identity produces same wallet)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet1 = identity.wallet;
    const wallet2 = identity.wallet;

    expect(wallet1.address).toBe(wallet2.address);
    expect(wallet1.privateKey).toBe(wallet2.privateKey);
  });

  it('different identities produce different wallets', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity1 = await loadOrCreateIdentity(dir1);
    const identity2 = await loadOrCreateIdentity(dir2);
    const wallet1 = identity1.wallet;
    const wallet2 = identity2.wallet;

    expect(wallet1.address).not.toBe(wallet2.address);
  });

  it('identity.wallet.address returns the same address as the wallet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identity.wallet;
    const address = identity.wallet.address;

    expect(address).toBe(wallet.address);
  });
});

describe('EIP-712 SpendingAuth signature helpers', () => {
  const CHAIN_ID = 31337; // Hardhat local
  const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

  it('signSpendingAuth produces a recoverable EIP-712 signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identity.wallet;
    const domain = makeChannelsDomain(CHAIN_ID, CONTRACT);

    const msg: SpendingAuthMessage = {
      channelId: '0x' + '01'.repeat(32),
      cumulativeAmount: 1_000_000n,
      metadataHash: computeMetadataHash({ cumulativeInputTokens: 500n, cumulativeOutputTokens: 200n, cumulativeLatencyMs: 0n, cumulativeRequestCount: 0n }),
    };

    const sig = await signSpendingAuth(wallet, domain, msg);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);

    // Recover signer via verifyTypedData
    const recovered = verifyTypedData(domain, SPENDING_AUTH_TYPES, msg, sig);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('makeChannelsDomain returns correct domain fields', () => {
    const domain = makeChannelsDomain(CHAIN_ID, CONTRACT);
    expect(domain.name).toBe('AntseedChannels');
    expect(domain.version).toBe('1');
    expect(domain.chainId).toBe(CHAIN_ID);
    expect(domain.verifyingContract).toBe(CONTRACT);
  });

  it('different messages produce different SpendingAuth signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identity.wallet;
    const domain = makeChannelsDomain(CHAIN_ID, CONTRACT);

    const msg1: SpendingAuthMessage = {
      channelId: '0x' + '01'.repeat(32),
      cumulativeAmount: 1_000_000n,
      metadataHash: ZERO_METADATA_HASH,
    };

    const msg2: SpendingAuthMessage = {
      ...msg1,
      cumulativeAmount: 2_000_000n,
    };

    const sig1 = await signSpendingAuth(wallet, domain, msg1);
    const sig2 = await signSpendingAuth(wallet, domain, msg2);
    expect(sig1).not.toBe(sig2);
  });

  it('different channel IDs produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);
    const wallet = identity.wallet;
    const domain = makeChannelsDomain(CHAIN_ID, CONTRACT);

    const msg: SpendingAuthMessage = {
      channelId: '0x' + '01'.repeat(32),
      cumulativeAmount: 1_000_000n,
      metadataHash: ZERO_METADATA_HASH,
    };

    const sig1 = await signSpendingAuth(wallet, domain, msg);
    const sig2 = await signSpendingAuth(wallet, domain, { ...msg, channelId: '0x' + '02'.repeat(32) });
    expect(sig1).not.toBe(sig2);
  });
});

describe('secp256k1 off-chain P2P signatures', () => {
  it('sign and verify round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);

    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = signData(identity.wallet, message);
    const valid = verifySignature(identity.peerId, sig, message);
    expect(valid).toBe(true);
  });

  it('verify rejects tampered message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity = await loadOrCreateIdentity(dir);

    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = signData(identity.wallet, message);
    const tampered = new Uint8Array([1, 2, 3, 4, 6]);
    const valid = verifySignature(identity.peerId, sig, tampered);
    expect(valid).toBe(false);
  });

  it('verify rejects wrong address', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'lch-test-'));
    const identity1 = await loadOrCreateIdentity(dir1);
    const identity2 = await loadOrCreateIdentity(dir2);

    const message = new Uint8Array([10, 20, 30]);
    const sig = signData(identity1.wallet, message);
    const valid = verifySignature(identity2.peerId, sig, message);
    expect(valid).toBe(false);
  });
});
