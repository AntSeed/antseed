import { describe, expect, it } from 'vitest';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

const publishedSdkImageMetadataHex = '0caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04746573740000018bcfe568000105696d616765000105696d616765000000000000000000000000000000000000000105696d616765040101003e80000000000000010000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('released billing compatibility boundary', () => {
  it('rejects published v12 image billing instead of reinterpreting its unit ID', () => {
    expect(() => decodeMetadata(Buffer.from(publishedSdkImageMetadataHex, 'hex'))).toThrow('seller upgrade required');
  });
  it.each([7, 8, 9, 10, 11, 12])('retains token-only metadata v%s', version => {
    const metadata: PeerMetadata = { version, peerId: 'a'.repeat(40) as PeerMetadata['peerId'], region: 'test', timestamp: 1700000000000, signature: 'b'.repeat(130), providers: [{ provider: 'example', services: ['model'], defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxConcurrency: 1, currentLoad: 0 }] };
    const decoded = decodeMetadata(encodeMetadata(metadata));
    expect(decoded.version).toBe(version);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(metadata));
  });
});
