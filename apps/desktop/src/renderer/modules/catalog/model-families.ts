import type { VprModelCatalogEntry } from '../../core/state';
import { resolveBrandKey, type BrandKey } from '../../ui/components/brand/BrandIcon';

/**
 * Model family (lab/vendor) names for catalog filtering, keyed by the brand
 * mark a row renders. Resolution mirrors the row icon (`provider` then
 * `label`) so filtering by a family selects exactly the rows showing that
 * vendor's mark. Tool/transport brands (zed, pi, telegram, …) are not model
 * families and resolve to no family at all; Codex models are OpenAI's.
 */
const FAMILY_LABELS: Partial<Record<BrandKey, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'OpenAI',
  gemini: 'Google',
  kimi: 'Moonshot',
  glm: 'Z.ai',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  grok: 'xAI',
  mistral: 'Mistral',
  minimax: 'MiniMax',
  llama: 'Meta',
};

export function modelFamilyLabel(entry: Pick<VprModelCatalogEntry, 'provider' | 'label'>): string | null {
  return FAMILY_LABELS[resolveBrandKey(entry.provider, entry.label)] ?? null;
}

/** Unique family names present in the catalog, alphabetized for the filter pill. */
export function availableModelFamilies(
  entries: readonly Pick<VprModelCatalogEntry, 'provider' | 'label'>[],
): string[] {
  const families = new Set<string>();
  for (const entry of entries) {
    const family = modelFamilyLabel(entry);
    if (family) families.add(family);
  }
  return Array.from(families).sort((a, b) => a.localeCompare(b));
}
