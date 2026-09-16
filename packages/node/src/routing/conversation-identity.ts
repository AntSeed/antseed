/**
 * Per-chat identity, as computed by the buyer's own request-parsing layer
 * (apps/cli/src/proxy/conversation-identity.ts) and threaded into `Router.selectRoute`.
 *
 * The type lives here, in packages/node, rather than in apps/cli where it's
 * actually computed, because `Router` (interfaces/buyer-router.ts) is part of
 * this package's public interface and router plugins need to reference the
 * type without depending on the CLI app. Extraction logic (header/body
 * parsing, per-tool detection) stays in apps/cli — only the shape moves.
 */
export type ConversationIdentity = {
  /** Slug for the originating tool ('claude-code' | 'codex' | 'opencode' | 'unknown'). */
  tool: string;
  /** Stable per-conversation key as sent by the tool. */
  sessionKey: string;
  /** Parent session for subagent traffic (OpenCode), when advertised. */
  parentSessionKey: string | null;
  /** False when the tool declares this thread as its own housekeeping rather
      than a user's chat. True by default -- a tool that says nothing is taken
      at face value. */
  isUserThread: boolean;
};
