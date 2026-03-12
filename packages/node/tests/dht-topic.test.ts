import { describe, it, expect } from 'vitest';
import {
  providerTopic,
  serviceTopic,
  serviceSearchTopic,
  capabilityTopic,
  normalizeServiceTopicKey,
  normalizeServiceSearchTopicKey,
} from '../src/discovery/dht-node.js';

describe('DHT topic helpers', () => {
  it('normalizes provider topics to lowercase', () => {
    expect(providerTopic('  OpenAI  ')).toBe('antseed:openai');
  });

  it('normalizes model topics to lowercase', () => {
    expect(serviceTopic('  KIMI2.5  ')).toBe('antseed:service:kimi2.5');
  });

  it('normalizes compact model-search keys by removing spaces, hyphens, and underscores', () => {
    expect(normalizeServiceTopicKey('  KIMI-2.5  ')).toBe('kimi-2.5');
    expect(normalizeServiceSearchTopicKey('  KIMI-2.5  ')).toBe('kimi2.5');
    expect(normalizeServiceSearchTopicKey('  kimi_2.5  ')).toBe('kimi2.5');
    expect(normalizeServiceSearchTopicKey('  kimi 2.5  ')).toBe('kimi2.5');
    expect(serviceSearchTopic('  kimi_2.5  ')).toBe('antseed:service-search:kimi2.5');
  });

  it('normalizes capability topics to lowercase', () => {
    expect(capabilityTopic('  TASK  ', '  My-Worker  ')).toBe('antseed:task:my-worker');
  });
});
