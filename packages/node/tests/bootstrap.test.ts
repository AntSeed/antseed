import { describe, it, expect } from 'vitest';
import {
  OFFICIAL_BOOTSTRAP_NODES,
  parseBootstrapList,
  mergeBootstrapNodes,
  toBootstrapConfig,
  type BootstrapNode,
} from '../src/discovery/bootstrap.js';

describe('OFFICIAL_BOOTSTRAP_NODES', () => {
  it('should contain at least one node', () => {
    expect(OFFICIAL_BOOTSTRAP_NODES.length).toBeGreaterThan(0);
  });

  it('should have valid host and port for every node', () => {
    for (const node of OFFICIAL_BOOTSTRAP_NODES) {
      expect(node.host).toBeTruthy();
      expect(node.port).toBeGreaterThanOrEqual(1);
      expect(node.port).toBeLessThanOrEqual(65535);
    }
  });
});

describe('parseBootstrapList', () => {
  it('should parse valid host:port entries', () => {
    const result = parseBootstrapList(['example.com:6881', '10.0.0.1:8080']);
    expect(result).toEqual([
      { host: 'example.com', port: 6881 },
      { host: '10.0.0.1', port: 8080 },
    ]);
  });

  it('should parse IPv6 addresses with port', () => {
    const result = parseBootstrapList(['::1:6881']);
    expect(result).toHaveLength(1);
    expect(result[0]!.host).toBe('::1');
    expect(result[0]!.port).toBe(6881);
  });

  it('should throw on missing port', () => {
    expect(() => parseBootstrapList(['example.com'])).toThrow('missing port');
  });

  it('should throw on invalid port (0)', () => {
    expect(() => parseBootstrapList(['example.com:0'])).toThrow('Invalid port');
  });

  it('should throw on port > 65535', () => {
    expect(() => parseBootstrapList(['example.com:99999'])).toThrow('Invalid port');
  });

  it('should throw on non-numeric port', () => {
    expect(() => parseBootstrapList(['example.com:abc'])).toThrow('Invalid port');
  });

  it('should handle an empty array', () => {
    expect(parseBootstrapList([])).toEqual([]);
  });
});

describe('mergeBootstrapNodes', () => {
  it('should combine two disjoint lists', () => {
    const official: BootstrapNode[] = [{ host: 'a.com', port: 1 }];
    const user: BootstrapNode[] = [{ host: 'b.com', port: 2 }];
    const result = mergeBootstrapNodes(official, user);
    expect(result).toHaveLength(2);
  });

  it('should deduplicate by host:port', () => {
    const official: BootstrapNode[] = [{ host: 'a.com', port: 1, label: 'Official' }];
    const user: BootstrapNode[] = [{ host: 'a.com', port: 1, label: 'User' }];
    const result = mergeBootstrapNodes(official, user);
    expect(result).toHaveLength(1);
    // Official entry comes first and should win
    expect(result[0]!.label).toBe('Official');
  });

  it('should keep user nodes that have different ports', () => {
    const official: BootstrapNode[] = [{ host: 'a.com', port: 1 }];
    const user: BootstrapNode[] = [{ host: 'a.com', port: 2 }];
    const result = mergeBootstrapNodes(official, user);
    expect(result).toHaveLength(2);
  });

  it('should return empty when both inputs are empty', () => {
    expect(mergeBootstrapNodes([], [])).toEqual([]);
  });
});

describe('toBootstrapConfig', () => {
  it('should strip labels and return only host/port', () => {
    const nodes: BootstrapNode[] = [
      { host: 'a.com', port: 1, label: 'A' },
      { host: 'b.com', port: 2 },
    ];
    const result = toBootstrapConfig(nodes);
    expect(result).toEqual([
      { host: 'a.com', port: 1 },
      { host: 'b.com', port: 2 },
    ]);
    // Ensure label is not present
    expect(result[0]).not.toHaveProperty('label');
  });

  it('should return empty array for empty input', () => {
    expect(toBootstrapConfig([])).toEqual([]);
  });
});
