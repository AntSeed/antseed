import { describe, it, expect } from 'vitest';
import {
  ANTSEED_WILDCARD_TOPIC,
  serviceTopic,
  serviceSearchTopic,
  capabilityTopic,
  peerTopic,
  normalizeServiceTopicKey,
  normalizeServiceSearchTopicKey,
} from '../src/discovery/dht-node.js';

describe('DHT topic helpers', () => {
  it('wildcard topic is antseed:*', () => {
    expect(ANTSEED_WILDCARD_TOPIC).toBe('antseed:*');
  });

  it('normalizes service topics to lowercase', () => {
    expect(serviceTopic('  KIMI2.5  ')).toBe('antseed:service:kimi2.5');
  });

  it('normalizes compact service-search keys by removing spaces, hyphens, and underscores', () => {
    expect(normalizeServiceTopicKey('  KIMI-2.5  ')).toBe('kimi-2.5');
    expect(normalizeServiceSearchTopicKey('  KIMI-2.5  ')).toBe('kimi2.5');
    expect(normalizeServiceSearchTopicKey('  kimi_2.5  ')).toBe('kimi2.5');
    expect(normalizeServiceSearchTopicKey('  kimi 2.5  ')).toBe('kimi2.5');
    expect(serviceSearchTopic('  kimi_2.5  ')).toBe('antseed:service-search:kimi2.5');
  });

  it('normalizes capability topics to lowercase', () => {
    expect(capabilityTopic('  TASK  ', '  My-Worker  ')).toBe('antseed:task:my-worker');
  });

  it('builds per-peer topics with the peerId normalized to lowercase hex (no 0x)', () => {
    expect(peerTopic('0E49122E76BD8B9CCB2FE10C0088C41CEB608927')).toBe(
      'antseed:peer:0e49122e76bd8b9ccb2fe10c0088c41ceb608927',
    );
    expect(peerTopic('  0x0E49122E76BD8B9CCB2FE10C0088C41CEB608927  ')).toBe(
      'antseed:peer:0e49122e76bd8b9ccb2fe10c0088c41ceb608927',
    );
  });
});
