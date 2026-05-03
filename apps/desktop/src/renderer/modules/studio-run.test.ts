import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStudioProxyRequest,
  buildStudioRunRequest,
  isStudioServiceCandidate,
  parseStudioProxyTransportResult,
  supportsStudioIntent,
} from './studio-run.js';

test('strict category matching gates Studio candidate + intent support', () => {
  const service = {
    categories: ['image', 'multimodal'],
  };
  assert.equal(isStudioServiceCandidate(service), true);
  assert.equal(supportsStudioIntent(service, 'image-generate'), true);
  assert.equal(supportsStudioIntent(service, 'image-edit'), true);
  assert.equal(supportsStudioIntent(service, 'video-generate'), false);
});

test('generic studio category opts services into Studio candidate discovery', () => {
  const service = { categories: ['studio'] };
  assert.equal(isStudioServiceCandidate(service), true);
  assert.equal(supportsStudioIntent(service, 'image-generate'), true);
  assert.equal(supportsStudioIntent(service, 'image-edit'), true);
});

test('buildStudioProxyRequest includes routing headers and studio payload', () => {
  const request = buildStudioRunRequest(
    'flux-dev',
    'image-generate',
    'A cinematic product render',
    [{ base64: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png', name: 'ref.png' }],
  );
  const proxy = buildStudioProxyRequest(
    { provider: 'open-generative-ai', peerId: 'a'.repeat(40) },
    request,
  );
  assert.equal(proxy.path, '/v1/studio/run');
  assert.equal(proxy.method, 'POST');
  assert.equal(proxy.headers['x-antseed-provider'], 'open-generative-ai');
  assert.equal(proxy.headers['x-antseed-pin-peer'], 'a'.repeat(40));

  const parsed = JSON.parse(proxy.bodyText) as { model: string; intent: string; references: unknown[] };
  assert.equal(parsed.model, 'flux-dev');
  assert.equal(parsed.intent, 'image-generate');
  assert.equal(Array.isArray(parsed.references), true);
});

test('parseStudioProxyTransportResult returns actionable endpoint guidance', () => {
  const parsed = parseStudioProxyTransportResult(
    {
      ok: true,
      status: 404,
      body: JSON.stringify({ error: { code: 'studio_endpoint_not_supported', message: 'no endpoint' } }),
      error: null,
    },
    'Flux Provider',
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 404);
  assert.match(parsed.message, /not Studio-capable yet/);
});

test('parseStudioProxyTransportResult returns structured Studio response on success', () => {
  const parsed = parseStudioProxyTransportResult(
    {
      ok: true,
      status: 200,
      body: JSON.stringify({
        id: 'run-1',
        status: 'completed',
        outputs: [{ url: 'https://cdn.example.com/out.png', kind: 'image' }],
      }),
      error: null,
    },
    'Flux Provider',
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.id, 'run-1');
    assert.equal(parsed.data.outputs.length, 1);
    assert.equal(parsed.data.outputs[0]?.url, 'https://cdn.example.com/out.png');
  }
});
