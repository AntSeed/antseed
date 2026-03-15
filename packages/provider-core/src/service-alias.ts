/**
 * Parse a JSON string into a service alias map (announced service → upstream model).
 * Used by all provider plugins via the ANTSEED_SERVICE_ALIAS_MAP_JSON env var.
 */
export function parseServiceAliasMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ANTSEED_SERVICE_ALIAS_MAP_JSON must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ANTSEED_SERVICE_ALIAS_MAP_JSON must be a JSON object');
  }

  const out: Record<string, string> = {};
  for (const [announcedRaw, upstreamRaw] of Object.entries(parsed as Record<string, unknown>)) {
    const announced = announcedRaw.trim().toLowerCase();
    if (!announced) continue;
    if (typeof upstreamRaw !== 'string' || !upstreamRaw.trim()) {
      throw new Error(`ANTSEED_SERVICE_ALIAS_MAP_JSON entry "${announcedRaw}" must map to a non-empty string`);
    }
    out[announced] = upstreamRaw.trim();
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
