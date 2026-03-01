import { describe, it, expect } from 'vitest';
import {
  providerTopic,
  modelTopic,
  modelSearchTopic,
  capabilityTopic,
  normalizeModelTopicKey,
  normalizeModelSearchTopicKey,
} from '../src/discovery/dht-node.js';

describe('DHT topic helpers', () => {
  it('normalizes provider topics to lowercase', () => {
    expect(providerTopic('  OpenAI  ')).toBe('antseed:openai');
  });

  it('normalizes model topics to lowercase', () => {
    expect(modelTopic('  KIMI2.5  ')).toBe('antseed:model:kimi2.5');
  });

  it('normalizes compact model-search keys by removing spaces, hyphens, and underscores', () => {
    expect(normalizeModelTopicKey('  KIMI-2.5  ')).toBe('kimi-2.5');
    expect(normalizeModelSearchTopicKey('  KIMI-2.5  ')).toBe('kimi2.5');
    expect(normalizeModelSearchTopicKey('  kimi_2.5  ')).toBe('kimi2.5');
    expect(normalizeModelSearchTopicKey('  kimi 2.5  ')).toBe('kimi2.5');
    expect(modelSearchTopic('  kimi_2.5  ')).toBe('antseed:model-search:kimi2.5');
  });

  it('normalizes capability topics to lowercase', () => {
    expect(capabilityTopic('  TASK  ', '  My-Worker  ')).toBe('antseed:task:my-worker');
  });
});
