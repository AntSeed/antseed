/**
 * Disk storage for chat attachments.
 *
 * Each message in a chat can carry attachments (images, PDFs, docs, etc).
 * The text/image data used for the LLM prompt is produced by
 * `chat-attachments.ts`. This module is separate — it persists the *raw*
 * bytes to disk so the renderer can preview them natively (images inline,
 * PDFs/HTML/SVG via a custom Electron protocol) without shipping
 * megabytes through IPC or through the persisted prompt text.
 *
 * Layout:
 *   <CHAT_DATA_DIR>/attachments/
 *     <conversationId>/
 *       <attachmentId><ext>
 *
 * Both IDs are validated against a strict charset before touching the
 * filesystem so a hostile renderer can't path-traverse out of the root.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHAT_DATA_DIR } from './chat-workspace.js';

/** Root directory where per-conversation attachment folders live. */
export const ATTACHMENTS_DIR = path.join(CHAT_DATA_DIR, 'attachments');

/**
 * IDs are used as directory / file names and as URL components in the custom
 * protocol. Allow only ASCII alphanumerics plus `-` and `_`, cap length at
 * 128 chars. Conversation IDs and attachment IDs produced elsewhere in the
 * app are UUIDs or monotonic counters, which all satisfy this.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Exposed for unit tests. */
export function isSafeId(value: string): boolean {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

/**
 * Derive a conservative extension from an attachment's original filename.
 * Limits to `[a-z0-9]{1,16}` so we don't smuggle things like `.php%00.jpg`
 * or multi-level extensions. Returns '' when no usable extension is found.
 */
function safeExtension(originalName: string): string {
  const idx = originalName.lastIndexOf('.');
  if (idx < 0 || idx === originalName.length - 1) return '';
  const raw = originalName.slice(idx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(raw)) return '';
  return `.${raw}`;
}

type StoreOptions = {
  /** Override the on-disk root (mainly for tests). */
  rootDir?: string;
};

function rootFor(options: StoreOptions | undefined): string {
  return options?.rootDir ?? ATTACHMENTS_DIR;
}

/**
 * Write raw attachment bytes to disk.
 *
 * Returns the absolute filesystem path that was written. Caller is
 * responsible for keeping the `attachmentId` in the message block so the
 * renderer can later ask the custom protocol for the same bytes.
 */
export async function saveAttachment(
  conversationId: string,
  attachmentId: string,
  originalName: string,
  buffer: Buffer | Uint8Array,
  options: StoreOptions = {},
): Promise<string> {
  if (!isSafeId(conversationId)) {
    throw new Error(`Invalid conversationId: ${conversationId}`);
  }
  if (!isSafeId(attachmentId)) {
    throw new Error(`Invalid attachmentId: ${attachmentId}`);
  }
  const root = rootFor(options);
  const dir = path.join(root, conversationId);
  await mkdir(dir, { recursive: true });
  const ext = safeExtension(originalName);
  const filename = ext ? `${attachmentId}${ext}` : attachmentId;
  const filePath = path.join(dir, filename);
  // `flag: 'w'` truncates any existing file; intentional: same attachmentId
  // always resolves to the same content.
  await writeFile(filePath, buffer, { flag: 'w' });
  return filePath;
}

/**
 * Resolve `(conversationId, attachmentId)` to an absolute filesystem path.
 * Returns `null` when the attachment isn't found, when IDs fail validation,
 * or when the resolved path somehow escapes the root (defense in depth).
 */
export async function resolveAttachmentPath(
  conversationId: string,
  attachmentId: string,
  options: StoreOptions = {},
): Promise<string | null> {
  if (!isSafeId(conversationId) || !isSafeId(attachmentId)) return null;
  const root = rootFor(options);
  const dir = path.join(root, conversationId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  // Match either `<id>` (no extension) or `<id>.<ext>`.
  const hit = entries.find((entry) => entry === attachmentId || entry.startsWith(`${attachmentId}.`));
  if (!hit) return null;
  const resolved = path.join(dir, hit);
  // Containment check — resolved path must live under root.
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const st = await stat(resolved);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/**
 * Delete every attachment belonging to a conversation. Safe no-op when
 * the conversation never had any attachments — `rm { force: true }`
 * swallows ENOENT, so no pre-check is needed.
 */
export async function deleteConversationAttachments(
  conversationId: string,
  options: StoreOptions = {},
): Promise<void> {
  if (!isSafeId(conversationId)) return;
  const root = rootFor(options);
  const dir = path.join(root, conversationId);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Remove attachment directories for conversations the caller no longer
 * tracks. Also removes directories whose names fail ID validation (they
 * shouldn't exist; we sweep them up just in case).
 *
 * Returns the names of directories that were removed (mostly for tests
 * and startup logging).
 */
export async function sweepOrphanAttachments(
  knownConversationIds: Set<string>,
  options: StoreOptions = {},
): Promise<string[]> {
  const root = rootFor(options);
  // No synchronous pre-check — the readdir try/catch below already
  // short-circuits when the root doesn't exist, and `existsSync` would
  // block the main event loop on every app startup.
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const keep = isSafeId(entry.name) && knownConversationIds.has(entry.name);
    if (keep) continue;
    try {
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Ignore individual failures — another sweep will retry.
    }
  }
  return removed;
}
