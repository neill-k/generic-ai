import { describe, expect, it } from "vitest";

import {
  clientKeyFromRequest,
  createAuthRateLimiter,
  createMemoryAuthStore,
  createOwnerAuth,
  createOwnerAuthRoutes,
  PEER_ADDRESS_SYMBOL,
} from "../src/index.js";

const ORIGIN = "http://localhost:3000";

describe("createAuthRateLimiter", () => {
  it("locks a key after too many failures and unlocks after the lockout", () => {
    let clock = 0;
    const limiter = createAuthRateLimiter({
      maxFailures: 3,
      windowMs: 1_000,
      lockoutMs: 10_000,
      now: () => clock,
    });
    limiter.recordFailure("a");
    limiter.recordFailure("a");
    expect(limiter.check("a")).toEqual({ allowed: true });
    limiter.recordFailure("a");
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect(limiter.check("b")).toEqual({ allowed: true });
    clock = 10_001;
    expect(limiter.check("a")).toEqual({ allowed: true });
  });

  it("forgets failures outside the window and on success", () => {
    let clock = 0;
    const limiter = createAuthRateLimiter({ maxFailures: 2, windowMs: 1_000, now: () => clock });
    limiter.recordFailure("a");
    clock = 1_500;
    limiter.recordFailure("a");
    expect(limiter.check("a").allowed).toBe(true);
    limiter.recordSuccess("a");
    limiter.recordFailure("a");
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("caps failures across all clients", () => {
    const limiter = createAuthRateLimiter({ maxFailures: 10, maxGlobalFailures: 3 });
    limiter.recordFailure("a");
    limiter.recordFailure("b");
    limiter.recordFailure("c");
    expect(limiter.check("d").allowed).toBe(false);
  });
});

describe("clientKeyFromRequest", () => {
  it("uses the peer address, or the last forwarded hop when proxies are trusted", () => {
    const request = new Request(`${ORIGIN}/`, {
      headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" },
    });
    Object.defineProperty(request, PEER_ADDRESS_SYMBOL, { value: "10.0.0.2" });
    expect(clientKeyFromRequest(request)).toBe("10.0.0.2");
    expect(clientKeyFromRequest(request, { trustProxyHeaders: true })).toBe("198.51.100.7");
    expect(clientKeyFromRequest(new Request(`${ORIGIN}/`))).toBe("unknown");
  });
});

describe("sign-in rate limiting over HTTP", () => {
  it("returns 429 after repeated bad setup tokens, per client", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: "fake-setup-token-for-tests-only",
    });
    const { app } = createOwnerAuthRoutes(auth, {
      clientKey: (request) => request.headers.get("x-test-client") ?? "none",
    });
    const attempt = (client: string, setupToken: string) =>
      app.request(`${ORIGIN}/auth/passkeys/register/options`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", "x-test-client": client },
        body: JSON.stringify({ setupToken }),
      });

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt("attacker", "wrong-guess")).status).toBe(401);
    }
    const locked = await attempt("attacker", "fake-setup-token-for-tests-only");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);

    expect((await attempt("owner", "fake-setup-token-for-tests-only")).status).toBe(200);
  });

  it("caps open challenges", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: "fake-setup-token-for-tests-only",
    });
    const { app } = createOwnerAuthRoutes(auth, { rateLimiter: false });
    let last = 0;
    for (let index = 0; index < 101; index += 1) {
      const response = await app.request(`${ORIGIN}/auth/passkeys/register/options`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ setupToken: "fake-setup-token-for-tests-only" }),
      });
      last = response.status;
    }
    expect(last).toBe(429);
  });
});
