import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { createRoutingServiceMetadata } from '@antseed/protocol';
import { signData, verifySignature } from '@antseed/protocol/signing';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

function metadata(): PeerMetadata {
  return { version: 14, peerId: 'a'.repeat(40) as PeerMetadata['peerId'], region: 'test', timestamp: Date.now(), signature: '0'.repeat(130), providers: [{
    provider: 'fixture', services: ['selector'], maxConcurrency: 1, currentLoad: 0,
    defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    serviceApiProtocols: { selector: ['antseed-routing'] }, serviceCapabilities: { selector: { routing: true } },
    serviceRouting: { selector: createRoutingServiceMetadata({ type: 'object', additionalProperties: false, properties: { threshold: { type: 'number', default: 0.5 } } }) },
  }] };
}

describe('signed routing metadata', () => {
  it('round trips descriptors through the binary and HTTP shapes', () => {
    const source = metadata();
    expect(validateMetadata(source)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(source));
    expect(decoded.providers[0]!.serviceRouting).toEqual(source.providers[0]!.serviceRouting);
    expect(encodeMetadataForSigning(JSON.parse(JSON.stringify(source)))).toEqual(encodeMetadataForSigning(source));
  });
  it('binds the complete schema to the seller signature', async () => {
    const source = metadata();
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const signature = signData(wallet, encodeMetadataForSigning(source));
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(source))).toBe(true);
    source.providers[0]!.serviceRouting!.selector = createRoutingServiceMetadata({ type: 'object', additionalProperties: false, properties: {} });
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(source))).toBe(false);
  });
  it('requires v14 and an advertised routing protocol and capability', () => {
    const source = metadata();
    source.version = 13;
    expect(() => encodeMetadata(source)).toThrow('v14');
    expect(validateMetadata(source).length).toBeGreaterThan(0);
    source.version = 14;
    source.providers[0]!.serviceApiProtocols = {};
    expect(validateMetadata(source).length).toBeGreaterThan(0);
  });
  it.each([10, 11, 12, 13])('still decodes metadata v%s without descriptors', (version) => {
    const source = metadata(); source.version = version;
    delete source.providers[0]!.serviceRouting;
    delete source.providers[0]!.serviceCapabilities;
    expect(decodeMetadata(encodeMetadata(source)).version).toBe(version);
  });
});
