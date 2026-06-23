import { CONNECT_VERSION, type ConnectRequest, type ScopeId } from './types.js';
import { isScopeId } from './scopes.js';

export class ConnectRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectRequestError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// These params are copied verbatim into the EIP-191 signed message, so an ASCII
// control char (newline/tab/etc.) could inject an extra line and make the signed
// bytes ambiguous. Reject anything below U+0020 or DEL.
function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isLoopback(url: URL) {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Parse and validate a request link (Section 6). Accepts the `antseed://connect`
 * deep link or its `https`-scheme equivalent carrying the same query.
 *
 * The requesting origin is derived solely from the redirect URL via the WHATWG
 * URL parser, so it cannot be spoofed by a separate link parameter.
 *
 * @throws {ConnectRequestError} on any rejected link.
 */
export function parseRequestLink(input: string): ConnectRequest {
  let link: URL;
  try {
    link = new URL(input);
  } catch {
    throw new ConnectRequestError('request link is not a valid URL');
  }

  const params = link.searchParams;

  const version = params.get('version');
  if (version !== String(CONNECT_VERSION)) {
    throw new ConnectRequestError(`unsupported version: ${version ?? '(missing)'}`);
  }

  const redirectRaw = params.get('redirect');
  if (!redirectRaw) {
    throw new ConnectRequestError('missing redirect');
  }
  if (hasControlChar(redirectRaw)) {
    throw new ConnectRequestError('redirect must not contain control characters');
  }
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectRaw);
  } catch {
    throw new ConnectRequestError('redirect is not a valid URL');
  }

  if (redirectUrl.username || redirectUrl.password) {
    throw new ConnectRequestError('redirect must not contain a username or password');
  }
  if (redirectUrl.hash) {
    throw new ConnectRequestError('redirect must not contain a fragment');
  }
  if (redirectUrl.protocol === 'http:') {
    if (!isLoopback(redirectUrl)) {
      throw new ConnectRequestError('non-HTTPS redirect is only allowed for loopback development');
    }
  } else if (redirectUrl.protocol !== 'https:') {
    throw new ConnectRequestError(`redirect must use https (got ${redirectUrl.protocol})`);
  }

  const scopesRaw = params.get('scopes');
  if (!scopesRaw) {
    throw new ConnectRequestError('missing scopes');
  }
  const scopeIds = scopesRaw.split(',');
  const scopes: ScopeId[] = [];
  const seen = new Set<string>();
  for (const id of scopeIds) {
    if (!id) {
      throw new ConnectRequestError('empty scope id');
    }
    if (seen.has(id)) {
      throw new ConnectRequestError(`duplicate scope: ${id}`);
    }
    if (!isScopeId(id)) {
      throw new ConnectRequestError(`unknown scope: ${id}`);
    }
    seen.add(id);
    scopes.push(id);
  }

  const challenge = params.get('challenge');
  if (!challenge) {
    throw new ConnectRequestError('missing challenge');
  }
  if (hasControlChar(challenge)) {
    throw new ConnectRequestError('challenge must not contain control characters');
  }

  return {
    version: CONNECT_VERSION,
    redirect: redirectRaw,
    origin: redirectUrl.origin,
    scopes,
    challenge,
  };
}
