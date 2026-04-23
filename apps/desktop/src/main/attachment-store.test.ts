import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deleteConversationAttachments,
  isSafeId,
  resolveAttachmentPath,
  saveAttachment,
  sweepOrphanAttachments,
} from './attachment-store.js';

async function withTempRoot(fn: (rootDir: string) => Promise<void>): Promise<void> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'antseed-attach-'));
  try {
    await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('isSafeId accepts normal IDs and rejects traversal / special chars', () => {
  assert.equal(isSafeId('abc123'), true);
  assert.equal(isSafeId('a-b_c'), true);
  assert.equal(isSafeId('0123456789abcdef'), true);
  assert.equal(isSafeId('x'.repeat(128)), true);

  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId('../evil'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.equal(isSafeId('a\\b'), false);
  assert.equal(isSafeId('a.b'), false); // dots are disallowed in IDs
  assert.equal(isSafeId('a b'), false);
  assert.equal(isSafeId('a\u0000'), false);
  assert.equal(isSafeId('x'.repeat(200)), false);
});

test('saveAttachment writes bytes under conversation dir with extension', async () => {
  await withTempRoot(async (rootDir) => {
    const written = await saveAttachment('conv1', 'att1', 'hello.TXT', Buffer.from('hello'), { rootDir });
    // Extension is normalised to lowercase.
    assert.match(written, /conv1[\\/]att1\.txt$/);
    const contents = await readFile(written, 'utf8');
    assert.equal(contents, 'hello');
  });
});

test('saveAttachment drops suspicious extensions', async () => {
  await withTempRoot(async (rootDir) => {
    // `php%00.jpg` would decode to php + nul. Only clean alphanumeric
    // extensions are kept; everything else falls back to no-extension.
    const written = await saveAttachment('conv1', 'att1', 'evil.php%00.jpg', Buffer.from('x'), { rootDir });
    assert.match(written, /conv1[\\/]att1(\.jpg)?$/);
  });
});

test('saveAttachment rejects unsafe conversation and attachment IDs', async () => {
  await withTempRoot(async (rootDir) => {
    await assert.rejects(
      () => saveAttachment('..', 'att1', 'f.txt', Buffer.from(''), { rootDir }),
      /Invalid conversationId/,
    );
    await assert.rejects(
      () => saveAttachment('c1', '../etc/passwd', 'f.txt', Buffer.from(''), { rootDir }),
      /Invalid attachmentId/,
    );
    await assert.rejects(
      () => saveAttachment('c1', 'a/b', 'f.txt', Buffer.from(''), { rootDir }),
      /Invalid attachmentId/,
    );
  });
});

test('resolveAttachmentPath returns the file path for valid IDs', async () => {
  await withTempRoot(async (rootDir) => {
    await saveAttachment('conv1', 'att1', 'hello.txt', Buffer.from('ok'), { rootDir });
    const found = await resolveAttachmentPath('conv1', 'att1', { rootDir });
    assert.ok(found);
    assert.match(found, /att1\.txt$/);
  });
});

test('resolveAttachmentPath returns null for missing or unsafe IDs', async () => {
  await withTempRoot(async (rootDir) => {
    assert.equal(await resolveAttachmentPath('conv1', 'missing', { rootDir }), null);
    assert.equal(await resolveAttachmentPath('..', 'x', { rootDir }), null);
    assert.equal(await resolveAttachmentPath('c', '../etc/passwd', { rootDir }), null);
  });
});

test('deleteConversationAttachments removes all files for the conversation', async () => {
  await withTempRoot(async (rootDir) => {
    await saveAttachment('c1', 'a1', 'one.txt', Buffer.from('1'), { rootDir });
    await saveAttachment('c1', 'a2', 'two.txt', Buffer.from('2'), { rootDir });
    await saveAttachment('c2', 'b1', 'three.txt', Buffer.from('3'), { rootDir });

    await deleteConversationAttachments('c1', { rootDir });

    assert.equal(await resolveAttachmentPath('c1', 'a1', { rootDir }), null);
    assert.equal(await resolveAttachmentPath('c1', 'a2', { rootDir }), null);
    // Other conversations untouched.
    assert.ok(await resolveAttachmentPath('c2', 'b1', { rootDir }));
  });
});

test('deleteConversationAttachments is a no-op when dir is missing', async () => {
  await withTempRoot(async (rootDir) => {
    await deleteConversationAttachments('never-existed', { rootDir });
  });
});

test('sweepOrphanAttachments removes unknown directories and unsafe names', async () => {
  await withTempRoot(async (rootDir) => {
    await mkdir(path.join(rootDir, 'keep'));
    await mkdir(path.join(rootDir, 'drop'));
    await writeFile(path.join(rootDir, 'drop', 'x.txt'), 'bye');

    // An unsafe-named directory shouldn't exist, but sweep should clean it
    // up defensively if it somehow does.
    await mkdir(path.join(rootDir, '..nope'), { recursive: true });

    const removed = await sweepOrphanAttachments(new Set(['keep']), { rootDir });
    assert.ok(removed.includes('drop'));
    assert.ok(removed.includes('..nope'));

    const entries = await readdir(rootDir);
    assert.deepEqual(entries.sort(), ['keep']);
  });
});

test('sweepOrphanAttachments is a no-op when the root does not exist', async () => {
  await withTempRoot(async (rootDir) => {
    const missing = path.join(rootDir, 'not-there');
    const removed = await sweepOrphanAttachments(new Set(), { rootDir: missing });
    assert.deepEqual(removed, []);
  });
});
