import test from 'node:test';
import assert from 'node:assert/strict';

import { createManagedWriteTool, MAX_DIRECT_WRITE_CHARS } from './write-tool-policy.js';

test('createManagedWriteTool writes small payloads', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  const tool = createManagedWriteTool('/workspace', {
    operations: {
      async writeFile(path, content) {
        writes.push({ path, content });
      },
      async mkdir(dir) {
        mkdirs.push(dir);
      },
    },
  });

  const result = await tool.execute('tool-1', {
    path: 'index.html',
    content: '<h1>Hello</h1>',
  }, undefined, undefined);

  assert.equal(mkdirs.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, '/workspace/index.html');
  assert.equal(writes[0]?.content, '<h1>Hello</h1>');
  const firstBlock = result.content[0];
  const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
  assert.match(text, /Successfully wrote 14 bytes/);
});

test('createManagedWriteTool rejects oversized payloads before touching the filesystem', async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const mkdirs: string[] = [];
  const tool = createManagedWriteTool('/workspace', {
    operations: {
      async writeFile(path, content) {
        writes.push({ path, content });
      },
      async mkdir(dir) {
        mkdirs.push(dir);
      },
    },
  });

  await assert.rejects(
    () => tool.execute('tool-2', {
      path: 'large.txt',
      content: 'x'.repeat(MAX_DIRECT_WRITE_CHARS + 1),
    }, undefined, undefined),
    /Direct write payload too large/,
  );

  assert.equal(mkdirs.length, 0);
  assert.equal(writes.length, 0);
});
