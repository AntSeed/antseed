import type { VprModelCatalogEntry } from '../../core/state';
import { canonicalModelKey } from './model-identity';
import { favoriteModelKey } from './favorites';

/** Hand-picked frontier lineup pinned to the top of every model picker:
 *  the popular Claude and GPT models plus the open-source flagships buyers
 *  actually ask for. Notable variants get their OWN slot (gpt-5.6-sol and
 *  gpt-5.6-luna are different models to a buyer, not noise), so the list is
 *  per-model rather than per-family.
 *
 *  Each slot yields at most one catalog entry: the exact canonical model when
 *  a seller advertises it, otherwise the most popular variant matching the
 *  pattern that no earlier slot already claimed. A slot with no live sellers
 *  simply doesn't appear. Order here is display order. */
const RECOMMENDED_MODEL_LINEUP: ReadonlyArray<{ pattern: RegExp; exact: string }> = [
  { pattern: /opus[-\s]?5/, exact: 'claudeopus5' },
  { pattern: /gpt[-\s]?5\.6[-\s]?sol/, exact: 'gpt5.6sol' },
  { pattern: /fable/, exact: 'claudefable5' },
  { pattern: /gpt[-\s]?5\.6[-\s]?luna/, exact: 'gpt5.6luna' },
  { pattern: /sonnet[-\s]?5/, exact: 'claudesonnet5' },
  // Generic GPT 5.6 slot runs after the named variants so it lands on the
  // base model (or whichever variant they left unclaimed).
  { pattern: /gpt[-\s]?5\.6/, exact: 'gpt5.6' },
  { pattern: /kimi[-\s]?k?[-\s]?3/, exact: 'kimik3' },
  { pattern: /minimax[-\s]?m?[-\s]?3/, exact: 'minimaxm3' },
  { pattern: /deep-?seek/, exact: 'deepseekv4' },
  { pattern: /glm[-\s]?5\.2/, exact: 'glm5.2' },
  { pattern: /qwen[-\s]?3\.5/, exact: 'qwen3.5' },
  { pattern: /gemini[-\s]?3[\d.\s-]*pro/, exact: 'gemini3pro' },
  { pattern: /grok[-\s]?4\.5/, exact: 'grok4.5' },
];

export function isFreeCatalogEntry(entry: VprModelCatalogEntry): boolean {
  if (entry.kind === 'image') return false;
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

  // The catalog is popularity-sorted, so the first unclaimed match is the
  // most-sold variant still available to this slot. Skipping already-picked
  // entries keeps a broad slot (gpt-5.6) from being starved by an earlier
  // narrow one (gpt-5.6-sol) that already took its most popular match.
  for (const slot of RECOMMENDED_MODEL_LINEUP) {
    const matches = catalog.filter((entry) => slot.pattern.test(entryMatchText(entry)));
    if (matches.length === 0) continue;
    const winner = matches.find((entry) => canonicalModelKey(entry.serviceId) === slot.exact)
      ?? matches.find((entry) => !pickedKeys.has(catalogEntryKey(entry)));
    if (winner) pick(winner);
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
