import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CUSTOM_APP_DEFAULT_PATH_PREFIXES,
  customAppName,
  customAppsFilePath,
  customAppToCliProfile,
  deriveCustomAppTarget,
  fetchCustomAppSiteMetadata,
  loadCustomApps,
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
