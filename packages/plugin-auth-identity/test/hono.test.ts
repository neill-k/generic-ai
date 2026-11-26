import { createHonoPlugin } from "@generic-ai/plugin-hono";
import { type AuthContext, toRunActor } from "@generic-ai/sdk";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  createMemoryAuthStore,
  createOwnerAuth,
  createOwnerAuthenticate,
  createOwnerAuthRoutes,
  requireOwnerAuth,
} from "../src/index.js";
import { createSoftAuthenticator } from "./soft-authenticator.js";

const ORIGIN = "http://localhost:3000";
const FAKE_SETUP_TOKEN = "fake-setup-token-for-tests-only";

function createServer() {
  const auth = createOwnerAuth({
    store: createMemoryAuthStore(),
    publicOrigin: ORIGIN,
    setupToken: FAKE_SETUP_TOKEN,
  });
  const seen: (AuthContext | undefined)[] = [];
  const transport = createHonoPlugin({
    routePrefix: "/starter",
    authenticate: createOwnerAuthenticate(auth),
    run: (payload, context) => {
      seen.push(context.auth);
      return { echo: payload.input };
    },
  });
  const routes = createOwnerAuthRoutes(auth);
  transport.app.route("/", routes.app);
  return { auth, app: transport.app, seen };
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

function client(app: Hono): Fetcher & { cookie: string | undefined } {
  const state = { cookie: undefined as string | undefined };
  const fetcher = (async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (state.cookie !== undefined) {
      headers.set("cookie", state.cookie);
    }
    if ((init.method ?? "GET") !== "GET" && !headers.has("origin")) {
      headers.set("origin", ORIGIN);
    }
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await app.request(`${ORIGIN}${path}`, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie !== null) {
      const pair = setCookie.split(";")[0] ?? "";
      state.cookie = pair.endsWith("=") ? undefined : pair;
    }
    return response;
  }) as Fetcher & { cookie: string | undefined };
  Object.defineProperty(fetcher, "cookie", { get: () => state.cookie });
  return fetcher;
}

async function registerOwner(
  fetcher: Fetcher,
  device = createSoftAuthenticator({ origin: ORIGIN }),
) {
  const options = await fetcher("/auth/passkeys/register/options", {
    method: "POST",
    body: JSON.stringify({ setupToken: FAKE_SETUP_TOKEN }),
  });
  expect(options.status).toBe(200);
  const start = (await options.json()) as {
    challengeId: string;
    options: { challenge: string; user: { id: string } };
  };
  const verify = await fetcher("/auth/passkeys/register/verify", {
    method: "POST",
    body: JSON.stringify({
      setupToken: FAKE_SETUP_TOKEN,
      challengeId: start.challengeId,
      name: "Test device",
      response: device.register(start.options),
    }),
  });
  expect(verify.status).toBe(200);
  return device;
}

describe("owner auth over Hono", () => {
  it("walks setup, session, API tokens, revocation, and logout end to end", async () => {
    const { app, seen } = createServer();
    const browser = client(app);

    const login = await browser("/auth/login");
    expect(login.status).toBe(200);
    expect(login.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(await login.text()).toContain("Create owner passkey");

    expect(await (await browser("/auth/session")).json()).toEqual({
      authenticated: false,
      setupRequired: true,
    });

    // Runs are closed to anonymous callers.
    const anonymous = await browser("/starter/run", {
      method: "POST",
      body: JSON.stringify({ input: "hi" }),
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");

    const badSetup = await browser("/auth/passkeys/register/options", {
      method: "POST",
      body: JSON.stringify({ setupToken: "nope" }),
    });
    expect(badSetup.status).toBe(401);

    const device = await registerOwner(browser);
    expect(browser.cookie).toMatch(/^gai_session=/);

    const session = (await (await browser("/auth/session")).json()) as {
      authenticated: boolean;
      subject: { subjectId: string; scopes: string[] };
    };
    expect(session.authenticated).toBe(true);
    expect(session.subject.subjectId).toBe("owner");

    // The cookie session can run.
    const cookieRun = await browser("/starter/run", {
      method: "POST",
      body: JSON.stringify({ input: "from browser" }),
    });
    expect(cookieRun.status).toBe(200);
    expect(seen.at(-1)?.credentialSource).toBe("cookie");

    // A cross-site POST that carries the cookie is refused.
    const forged = await browser("/starter/run", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ input: "csrf" }),
    });
    expect(forged.status).toBe(401);

    // Create a narrow token and use it from a script.
    const created = await browser("/auth/tokens", {
      method: "POST",
      body: JSON.stringify({ name: "ci", scopes: ["runs:execute"], expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const { token, record } = (await created.json()) as {
      token: string;
      record: { id: string; scopes: string[] };
    };
    expect(record.scopes).toEqual(["runs:execute"]);

    const scripted = await app.request(`${ORIGIN}/starter/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "from script" }),
    });
    expect(scripted.status).toBe(200);
    const actor = seen.at(-1);
    expect(actor === undefined ? undefined : toRunActor(actor)).toEqual({
      subjectId: "owner",
      actorType: "human",
      credentialSource: "bearer",
      displayName: "Owner",
      credentialId: `token:${record.id}`,
    });

    // The narrow token cannot manage tokens.
    const escalate = await app.request(`${ORIGIN}/auth/tokens`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(escalate.status).toBe(403);

    // The token list never exposes secrets.
    const listed = await browser("/auth/tokens");
    expect(await listed.text()).not.toContain(token);

    const revoke = await browser(`/auth/tokens/${record.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    const afterRevoke = await app.request(`${ORIGIN}/starter/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: "revoked" }),
    });
    expect(afterRevoke.status).toBe(401);

    // Log out, then sign back in with the passkey.
    expect((await browser("/auth/logout", { method: "POST" })).status).toBe(200);
    expect(browser.cookie).toBeUndefined();
    expect(
      ((await (await browser("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(false);

    const loginOptions = (await (
      await browser("/auth/passkeys/login/options", { method: "POST" })
    ).json()) as { challengeId: string; options: { challenge: string } };
    const loginVerify = await browser("/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: loginOptions.challengeId,
        response: device.authenticate(loginOptions.options),
      }),
    });
    expect(loginVerify.status).toBe(200);
    expect(browser.cookie).toMatch(/^gai_session=/);
  });

  it("rotates sessions on sign-in and after sensitive changes", async () => {
    const { app } = createServer();
    const laptop = client(app);
    const device = await registerOwner(laptop);
    const firstCookie = laptop.cookie;
    expect(firstCookie).toBeDefined();

    // Signing in again replaces the session the browser already had.
    const options = (await (
      await laptop("/auth/passkeys/login/options", { method: "POST" })
    ).json()) as { challengeId: string; options: { challenge: string } };
    await laptop("/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: options.challengeId,
        response: device.authenticate(options.options),
      }),
    });
    const secondCookie = laptop.cookie;
    expect(secondCookie).not.toBe(firstCookie);
    const stale = await app.request(`${ORIGIN}/auth/session`, {
      headers: { cookie: firstCookie ?? "" },
    });
    expect(((await stale.json()) as { authenticated: boolean }).authenticated).toBe(false);

    // Adding a passkey while signed in also rotates the session.
    const phone = createSoftAuthenticator({ origin: ORIGIN });
    const addStart = (await (
      await laptop("/auth/passkeys/register/options", { method: "POST" })
    ).json()) as { challengeId: string; options: { challenge: string; user: { id: string } } };
    const added = await laptop("/auth/passkeys/register/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: addStart.challengeId,
        name: "Phone",
        response: phone.register(addStart.options),
      }),
    });
    expect(added.status).toBe(200);
    const thirdCookie = laptop.cookie;
    expect(thirdCookie).not.toBe(secondCookie);
    const afterAdd = await app.request(`${ORIGIN}/auth/session`, {
      headers: { cookie: secondCookie ?? "" },
    });
    expect(((await afterAdd.json()) as { authenticated: boolean }).authenticated).toBe(false);

    // A second browser signs in with the phone passkey.
    const tablet = client(app);
    const tabletOptions = (await (
      await tablet("/auth/passkeys/login/options", { method: "POST" })
    ).json()) as { challengeId: string; options: { challenge: string } };
    await tablet("/auth/passkeys/login/verify", {
      method: "POST",
      body: JSON.stringify({
        challengeId: tabletOptions.challengeId,
        response: phone.authenticate(tabletOptions.options),
      }),
    });
    expect(
      ((await (await tablet("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(true);

    // "Sign out other sessions" from the laptop ends the tablet's session and
    // rotates the laptop's own.
    const revoke = await laptop("/auth/sessions/revoke-others", { method: "POST" });
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { revoked: number }).revoked).toBe(1);
    expect(laptop.cookie).not.toBe(thirdCookie);
    expect(
      ((await (await tablet("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(false);
    expect(
      ((await (await laptop("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(true);

    // Removing a passkey rotates the caller's session too.
    const beforeRemove = laptop.cookie;
    const removed = await laptop(`/auth/passkeys/${encodeURIComponent(phone.credentialId)}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(laptop.cookie).not.toBe(beforeRemove);
    expect(
      ((await (await laptop("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(true);
  });

  it("lets a token holder sign out every browser session", async () => {
    const { app, auth } = createServer();
    const browser = client(app);
    await registerOwner(browser);
    const admin = await auth.createApiToken({ name: "admin" });
    const response = await app.request(`${ORIGIN}/auth/sessions/revoke-others`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(((await response.json()) as { revoked: number }).revoked).toBe(1);
    expect(
      ((await (await browser("/auth/session")).json()) as { authenticated: boolean }).authenticated,
    ).toBe(false);
  });

  it("refuses a second passkey from an anonymous caller and cross-origin auth calls", async () => {
    const { app } = createServer();
    const owner = client(app);
    await registerOwner(owner);

    const stranger = client(app);
    const attempt = await stranger("/auth/passkeys/register/options", {
      method: "POST",
      body: JSON.stringify({ setupToken: FAKE_SETUP_TOKEN }),
    });
    expect(attempt.status).toBe(403);

    const crossOrigin = await stranger("/auth/passkeys/login/options", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it("does not let a token grant scopes it does not hold", async () => {
    const { app, auth } = createServer();
    const manager = await auth.createApiToken({
      name: "manager",
      scopes: ["tokens:manage", "runs:read"],
    });
    const response = await app.request(`${ORIGIN}/auth/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${manager.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "wider", scopes: ["runs:execute"] }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("runs:execute");
  });

  it("guards arbitrary routes with requireOwnerAuth", async () => {
    const auth = createOwnerAuth({ store: createMemoryAuthStore(), publicOrigin: ORIGIN });
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("/private/*", requireOwnerAuth(auth, "runs:read"));
    app.get("/private/me", (c) => c.json({ subject: c.get("auth").subject.subjectId }));

    expect((await app.request(`${ORIGIN}/private/me`)).status).toBe(401);
    const reader = await auth.createApiToken({ name: "reader", scopes: ["runs:read"] });
    const ok = await app.request(`${ORIGIN}/private/me`, {
      headers: { authorization: `Bearer ${reader.token}` },
    });
    expect(await ok.json()).toEqual({ subject: "owner" });

    const runner = await auth.createApiToken({ name: "runner", scopes: ["runs:execute"] });
    const denied = await app.request(`${ORIGIN}/private/me`, {
      headers: { authorization: `Bearer ${runner.token}` },
    });
    expect(denied.status).toBe(403);
  });

  it("uses a __Host- secure cookie for https origins", async () => {
    const httpsOrigin = "https://owner.example";
    const auth = createOwnerAuth({
      store: createMemoryAuthStore(),
      publicOrigin: httpsOrigin,
      setupToken: FAKE_SETUP_TOKEN,
    });
    const app = createOwnerAuthRoutes(auth).app;
    const device = createSoftAuthenticator({ origin: httpsOrigin });
    const options = await app.request(`${httpsOrigin}/auth/passkeys/register/options`, {
      method: "POST",
      headers: { origin: httpsOrigin, "content-type": "application/json" },
      body: JSON.stringify({ setupToken: FAKE_SETUP_TOKEN }),
    });
    const start = (await options.json()) as {
      challengeId: string;
      options: { challenge: string; user: { id: string } };
    };
    const verify = await app.request(`${httpsOrigin}/auth/passkeys/register/verify`, {
      method: "POST",
      headers: { origin: httpsOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        setupToken: FAKE_SETUP_TOKEN,
        challengeId: start.challengeId,
        response: device.register(start.options),
      }),
    });
    const cookie = verify.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^__Host-gai_session=/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});
