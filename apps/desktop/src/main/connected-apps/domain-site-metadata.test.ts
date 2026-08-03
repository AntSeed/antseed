import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichDomainVerificationLinks } from './domain-site-metadata.js';

test('enrichDomainVerificationLinks adds desktop-only domain page metadata', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(`
      <!doctype html>
      <html>
        <head>
          <title>Example &amp; Co</title>
          <meta name="description" content="A verified example domain.">
          <link rel="icon" href="/assets/icon.png">
        </head>
      </html>
    `, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const links = await enrichDomainVerificationLinks([
    { kind: 'domain', label: 'example.com', href: 'https://example.com' },
    { kind: 'github', label: '@antseed/test', href: 'https://github.com/antseed/test' },
  ], { fetch: fetchImpl, nowMs: 1000 });

  assert.deepEqual(calls, ['https://example.com/']);
  assert.deepEqual(links, [
    {
      kind: 'domain',
      label: 'example.com',
      href: 'https://example.com',
      title: 'Example & Co',
      description: 'A verified example domain.',
      faviconUrl: 'https://example.com/assets/icon.png',
    },
    { kind: 'github', label: '@antseed/test', href: 'https://github.com/antseed/test' },
  ]);
});

test('enrichDomainVerificationLinks caches duplicate domain metadata', async () => {
  let callCount = 0;
  const fetchImpl: typeof fetch = async () => {
    callCount += 1;
    return new Response('<title>Cached Site</title>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };

  const links = await enrichDomainVerificationLinks([
    { kind: 'domain', label: 'cache.example', href: 'https://cache.example' },
    { kind: 'domain', label: 'cache.example', href: 'https://cache.example/about' },
  ], { fetch: fetchImpl, nowMs: 2000 });

  assert.equal(callCount, 1);
  assert.equal(links[0]?.title, 'Cached Site');
  assert.equal(links[1]?.title, 'Cached Site');
});

test('enrichDomainVerificationLinks ignores non-html responses', async () => {
  const fetchImpl: typeof fetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const links = await enrichDomainVerificationLinks([
    { kind: 'domain', label: 'json.example', href: 'https://json.example' },
  ], { fetch: fetchImpl, nowMs: 3000 });

  assert.deepEqual(links, [
    { kind: 'domain', label: 'json.example', href: 'https://json.example' },
  ]);
});
