/**
 * Resolve Express' `trust proxy` setting from TRUST_PROXY.
 * Unset means no trusted proxies: forwarded headers from a direct caller must
 * never influence req.ip (and therefore rate-limit buckets).
 */
export function parseTrustProxy(value: string | undefined): number | string | boolean {
  if (!value) return 0;
  return Number.isNaN(Number(value)) ? value : Number(value);
}
