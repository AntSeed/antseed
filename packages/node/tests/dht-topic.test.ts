import { describe, it, expect } from 'vitest';
import { providerTopic, modelTopic, capabilityTopic } from '../src/discovery/dht-node.js';

describe('DHT topic helpers', () => {
  it('normalizes provider topics to lowercase', () => {
    expect(providerTopic('  OpenAI  ')).toBe('antseed:openai');
  });

  it('normalizes model topics to lowercase', () => {
    expect(modelTopic('  KIMI2.5  ')).toBe('antseed:model:kimi2.5');
  });

  it('normalizes capability topics to lowercase', () => {
    expect(capabilityTopic('  TASK  ', '  My-Worker  ')).toBe('antseed:task:my-worker');
  });
});
