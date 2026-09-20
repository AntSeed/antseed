import { describe, expect, it } from 'vitest';
import { createRoutingServiceMetadata } from '@antseed/protocol';
import { AntseedNode } from '../src/node.js';
import { METADATA_VERSION, type PeerMetadata, type ProviderAnnouncement } from '../src/discovery/peer-metadata.js';
import { buildNetworkServiceOffers } from '../src/discovery/service-catalog.js';
import type { LookupResult } from '../src/discovery/peer-lookup.js';
import type { PeerInfo } from '../src/types/peer.js';

function routingProvider(service: string, provider = 'example-router'): ProviderAnnouncement {
  return {
    provider,
    services: [service],
    defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    maxConcurrency: 10,
    currentLoad: 0,
    serviceApiProtocols: { [service]: ['antseed-routing'] },
    serviceCapabilities: { [service]: { routing: true } },
    serviceRouting: {
      [service]: createRoutingServiceMetadata({
        type: 'object', additionalProperties: false,
        properties: { preference: { type: 'string', default: service } },
      }),
    },
  };
}

function discover(providers: ProviderAnnouncement[]): PeerInfo {
  const node = new AntseedNode({ role: 'buyer' });
  const metadata: PeerMetadata = {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    providers,
    region: 'test',
    timestamp: Date.now(),
    signature: 'b'.repeat(130),
  };
  return (node as unknown as { _lookupResultToPeerInfo(result: LookupResult): PeerInfo })
    ._lookupResultToPeerInfo({ host: '127.0.0.1', port: 6882, metadata });
}

describe('AntseedNode routing discovery', () => {
  it.each([false, true])('preserves every routing descriptor across duplicate provider names (reversed: %s)', (reversed) => {
    const cheap = routingProvider('cheap-router');
    const fast = routingProvider('fast-router');
    const other = routingProvider('cheap-router', 'other-provider');
    const providers = [cheap, fast, other];
    const peer = discover(reversed ? providers.reverse() : providers);

    expect(peer.providerServiceRouting).toEqual({
      'example-router': { services: { ...cheap.serviceRouting, ...fast.serviceRouting } },
      'other-provider': { services: other.serviceRouting },
    });
    const offers = buildNetworkServiceOffers([peer]);
    expect(offers).toHaveLength(3);
    for (const provider of [cheap, fast, other]) {
      const serviceId = provider.services[0]!;
      expect(offers.find((offer) => offer.provider === provider.provider && offer.serviceId === serviceId)?.routing)
        .toEqual(provider.serviceRouting![serviceId]);
    }
  });

  it('does not share mutable descriptors with the announcement', () => {
    const provider = routingProvider('cheap-router');
    const peer = discover([provider]);
    const descriptor = peer.providerServiceRouting!['example-router']!.services['cheap-router']!;

    descriptor.preferencesSchema.properties!.preference!.default = 'changed';

    expect(provider.serviceRouting!['cheap-router']!.preferencesSchema.properties!.preference!.default)
      .toBe('cheap-router');
  });

  it('keeps the routing map empty when announcements have no descriptors', () => {
    const provider = routingProvider('cheap-router');
    delete provider.serviceRouting;

    expect(discover([provider]).providerServiceRouting).toEqual({});
  });
});
