/**
 * Normalize advertised model names into a conservative cross-provider match
 * key. Cosmetic separators, vendor paths, `latest`, and trailing release dates
 * are ignored. Known flattened vendor prefixes are ignored only when followed
 * by their established model family. Numeric version punctuation is compacted
 * for established versioned families, covering equivalent forms such as
 * `gpt-5.6`, `gpt-5-6`, and `gpt-56` without changing arbitrary service ids.
 */
export function canonicalModelKey(serviceId: string): string {
  let value = String(serviceId ?? '').trim().toLowerCase();
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  value = value.replace(/[-:._\s]+(latest|\d{6,8}|\d{4}-\d{2}(-\d{2})?)$/, '');
  value = value.replace(/^anthropic[-:._\s]+(?=claude(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^openai[-:._\s]+(?=gpt(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^google[-:._\s]+(?=gemma(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^aion[-:._\s]+labs[-:._\s]+(?=aion(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^(?:zai[-:._\s]+org|z[-:._\s]+ai)[-:._\s]+(?=glm(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^claude[-:._\s]+(?=(opus|sonnet|haiku|fable)(?:[-:._\s]|\d|$))/, '');
  if (/^fable(?:[-:._\s]|\d)/.test(value)) {
    value = value.replace(/[-:._\s]+coding[-:._\s]+only$/, '');
  }
  const compactVersionPunctuation = /^(?:aion|opus|sonnet|haiku|fable|deepseek|e2ee[-:._\s]*glm|gemini|gemma|glm|gpt|grok|hermes|kimi|llama|mimo|minimax|mistral|qwen|venice[-:._\s]*uncensored)(?:[-:._\s]|\d)/.test(value);
  return compactVersionPunctuation
    ? value.replace(/[^a-z0-9]+/g, '')
    : value.replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '');
}

export function sameCanonicalModel(a: string, b: string): boolean {
  const keyA = canonicalModelKey(a);
  return keyA.length > 0 && keyA === canonicalModelKey(b);
}
