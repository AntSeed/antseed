import { parseJsonObject } from '@antseed/api-adapter'

/**
 * Per-chat identity extraction for the buyer proxy.
 *
 * Coding tools stamp a stable per-conversation identifier onto every model
 * request (verified by live capture, 2026-07-21):
 *
 *   - Claude Code   header `x-claude-code-session-id`, plus the same UUID in
 *                   body `metadata.user_id` (JSON string with `session_id`).
 *   - Codex         headers `thread-id` / `session-id` (+ `originator`), plus
 *                   body `prompt_cache_key` with the same UUID. `thread-id`
 *                   is stable across resume/fork, so it wins.
 *   - OpenCode      headers `x-session-id` / `x-session-affinity`, and
 *                   `x-parent-session-id` on subagent sessions.
 *
 * The buyer uses this identity to key per-chat routing overrides and the
 * conversations list shown in the desktop app. pi sends no wire identity
 * today, so its requests simply resolve to no conversation.
 *
 * Detection is fully generic — no per-tool rules anywhere: the tool name
 * comes from the `x-<tool>-session-id` header name, the `originator` header
 * value, or the User-Agent product token, in that order.
 */

export type ConversationIdentity = {
  /** Slug for the originating tool ('claude-code' | 'codex' | 'opencode' | 'unknown'). */
  tool: string
  /** Stable per-conversation key as sent by the tool. */
  sessionKey: string
  /** Parent session for subagent traffic (OpenCode), when advertised. */
  parentSessionKey: string | null
}

/* Snippets are labels, not previews — keep them short. */
const SNIPPET_MAX_CHARS = 80

/** Machine-generated context wrappers that must not become a chat label.
    Skipped in favor of a later genuine prompt, but usable as a fallback. */
const NON_PROMPT_PREFIXES = [
  '<system-reminder',
  '<environment_context',
  '<user_instructions',
  '<command-name',
  '<local-command',
  '<permissions',
  '<workspace',
]

/** Tool-injected title/summary instructions (OpenCode fires a same-session
    "Generate a title for this conversation:" request concurrently with the
    first real turn; Claude Code sends "Please write a 5-10 word title...").
    These must NEVER become a label — not even as a fallback — otherwise the
    title request racing ahead of the real first turn names the chat
    "Generate a title for this conversation:". */
const TITLE_REQUEST_PREFIXES = [
  'generate a title',
  'generate a brief title',
  'please write a 5-10 word title',
  'write a 5-10 word title',
  'write a short title',
  'summarize this conversation in a title',
  'summarize this coding conversation',
]

/** Injected project-doc blobs — Codex sends AGENTS.md / CLAUDE.md contents
    as a user message ("# AGENTS.md instructions for <cwd> ..."). Like title
    requests these must never label a chat, not even as a fallback; matched
    against the tag-stripped text so a wrapper can't hide the doc header. */
const INSTRUCTION_DOC_PATTERN = /^#*\s*(agents|claude|gemini)\.md\b/i

function getHeader(headers: Record<string, string>, name: string): string {
  const direct = headers[name]
  if (typeof direct === 'string') return direct
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? ''
  }
  return ''
}

/** True for API paths that carry a user conversation turn. */
export function isCompletionRequestPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').replace(/\/+$/, '')
  return clean.endsWith('/messages')
    || clean.endsWith('/chat/completions')
    || clean.endsWith('/completions')
    || clean.endsWith('/responses')
}

/**
 * Tools that stamp `x-<tool>-session-id` (e.g. Claude Code's
 * `x-claude-code-session-id`) are identified generically from the header
 * name itself — a new tool following the convention needs no code change.
 * `x-parent-session-id` is the subagent parent pointer, not a tool name.
 */
function toolSessionHeader(headers: Record<string, string>): { tool: string; sessionKey: string } | null {
  for (const name of Object.keys(headers)) {
    const match = /^x-(.+)-session-id$/.exec(name.toLowerCase())
    const tool = match?.[1] ?? ''
    if (!tool || tool === 'parent') continue
    const value = headers[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { tool, sessionKey: value.trim() }
    }
  }
  return null
}

/** Normalize a client identifier into a display-safe slug. */
function slugifyTool(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Fully generic client identity — no per-tool rules. The `originator` header
 * names the originating client when present (e.g. Codex sends its client id
 * there); otherwise the User-Agent product token (the part before the first
 * `/`) identifies the client, the same way HTTP intends it to.
 */
function detectTool(headers: Record<string, string>): string {
  const originator = slugifyTool(getHeader(headers, 'originator'))
  if (originator) return originator
  const userAgent = getHeader(headers, 'user-agent').trim()
  const product = userAgent.split(/[/\s]/, 1)[0] ?? ''
  return slugifyTool(product) || 'unknown'
}

function sessionKeyFromBody(body: Record<string, unknown> | null): string {
  if (!body) return ''
  const cacheKey = body['prompt_cache_key']
  if (typeof cacheKey === 'string' && cacheKey.trim().length > 0) return cacheKey.trim()
  const metadata = body['metadata']
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const userId = (metadata as Record<string, unknown>)['user_id']
    if (typeof userId === 'string' && userId.length > 0) {
      // Claude Code packs a JSON object into the string; prefer its session_id.
      try {
        const parsed = JSON.parse(userId) as Record<string, unknown>
        if (typeof parsed['session_id'] === 'string' && parsed['session_id'].length > 0) {
          return parsed['session_id']
        }
      } catch { /* plain string user_id */ }
      return userId
    }
  }
  return ''
}

/**
 * Extract the conversation identity from a completion request, or null when
 * the tool sent nothing to key on. `parsedBody` is the request body as a JSON
 * object when available (callers usually have it parsed already).
 */
export function extractConversationIdentity(
  headers: Record<string, string>,
  parsedBody: Record<string, unknown> | null,
): ConversationIdentity | null {
  const named = toolSessionHeader(headers)
  const sessionKey = named?.sessionKey
    || getHeader(headers, 'thread-id')
    || getHeader(headers, 'session-id')
    || getHeader(headers, 'x-session-id')
    || getHeader(headers, 'x-session-affinity')
    || sessionKeyFromBody(parsedBody)
  const trimmed = sessionKey.trim()
  if (!trimmed) return null
  const parent = getHeader(headers, 'x-parent-session-id').trim()
  return {
    tool: named?.tool ?? detectTool(headers),
    sessionKey: trimmed,
    parentSessionKey: parent.length > 0 ? parent : null,
  }
}

function looksLikeMachineContext(text: string): boolean {
  const start = text.trimStart().toLowerCase()
  return NON_PROMPT_PREFIXES.some((prefix) => start.startsWith(prefix))
}

function looksLikeTitleRequest(text: string): boolean {
  const start = text.trimStart().toLowerCase()
  return TITLE_REQUEST_PREFIXES.some((prefix) => start.startsWith(prefix))
}

/** Strip XML-ish tags (prompts often open with wrappers like `<session>`),
    collapse whitespace, and truncate to label length. */
function normalizeSnippet(text: string): string {
  const collapsed = text
    .replace(/<\/?[a-zA-Z][^<>]{0,120}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (collapsed.length <= SNIPPET_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, SNIPPET_MAX_CHARS - 1).trimEnd()}…`
}

function textFromContent(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    const type = typeof record['type'] === 'string' ? record['type'] : ''
    if (type && type !== 'text' && type !== 'input_text') continue
    if (typeof record['text'] === 'string') texts.push(record['text'])
  }
  return texts
}

function userTextsFromMessageList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const texts: string[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record['role'] !== 'user') continue
    texts.push(...textFromContent(record['content']))
  }
  return texts
}

/**
 * Best-effort label for a new conversation: the first genuine user prompt in
 * the request, skipping machine-generated context wrappers (system reminders,
 * environment context, tool instructions). Handles Anthropic `messages`,
 * OpenAI chat `messages`, and Responses `input` (string or item list).
 */
export function extractFirstUserSnippet(parsedBody: Record<string, unknown> | null): string | null {
  if (!parsedBody) return null
  const candidates: string[] = []
  candidates.push(...userTextsFromMessageList(parsedBody['messages']))
  const input = parsedBody['input']
  if (typeof input === 'string') candidates.push(input)
  else candidates.push(...userTextsFromMessageList(input))

  // Title-request instructions are dropped entirely; OpenCode embeds the
  // real conversation after its instruction, so the genuine prompt still
  // surfaces. A request that is ONLY a title instruction yields null — the
  // conversation stays unlabeled until a real turn arrives. Genuine prompts
  // are preferred over machine-context wrappers, and candidates that strip
  // down to nothing (pure markup) are passed over.
  const usable = candidates.filter((text) => text.trim().length > 0 && !looksLikeTitleRequest(text))
  const genuine = usable.filter((text) => !looksLikeMachineContext(text))
  for (const text of [...genuine, ...usable]) {
    const normalized = normalizeSnippet(text)
    if (normalized.length > 0 && !INSTRUCTION_DOC_PATTERN.test(normalized)) return normalized
  }
  return null
}

/**
 * Re-clean a snippet that was persisted by an older version of this pipeline:
 * stored title-request instructions are dropped (empty snippets get upgraded
 * by the next real turn), everything else goes through the current
 * tag-stripping/normalizing rules.
 */
export function sanitizeStoredSnippet(text: string): string {
  if (!text) return ''
  if (looksLikeTitleRequest(text)) return ''
  const normalized = normalizeSnippet(text)
  // Stored labels from before the instruction-doc rule heal to empty so the
  // next real turn names the chat.
  return INSTRUCTION_DOC_PATTERN.test(normalized) ? '' : normalized
}

/** Convenience: parse a raw body for identity/snippet extraction. */
export function parseRequestBodyObject(body: Uint8Array, headers: Record<string, string>): Record<string, unknown> | null {
  if (!getHeader(headers, 'content-type').toLowerCase().includes('application/json') || body.length === 0) {
    return null
  }
  return parseJsonObject(body)
}
