import type { BuyerConversationSummary } from '../types/bridge';

/**
 * Shared helpers for buyer conversation rows (per-chat routing) — the same
 * list renders on the Home page, the Apps page, and the floating pill.
 */

/** How long after a chat's last request its row keeps the green pulse. The
    buyer stamps lastActiveAt per dispatched request, so this must outlast
    the gap between an agent tool's consecutive calls (and the 3s payload
    cadence) or the pulse would flicker mid-conversation. */
export const CONVERSATION_ACTIVE_HOLD_MS = 10_000;

/** Display name: user label, else prompt snippet, else the session key. */
export function conversationTitle(record: BuyerConversationSummary): string {
  return record.label || record.snippet || record.sessionKey.slice(0, 12);
}

/** Service id of the pinned model, or null when following the default route. */
export function conversationPinnedServiceId(record: BuyerConversationSummary): string | null {
  return record.pinnedModel?.split('@').slice(1).join('@') || null;
}

/** Slugs are single tokens ('codex', 'opencode') while the wire-derived
    tool slug may carry a variant suffix ('codex-exec', 'codex-cli-rs'), so
    either side may extend the other by a `-` segment. */
function toolMatchesSlug(tool: string, slug: string): boolean {
  if (!slug) return false;
  if (tool === slug) return true;
  return tool.startsWith(`${slug}-`) || slug.startsWith(`${tool}-`);
}

/**
 * True when a conversation's tool slug belongs to the given app profile.
 * The profile's configurable client names (`toolSlugs` — the User-Agent
 * product / session-header identity each request carries) are the source of
 * truth; the profile name itself remains a fallback match.
 */
export function conversationMatchesApp(
  tool: string,
  profile: { name: string; toolSlugs?: string[] },
): boolean {
  if (profile.toolSlugs?.some((slug) => toolMatchesSlug(tool, slug))) return true;
  return toolMatchesSlug(tool, profile.name);
}

/** True while the chat reads as receiving traffic (drives the green pulse). */
export function isConversationActive(lastActiveAt: number): boolean {
  return Date.now() - lastActiveAt < CONVERSATION_ACTIVE_HOLD_MS;
}

/** Compact session identifier for meta lines ("019f83b7"): common tool
    prefixes like `ses_` are stripped so the distinctive part shows. */
export function shortSessionId(sessionKey: string): string {
  return sessionKey.replace(/^[a-z]+_/i, '').slice(0, 8);
}

/** Compact relative timestamp for chat rows ("now", "5m", "2h", "3d"). */
export function conversationAge(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
