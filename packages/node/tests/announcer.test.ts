import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';
import { verifySellerDelegation } from '../src/payments/evm/signatures.js';

function makeBaseConfig(): AnnouncerConfig {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const mockDht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const mockIdentity = {
    peerId,
    privateKey,
    wallet,
  };

  return {
    identity: mockIdentity,
    dht: mockDht as unknown as AnnouncerConfig['dht'],
    providers: [],
    region: 'us',
    pricing: new Map(),
    reannounceIntervalMs: 60_000,
    signalingPort: 0,
  };
}

describe('PeerAnnouncer sellerDelegation', () => {
  it('signs sellerDelegation with the peer identity wallet', async () => {
    const base = makeBaseConfig();
    const proxy = '0x' + 'bb'.repeat(20);
    const announcer = new PeerAnnouncer({
      ...base,
      sellerDelegation: {
        sellerContract: proxy,
        chainId: 8453,
        expiresInSeconds: 3600,
      },
    });

    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerDelegation).toBeDefined();
    expect(meta?.sellerDelegation?.sellerContract).toBe('bb'.repeat(20));

    const verified = verifySellerDelegation(
      proxy,
      {
        peerAddress: base.identity.wallet.address,
        sellerContract: proxy,
        chainId: meta!.sellerDelegation!.chainId,
        expiresAt: meta!.sellerDelegation!.expiresAt,
      },
      meta!.sellerDelegation!.signature,
      base.identity.wallet.address,
    );
    expect(verified).toBe(true);
  });

  it('caches the signed delegation and refreshes before expiry', async () => {
    const base = makeBaseConfig();
    const signSpy = vi.spyOn(base.identity.wallet, 'signTypedData');
    const announcer = new PeerAnnouncer({
      ...base,
      sellerDelegation: {
        sellerContract: '0x' + 'bb'.repeat(20),
        chainId: 8453,
        expiresInSeconds: 3600,
        refreshBeforeExpirySeconds: 600,
      },
    });

    await announcer.announce();
    await announcer.announce();
    expect(signSpy).toHaveBeenCalledTimes(1);
  });
});
