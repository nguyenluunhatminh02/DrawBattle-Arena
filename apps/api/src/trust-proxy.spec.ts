import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy (P2-02)', () => {
  it('defaults to 0 (no trusted proxies) when unset', () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('')).toBe(0);
  });

  it('parses numeric hop counts configured by compose/tunnel deployments', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('passes through Express-compatible string settings', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});
