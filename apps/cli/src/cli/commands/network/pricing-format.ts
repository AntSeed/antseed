import chalk from 'chalk';

const DIM_DASH = chalk.dim('—');

/**
 * Format a USD-per-million-tokens price with precision proportional to the
 * magnitude so sub-cent rates don't collapse to "$0.00":
 *
 *   * null / undefined / non-finite → dim em-dash placeholder
 *   * 0                             → "$0.00" (2 decimals, tabular-aligned)
 *   * 0 <  x < 0.001                → 6 decimals (e.g. "$0.000015")
 *   * 0.001 ≤ x < 0.1               → 4 decimals (e.g. "$0.0050", "$0.0500")
 *   * x ≥ 0.1                       → 2 decimals (e.g. "$0.10", "$15.00")
 *
 * The tiering matches the cost ranges real LLM providers actually charge at:
 * pennies per million tokens (most of today's models), sub-cent per million
 * (bulk/long-context tiers), and sub-thousandth-cent per million (some
 * cached-input rates). Tables using this formatter have columns wide enough
 * for the 4/6-decimal cases; the 2-decimal branch renders flush-right for
 * the common majority of rows.
 *
 * `opts.withUnit` appends `/1M` for contexts where there's no column header
 * (per-service detail lines); table renderers should omit the suffix since
 * their column header already says "$/1M".
 */
export function formatUsdPerMillion(
  value: number | null | undefined,
  opts?: { withUnit?: boolean },
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return DIM_DASH;
  }
  const withUnit = opts?.withUnit ?? false;
  const rendered =
    value === 0
      ? `$${value.toFixed(2)}`
      : value < 0.001
        ? `$${value.toFixed(6)}`
        : value < 0.1
          ? `$${value.toFixed(4)}`
          : `$${value.toFixed(2)}`;
  return withUnit ? `${rendered}/1M` : rendered;
}
