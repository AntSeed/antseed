/**
 * Connection auth envelope: the signed `intro`/`hello` line that opens every
 * transport connection. Signatures are EIP-191 personal-sign over
 * MSG_SIGNING_DOMAIN + buildConnectionAuthPayload(...). Verification (replay
 * guard, clock skew) lives in @antseed/node; this module is the wire format.
 */

export type InitialWireType = 'intro' | 'hello';

export interface ConnectionAuthEnvelope {
  peerId: string;
  ts: number;
  nonce: string;
  sig: string;
}

/** Domain prefix for EIP-191 message signing (see signUtf8 in @antseed/node). */
export const MSG_SIGNING_DOMAIN = 'antseed-msg-v1:';

export const INTRO_AUTH_MAX_SKEW_MS = 30_000;

export function buildConnectionAuthPayload(
  type: InitialWireType,
  peerId: string,
  ts: number,
  nonce: string,
): string {
  return `${type}|${peerId}|${ts}|${nonce}`;
}
