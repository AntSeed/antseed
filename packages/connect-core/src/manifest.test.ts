import { describe, it, expect } from 'vitest';
import { parseManifest, ConnectManifestError } from './manifest.js';

const ORIGIN = 'https://app.example';

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: 'antseed.connect.manifest',
    name: 'Example App',
    homepage: 'https://app.example',
    icon: 'https://app.example/icon.png',
    ...overrides,
  });
}

describe('parseManifest', () => {
  it('parses a valid same-origin manifest', () => {
    const m = parseManifest(manifest(), ORIGIN);
    expect(m.name).toBe('Example App');
    expect(m.homepage).toBe('https://app.example');
    expect(m.icon).toBe('https://app.example/icon.png');
  });

  it('treats icon as optional', () => {
    const m = parseManifest(manifest({ icon: undefined }), ORIGIN);
    expect(m.icon).toBeUndefined();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseManifest('{not json', ORIGIN)).toThrow(ConnectManifestError);
  });

  it('rejects a bad version', () => {
    expect(() => parseManifest(manifest({ version: 2 }), ORIGIN)).toThrow(/version/);
  });

  it('rejects a bad kind', () => {
    expect(() => parseManifest(manifest({ kind: 'other' }), ORIGIN)).toThrow(/kind/);
  });

  it('rejects a missing name', () => {
    expect(() => parseManifest(manifest({ name: '' }), ORIGIN)).toThrow(/name/);
  });

  it('rejects a cross-origin homepage', () => {
    expect(() => parseManifest(manifest({ homepage: 'https://evil.example' }), ORIGIN)).toThrow(
      /same-origin/,
    );
  });

  it('rejects a cross-origin icon', () => {
    expect(() =>
      parseManifest(manifest({ icon: 'https://cdn.other.example/icon.png' }), ORIGIN),
    ).toThrow(/same-origin/);
  });

  it('rejects a non-HTTPS homepage', () => {
    expect(() =>
      parseManifest(manifest({ homepage: 'http://app.example' }), 'http://app.example'),
    ).toThrow(/HTTPS/);
  });
});
