import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import {
  METADATA_AUTH_TYPES,
  makeSessionsDomain,
  signMetadataAuth,
  computeMetadataHash,
  ZERO_METADATA_HASH,
  type MetadataAuthMessage,
} from '../src/payments/evm/signatures.js';
import { identityToEvmWallet } from '../src/payments/evm/keypair.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('EIP-712 Contract Compatibility', () => {
  it('METADATA_AUTH_TYPES typehash matches contract format', () => {
    // The contract computes:
    // keccak256("MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)")
    const expectedTypeString =
      'MetadataAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)';
    const expectedHash = keccak256(toUtf8Bytes(expectedTypeString));

    // Verify our TS type definition produces the same encoding
    const fields = METADATA_AUTH_TYPES.MetadataAuth;
    const tsTypeString = `MetadataAuth(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
    const tsHash = keccak256(toUtf8Bytes(tsTypeString));

    expect(tsHash).toBe(expectedHash);
  });

  it('TS MetadataAuth type string has exactly the right field order and types', () => {
    const fields = METADATA_AUTH_TYPES.MetadataAuth;
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({ name: 'channelId', type: 'bytes32' });
    expect(fields[1]).toEqual({ name: 'cumulativeAmount', type: 'uint256' });
    expect(fields[2]).toEqual({ name: 'metadataHash', type: 'bytes32' });
  });

  it('AntSeed domain version is "6" matching contract constructor', () => {
    const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(domain.name).toBe('AntseedSessions');
    expect(domain.version).toBe('6');
    expect(domain.chainId).toBe(31337);
    expect(domain.verifyingContract).toBe('0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
  });

  it('domain separator is deterministic for same inputs', () => {
    const d1 = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const d2 = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(d1).toEqual(d2);
  });

  it('different chain IDs produce different domains', () => {
    const local = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    const base = makeSessionsDomain(8453, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
    expect(local.chainId).not.toBe(base.chainId);
  });

  it('reserve MetadataAuth (cumulative=0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identityToEvmWallet(identity);
      const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: MetadataAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 0n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig = await signMetadataAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, METADATA_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('settle MetadataAuth (cumulative>0) signs and recovers correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identityToEvmWallet(identity);
      const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const msg: MetadataAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 500000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 5000n, cumulativeOutputTokens: 12000n, cumulativeLatencyMs: 0n, cumulativeRequestCount: 0n }),
      };

      const sig = await signMetadataAuth(wallet, domain, msg);
      const recovered = verifyTypedData(domain, METADATA_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different cumulative amounts produce different MetadataAuth signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identityToEvmWallet(identity);
      const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: MetadataAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: computeMetadataHash({ cumulativeInputTokens: 1000n, cumulativeOutputTokens: 2000n, cumulativeLatencyMs: 0n, cumulativeRequestCount: 0n }),
      };

      const sig1 = await signMetadataAuth(wallet, domain, baseMsg);
      const sig2 = await signMetadataAuth(wallet, domain, {
        ...baseMsg,
        cumulativeAmount: 200000n,
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('different channel IDs produce different signatures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const wallet = identityToEvmWallet(identity);
      const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');

      const baseMsg: MetadataAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      const sig1 = await signMetadataAuth(wallet, domain, baseMsg);
      const sig2 = await signMetadataAuth(wallet, domain, {
        ...baseMsg,
        channelId: '0x' + '02'.repeat(32),
      });
      expect(sig1).not.toBe(sig2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('wrong signer is not recovered from signature', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eip712-test-'));
    try {
      const identity1 = await loadOrCreateIdentity(dir);
      const wallet1 = identityToEvmWallet(identity1);

      // Create a second identity in a different dir
      const dir2 = await mkdtemp(join(tmpdir(), 'eip712-test2-'));
      const identity2 = await loadOrCreateIdentity(dir2);
      const wallet2 = identityToEvmWallet(identity2);

      const domain = makeSessionsDomain(31337, '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707');
      const msg: MetadataAuthMessage = {
        channelId: '0x' + '01'.repeat(32),
        cumulativeAmount: 100000n,
        metadataHash: ZERO_METADATA_HASH,
      };

      // Sign with wallet1
      const sig = await signMetadataAuth(wallet1, domain, msg);
      // Recover and check it does NOT match wallet2
      const recovered = verifyTypedData(domain, METADATA_AUTH_TYPES, msg, sig);
      expect(recovered.toLowerCase()).toBe(wallet1.address.toLowerCase());
      expect(recovered.toLowerCase()).not.toBe(wallet2.address.toLowerCase());

      await rm(dir2, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
