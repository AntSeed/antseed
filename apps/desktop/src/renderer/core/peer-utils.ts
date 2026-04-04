/* peer-utils.ts — shared peer display utilities */

export function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export const PEER_GRADIENTS = [
  'linear-gradient(180deg, #ffa66c, #ff7b15)',
  'linear-gradient(180deg, #5ca9e0, #178dd6)',
  'linear-gradient(180deg, #4ece64, #00be2c)',
  'linear-gradient(180deg, #6fc5ff, #38b2ff)',
  'linear-gradient(180deg, #f27796, #ec4b74)',
  'linear-gradient(180deg, #8B5CF6, #7C3AED)',
  'linear-gradient(180deg, #06B6D4, #0891B2)',
  'linear-gradient(180deg, #EAB308, #CA8A04)',
  'linear-gradient(180deg, #0EA5E9, #0284C7)',
  'linear-gradient(180deg, #84CC16, #65A30D)',
];

export function getPeerGradient(key: string): string {
  return PEER_GRADIENTS[stringHash(key) % PEER_GRADIENTS.length];
}

/**
 * Strip parenthesized suffix from peer labels.
 * "Ember Forge (0x1234ab)" → "Ember Forge"
 */
export function getPeerDisplayName(peerLabel: string): string {
  return peerLabel.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}

export function formatPerMillionPrice(usdPerMillion: number): string {
  if (usdPerMillion <= 0) return 'Free';
  if (usdPerMillion < 0.01) return `$${usdPerMillion.toFixed(3)}/M`;
  return `$${usdPerMillion.toFixed(2)}/M`;
}
