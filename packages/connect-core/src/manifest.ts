import { CONNECT_VERSION, type ConnectManifest } from './types.js';

export class ConnectManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectManifestError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function assertSameOriginHttps(url: string, origin: string, field: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectManifestError(`manifest ${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    if (!loopback) {
      throw new ConnectManifestError(`manifest ${field} must be HTTPS`);
    }
  }
  if (parsed.origin !== origin) {
    throw new ConnectManifestError(`manifest ${field} must be same-origin with ${origin}`);
  }
}

/**
 * Parse and validate a web app manifest. The manifest is
 * display-only: it never carries a security decision. `origin` is the request
 * origin the manifest was fetched from.
 *
 * @throws {ConnectManifestError} on any failed check.
 */
export function parseManifest(jsonText: string, origin: string): ConnectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ConnectManifestError('manifest is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConnectManifestError('manifest is not an object');
  }
  const m = parsed as Record<string, unknown>;

  if (m['version'] !== CONNECT_VERSION) {
    throw new ConnectManifestError('unsupported manifest version');
  }
  if (m['kind'] !== 'antseed.connect.manifest') {
    throw new ConnectManifestError('unexpected manifest kind');
  }
  if (typeof m['name'] !== 'string' || m['name'].length === 0) {
    throw new ConnectManifestError('manifest name is required');
  }
  if (typeof m['homepage'] !== 'string') {
    throw new ConnectManifestError('manifest homepage is required');
  }
  assertSameOriginHttps(m['homepage'], origin, 'homepage');

  const manifest: ConnectManifest = {
    version: CONNECT_VERSION,
    kind: 'antseed.connect.manifest',
    name: m['name'],
    homepage: m['homepage'],
  };

  if (m['icon'] !== undefined) {
    if (typeof m['icon'] !== 'string') {
      throw new ConnectManifestError('manifest icon must be a string');
    }
    assertSameOriginHttps(m['icon'], origin, 'icon');
    manifest.icon = m['icon'];
  }

  return manifest;
}
