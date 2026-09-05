import { useEffect, useState } from 'react';
import { shallowEqual, useUiSelector } from './useUiSelector';

const HAS_EVER_FUNDED_KEY = 'antseed.desktop.vpr.hasEverFunded';

function loadEverFunded(): boolean {
  try {
    return localStorage.getItem(HAS_EVER_FUNDED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Sticky funding memory: false only until the first deposit is ever observed
 * (owned USDC or an open payment channel). The stored flag makes the switch
 * permanent — free-first surfaces (Home dropdown, Models page) never revert to
 * the unfunded presentation, even when the balance later drains to zero.
 */
export function useEverFunded(): boolean {
  const snap = useUiSelector((state) => ({
    totalOwned: state.creditsTotalOwnedUsdc,
    channelCount: state.creditsChannels.length,
  }), shallowEqual);
  const [everFunded, setEverFunded] = useState(loadEverFunded);
  const hasDeposited = Number(snap.totalOwned) > 0 || snap.channelCount > 0;

  useEffect(() => {
    if (!hasDeposited || everFunded) return;
    setEverFunded(true);
    try {
      localStorage.setItem(HAS_EVER_FUNDED_KEY, '1');
    } catch { /* private mode */ }
  }, [everFunded, hasDeposited]);

  return everFunded || hasDeposited;
}
