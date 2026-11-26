/**
 * In-memory limiter for failed sign-in attempts. Each client key gets a small
 * failure budget per window; a global budget also caps failures from all
 * clients together, so rotating addresses does not buy unlimited guesses.
 *
 * State lives in process memory, which fits the single-instance, single-owner
 * deployment this plugin targets. A restart clears it.
 */

export interface AuthRateLimiterOptions {
  /** Failures allowed per client key within `windowMs`. Defaults to 5. */
  readonly maxFailures?: number;
  /** Failures allowed across all clients within `windowMs`. Defaults to 50. */
  readonly maxGlobalFailures?: number;
  /** Window over which failures are counted. Defaults to 15 minutes. */
  readonly windowMs?: number;
  /** How long a key stays blocked once over budget. Defaults to 15 minutes. */
  readonly lockoutMs?: number;
  readonly now?: () => number;
}

export type AuthRateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface AuthRateLimiter {
  check(key: string): AuthRateLimitDecision;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
}

interface Bucket {
  failures: number[];
  blockedUntil: number;
}

const GLOBAL_KEY = "\u0000global";
const MAX_TRACKED_KEYS = 10_000;

export function createAuthRateLimiter(options: AuthRateLimiterOptions = {}): AuthRateLimiter {
  const maxFailures = options.maxFailures ?? 5;
  const maxGlobalFailures = options.maxGlobalFailures ?? 50;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= MAX_TRACKED_KEYS) {
        prune(now());
      }
      bucket = { failures: [], blockedUntil: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  function prune(at: number): void {
    for (const [key, bucket] of buckets) {
      bucket.failures = bucket.failures.filter((time) => at - time < windowMs);
      if (bucket.failures.length === 0 && bucket.blockedUntil <= at) {
        buckets.delete(key);
      }
    }
  }

  const blockedFor = (key: string, at: number): number => {
    const bucket = buckets.get(key);
    return bucket === undefined ? 0 : Math.max(0, bucket.blockedUntil - at);
  };

  return Object.freeze({
    check(key: string): AuthRateLimitDecision {
      const at = now();
      const wait = Math.max(blockedFor(key, at), blockedFor(GLOBAL_KEY, at));
      return wait > 0
        ? { allowed: false, retryAfterSeconds: Math.ceil(wait / 1000) }
        : { allowed: true };
    },

    recordFailure(key: string): void {
      const at = now();
      for (const [bucketKey, limit] of [
        [key, maxFailures],
        [GLOBAL_KEY, maxGlobalFailures],
      ] as const) {
        const bucket = bucketFor(bucketKey);
        bucket.failures = bucket.failures.filter((time) => at - time < windowMs);
        bucket.failures.push(at);
        if (bucket.failures.length >= limit) {
          bucket.blockedUntil = at + lockoutMs;
          bucket.failures = [];
        }
      }
    },

    recordSuccess(key: string): void {
      buckets.delete(key);
    },
  });
}

/** Symbol the starter's Node server uses to attach the TCP peer address. */
export const PEER_ADDRESS_SYMBOL = Symbol.for("@generic-ai/http.peerAddress");

export interface ClientKeyOptions {
  /**
   * Use the last `X-Forwarded-For` entry, which the nearest reverse proxy
   * appends. Enable only behind a proxy you trust (for example Railway).
   */
  readonly trustProxyHeaders?: boolean;
}

/** Derives a rate-limit key for the client that sent `request`. */
export function clientKeyFromRequest(request: Request, options: ClientKeyOptions = {}): string {
  if (options.trustProxyHeaders === true) {
    const forwarded = request.headers.get("x-forwarded-for");
    const last = forwarded
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    if (last !== undefined) {
      return last;
    }
  }

  const peer = (request as unknown as Record<symbol, unknown>)[PEER_ADDRESS_SYMBOL];
  return typeof peer === "string" && peer.length > 0 ? peer : "unknown";
}
