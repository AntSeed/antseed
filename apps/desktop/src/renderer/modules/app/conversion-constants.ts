declare const __ANTSEED_CONVERSION_DEV__: boolean;

const conversionDev = typeof __ANTSEED_CONVERSION_DEV__ !== 'undefined'
  && __ANTSEED_CONVERSION_DEV__;

export const CONVERSION_DEV = conversionDev;
export const D1_MIN_REQUESTS = 15;
export const D1_MIN_OUTPUT_TOKENS = 30_000;
export const D1_WARMUP_MS = conversionDev ? 60_000 : 30 * 60_000;
export const D1_MIN_CONVERSATIONS = 2;
export const D1_MIN_TURNS = 3;
export const D2_MIN_LIFETIME_REQUESTS = 8;
export const MIN_AMMO_USD = 0.5;
export const MIN_NETWORK_DISCOUNT = 0.2;
export const IDLE_MS = conversionDev ? 3_000 : 20_000;
export const DEPOSIT_SUGGESTED_USD = 10;
export const COUNTER_RETENTION_DAYS = 7;
