import { describe, expect, it } from 'vitest';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import {
  CONNECTION_CAPABILITY_PROBE_DELEGATION_V1,
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
} from '../src/types/protocol.js';

function hostMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    providers: [],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, CONNECTION_CAPABILITY_PROBE_DELEGATION_V1],
    region: 'unknown',
    timestamp: Date.now(),
    signature: 'f'.repeat(130),
    ...overrides,
  };
}

describe('delegation host metadata', () => {
  it('accepts an empty provider catalog when the probe-delegation capability is announced', () => {
    const errors = validateMetadata(hostMetadata());
    expect(errors.filter((e) => e.field === 'providers')).toEqual([]);
  });

  it('still rejects an empty provider catalog without the capability', () => {
    const errors = validateMetadata(hostMetadata({ capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] }));
    expect(errors.some((e) => e.field === 'providers')).toBe(true);
  });
});
