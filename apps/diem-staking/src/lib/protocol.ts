// Frontend mirrors of protocol-level on-chain constants. Values that ship
// baked into the DiemStakingProxy (via `constant` or constructor init) live
// here so the UI can render sensible defaults before the first on-chain read
// lands, and to keep a single source of truth for values the UI needs in
// multiple places.
//
// SOURCE OF TRUTH: packages/contracts/DiemStakingProxy.sol. Keep in sync.

/**
 * Constructor-set default for `maxTotalStake`. Assumes 18-decimal DIEM.
 * Owner can raise or remove (set to 0 for unlimited) via `setMaxTotalStake`.
 * Used as the display fallback when the proxy isn't deployed yet or the
 * live read hasn't returned, so the alpha-strip shows the correct cap
 * from page load even in pre-deploy mode.
 */
export const ALPHA_MAX_TOTAL_STAKE_DIEM_BASE = 50n * 10n ** 18n;
