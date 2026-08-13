import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { isCompatibleSharedBuyer } from './shared-buyer.js';

test('isCompatibleSharedBuyer accepts the AntSeed status endpoint', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal(await isCompatibleSharedBuyer(address.port), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('isCompatibleSharedBuyer rejects unrelated listeners', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    assert.equal(await isCompatibleSharedBuyer(address.port), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
