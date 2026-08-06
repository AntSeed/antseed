/** Canonical identity + display naming for advertised model services.
 *
 * Sellers advertise the same model under near-identical keys ("gpt-5.6-luna",
 * "GPT 5.6 Luna", "openai/gpt-5.6-luna", "gpt-5.6-luna-20260115") and under
 * different provider strings. The canonical key aggressively normalizes a
 * serviceId so those variants aggregate into one catalog entry, and the
 * display label renders a human model name ("Claude Fable 5") so raw service
 * keys never reach the UI.
 */

/** Lowercase letters/digits/version-dots only — "gpt-5.6-luna" → "gpt5.6luna".
 *  Vendor prefixes ("openai/…"), separators, "-latest" and trailing date
 *  stamps are all stripped, so cosmetic key differences collapse. */
export function canonicalModelKey(serviceId: string): string {
  let value = String(serviceId ?? '').trim().toLowerCase();
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  value = value.replace(/[-:._\s]+(latest|\d{6,8}|\d{4}-\d{2}(-\d{2})?)$/, '');
  return value.replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '');
}

/** True when both ids collapse to the same canonical model. */
export function sameCanonicalModel(a: string, b: string): boolean {
  const keyA = canonicalModelKey(a);
  return keyA.length > 0 && keyA === canonicalModelKey(b);
}

/* Tokens whose conventional casing isn't first-letter-capitalized. */
const TOKEN_CASING: Record<string, string> = {
  gpt: 'GPT',
  chatgpt: 'ChatGPT',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  xai: 'xAI',
  ai: 'AI',
  llm: 'LLM',
  oss: 'OSS',
  moe: 'MoE',
};

/* A string that reads as a machine key rather than a human label. */
const SLUG_RE = /^[a-z0-9./_:-]+$/;

function prettifySlug(slug: string): string {
  let value = slug.toLowerCase();
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  return value
    .split(/[-_:\s]+/)
    .filter(Boolean)
    .map((token) => {
      const mapped = TOKEN_CASING[token];
      if (mapped) return mapped;
      // Short letter+version tokens: v4 → V4, k3 → K3, r2.5 → R2.5.
      if (/^[a-z]\d+(\.\d+)?$/.test(token)) return token.toUpperCase();
      if (/^\d/.test(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

/** Human model name for display: a seller-provided label that already reads
 *  as prose wins; slug-shaped labels and raw serviceIds get prettified
 *  ("claude-fable-5" → "Claude Fable 5"). */
export function displayModelLabel(serviceId: string, serviceLabel?: string | null): string {
  const label = (serviceLabel ?? '').trim();
  if (label && !SLUG_RE.test(label)) return label;
  const source = label || String(serviceId ?? '').trim();
  if (!source || !SLUG_RE.test(source)) return source;
  return prettifySlug(source);
}
