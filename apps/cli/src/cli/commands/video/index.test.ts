import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadArtifact } from './index.js';

function fixture(bytes: Uint8Array) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const artifact = {
    id: 'va_test', type: 'video' as const, mime_type: 'video/mp4', bytes: bytes.length, sha256,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    links: { content: '/v1/video/generations/vg_test/artifacts/va_test/content' },
  };
  const generation = {
    id: 'vg_test', object: 'video.generation' as const, created_at: 1, updated_at: 1,
    model: 'gen4.5', status: 'succeeded' as const, progress: 100, artifacts: [artifact], error: null,
    payment: { currency: 'USDC' as const, total_amount: '0', upfront_bps: 0, milestones: [] },
    links: { self: '/v1/video/generations/vg_test', cancel: '/v1/video/generations/vg_test/cancel' },
  };
  return { artifact, generation };
}

test('video download resumes a partial file and verifies before atomic rename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-video-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = new TextEncoder().encode('complete-video-bytes');
    const { artifact, generation } = fixture(bytes);
    const output = join(dir, 'video.mp4');
    await writeFile(`${output}.part`, bytes.slice(0, 8));
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'content-length': String(bytes.length), 'accept-ranges': 'bytes', 'x-antseed-artifact-sha256': artifact.sha256,
      } });
      if (String(input).endsWith('/receipt')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(bytes.slice(8), { status: 206, headers: { 'content-range': `bytes 8-${bytes.length - 1}/${bytes.length}` } });
    };
    await downloadArtifact({ baseUrl: 'http://127.0.0.1:8080', json: true }, generation, artifact, output);
    assert.deepEqual(await readFile(output), Buffer.from(bytes));
    await assert.rejects(stat(`${output}.part`));
    assert.equal(new Headers(calls[1]?.init?.headers).get('range'), 'bytes=8-');
    assert.ok(calls.some((call) => call.url.endsWith('/receipt')));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('video download safely restarts when a server ignores Range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-video-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = new TextEncoder().encode('replacement-video');
    const { artifact, generation } = fixture(bytes);
    const output = join(dir, 'video.mp4');
    await writeFile(`${output}.part`, new TextEncoder().encode('stale'));
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: {
        'content-length': String(bytes.length), 'accept-ranges': 'bytes', 'x-antseed-artifact-sha256': artifact.sha256,
      } });
      if (String(input).endsWith('/receipt')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(bytes, { status: 200 });
    };
    await downloadArtifact({ baseUrl: 'http://127.0.0.1:8080', json: true }, generation, artifact, output);
    assert.deepEqual(await readFile(output), Buffer.from(bytes));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('video download preserves a partial file when hash verification fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-video-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const expected = new TextEncoder().encode('expected');
    const corrupt = new TextEncoder().encode('corrupt!');
    const { artifact, generation } = fixture(expected);
    const output = join(dir, 'video.mp4');
    globalThis.fetch = async (_input, init) => init?.method === 'HEAD'
      ? new Response(null, { status: 200, headers: { 'content-length': String(expected.length), 'accept-ranges': 'bytes' } })
      : new Response(corrupt, { status: 200 });
    await assert.rejects(
      downloadArtifact({ baseUrl: 'http://127.0.0.1:8080', json: true }, generation, artifact, output),
      /SHA-256 mismatch/,
    );
    assert.deepEqual(await readFile(`${output}.part`), Buffer.from(corrupt));
    await assert.rejects(stat(output));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
