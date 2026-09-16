import { describe, expect, it } from 'vitest';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

const publishedSdkImageMetadataHex = '0caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa04746573740000018bcfe568000105696d616765000105696d616765000000000000000000000000000000000000000105696d616765040101003e80000000000000010000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function releasedMetadata(): PeerMetadata {
  return decodeMetadata(Buffer.from(publishedSdkImageMetadataHex, 'hex'));
}

describe('published SDK 0.2.118 discovery baseline', () => {
  it('preserves the published v12 image-unit bytes and signing payload', () => {
    const metadata = releasedMetadata();
    expect(metadata.providers[0]!.serviceUnitBillingModels).toEqual({
      image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.25 }] } },
    });
    expect(Buffer.from(encodeMetadata(metadata)).toString('hex')).toBe(publishedSdkImageMetadataHex);
    expect(Buffer.from(encodeMetadataForSigning(metadata)).toString('hex')).toBe(publishedSdkImageMetadataHex.slice(0, -130));
  });

  it.each([7, 8, 9, 10])('rejects signing or advertising unit fees as metadata v%s', (version) => {
    const metadata = releasedMetadata();
    metadata.version = version;
    expect(() => encodeMetadata(metadata)).toThrow('Service unit billing requires metadata v11 or newer');
    expect(() => encodeMetadataForSigning(metadata)).toThrow('Service unit billing requires metadata v11 or newer');
  });

  it.each([7, 8, 9, 10])('continues to read and write token-only metadata v%s', (version) => {
    const metadata = releasedMetadata();
    metadata.version = version;
    delete metadata.providers[0]!.serviceUnitBillingModels;
    expect(decodeMetadata(encodeMetadata(metadata)).version).toBe(version);
  });
});
