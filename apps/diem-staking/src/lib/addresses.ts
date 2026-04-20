// Central address book for the DIEM Staking portal. All on-chain reads/writes
// resolve through these constants.
//
// NOTE: `DIEM_STAKING_PROXY` is populated at deploy time. Until deployed the
// frontend will show "contract not deployed yet" everywhere a read is needed.
// Override in development via VITE_DIEM_STAKING_PROXY (see below).

import type { Address } from 'viem';

/** Venice DIEM token on Base. ERC-20 + stake / initiateUnstake / unstake. */
export const DIEM_TOKEN: Address = '0xf4d97f2da56e8c3098f3a8d538db630a2606a024';

/** Zero sentinel — treat as "proxy not yet deployed". */
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

/**
 * DiemStakingProxy contract on Base.
 *
 * Source of truth at deploy time:
 *   - `VITE_DIEM_STAKING_PROXY` in `.env` / `.env.local` for local/staging
 *   - Fallback constant below is updated post-deploy and committed
 *
 * The UI tolerates an unset address: `useProxyDeployed` returns false and
 * every read-hook short-circuits to `null`, so the page renders cleanly with
 * "—" placeholders rather than throwing.
 */
const envProxy = (import.meta.env.VITE_DIEM_STAKING_PROXY as string | undefined) ?? '';
export const DIEM_STAKING_PROXY: Address = (envProxy && envProxy.startsWith('0x')
  ? (envProxy as Address)
  : ZERO_ADDRESS);

export function isAddressSet(a: Address): boolean {
  return a !== ZERO_ADDRESS && a.length === 42;
}
