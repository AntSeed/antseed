import { describe, expect, it } from 'vitest';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import {
  CONNECTION_CAPABILITY_AUDIT_RELAY_V1,
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
} from '../src/types/protocol.js';

function relayMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    providers: [],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, CONNECTION_CAPABILITY_AUDIT_RELAY_V1],
    region: 'unknown',
    timestamp: Date.now(),
    signature: 'f'.repeat(130),
    ...overrides,
  };
}

describe('audit relay host metadata', () => {
  it('accepts an empty provider catalog when audit relay capability is announced', () => {
    const errors = validateMetadata(relayMetadata());
    expect(errors.filter((error) => error.field === 'providers')).toEqual([]);
  });

  it('still rejects an empty provider catalog without audit relay capability', () => {
    const errors = validateMetadata(relayMetadata({ capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1] }));
    expect(errors.some((error) => error.field === 'providers')).toBe(true);
  });
});
