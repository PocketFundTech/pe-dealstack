/**
 * urlHelpers — isPrivateUrl() SSRF guards
 *
 * Verifies isPrivateUrl() blocks the full set of internal/private ranges:
 * - IPv4 loopback, RFC1918, link-local (169.254/16 — AWS IMDS), CGNAT (100.64/10)
 * - IPv6 loopback ([::1]), link-local (fe80::/10), unique-local (fc00::/7, fd00::/8)
 * - Hostnames: localhost, *.local, *.internal
 *
 * Regression: ensures common public hostnames are NOT mis-flagged.
 */

import { describe, it, expect } from 'vitest';
import { isPrivateUrl } from '../src/utils/urlHelpers.js';

describe('isPrivateUrl — IPv4 private ranges', () => {
  const blocked = [
    'http://localhost/',
    'http://localhost:6379/',
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://192.168.1.1/admin',
    'http://172.16.5.5/',
    'http://172.31.0.1/',
    'http://0.0.0.0/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }
});

describe('isPrivateUrl — IPv4 link-local 169.254/16 (AWS IMDS, ECS task role)', () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // AWS IMDS — canonical SSRF target
    'http://169.254.170.2/v2/credentials',      // ECS task role
    'http://169.254.0.1/',
    'http://169.254.255.255/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }
});

describe('isPrivateUrl — IPv4 CGNAT 100.64/10', () => {
  const blocked = [
    'http://100.64.0.1/',
    'http://100.127.255.254/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }

  // Regression: 100.0.0.1 and 100.128.0.1 are PUBLIC (outside CGNAT range)
  it('does NOT block 100.0.0.1 (public, below CGNAT range)', () => {
    expect(isPrivateUrl('http://100.0.0.1/')).toBe(false);
  });
  it('does NOT block 100.128.0.1 (public, above CGNAT range)', () => {
    expect(isPrivateUrl('http://100.128.0.1/')).toBe(false);
  });
});

describe('isPrivateUrl — IPv6 loopback / link-local / unique-local', () => {
  const blocked = [
    'http://[::1]/',          // IPv6 loopback
    'http://[fe80::1]/',      // IPv6 link-local
    'http://[fe80::1234]/',
    'http://[fc00::1]/',      // IPv6 unique-local
    'http://[fd00::1]/',      // IPv6 unique-local
    'http://[fdff:ffff::1]/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }
});

describe('isPrivateUrl — hostnames', () => {
  const blocked = [
    'http://foo.local/',
    'http://service.internal/',
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(true);
    });
  }
});

describe('isPrivateUrl — public URLs (regression guard)', () => {
  const allowed = [
    'https://www.example.com/',
    'https://api.openai.com/v1/chat',
    'https://github.com',
    'https://www.pocket-fund.com/about',
    'https://in.linkedin.com/in/test',
  ];
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(isPrivateUrl(url)).toBe(false);
    });
  }
});

describe('isPrivateUrl — fail-closed on invalid input', () => {
  it('treats empty string as private', () => {
    expect(isPrivateUrl('')).toBe(true);
  });
  it('treats malformed URL as private', () => {
    expect(isPrivateUrl('http://[invalid')).toBe(true);
  });
});
