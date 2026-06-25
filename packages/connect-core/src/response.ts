import { verifyMessage } from 'ethers';
import {
  CONNECT_VERSION,
  type ConnectRequest,
  type ConnectResponse,
  type ConnectSigner,
  type ScopeAccount,
  type ScopeId,
} from './types.js';
import { SCOPES } from './scopes.js';
import { buildSignedMessage } from './message.js';
import { buildFragmentUrl } from './fragment.js';

export class ConnectResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectResponseError';
  }
}

function normalizeSignature(sig: string) {
  const lower = sig.toLowerCase();
  return lower.startsWith('0x') ? lower.slice(2) : lower;
}

/**
 * Resolve the value each requested scope would share, from the local account
 * address. The client shows these to the user before approval.
 */
export function resolveScopeValues(
  req: ConnectRequest,
  account: ScopeAccount,
): Record<ScopeId, string> {
  const values = {} as Record<ScopeId, string>;
  for (const scope of req.scopes) {
    values[scope] = SCOPES[scope].resolve(account);
  }
  return values;
}

/**
 * Sign a Connect response with the local identity after user approval.
 * Validates every value before signing and binds the address scope to the
 * signer.
 */
export async function signConnectResponse(
  signer: ConnectSigner,
  req: ConnectRequest,
  values: Record<string, string>,
): Promise<{ response: ConnectResponse; fragmentUrl: string }> {
  const signerAddress = signer.address.toLowerCase();

  for (const scope of req.scopes) {
    if (values[scope] === undefined) {
      throw new ConnectResponseError(`missing value for scope: ${scope}`);
    }
  }
  if (req.scopes.includes('address') && values['address'] !== signerAddress) {
    throw new ConnectResponseError('address scope value does not match the signer');
  }

  const message = buildSignedMessage(req, values);
  const rawSig = await signer.signMessage(message);

  const response: ConnectResponse = {
    version: CONNECT_VERSION,
    kind: 'antseed.connect.response',
    challenge: req.challenge,
    values: pickScopeValues(req, values),
    signatureScheme: 'eip191-personal-sign',
    signature: normalizeSignature(rawSig),
  };

  return { response, fragmentUrl: buildFragmentUrl(req.redirect, response) };
}

function pickScopeValues(req: ConnectRequest, values: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const scope of req.scopes) {
    out[scope] = values[scope]!;
  }
  return out;
}

/**
 * Verify a signed response against the request it answers (web-app side).
 * Returns the recovered account address (lowercase). Lives here so a
 * gateway can reuse it and so the tests can round-trip sign against verify.
 *
 * @throws {ConnectResponseError} on any failed check.
 */
export function verifyConnectResponse(
  response: unknown,
  req: ConnectRequest,
): string {
  if (typeof response !== 'object' || response === null) {
    throw new ConnectResponseError('response is not an object');
  }
  const r = response as Record<string, unknown>;

  if (r['version'] !== CONNECT_VERSION) {
    throw new ConnectResponseError('unsupported response version');
  }
  if (r['kind'] !== 'antseed.connect.response') {
    throw new ConnectResponseError('unexpected response kind');
  }
  if (r['signatureScheme'] !== 'eip191-personal-sign') {
    throw new ConnectResponseError('unsupported signature scheme');
  }
  if (r['challenge'] !== req.challenge) {
    throw new ConnectResponseError('challenge mismatch');
  }
  if (typeof r['signature'] !== 'string') {
    throw new ConnectResponseError('missing signature');
  }
  const values = r['values'];
  if (typeof values !== 'object' || values === null) {
    throw new ConnectResponseError('missing values');
  }
  const valueMap = values as Record<string, unknown>;

  const requested = new Set<string>(req.scopes);
  for (const key of Object.keys(valueMap)) {
    if (!requested.has(key)) {
      throw new ConnectResponseError(`response contains unrequested scope: ${key}`);
    }
  }
  const flatValues: Record<string, string> = {};
  for (const scope of req.scopes) {
    const value = valueMap[scope];
    if (typeof value !== 'string') {
      throw new ConnectResponseError(`missing value for scope: ${scope}`);
    }
    flatValues[scope] = value;
  }

  const message = buildSignedMessage(req, flatValues);
  let recovered: string;
  try {
    recovered = verifyMessage(message, '0x' + normalizeSignature(r['signature'])).toLowerCase();
  } catch {
    throw new ConnectResponseError('signature recovery failed');
  }

  if (req.scopes.includes('address') && flatValues['address'] !== recovered) {
    throw new ConnectResponseError('address scope value does not match the recovered signer');
  }

  return recovered;
}
