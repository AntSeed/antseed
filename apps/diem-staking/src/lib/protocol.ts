// Frontend fallbacks for protocol-level values. Live on-chain reads are the
// source of truth; these values are only used before the first read lands or
// when the proxy isn't deployed in the current environment.

/**
 * Expected owner-set `maxTotalStake` fallback. Assumes 18-decimal DIEM.
 * The owner can raise or remove the cap (set to 0 for unlimited) via
 * `setMaxTotalStake`; once the read returns, the UI uses the contract value.
 */
export const ALPHA_MAX_TOTAL_STAKE_DIEM_BASE = 100n * 10n ** 18n;
