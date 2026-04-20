import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

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

describe('PeerAnnouncer sellerContract', () => {
  it('publishes sellerContract in metadata as lowercase 40-hex', async () => {
    const base = makeBaseConfig();
    const proxy = '0x' + 'bb'.repeat(20);
    const announcer = new PeerAnnouncer({
      ...base,
      sellerContract: { sellerContract: proxy },
    });

    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBe('bb'.repeat(20));
  });

  it('omits sellerContract when not configured', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBeUndefined();
  });
});
