import {useEffect, useState} from 'react';
import {ANTS_TOKEN_ADDRESS} from './useEpochCountdown';

/**
 * Live ANTS supply, read straight from the token contract on Base via the
 * public RPC (eth_call totalSupply() / balanceOf(0xdEaD)). Cached for
 * 10 minutes in sessionStorage; `null` until the first read lands so the
 * caller can fall back to the emission schedule.
 */

const RPC = 'https://mainnet.base.org';
const CACHE_KEY = 'as-ants-supply-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEAD = '0x000000000000000000000000000000000000dEaD';
const SEL_TOTAL_SUPPLY = '0x18160ddd';
const SEL_BALANCE_OF = '0x70a08231';

export interface AntsSupply {
  /** totalSupply(), in whole ANTS */
  total: number;
  /** balanceOf(0xdEaD), in whole ANTS — emission + early-exit burns */
  burned: number;
}

function toAnts(hex: string): number {
  return Number(BigInt(hex) / 10n ** 12n) / 1e6;
}

async function call(data: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{to: ANTS_TOKEN_ADDRESS, data}, 'latest'],
    }),
  });
  const json = (await res.json()) as {result?: string};
  if (!json.result || json.result === '0x') throw new Error('empty eth_call result');
  return json.result;
}

export function useAntsSupply(): AntsSupply | null {
  const [supply, setSupply] = useState<AntsSupply | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as AntsSupply & {at: number};
        if (Date.now() - cached.at < CACHE_TTL_MS) {
          setSupply({total: cached.total, burned: cached.burned});
          return undefined;
        }
      }
    } catch {
      /* ignore cache errors */
    }

    const ctrl = new AbortController();
    const deadArg = DEAD.slice(2).toLowerCase().padStart(64, '0');
    Promise.all([call(SEL_TOTAL_SUPPLY, ctrl.signal), call(SEL_BALANCE_OF + deadArg, ctrl.signal)])
      .then(([total, burned]) => {
        const next = {total: toAnts(total), burned: toAnts(burned)};
        setSupply(next);
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({...next, at: Date.now()}));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* leave null → caller falls back to the schedule */
      });
    return () => ctrl.abort();
  }, []);

  return supply;
}
