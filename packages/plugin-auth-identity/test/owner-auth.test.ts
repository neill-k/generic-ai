import type { StorageContract, StorageRecord } from "@generic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  createMemoryAuthStore,
  createOwnerAuth,
  createStorageContractAuthStore,
  OwnerAuthError,
  parseApiToken,
} from "../src/index.js";
import { createSoftAuthenticator } from "./soft-authenticator.js";

const ORIGIN = "http://localhost:3000";
const FAKE_SETUP_TOKEN = "fake-setup-token-for-tests-only";
const FAKE_STATIC_TOKEN = "fake-static-token-for-tests-only";

function request(path = "/auth/login"): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST" });
}

describe("createOwnerAuth API tokens", () => {
  it("creates a token, authenticates it, and stores only a hash", async () => {
    const store = createMemoryAuthStore();
    const auth = createOwnerAuth({ store, publicOrigin: ORIGIN });

    const created = await auth.createApiToken({ name: "ci", scopes: ["runs:execute"] });
    expect(created.token).toMatch(/^gai_[0-9a-f]{16}_/);
    expect(parseApiToken(created.token)?.id).toBe(created.record.id);

    const stored = await store.get("tokens", created.record.id);
    expect(JSON.stringify(stored)).not.toContain(parseApiToken(created.token)?.secret);

    const context = await auth.authenticateBearer(created.token);
    expect(context?.subject.subjectId).toBe("owner");
    expect(context?.subject.scopes).toEqual(["runs:execute"]);
    expect(context?.credentialSource).toBe("bearer");
    expect(context?.credentialId).toBe(`token:${created.record.id}`);
    expect(JSON.stringify(context)).not.toContain(created.token);

    const listed = await auth.listApiTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastUsedAt).toBeDefined();
  });

  it("rejects a tampered, revoked, or expired token", async () => {
    let clock = new Date("2026-11-26T00:00:00.000Z");
    const auth = createOwnerAuth({ store: createMemoryAuthStore(), now: () => clock });

    const created = await auth.createApiToken({ name: "short", expiresInDays: 1 });
    expect(await auth.authenticateBearer(`${created.token}x`)).toBeUndefined();
    expect(await auth.authenticateBearer(created.token)).toBeDefined();

    clock = new Date("2026-11-27T00:00:01.000Z");
    expect(await auth.authenticateBearer(created.token)).toBeUndefined();

    const other = await auth.createApiToken({ name: "revoke-me" });
    expect(await auth.authenticateBearer(other.token)).toBeDefined();
    const revoked = await auth.revokeApiToken(other.record.id);
    expect(revoked.revokedAt).toBeDefined();
    expect(await auth.authenticateBearer(other.token)).toBeUndefined();
  });

  it("validates token input", async () => {
    const auth = createOwnerAuth({ store: createMemoryAuthStore() });
    await expect(auth.createApiToken({ name: "" })).rejects.toBeInstanceOf(OwnerAuthError);
    await expect(auth.createApiToken({ name: "x", scopes: [] })).rejects.toThrow(/scope/);
    await expect(auth.createApiToken({ name: "x", scopes: ["Bad Scope"] })).rejects.toThrow(
      /Invalid scope/,
    );
    await expect(auth.createApiToken({ name: "x", expiresInDays: -1 })).rejects.toThrow(
      /expiresInDays/,
    );
    await expect(auth.revokeApiToken("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("accepts configured static tokens with their scopes", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      staticTokens: [{ id: "env:TEST", token: FAKE_STATIC_TOKEN, scopes: ["runs:read"] }],
    });
    const context = await auth.authenticateBearer(FAKE_STATIC_TOKEN);
    expect(context?.credentialId).toBe("env:TEST");
    expect(context?.subject.scopes).toEqual(["runs:read"]);
    expect(await auth.authenticateBearer("wrong-static-token-value")).toBeUndefined();
    expect(() =>
      createOwnerAuth({
        store: createMemoryAuthStore(),
        staticTokens: [{ id: "x", token: "short" }],
      }),
    ).toThrow(/at least 16/);
  });
});

describe("createOwnerAuth passkeys and sessions", () => {
  it("requires the setup token for the first passkey, then signs in", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: FAKE_SETUP_TOKEN,
    });
    const device = createSoftAuthenticator({ origin: ORIGIN });
    expect(await auth.status()).toEqual({ setupRequired: true, passkeyCount: 0 });

    await expect(
      auth.startPasskeyRegistration({ request: request(), setupToken: "wrong" }),
    ).rejects.toMatchObject({ code: "SETUP_TOKEN_INVALID" });

    const start = await auth.startPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
    });
    expect(start.options.rp.id).toBe("localhost");
    const registered = await auth.finishPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
      challengeId: start.challengeId,
      response: device.register(start.options),
      name: "Laptop",
    });
    expect(registered.passkey.name).toBe("Laptop");
    expect(await auth.status()).toEqual({ setupRequired: false, passkeyCount: 1 });

    const fromRegistration = await auth.authenticateSession(registered.session.secret);
    expect(fromRegistration?.credentialSource).toBe("cookie");
    expect(fromRegistration?.subject.scopes).toContain("tokens:manage");

    // The setup token no longer works once a passkey exists.
    await expect(
      auth.startPasskeyRegistration({ request: request(), setupToken: FAKE_SETUP_TOKEN }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const login = await auth.startPasskeyAuthentication({ request: request() });
    const assertion = device.authenticate(login.options);
    const session = await auth.finishPasskeyAuthentication({
      request: request(),
      challengeId: login.challengeId,
      response: assertion,
    });
    expect(await auth.authenticateSession(session.secret)).toBeDefined();

    // A challenge can only be used once.
    await expect(
      auth.finishPasskeyAuthentication({
        request: request(),
        challengeId: login.challengeId,
        response: assertion,
      }),
    ).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });

    await auth.revokeSession(session.secret);
    expect(await auth.authenticateSession(session.secret)).toBeUndefined();
  });

  it("rejects an assertion from the wrong origin or an unknown passkey", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: FAKE_SETUP_TOKEN,
    });
    const device = createSoftAuthenticator({ origin: ORIGIN });
    const start = await auth.startPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
    });
    await auth.finishPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
      challengeId: start.challengeId,
      response: device.register(start.options),
    });

    const login = await auth.startPasskeyAuthentication({ request: request() });
    await expect(
      auth.finishPasskeyAuthentication({
        request: request(),
        challengeId: login.challengeId,
        response: device.authenticate(login.options, "https://evil.example"),
      }),
    ).rejects.toMatchObject({ code: "PASSKEY_VERIFICATION_FAILED" });

    const stranger = createSoftAuthenticator({ origin: ORIGIN });
    const second = await auth.startPasskeyAuthentication({ request: request() });
    await expect(
      auth.finishPasskeyAuthentication({
        request: request(),
        challengeId: second.challengeId,
        response: stranger.authenticate(second.options),
      }),
    ).rejects.toMatchObject({ code: "PASSKEY_UNKNOWN" });
  });

  it("requires user verification", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: FAKE_SETUP_TOKEN,
    });
    const device = createSoftAuthenticator({ origin: ORIGIN, userVerified: false });
    const start = await auth.startPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
    });
    await expect(
      auth.finishPasskeyRegistration({
        request: request(),
        setupToken: FAKE_SETUP_TOKEN,
        challengeId: start.challengeId,
        response: device.register(start.options),
      }),
    ).rejects.toMatchObject({ code: "PASSKEY_VERIFICATION_FAILED" });
  });

  it("refuses to remove the last passkey and drops sessions of removed passkeys", async () => {
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: FAKE_SETUP_TOKEN,
    });
    const first = createSoftAuthenticator({ origin: ORIGIN });
    const start = await auth.startPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
    });
    const registered = await auth.finishPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
      challengeId: start.challengeId,
      response: first.register(start.options),
    });
    const owner = await auth.authenticateSession(registered.session.secret);
    expect(owner).toBeDefined();

    await expect(auth.removePasskey(first.credentialId)).rejects.toMatchObject({
      code: "LAST_PASSKEY",
    });

    const second = createSoftAuthenticator({ origin: ORIGIN });
    const addStart = await auth.startPasskeyRegistration({
      request: request(),
      ...(owner === undefined ? {} : { auth: owner }),
    });
    expect(addStart.options.excludeCredentials?.map((entry) => entry.id)).toEqual([
      first.credentialId,
    ]);
    await auth.finishPasskeyRegistration({
      request: request(),
      ...(owner === undefined ? {} : { auth: owner }),
      challengeId: addStart.challengeId,
      response: second.register(addStart.options),
    });
    expect(await auth.listPasskeys()).toHaveLength(2);

    await auth.removePasskey(first.credentialId);
    expect(await auth.authenticateSession(registered.session.secret)).toBeUndefined();
  });

  it("expires sessions", async () => {
    let clock = new Date("2026-11-26T00:00:00.000Z");
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: ORIGIN,
      setupToken: FAKE_SETUP_TOKEN,
      sessionTtlMs: 60_000,
      now: () => clock,
    });
    const device = createSoftAuthenticator({ origin: ORIGIN });
    const start = await auth.startPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
    });
    const { session } = await auth.finishPasskeyRegistration({
      request: request(),
      setupToken: FAKE_SETUP_TOKEN,
      challengeId: start.challengeId,
      response: device.register(start.options),
    });
    expect(await auth.authenticateSession(session.secret)).toBeDefined();
    clock = new Date("2026-11-26T00:01:01.000Z");
    expect(await auth.authenticateSession(session.secret)).toBeUndefined();
  });

  it("refuses registration when no setup token is configured", async () => {
    const auth = createOwnerAuth({ store: createMemoryAuthStore(), publicOrigin: ORIGIN });
    await expect(auth.startPasskeyRegistration({ request: request() })).rejects.toMatchObject({
      code: "SETUP_REQUIRED",
    });
  });
});

describe("createStorageContractAuthStore", () => {
  it("persists auth records through an SDK storage contract", async () => {
    const records = new Map<string, StorageRecord>();
    const keyOf = (key: { namespace: string; collection: string; id: string }) =>
      `${key.namespace}/${key.collection}/${key.id}`;
    const storage: StorageContract = {
      kind: "storage",
      driver: "test",
      get: (key) => records.get(keyOf(key)) as never,
      set: (record) => {
        records.set(keyOf(record.key), record);
      },
      delete: (key) => records.delete(keyOf(key)),
      list: (filter) =>
        [...records.values()].filter(
          (record) =>
            record.key.namespace === filter?.namespace &&
            record.key.collection === filter?.collection,
        ),
      clear: () => records.clear(),
    };

    const auth = createOwnerAuth({ store: createStorageContractAuthStore(storage) });
    const created = await auth.createApiToken({ name: "kv" });
    expect([...records.keys()]).toEqual([`generic-ai.auth/tokens/${created.record.id}`]);

    const reopened = createOwnerAuth({ store: createStorageContractAuthStore(storage) });
    expect(await reopened.authenticateBearer(created.token)).toBeDefined();
  });
});
