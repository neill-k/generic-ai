import { describe, expect, it, vi } from "vitest";
import { AuthError } from "../src/errors.js";
import { InMemoryCredentialStore } from "../src/memory-store.js";
import {
  createApiKeyResolver,
  login,
  logout,
  refreshStoredOAuthCredential,
  resolveAuth,
  saveApiKey,
} from "../src/resolve.js";
import type { OAuthCredential, OAuthProvider } from "../src/types.js";

const MINUTE = 60_000;

function fakeOAuth(
  overrides: Partial<OAuthProvider> = {},
): OAuthProvider & { refreshCalls: number } {
  const provider = {
    name: "Example",
    refreshCalls: 0,
    async login(): Promise<OAuthCredential> {
      return {
        type: "oauth",
        access: "logged-in",
        refresh: "r0",
        expires: Date.now() + 60 * MINUTE,
      };
    },
    async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
      provider.refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        type: "oauth",
        access: `access-${provider.refreshCalls}`,
        refresh: `${credential.refresh}+`,
        expires: Date.now() + 60 * MINUTE,
      };
    },
    async toAuth(credential: OAuthCredential) {
      return { apiKey: credential.access };
    },
    ...overrides,
  };
  return provider;
}

describe("resolveAuth", () => {
  it("prefers a stored API key over the fallback", async () => {
    const store = new InMemoryCredentialStore({ p: { type: "api_key", key: "stored" } });
    const fallback = vi.fn(() => "from-env");
    expect(await resolveAuth("p", { store, fallback })).toEqual({
      auth: { apiKey: "stored" },
      source: "api_key",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the fallback only when nothing is stored", async () => {
    const store = new InMemoryCredentialStore();
    expect(await resolveAuth("p", { store, fallback: async () => "from-env" })).toEqual({
      auth: { apiKey: "from-env" },
      source: "fallback",
    });
    expect(await resolveAuth("p", { store })).toBeUndefined();
  });

  it("returns a valid OAuth token without refreshing", async () => {
    const oauth = fakeOAuth();
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "fresh", refresh: "r", expires: Date.now() + 30 * MINUTE },
    });
    expect(await resolveAuth("p", { store, oauth: { p: oauth } })).toEqual({
      auth: { apiKey: "fresh" },
      source: "oauth",
    });
    expect(oauth.refreshCalls).toBe(0);
  });

  it("refreshes a token close to expiry once, even under concurrent requests, and stores it", async () => {
    const oauth = fakeOAuth();
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "old", refresh: "r", expires: Date.now() + MINUTE },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveAuth("p", { store, oauth: { p: oauth } })),
    );
    expect(oauth.refreshCalls).toBe(1);
    expect(results.map((result) => result?.auth.apiKey)).toEqual(Array(5).fill("access-1"));
    expect(await store.read("p")).toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "r+",
    });
  });

  it("raises on a failed refresh instead of falling back", async () => {
    const oauth = fakeOAuth({
      refresh: async () => {
        throw new Error("invalid_grant");
      },
    });
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "old", refresh: "r", expires: 0 },
    });
    const fallback = vi.fn(() => "from-env");
    const error = await resolveAuth("p", { store, oauth: { p: oauth }, fallback }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "oauth", message: "OAuth refresh failed for p" });
    expect((error as Error).cause).toMatchObject({ message: "invalid_grant" });
    expect(fallback).not.toHaveBeenCalled();
    expect(await store.read("p")).toMatchObject({ access: "old" });
  });

  it("raises when an OAuth credential has no registered sign-in method", async () => {
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "a", refresh: "r", expires: 0 },
    });
    await expect(resolveAuth("p", { store, fallback: () => "env" })).rejects.toThrow(
      "No OAuth sign-in method is registered for p",
    );
  });

  it("wraps store read failures", async () => {
    const store = new InMemoryCredentialStore();
    store.read = async () => {
      throw new Error("disk gone");
    };
    await expect(resolveAuth("p", { store })).rejects.toMatchObject({ code: "store" });
  });
});

describe("refreshStoredOAuthCredential", () => {
  it("persists a refresh that started even if the caller cancels", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRefresh!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const oauth = fakeOAuth({
      refresh: async (credential) => {
        markStarted();
        await gate;
        return {
          ...credential,
          access: "rotated",
          refresh: "rotated-refresh",
          expires: Date.now() + 60 * MINUTE,
        };
      },
    });
    const controller = new AbortController();
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "old", refresh: "r", expires: 0 },
    });
    const run = refreshStoredOAuthCredential(store, "p", oauth, () => true, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new Error("caller went away"));
    finishRefresh();
    await expect(run).resolves.toMatchObject({ access: "rotated" });
    expect(await store.read("p")).toMatchObject({ refresh: "rotated-refresh" });
  });

  it("skips the refresh when someone signed out meanwhile", async () => {
    const oauth = fakeOAuth();
    const store = new InMemoryCredentialStore();
    expect(await refreshStoredOAuthCredential(store, "p", oauth, () => true)).toBeUndefined();
    expect(oauth.refreshCalls).toBe(0);
  });

  it("bounds a hung refresh with the timeout", async () => {
    const oauth = fakeOAuth({
      refresh: (_credential, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    const store = new InMemoryCredentialStore({
      p: { type: "oauth", access: "a", refresh: "r", expires: 0 },
    });
    await expect(
      refreshStoredOAuthCredential(store, "p", oauth, () => true, { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "oauth" });
  });
});

describe("sign-in helpers", () => {
  it("login stores the credential, saveApiKey trims, logout removes", async () => {
    const store = new InMemoryCredentialStore();
    const credential = await login(store, "p", fakeOAuth(), {
      prompt: async () => "",
      notify: () => {},
    });
    expect(await store.read("p")).toEqual(credential);

    await saveApiKey(store, "q", "  sk-key \n");
    expect(await store.read("q")).toEqual({ type: "api_key", key: "sk-key" });
    await expect(saveApiKey(store, "q", "   ")).rejects.toThrow("API key is empty");

    await logout(store, "p");
    expect(await store.read("p")).toBeUndefined();
  });

  it("wraps sign-in failures and does not store anything", async () => {
    const store = new InMemoryCredentialStore();
    const oauth = fakeOAuth({
      login: async () => {
        throw new Error("denied");
      },
    });
    await expect(
      login(store, "p", oauth, { prompt: async () => "", notify: () => {} }),
    ).rejects.toMatchObject({
      code: "login",
      message: "Example sign-in failed",
    });
    expect(await store.list()).toEqual([]);
  });

  it("createApiKeyResolver matches the agent getApiKey contract", async () => {
    const store = new InMemoryCredentialStore({ p: { type: "api_key", key: "k" } });
    const getApiKey = createApiKeyResolver({
      store,
      fallback: (id) => (id === "env-only" ? "e" : undefined),
    });
    expect(await getApiKey("p")).toBe("k");
    expect(await getApiKey("env-only")).toBe("e");
    expect(await getApiKey("missing")).toBeUndefined();
  });
});
