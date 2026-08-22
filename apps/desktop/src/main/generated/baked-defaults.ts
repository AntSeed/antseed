/**
 * Build-time baked defaults.
 *
 * Committed with every value null. Release builds overwrite this file via
 * `node scripts/bake-comparable-prices-url.mjs` before compiling, so
 * packaged apps carry defaults without hard-coding them in the repo.
 * Runtime environment variables always win over a baked value.
 */

/**
 * Default retail-prices models API URL for the measured-savings baseline.
 * Overridden by ANTSEED_COMPARABLE_PRICES_URL at runtime (an empty value
 * disables the baseline entirely).
 */
export const BAKED_COMPARABLE_PRICES_URL: string | null = null;

/** Dedicated Telegram bot used only for the public desktop feedback channel. */
export const BAKED_FEEDBACK_TELEGRAM_BOT_TOKEN: string | null = null;

/** Numeric channel ID or public @channelusername for desktop feedback. */
export const BAKED_FEEDBACK_TELEGRAM_CHAT_ID: string | null = null;
