import { describe, it, expect } from 'vitest';
import {
  ANTSEED_WILDCARD_TOPIC,
  SUBNET_COUNT,
  serviceTopic,
  serviceSearchTopic,
  serviceSubnetTopic,
  serviceSearchSubnetTopic,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  subnetOf,
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

  it('builds service subnet topics with normalized service keys', () => {
    expect(serviceSubnetTopic('  KIMI-2.5  ', 7)).toBe('antseed:service:kimi-2.5:subnet:7');
    expect(serviceSearchSubnetTopic('  kimi_2.5  ', 7)).toBe('antseed:service-search:kimi2.5:subnet:7');
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

  it('builds subnet topics as antseed:subnet:<index>', () => {
    expect(subnetTopic(0)).toBe('antseed:subnet:0');
    expect(subnetTopic(15)).toBe('antseed:subnet:15');
  });

  it('subnetOf maps the same peerId to the same subnet regardless of casing or 0x prefix', () => {
    const id = '0E49122E76BD8B9CCB2FE10C0088C41CEB608927';
    const lowered = id.toLowerCase();
    const prefixed = '0x' + id;
    expect(subnetOf(id)).toBe(subnetOf(lowered));
    expect(subnetOf(id)).toBe(subnetOf(prefixed));
    expect(subnetOf(id)).toBe(0x0E % SUBNET_COUNT);
  });

  it('subnetOf distributes a uniform peerId byte space exactly evenly across subnets', () => {
    // 256 first-byte values ÷ SUBNET_COUNT subnets must be an integer for the
    // distribution to be perfectly even — SUBNET_COUNT must divide 256. If a
    // future change to SUBNET_COUNT picks a non-divisor (e.g. 12), this test
    // catches the resulting per-subnet skew before it lands in production.
    expect(256 % SUBNET_COUNT).toBe(0);
    const expectedPerSubnet = 256 / SUBNET_COUNT;

    const counts = new Array<number>(SUBNET_COUNT).fill(0);
    for (let byte = 0; byte < 256; byte++) {
      const peerId = byte.toString(16).padStart(2, '0') + 'a'.repeat(38);
      const idx = subnetOf(peerId);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(SUBNET_COUNT);
      counts[idx] = (counts[idx] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBe(expectedPerSubnet);
    }
  });

  it('subnetOf falls back to subnet 0 for malformed input rather than throwing', () => {
    expect(subnetOf('')).toBe(0);
    expect(subnetOf('   ')).toBe(0);
    expect(subnetOf('zz' + 'a'.repeat(38))).toBe(0);
  });
});
