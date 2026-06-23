import type { ConnectRequest } from './types.js';

/**
 * Build the exact UTF-8 message that is signed with EIP-191 personal_sign
 * (Section 9). The first line is the only domain separator and MUST be
 * reproduced exactly. Line endings are LF with no trailing blank line. One
 * value line follows `scopes:` for each shared scope, in request order.
 */
export function buildSignedMessage(
  req: ConnectRequest,
  values: Record<string, string>,
): string {
  const lines = [
    'AntSeed Connect',
    `version: ${req.version}`,
    `redirect: ${req.redirect}`,
    `challenge: ${req.challenge}`,
    `scopes: ${req.scopes.join(',')}`,
  ];
  for (const scope of req.scopes) {
    const value = values[scope];
    if (value === undefined) {
      throw new Error(`missing value for scope: ${scope}`);
    }
    lines.push(`${scope}: ${value}`);
  }
  return lines.join('\n');
}
