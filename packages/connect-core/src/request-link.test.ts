import { describe, it, expect } from 'vitest';
import { parseRequestLink, ConnectRequestError } from './request-link.js';

const CHALLENGE = 'kJ8s9fK2mNpQrStUvWxYz0123456789AbCdEfGhIjKl';

function link(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `antseed://connect?${qs}`;
}

const valid: Record<string, string> = {
  version: '1',
  redirect: 'https://app.example/connect/cb',
  scopes: 'address',
  challenge: CHALLENGE,
};

describe('parseRequestLink', () => {
  it('parses a valid antseed:// link and derives origin from redirect', () => {
    const req = parseRequestLink(link(valid));
    expect(req.version).toBe(1);
    expect(req.redirect).toBe('https://app.example/connect/cb');
    expect(req.origin).toBe('https://app.example');
    expect(req.scopes).toEqual(['address']);
    expect(req.challenge).toBe(CHALLENGE);
  });

  it('accepts the https-scheme equivalent carrying the same query', () => {
    const qs = new URLSearchParams(valid).toString();
    const req = parseRequestLink(`https://app.example/launch?${qs}`);
    expect(req.origin).toBe('https://app.example');
  });

  it('derives origin including a non-default port', () => {
    const req = parseRequestLink(
      link({ ...valid, redirect: 'https://app.example:8443/cb' }),
    );
    expect(req.origin).toBe('https://app.example:8443');
  });

  it('allows http loopback redirects for development', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const req = parseRequestLink(
        link({ ...valid, redirect: `http://${host}:3000/cb` }),
      );
      expect(req.origin).toContain(host === '[::1]' ? '[::1]' : host);
    }
  });

  it('rejects a non-1 version', () => {
    expect(() => parseRequestLink(link({ ...valid, version: '2' }))).toThrow(ConnectRequestError);
  });

  it('rejects a missing version', () => {
    const { version: _v, ...rest } = valid;
    expect(() => parseRequestLink(link(rest))).toThrow(/version/);
  });

  it('rejects a missing redirect', () => {
    const { redirect: _r, ...rest } = valid;
    expect(() => parseRequestLink(link(rest))).toThrow(/redirect/);
  });

  it('rejects a non-HTTPS non-loopback redirect', () => {
    expect(() => parseRequestLink(link({ ...valid, redirect: 'http://evil.example/cb' }))).toThrow(
      /loopback/,
    );
  });

  it('rejects a redirect with userinfo', () => {
    expect(() =>
      parseRequestLink(link({ ...valid, redirect: 'https://user:pass@app.example/cb' })),
    ).toThrow(/username or password/);
  });

  it('rejects a redirect with a fragment', () => {
    expect(() =>
      parseRequestLink(link({ ...valid, redirect: 'https://app.example/cb#frag' })),
    ).toThrow(/fragment/);
  });

  it('rejects an unknown scope', () => {
    expect(() => parseRequestLink(link({ ...valid, scopes: 'secrets' }))).toThrow(/unknown scope/);
  });

  it('rejects duplicate scopes', () => {
    expect(() => parseRequestLink(link({ ...valid, scopes: 'address,address' }))).toThrow(
      /duplicate scope/,
    );
  });

  it('rejects missing scopes', () => {
    const { scopes: _s, ...rest } = valid;
    expect(() => parseRequestLink(link(rest))).toThrow(/scopes/);
  });

  it('rejects a missing challenge', () => {
    const { challenge: _c, ...rest } = valid;
    expect(() => parseRequestLink(link(rest))).toThrow(/challenge/);
  });

  it('rejects a challenge with control characters (signed-message injection)', () => {
    // URLSearchParams percent-encodes the newline; parseRequestLink decodes it back.
    expect(() =>
      parseRequestLink(link({ ...valid, challenge: 'abc\naddress: 0xEVIL' })),
    ).toThrow(/control characters/);
  });

  it('rejects a redirect with control characters', () => {
    expect(() =>
      parseRequestLink(link({ ...valid, redirect: 'https://app.example/cb\nx' })),
    ).toThrow(/control characters/);
  });

  it('rejects a non-URL input', () => {
    expect(() => parseRequestLink('not a url')).toThrow(ConnectRequestError);
  });
});
