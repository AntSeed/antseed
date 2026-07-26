import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CUSTOM_APP_DEFAULT_PATH_PREFIXES,
  customAppModelsProbeUrl,
  customAppName,
  customAppsFilePath,
  customAppToCliProfile,
  deriveCustomAppTarget,
  fetchCustomAppSiteMetadata,
  loadCustomApps,
  probeCustomAppModelsEndpoint,
  saveCustomApps,
  type CustomAppRecord,
} from './custom-apps.js';

test('deriveCustomAppTarget uses standard API paths when the URL has no path', () => {
  assert.deepEqual(deriveCustomAppTarget('https://api.example.com'), {
    host: 'api.example.com',
    pathPrefixes: [...CUSTOM_APP_DEFAULT_PATH_PREFIXES],
  });
  assert.deepEqual(deriveCustomAppTarget('api.example.com/'), {
    host: 'api.example.com',
    pathPrefixes: [...CUSTOM_APP_DEFAULT_PATH_PREFIXES],
  });
});

test('deriveCustomAppTarget uses the entered path as the intercept prefix', () => {
  assert.deepEqual(deriveCustomAppTarget('https://Api.Example.com/v1/'), {
    host: 'api.example.com',
    pathPrefixes: ['/v1'],
  });
  assert.deepEqual(deriveCustomAppTarget('https://api.example.com/api/chat'), {
    host: 'api.example.com',
    pathPrefixes: ['/api/chat'],
  });
});

test('deriveCustomAppTarget rejects unusable URLs', () => {
  assert.throws(() => deriveCustomAppTarget('   '), /Enter the API URL/);
  assert.throws(() => deriveCustomAppTarget('http://api.example.com'), /https/);
  assert.throws(() => deriveCustomAppTarget('ftp://api.example.com'), /https/);
  assert.throws(() => deriveCustomAppTarget('https://'), /valid URL|hostname/);
});

test('customAppModelsProbeUrl derives the models URL from the entered base', () => {
  // Bare domain assumes the standard /v1 base.
  assert.equal(customAppModelsProbeUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/models');
  assert.equal(customAppModelsProbeUrl('api.openai.com'), 'https://api.openai.com/v1/models');
  // The entered path is the API base — OpenRouter lives under /api/v1.
  assert.equal(customAppModelsProbeUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  assert.equal(customAppModelsProbeUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/models');
  assert.equal(customAppModelsProbeUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/models');
});

test('customAppModelsProbeUrl strips a pasted endpoint path down to the base', () => {
  assert.equal(customAppModelsProbeUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1/models');
  assert.equal(customAppModelsProbeUrl('https://openrouter.ai/api/v1/chat/completions'), 'https://openrouter.ai/api/v1/models');
  assert.equal(customAppModelsProbeUrl('https://api.together.xyz/v1/completions'), 'https://api.together.xyz/v1/models');
  assert.equal(customAppModelsProbeUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1/models');
  assert.equal(customAppModelsProbeUrl('https://openrouter.ai/api/v1/models'), 'https://openrouter.ai/api/v1/models');
});

test('probeCustomAppModelsEndpoint accepts an open OpenAI-style model list', async () => {
  // OpenRouter shape: GET /api/v1/models answers 200 with a data array, no key needed.
  const fetchImpl: typeof fetch = async (input) => {
    assert.equal(String(input), 'https://openrouter.ai/api/v1/models');
    return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  assert.deepEqual(await probeCustomAppModelsEndpoint('https://openrouter.ai/api/v1', { fetch: fetchImpl }), {
    ok: true,
    url: 'https://openrouter.ai/api/v1/models',
    authRequired: false,
  });
});

test('probeCustomAppModelsEndpoint accepts an auth-gated AI API rejecting the key-less probe', async () => {
  // Anthropic shape: 401 {"type":"error","error":{"type":"authentication_error",...}}.
  const anthropic: typeof fetch = async () =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  assert.deepEqual(await probeCustomAppModelsEndpoint('https://api.anthropic.com', { fetch: anthropic }), {
    ok: true,
    url: 'https://api.anthropic.com/v1/models',
    authRequired: true,
  });

  // OpenAI shape: 401 {"error":{"message":"Missing bearer authentication in header",...}}.
  const openai: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'Missing bearer authentication in header', type: 'invalid_request_error' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  assert.deepEqual(await probeCustomAppModelsEndpoint('https://api.openai.com/v1', { fetch: openai }), {
    ok: true,
    url: 'https://api.openai.com/v1/models',
    authRequired: true,
  });
});

test('probeCustomAppModelsEndpoint rejects non-AI responses', async () => {
  // A plain website: 200 HTML is not a model list.
  const html: typeof fetch = async () =>
    new Response('<html><body>hello</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const htmlResult = await probeCustomAppModelsEndpoint('https://example.com', { fetch: html });
  assert.equal(htmlResult.ok, false);
  assert.match((htmlResult as { detail: string }).detail, /HTTP 200/);

  // A 404 means no models endpoint at that base.
  const missing: typeof fetch = async () => new Response('not found', { status: 404 });
  const missingResult = await probeCustomAppModelsEndpoint('https://example.com/v2/generate', { fetch: missing });
  assert.equal(missingResult.ok, false);
  assert.match((missingResult as { detail: string }).detail, /HTTP 404/);

  // A 401 without a JSON error body (bot challenge, LB page) stays unverified.
  const challenge: typeof fetch = async () =>
    new Response('<html>Access denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const challengeResult = await probeCustomAppModelsEndpoint('https://gateway.example.com/v1', { fetch: challenge });
  assert.equal(challengeResult.ok, false);
});

test('probeCustomAppModelsEndpoint reports unreachable hosts without throwing', async () => {
  const offline: typeof fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND nope.example');
  };
  const result = await probeCustomAppModelsEndpoint('https://nope.example', { fetch: offline });
  assert.equal(result.ok, false);
  assert.match((result as { detail: string }).detail, /could not be reached/);
  assert.match((result as { detail: string }).detail, /ENOTFOUND/);
});

test('customAppName slugs the host and avoids collisions', () => {
  assert.equal(customAppName('api.example.com', []), 'custom-api-example-com');
  assert.equal(
    customAppName('api.example.com', ['custom-api-example-com']),
    'custom-api-example-com-2',
  );
  assert.equal(
    customAppName('api.example.com', ['custom-api-example-com', 'custom-api-example-com-2']),
    'custom-api-example-com-3',
  );
});

test('customAppToCliProfile emits a plain proxy profile', () => {
  const record: CustomAppRecord = {
    name: 'custom-api-example-com',
    displayName: 'Example',
    apiUrl: 'https://api.example.com/v1',
    host: 'api.example.com',
    pathPrefixes: ['/v1'],
    iconDataUri: 'data:image/png;base64,aGk=',
    createdAt: 1000,
  };
  assert.deepEqual(customAppToCliProfile(record), {
    name: 'custom-api-example-com',
    displayName: 'Example',
    kind: 'proxy',
    method: 'HTTPS proxy',
    domains: ['api.example.com'],
    pathPrefixes: ['/v1'],
  });
});

test('saveCustomApps/loadCustomApps round-trips and skips malformed entries', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'antseed-custom-apps-'));
  assert.deepEqual(loadCustomApps(dataDir), []);

  const record: CustomAppRecord = {
    name: 'custom-api-example-com',
    displayName: 'Example',
    apiUrl: 'https://api.example.com',
    host: 'api.example.com',
    pathPrefixes: [...CUSTOM_APP_DEFAULT_PATH_PREFIXES],
    iconDataUri: 'data:image/png;base64,aGk=',
    createdAt: 1000,
  };
  saveCustomApps(dataDir, [record]);
  assert.deepEqual(loadCustomApps(dataDir), [record]);

  writeFileSync(
    customAppsFilePath(dataDir),
    JSON.stringify([record, { name: 'broken' }, 42, { ...record, pathPrefixes: [] }]),
    'utf8',
  );
  assert.deepEqual(loadCustomApps(dataDir), [record]);

  writeFileSync(customAppsFilePath(dataDir), 'not json', 'utf8');
  assert.deepEqual(loadCustomApps(dataDir), []);
});

test('fetchCustomAppSiteMetadata returns title and favicon data URI', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://meta.example/') {
      return new Response('<title>Meta App</title><link rel="icon" href="/icon.png">', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url === 'https://meta.example/icon.png') {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('nope', { status: 404 });
  };

  const metadata = await fetchCustomAppSiteMetadata('meta.example', { fetch: fetchImpl });
  assert.equal(metadata.title, 'Meta App');
  assert.equal(metadata.iconDataUri, `data:image/png;base64,${png.toString('base64')}`);
});

test('fetchCustomAppSiteMetadata tolerates fetch failures and non-image favicons', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url === 'https://nohtml.example/') {
      return new Response('<title>No Icon</title><link rel="icon" href="/icon">', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url === 'https://nohtml.example/icon') {
      return new Response('<html>login page</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error('network down');
  };

  const metadata = await fetchCustomAppSiteMetadata('nohtml.example', { fetch: fetchImpl });
  assert.equal(metadata.title, 'No Icon');
  assert.equal(metadata.iconDataUri, undefined);

  const offline = await fetchCustomAppSiteMetadata('down.example', { fetch: fetchImpl });
  assert.deepEqual(offline, {});
});
