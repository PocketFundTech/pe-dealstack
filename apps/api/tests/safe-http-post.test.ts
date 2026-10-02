/**
 * SSRF guard for outbound webhooks: which addresses count as private, and
 * IP-literal URLs are refused before any connection is attempted.
 */
import { describe, it, expect } from 'vitest';
import { isPrivateAddress, safePostJson, BlockedAddressError } from '../src/services/safeHttpPost.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.1.2.3',
    '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s', (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});

describe('safePostJson', () => {
  it.each([
    'https://127.0.0.1/hook', 'https://[::ffff:127.0.0.1]/hook', 'https://169.254.169.254/latest',
  ])('refuses %s without connecting', async (url) => {
    await expect(safePostJson(url, {}, '{}', 1000)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('refuses plain http', async () => {
    await expect(safePostJson('http://example.com/x', {}, '{}', 1000)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('refuses a hostname that resolves to loopback', async () => {
    await expect(safePostJson('https://localhost/hook', {}, '{}', 2000)).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
