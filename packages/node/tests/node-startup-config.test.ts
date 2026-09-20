import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoutingServiceMetadata } from '@antseed/protocol';
import { AntseedNode } from '../src/node.js';
import type { Provider } from '../src/interfaces/seller-provider.js';

function routingProvider(): Provider {
  return {
    name: 'router',
    services: ['selector'],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 10,
    serviceApiProtocols: { selector: ['antseed-routing'] },
    serviceCapabilities: { selector: { routing: true } },
    serviceRouting: {
      selector: createRoutingServiceMetadata({ type: 'object', additionalProperties: false, properties: {} }),
    },
    handleRequest: vi.fn(),
    getCapacity: () => ({ current: 0, max: 10 }),
  };
}

function seller(provider: Provider) {
  const identityStore = { load: vi.fn().mockResolvedValue('1'.repeat(64)), save: vi.fn() };
  const node = new AntseedNode({ role: 'seller', identityStore });
  const startSeller = vi.spyOn(node as unknown as { _startSeller(): Promise<void> }, '_startSeller').mockResolvedValue(undefined);
  const started = vi.fn();
  node.on('started', started);
  node.registerProvider(provider);
  return { node, identityStore, startSeller, started };
}

describe('seller configuration preflight', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { name: 'stale schema hash', field: 'serviceRouting.selector', change: (provider: Provider) => { provider.serviceRouting!.selector!.preferencesSchemaHash = 'stale'; } },
    { name: 'invalid preference schema', field: 'serviceRouting.selector', change: (provider: Provider) => { provider.serviceRouting!.selector!.preferencesSchema.properties = { policy: { type: 'string', enum: [] } }; } },
    { name: 'missing descriptor', field: 'serviceRouting.selector', change: (provider: Provider) => { delete provider.serviceRouting; } },
    { name: 'missing protocol', field: 'serviceRouting.selector', change: (provider: Provider) => { delete provider.serviceApiProtocols; } },
    { name: 'missing routing capability', field: 'serviceRouting.selector', change: (provider: Provider) => { delete provider.serviceCapabilities; } },
    { name: 'descriptor for unadvertised service', field: 'serviceRouting.selector', change: (provider: Provider) => { provider.services = ['other']; } },
    { name: 'negative pricing', field: 'defaultPricing.inputUsdPerMillion', change: (provider: Provider) => { provider.pricing.defaults.inputUsdPerMillion = -1; } },
    { name: 'invalid cached pricing', field: 'defaultPricing.cachedInputUsdPerMillion', change: (provider: Provider) => { provider.pricing.defaults.cachedInputUsdPerMillion = NaN; } },
    { name: 'invalid service cached pricing', field: 'servicePricing.selector.cachedInputUsdPerMillion', change: (provider: Provider) => { provider.pricing.services = { selector: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: -1 } }; } },
    { name: 'invalid concurrency', field: 'maxConcurrency', change: (provider: Provider) => { provider.maxConcurrency = NaN; } },
    { name: 'empty provider name', field: 'provider', change: (provider: Provider) => { provider.name = ''; } },
    { name: 'duplicate efforts', field: 'serviceCapabilities.selector', change: (provider: Provider) => { provider.serviceCapabilities!.selector!.reasoningEfforts = ['adaptive', 'adaptive']; } },
    { name: 'non-object capabilities', field: 'serviceCapabilities', change: (provider: Provider) => { provider.serviceCapabilities = null as never; } },
    { name: 'non-array services', field: 'services', change: (provider: Provider) => { provider.services = 'selector' as never; } },
    { name: 'sparse services', field: 'services', change: (provider: Provider) => { provider.services = Array(1); } },
    { name: 'missing handler', field: 'handleRequest', change: (provider: Provider) => { provider.handleRequest = undefined as never; } },
  ])('rejects $name before identity loading or networking with a field-specific reason', async ({ change, field }) => {
    const provider = routingProvider();
    const { node, identityStore, startSeller, started } = seller(provider);
    change(provider);

    await expect(node.start()).rejects.toThrow(`providers[0].${field}`);
    expect(identityStore.load).not.toHaveBeenCalled();
    expect(startSeller).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it('allows correcting invalid configuration and retrying startup', async () => {
    const provider = routingProvider();
    const { node, startSeller, started } = seller(provider);
    provider.maxConcurrency = 0;
    await expect(node.start()).rejects.toThrow('maxConcurrency');
    provider.maxConcurrency = 10;
    await node.start();
    expect(startSeller).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledOnce();
  });

  it.each([false, true])('starts a valid seller with custom reasoning labels (wildcard: %s)', async (wildcard) => {
    const provider = routingProvider();
    if (wildcard) provider.services = [];
    provider.serviceCapabilities!.selector!.reasoningEfforts = ['adaptive', 'deep-analysis'];
    const { node, startSeller, started } = seller(provider);
    await node.start();
    expect(startSeller).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledOnce();
  });

  it('rejects oversized combined routing metadata before networking', async () => {
    const provider = routingProvider();
    const descriptor = createRoutingServiceMetadata({
      type: 'object', additionalProperties: false,
      properties: { policy: { type: 'string', enum: ['balanced'], description: 'x'.repeat(15000) } },
    });
    provider.services = Array.from({ length: 10 }, (_, index) => `selector-${index}`);
    provider.serviceRouting = Object.fromEntries(provider.services.map((service) => [service, descriptor]));
    provider.serviceApiProtocols = Object.fromEntries(provider.services.map((service) => [service, ['antseed-routing']]));
    provider.serviceCapabilities = Object.fromEntries(provider.services.map((service) => [service, { routing: true }]));
    const { node, startSeller, started } = seller(provider);

    await expect(node.start()).rejects.toThrow('Invalid seller configuration: Routing descriptors exceed metadata limit');
    expect(startSeller).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });
});
