/** Shared formatting for the Figma "sellers list" rows (model page, prefs). */

import type { DiscoverRow } from '../../core/state';
import { formatUsdShort } from '../../core/format';

/** Effective model reputation is 0-100; the UI shows it on a 10-point scale. */
export function sellerReputationLabel(route: DiscoverRow): string {
  const score = route.effectiveReputationScore ?? route.onChainReputationScore;
  if (score === null) return '-';
  return reputationScaleLabel(score);
}

/** 0-100 score → "9.8" (10-point scale). */
export function reputationScaleLabel(score: number): string {
  return (Math.min(score, 100) / 10).toFixed(1);
}

/** "$0.60" → "$0.6" — the seller meta line uses trimmed amounts (Figma). */
function trimmedUsd(value: number): string {
  return formatUsdShort(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function isFreeRoute(route: DiscoverRow): boolean {
  if (route.protocol === 'openai-images') {
    return route.maxImageUsdPerImage !== null && route.maxImageUsdPerImage <= 0;
  }
  const { inputUsdPerMillion: input, outputUsdPerMillion: output } = route;
  return input !== null && output !== null && input <= 0 && output <= 0;
}

/** "May 20, 2026 · $0.6/m input · $1.8/m output" (Figma sellers list row). */
export function sellerMetaLabel(route: DiscoverRow): string {
  const parts: string[] = [];
  if (isFreeRoute(route)) {
    parts.push('Free');
  } else if (route.protocol === 'openai-images' && route.minImageUsdPerImage !== null) {
    const min = trimmedUsd(route.minImageUsdPerImage);
    const max = route.maxImageUsdPerImage;
    parts.push(max !== null && max !== route.minImageUsdPerImage
      ? `${min}-${trimmedUsd(max)}/image`
      : `${min}/image`);
  } else if (route.inputUsdPerMillion !== null) {
    parts.push(`${trimmedUsd(route.inputUsdPerMillion)}/m input`);
    if (route.outputUsdPerMillion !== null) {
      parts.push(`${trimmedUsd(route.outputUsdPerMillion)}/m output`);
    }
  } else {
    parts.push('Price unknown');
  }
  return parts.join(' · ');
}
