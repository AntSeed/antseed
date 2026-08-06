/**
 * Shared model-key normalization used by both the main process (OpenRouter
 * catalog fetch) and the renderer (baseline price matching). Both ends must
 * produce identical keys, so the logic lives here exactly once.
 */

/**
 * Normalize a model id/name into a match key: lowercase, drop any `vendor/`
 * prefix, and strip everything but alphanumerics.
 */
export function normalizeModelKey(value: string): string {
  const withoutVendor = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
  return withoutVendor.toLowerCase().replace(/[^a-z0-9]/g, '');
}
