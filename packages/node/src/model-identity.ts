/**
 * Normalize advertised model names into a conservative cross-provider match
 * key. Cosmetic separators, vendor paths, `latest`, and trailing release dates
 * are ignored. Anthropic's optional `claude` brand prefix is ignored only for
 * the established Opus, Sonnet, and Haiku model families.
 */
export function canonicalModelKey(serviceId: string): string {
  let value = String(serviceId ?? '').trim().toLowerCase();
  const slash = value.lastIndexOf('/');
  if (slash >= 0) value = value.slice(slash + 1);
  value = value.replace(/[-:._\s]+(latest|\d{6,8}|\d{4}-\d{2}(-\d{2})?)$/, '');
  value = value.replace(/^claude[-:._\s]+(?=(opus|sonnet|haiku)(?:[-:._\s]|\d|$))/, '');
  return value.replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '');
}

export function sameCanonicalModel(a: string, b: string): boolean {
  const keyA = canonicalModelKey(a);
  return keyA.length > 0 && keyA === canonicalModelKey(b);
}
