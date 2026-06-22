import { describe, expect, it } from 'vitest';
import { AbiCoder, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import {
  FREE_USAGE_AUTH_TYPES,
  FREE_USAGE_OPEN_TYPES,
  computeChannelId,
  computeFreeUsageChannelId,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  getServiceMetadataId,
  makeFreeUsageDomain,
  signFreeUsageAuth,
  signFreeUsageOpen,
  type FreeUsageAuthMessage,
  type FreeUsageOpenMessage,
} from '../src/payments/evm/signatures.js';
import { loadOrCreateIdentity } from '../src/p2p/identity.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('FreeUsage EIP-712 helpers', () => {
  it('typehashes match AntseedFreeUsage contract strings', () => {
    const openType = `FreeUsageOpen(${FREE_USAGE_OPEN_TYPES.FreeUsageOpen.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(keccak256(toUtf8Bytes(openType))).toBe(
      keccak256(toUtf8Bytes('FreeUsageOpen(bytes32 channelId,uint256 deadline)')),
    );

    const authType = `FreeUsageAuth(${FREE_USAGE_AUTH_TYPES.FreeUsageAuth.map((f) => `${f.type} ${f.name}`).join(',')})`;
    expect(keccak256(toUtf8Bytes(authType))).toBe(
      keccak256(toUtf8Bytes('FreeUsageAuth(bytes32 channelId,uint256 sequence,bytes32 metadataHash,uint256 deadline)')),
    );
  });

  it('encodes metadata with services and zero prices in contract layout', () => {
    const serviceId = getServiceMetadataId('gpt-free');
    const metadata = {
      cumulativeInputTokens: 100n,
      cumulativeOutputTokens: 40n,
      cumulativeRequestCount: 2n,
      services: [{
        serviceId,
        cumulativeAmount: 0n,
        cumulativeInputTokens: 100n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 40n,
        cumulativeRequestCount: 2n,
      }],
    };

    const encoded = encodeFreeUsageMetadata(metadata);
    const coder = AbiCoder.defaultAbiCoder();
    const decoded = coder.decode(
      [
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]',
      ],
      encoded,
    );

    expect(decoded[0]).toBe(1n);
    expect(decoded[1]).toBe(100n);
    expect(decoded[2]).toBe(40n);
    expect(decoded[3]).toBe(2n);
    expect(decoded[4]).toEqual([[
      serviceId,
      0n,
      100n,
      0n,
      40n,
      2n,
    ]]);
    expect(computeFreeUsageMetadataHash(metadata)).toBe(keccak256(encoded));
  });

  it('signs and recovers free usage open and usage auth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'free-usage-eip712-'));
    try {
      const identity = await loadOrCreateIdentity(dir);
      const domain = makeFreeUsageDomain(31337, '0x0165878A594ca255338adfa4d48449f69242Eb8F');
      const channelId = computeChannelId(
        identity.wallet.address,
        '0x00000000000000000000000000000000000000b0',
        '0x' + '01'.repeat(32),
      );

      const openMsg: FreeUsageOpenMessage = {
        channelId,
        deadline: 1234n,
      };
      const openSig = await signFreeUsageOpen(identity.wallet, domain, openMsg);
      expect(verifyTypedData(domain, FREE_USAGE_OPEN_TYPES, openMsg, openSig).toLowerCase())
        .toBe(identity.wallet.address.toLowerCase());

      const metadataHash = computeFreeUsageMetadataHash({
        cumulativeInputTokens: 10n,
        cumulativeOutputTokens: 5n,
        cumulativeRequestCount: 1n,
        services: [{
          serviceId: getServiceMetadataId('gpt-free'),
          cumulativeAmount: 0n,
          cumulativeInputTokens: 10n,
          cumulativeCachedInputTokens: 0n,
          cumulativeOutputTokens: 5n,
          cumulativeRequestCount: 1n,
        }],
      });
      const usageMsg: FreeUsageAuthMessage = {
        channelId,
        sequence: 1n,
        metadataHash,
        deadline: 1234n,
      };
      const usageSig = await signFreeUsageAuth(identity.wallet, domain, usageMsg);
      expect(verifyTypedData(domain, FREE_USAGE_AUTH_TYPES, usageMsg, usageSig).toLowerCase())
        .toBe(identity.wallet.address.toLowerCase());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('free usage channel IDs are domain-separated from paid channel IDs', () => {
    const buyer = '0x00000000000000000000000000000000000000a1';
    const seller = '0x00000000000000000000000000000000000000b0';
    const salt = '0x' + '01'.repeat(32);

    expect(computeFreeUsageChannelId(buyer, seller, salt))
      .not.toBe(computeChannelId(buyer, seller, salt));
  });
});
