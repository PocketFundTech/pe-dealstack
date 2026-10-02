/**
 * POST to a customer-supplied URL without letting it reach our own network.
 *
 * The hostname is resolved at connection time and every resolved address is
 * checked; the socket then connects to exactly the address that was checked,
 * so DNS rebinding between "validate" and "connect" can't slip through.
 * Redirects are never followed.
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export class BlockedAddressError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];

/** True for loopback, private, link-local, CGNAT, multicast/reserved and their IPv4-mapped IPv6 forms. */
export function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) {
    const rest = ip.slice(7);
    if (net.isIPv4(rest)) ip = rest;
    else {
      // Hex form, e.g. ::ffff:7f00:1 → 127.0.0.1
      const m = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (!m) return true;
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
  }
  return true; // not an IP at all: fail closed
}

const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked || addresses.length === 0) {
      return callback(new BlockedAddressError(`${hostname} resolves to a private or internal address`), '', 0);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
};

export function safePostJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new BlockedAddressError('Invalid URL'));
    }
    if (parsed.protocol !== 'https:') return reject(new BlockedAddressError('Only https:// URLs are allowed'));
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    // IP literals skip DNS lookup entirely, so check them here.
    if (net.isIP(host) && isPrivateAddress(host)) {
      return reject(new BlockedAddressError(`${host} is a private or internal address`));
    }

    const req = https.request(
      parsed,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body).toString() },
        lookup: safeLookup,
      },
      (res) => {
        res.resume(); // discard the body; only the status matters
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.setTimeout(timeoutMs, () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end(body);
  });
}
