/**
 * Guards the bridge against dialing internal networks. Seller endpoints
 * discovered over the DHT are attacker-controlled (any peer can announce any
 * publicAddress), so before dialing one the relay rejects loopback, private,
 * link-local, and CGNAT ranges — both for IP literals and for what a hostname
 * actually resolves to (covers DNS rebinding). Operator-configured static
 * sellers skip the guard so local/e2e setups keep working.
 */

import { lookup, type LookupAddress } from 'node:dns';
import net from 'node:net';

export function isForbiddenIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isForbiddenV4(ip);
  if (family === 6) return isForbiddenV6(ip);
  return true;
}

function isForbiddenV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||                        // "this network"
    a === 10 ||                       // private
    a === 127 ||                      // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||       // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168)          // private
  );
}

function isForbiddenV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isForbiddenV4(mapped[1]!);
  if (lower === '::' || lower === '::1') return true; // unspecified / loopback
  const firstHextet = lower.split(':', 1)[0] ?? '';
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
  return false;
}

/**
 * dns.lookup wrapper for net.connect that fails when an untrusted hostname
 * resolves into a forbidden range. Handles both single-address and all:true
 * lookups (Node's autoSelectFamily uses the latter). net.connect skips lookup
 * for IP literals, so callers must check those with isForbiddenIp() separately.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (err, address, family) => {
    if (!err) {
      const resolved = Array.isArray(address)
        ? (address as LookupAddress[]).map((a) => a.address)
        : [address];
      const forbidden = resolved.find((a) => isForbiddenIp(a));
      if (forbidden !== undefined) {
        callback(new Error(`refusing to dial forbidden address ${forbidden} (${hostname})`), address, family);
        return;
      }
    }
    callback(err, address, family);
  });
};
