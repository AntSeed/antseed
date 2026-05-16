/**
 * Known on-chain seller-proxy contracts.
 *
 * When a peer publishes a `SellerDelegation` (peer metadata codec v8+) the
 * settled-to address is the proxy contract \u2014 not the peer's identity
 * address. We don't verify ownership here (the daemon does that during
 * discovery); this map purely surfaces a recognisable identification badge
 * on Discover cards so users can tell "this peer routes settlements through
 * the DIEM staking pool" at a glance.
 *
 * Addresses are stored lowercased without the `0x` prefix so comparisons
 * don't accidentally fail on EIP-55 checksum mismatches.
 */

export type KnownProxy = {
  /** Canonical lowercased address without 0x prefix (40 hex chars). */
  address: string;
  /** Short label shown inside the badge pill. */
  label: string;
  /** Tooltip / aria description explaining what the badge means. */
  description: string;
};

const KNOWN_PROXIES: ReadonlyArray<KnownProxy> = [
  {
    // DiemStakingProxy on Base mainnet \u2014 see docs/protocol/diem-proxy.md
    // and apps/diem-staking/src/lib/addresses.ts.
    address: '1f228613116e2d08014dfdcc198377c8dedf18c9',
    label: 'DIEM Pool',
    description:
      'Settled through the DIEM Staking Pool. Revenue is distributed pro-rata to DIEM stakers via the staking proxy contract on Base.',
  },
];

function normalizeAddress(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const hex = input.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{40}$/.test(hex) ? hex : null;
}

/**
 * Returns metadata for a known seller proxy, or `null` if the address is not
 * recognised (or empty). Safe to call with `peerEvmAddress` too \u2014
 * mismatches simply return `null`.
 */
export function getKnownProxy(sellerContract: string | null | undefined): KnownProxy | null {
  const hex = normalizeAddress(sellerContract);
  if (!hex) return null;
  return KNOWN_PROXIES.find((p) => p.address === hex) ?? null;
}
