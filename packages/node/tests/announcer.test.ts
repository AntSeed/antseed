import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { capabilityTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 } from '../src/types/protocol.js';

const EXTRA_CAPABILITY = 'tools.streaming.v1';

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

describe('PeerAnnouncer capabilities', () => {
  it('publishes response auth support in metadata', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.capabilities).toEqual([CONNECTION_CAPABILITY_RESPONSE_AUTH_V1]);
  });

  it('announces every extraCapabilities entry on its capability topic (findByCapability path)', async () => {
    const base = makeBaseConfig();
    const announcer = new PeerAnnouncer({
      ...base,
      extraCapabilities: [EXTRA_CAPABILITY],
    });

    await announcer.announce();

    const announceMock = (base.dht as unknown as { announce: ReturnType<typeof vi.fn> }).announce;
    const announcedInfoHashes = announceMock.mock.calls.map(
      ([infoHash]) => Buffer.from(infoHash as Uint8Array).toString('hex'),
    );
    // This is the exact infohash PeerLookup.findByCapability() queries.
    expect(announcedInfoHashes).toContain(
      Buffer.from(topicToInfoHash(capabilityTopic(EXTRA_CAPABILITY))).toString('hex'),
    );
  });

  it('normalizes and dedupes extraCapabilities against the mandatory set before signing', async () => {
    const base = makeBaseConfig();
    const announcer = new PeerAnnouncer({
      ...base,
      extraCapabilities: [
        // Mandatory capability restated, mixed case, duplicates, whitespace,
        // and empties must all collapse to a validator-clean list.
        CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
        ` ${EXTRA_CAPABILITY.toUpperCase()} `,
        EXTRA_CAPABILITY,
        '  ',
      ],
    });

    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.capabilities).toEqual([
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      EXTRA_CAPABILITY,
    ]);
    expect(validateMetadata(meta!).filter((e) => e.field.startsWith('capabilities'))).toEqual([]);
  });
});
