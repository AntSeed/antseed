import type { ConnectResponse } from './types.js';

export function encodeResponseFragment(response: ConnectResponse): string {
  const json = JSON.stringify(response);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeResponseFragment(encoded: string): unknown {
  const json = Buffer.from(encoded, 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * Build the delivery URL: the redirect URL with the response in the fragment, so
 * it is never sent to the server or leaked through referrers.
 */
export function buildFragmentUrl(redirect: string, response: ConnectResponse): string {
  return `${redirect}#result=${encodeResponseFragment(response)}`;
}
