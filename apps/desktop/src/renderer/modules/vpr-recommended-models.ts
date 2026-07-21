import type { VprModelCatalogEntry } from '../core/state';
import { canonicalModelKey } from './model-identity';
import { favoriteModelKey } from './vpr-favorites';

/** Hand-picked frontier lineup pinned to the top of every model picker.
 *  Each slot yields at most ONE catalog entry: the exact canonical model if
 *  a seller advertises it, otherwise the family's most popular variant — so
 *  a family with many variants (gpt-5.6-luna/-sol/-terra…) doesn't flood the
 *  recommended list. A slot with no live sellers simply doesn't appear.
 *  Order here is display order. */
const RECOMMENDED_MODEL_LINEUP: ReadonlyArray<{ pattern: RegExp; exact: string }> = [
  { pattern: /gpt[-\s]?5\.6/, exact: 'gpt5.6' },
  { pattern: /fable/, exact: 'claudefable5' },
  { pattern: /kimi[-\s]?k?[-\s]?3/, exact: 'kimik3' },
  { pattern: /glm[-\s]?5\.2/, exact: 'glm5.2' },
  { pattern: /deep-?seek/, exact: 'deepseekv4' },
  { pattern: /gemini[-\s]?3[\d.\s-]*pro/, exact: 'gemini3pro' },
  { pattern: /grok[-\s]?4\.5/, exact: 'grok4.5' },
  { pattern: /qwen[-\s]?3\.5/, exact: 'qwen3.5' },
];

export function isFreeCatalogEntry(entry: VprModelCatalogEntry): boolean {
  const { minInputUsdPerMillion: input, minOutputUsdPerMillion: output } = entry;
  return input !== null && output !== null && input <= 0 && output <= 0;
}

function entryMatchText(entry: VprModelCatalogEntry): string {
  return `${entry.serviceId} ${entry.label}`.toLowerCase();
}

export function catalogEntryKey(entry: VprModelCatalogEntry): string {
  return favoriteModelKey(entry.provider, entry.serviceId);
}

/** The curated "Recommended" list: frontier models in lineup order, then any
 *  free models (free rides along by default — it costs nothing to try). */
export function selectRecommendedVprCatalog(catalog: VprModelCatalogEntry[]): VprModelCatalogEntry[] {
  const picked: VprModelCatalogEntry[] = [];
  const pickedKeys = new Set<string>();
  const pick = (entry: VprModelCatalogEntry): void => {
    const key = catalogEntryKey(entry);
    if (pickedKeys.has(key)) return;
    pickedKeys.add(key);
    picked.push(entry);
  };

  // The catalog is popularity-sorted, so matches[0] is the family's
  // most-sold variant.
  for (const slot of RECOMMENDED_MODEL_LINEUP) {
    const matches = catalog.filter((entry) => slot.pattern.test(entryMatchText(entry)));
    if (matches.length === 0) continue;
    const winner = matches.find((entry) => canonicalModelKey(entry.serviceId) === slot.exact) ?? matches[0];
    pick(winner);
  }
  for (const entry of catalog) {
    if (isFreeCatalogEntry(entry)) pick(entry);
  }
  return picked;
}

/** Catalog entries the user starred on their model pages, in catalog order. */
export function selectFavoriteVprCatalog(
  catalog: VprModelCatalogEntry[],
  favorites: ReadonlySet<string>,
): VprModelCatalogEntry[] {
  if (favorites.size === 0) return [];
  return catalog.filter((entry) => favorites.has(catalogEntryKey(entry)));
}
