import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sanitizeStoredSnippet } from './conversation-identity.js'

/**
 * File-backed store for tool conversations seen by the buyer proxy.
 *
 * Each record maps one tool chat session (identified on the wire — see
 * conversation-identity.ts) to a display label and an optional per-chat
 * routed-model pin. Persists as `conversations.json` in the buyer data dir,
 * written atomically (tmp + rename) with writes serialized behind a queue,
 * mirroring how buyer.state.json is handled. No database involved.
 */

export type StoredConversation = {
  /** `${tool}:${sessionKey}` — unique per tool chat. */
  id: string
  tool: string
  sessionKey: string
  /** First genuine user prompt, captured when the conversation is first seen. */
  snippet: string
  /** User-assigned name; overrides the snippet for display when set. */
  label: string | null
  /** Per-chat route pin as `<peerId>@<service>`; null follows the default route. */
  pinnedModel: string | null
  /** Model that served the most recent request (`<peerId>@<service>`), for display. */
  lastModel: string | null
  createdAt: number
  lastActiveAt: number
}

export const CONVERSATIONS_FILE = 'conversations.json'
/** LRU cap — oldest by lastActiveAt beyond this are pruned. */
const MAX_CONVERSATIONS = 50
/** Conversations idle longer than this are pruned. */
const MAX_IDLE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LABEL_CHARS = 120

export function conversationId(tool: string, sessionKey: string): string {
  return `${tool}:${sessionKey}`
}

function sanitizeRecord(value: unknown): StoredConversation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const tool = typeof record.tool === 'string' ? record.tool : ''
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey : ''
  if (!tool || !sessionKey) return null
  return {
    id: conversationId(tool, sessionKey),
    tool,
    sessionKey,
    // Persisted snippets are re-cleaned so rows written by older extraction
    // rules (raw XML wrappers, title-request text) heal on reload.
    snippet: typeof record.snippet === 'string' ? sanitizeStoredSnippet(record.snippet) : '',
    label: typeof record.label === 'string' && record.label.length > 0 ? record.label : null,
    pinnedModel: typeof record.pinnedModel === 'string' && record.pinnedModel.length > 0 ? record.pinnedModel : null,
    lastModel: typeof record.lastModel === 'string' && record.lastModel.length > 0 ? record.lastModel : null,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    lastActiveAt: typeof record.lastActiveAt === 'number' ? record.lastActiveAt : Date.now(),
  }
}

export class ConversationStore {
  private readonly _dir: string
  private readonly _file: string
  private readonly _byId = new Map<string, StoredConversation>()
  private _writeQueue: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this._dir = dataDir
    this._file = join(dataDir, CONVERSATIONS_FILE)
    this._loadSync()
  }

  private _loadSync(): void {
    let raw: string
    try {
      raw = readFileSync(this._file, 'utf8')
    } catch {
      return // first run — no file yet
    }
    try {
      const parsed = JSON.parse(raw) as { conversations?: unknown[] }
      const records = (parsed.conversations ?? [])
        .map(sanitizeRecord)
        .filter((record): record is StoredConversation => record !== null)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt) // map order tracks recency
      for (const record of records) {
        this._byId.set(record.id, record)
      }
    } catch { /* corrupted file — start clean, next write repairs it */ }
    this._prune()
  }

  /* The map's insertion order tracks recency (touch() re-inserts), so ties
     on lastActiveAt — e.g. many chats touched in the same millisecond —
     still evict oldest-first. */
  private _prune(): void {
    const cutoff = Date.now() - MAX_IDLE_MS
    for (const [id, record] of this._byId) {
      if (record.lastActiveAt < cutoff) this._byId.delete(id)
    }
    while (this._byId.size > MAX_CONVERSATIONS) {
      const oldest = this._byId.keys().next().value
      if (oldest === undefined) break
      this._byId.delete(oldest)
    }
  }

  /** Serialized atomic write; returns the queued write promise. */
  private _persist(): Promise<void> {
    this._writeQueue = this._writeQueue.then(async () => {
      const payload = JSON.stringify({ conversations: [...this._byId.values()] }, null, 2)
      await mkdir(this._dir, { recursive: true })
      const tmp = `${this._file}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this._file)
    }).catch(() => { /* keep the queue alive after a failed write */ })
    return this._writeQueue
  }

  /** Wait for pending writes (tests / shutdown). */
  flush(): Promise<void> {
    return this._writeQueue
  }

  /**
   * Record activity for a conversation, creating it on first sight. The
   * snippet only sticks at creation — later turns keep the original label.
   */
  touch(input: { tool: string; sessionKey: string; snippet?: string | null; lastModel?: string | null }): StoredConversation {
    const id = conversationId(input.tool, input.sessionKey)
    const existing = this._byId.get(id)
    const now = Date.now()
    let record: StoredConversation
    if (existing) {
      record = {
        ...existing,
        lastActiveAt: now,
        lastModel: input.lastModel ?? existing.lastModel,
        snippet: existing.snippet || (input.snippet ?? ''),
      }
    } else {
      record = {
        id,
        tool: input.tool,
        sessionKey: input.sessionKey,
        snippet: input.snippet ?? '',
        label: null,
        pinnedModel: null,
        lastModel: input.lastModel ?? null,
        createdAt: now,
        lastActiveAt: now,
      }
    }
    this._byId.delete(id) // re-insert so map order tracks recency
    this._byId.set(id, record)
    this._prune()
    void this._persist()
    return record
  }

  /** Newest-activity first (stable sort over reversed insertion order keeps
      same-millisecond ties in true recency order). */
  list(): StoredConversation[] {
    return [...this._byId.values()].reverse().sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  get(id: string): StoredConversation | null {
    return this._byId.get(id) ?? null
  }

  getPinnedModel(tool: string, sessionKey: string): string | null {
    return this._byId.get(conversationId(tool, sessionKey))?.pinnedModel ?? null
  }

  setLabel(id: string, label: string | null): StoredConversation | null {
    const existing = this._byId.get(id)
    if (!existing) return null
    const clean = label?.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || null
    const record = { ...existing, label: clean }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  setPinnedModel(id: string, pinnedModel: string | null): StoredConversation | null {
    const existing = this._byId.get(id)
    if (!existing) return null
    const record = { ...existing, pinnedModel: pinnedModel || null }
    this._byId.set(id, record)
    void this._persist()
    return record
  }

  remove(id: string): boolean {
    const removed = this._byId.delete(id)
    if (removed) void this._persist()
    return removed
  }
}
