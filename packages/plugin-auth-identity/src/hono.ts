import { randomBytes } from "node:crypto";

import { type AuthContext, AUTH_SCOPES, hasAuthScope } from "@generic-ai/sdk";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { renderOwnerAuthPage } from "./login-page.js";
import { type OwnerAuth, OwnerAuthError } from "./owner-auth.js";

const DEFAULT_ROUTE_PREFIX = "/auth";
const DEFAULT_COOKIE_NAME = "gai_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_AUTH_BODY_BYTES = 64 * 1024;

export interface OwnerAuthHttpOptions {
  /** Where the auth routes are mounted. Defaults to `/auth`. */
  readonly routePrefix?: string;
  /**
   * Base session cookie name. When cookies are secure the `__Host-` prefix is
   * added, which pins the cookie to this host and path `/`.
   */
  readonly cookieName?: string;
  /**
   * Whether to mark the session cookie `Secure`. `auto` (the default) does so
   * when the expected origin is https.
   */
  readonly secureCookies?: boolean | "auto";
  /** Where the login page sends the owner after signing in. Defaults to `/`. */
  readonly afterLoginPath?: string;
  /** Page title shown on the login page. */
  readonly appName?: string;
}

interface ResolvedHttpOptions {
  readonly routePrefix: string;
  readonly cookieName: string;
  readonly secureCookies: boolean | "auto";
  readonly afterLoginPath: string;
  readonly appName: string;
}

function normalizeRoutePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? DEFAULT_ROUTE_PREFIX).trim();
  if (trimmed.length === 0 || trimmed === "/") {
    return "";
  }
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading.slice(0, -1) : leading;
}

function resolveHttpOptions(options: OwnerAuthHttpOptions = {}): ResolvedHttpOptions {
  const afterLoginPath = options.afterLoginPath ?? "/";
  if (!afterLoginPath.startsWith("/") || afterLoginPath.startsWith("//")) {
    throw new Error("afterLoginPath must be a same-origin absolute path.");
  }
  return {
    routePrefix: normalizeRoutePrefix(options.routePrefix),
    cookieName: options.cookieName ?? DEFAULT_COOKIE_NAME,
    secureCookies: options.secureCookies ?? "auto",
    afterLoginPath,
    appName: options.appName ?? "Generic AI",
  };
}

function isSecure(auth: OwnerAuth, request: Request, options: ResolvedHttpOptions): boolean {
  if (options.secureCookies !== "auto") {
    return options.secureCookies;
  }
  return auth.resolveOrigin(request).origin.startsWith("https:");
}

function cookieNameFor(auth: OwnerAuth, request: Request, options: ResolvedHttpOptions): string {
  return isSecure(auth, request, options) ? `__Host-${options.cookieName}` : options.cookieName;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value.length === 0 ? undefined : value;
    }
  }
  return undefined;
}

/**
 * Cookie-authenticated requests that change state must come from the app's
 * own origin. Browsers always send `Origin` on cross-site POSTs, so a missing
 * or foreign origin is treated as a forged request.
 */
function isSameOriginRequest(auth: OwnerAuth, request: Request): boolean {
  const expected = auth.resolveOrigin(request).origin;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return origin === expected;
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function readBearer(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) {
      return match[1].trim();
    }
  }
  const legacy = request.headers.get("x-generic-ai-token");
  return legacy === null || legacy.trim().length === 0 ? undefined : legacy.trim();
}

/**
 * Authenticates a request against the owner auth service. Bearer credentials
 * win over the session cookie. Returns `undefined` for anonymous or invalid
 * credentials. A presented-but-invalid bearer token never falls back to the
 * cookie.
 */
export async function authenticateOwnerRequest(
  auth: OwnerAuth,
  request: Request,
  options: OwnerAuthHttpOptions = {},
): Promise<AuthContext | undefined> {
  const bearer = readBearer(request);
  if (bearer !== undefined) {
    return auth.authenticateBearer(bearer);
  }

  const resolved = resolveHttpOptions(options);
  const cookieHeader = request.headers.get("cookie");
  const secret =
    readCookie(cookieHeader, `__Host-${resolved.cookieName}`) ??
    readCookie(cookieHeader, resolved.cookieName);
  if (secret === undefined) {
    return undefined;
  }

  if (!SAFE_METHODS.has(request.method.toUpperCase()) && !isSameOriginRequest(auth, request)) {
    return undefined;
  }

  return auth.authenticateSession(secret);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function unauthorizedResponse(message = "Authentication required."): Response {
  return jsonResponse(401, { error: message }, { "www-authenticate": 'Bearer realm="generic-ai"' });
}

export function forbiddenResponse(scope: string): Response {
  return jsonResponse(403, { error: `Missing required scope: ${scope}.` });
}

export type OwnerAuthenticateResult =
  | { readonly ok: true; readonly auth: AuthContext }
  | { readonly ok: false; readonly response: Response };

export interface OwnerAuthenticateOptions extends OwnerAuthHttpOptions {
  /**
   * Scope required per transport mode. Defaults to `runs:execute` for `sync`
   * and `stream`, and `runs:read` for anything else.
   */
  readonly requiredScopes?: Readonly<Record<string, string>>;
}

/**
 * Builds an `authenticate` handler for `@generic-ai/plugin-hono`. It is
 * structurally typed so this package does not depend on the transport.
 */
export function createOwnerAuthenticate(
  auth: OwnerAuth,
  options: OwnerAuthenticateOptions = {},
): (context: {
  readonly request: Request;
  readonly mode: string;
}) => Promise<OwnerAuthenticateResult> {
  const requiredScopes: Readonly<Record<string, string>> = {
    sync: AUTH_SCOPES.runsExecute,
    stream: AUTH_SCOPES.runsExecute,
    ...options.requiredScopes,
  };

  return async ({ request, mode }) => {
    const context = await authenticateOwnerRequest(auth, request, options);
    if (context === undefined) {
      return { ok: false, response: unauthorizedResponse() };
    }
    const scope = requiredScopes[mode] ?? AUTH_SCOPES.runsRead;
    if (!hasAuthScope(context, scope)) {
      return { ok: false, response: forbiddenResponse(scope) };
    }
    return { ok: true, auth: context };
  };
}

export interface OwnerAuthVariables {
  auth: AuthContext;
}

/**
 * Hono middleware that requires an authenticated owner holding `scope` and
 * exposes the normalized context as `c.get("auth")`.
 */
export function requireOwnerAuth(
  auth: OwnerAuth,
  scope: string = AUTH_SCOPES.runsRead,
  options: OwnerAuthHttpOptions = {},
): MiddlewareHandler<{ Variables: OwnerAuthVariables }> {
  return async (c, next) => {
    const context = await authenticateOwnerRequest(auth, c.req.raw, options);
    if (context === undefined) {
      return unauthorizedResponse();
    }
    if (!hasAuthScope(context, scope)) {
      return forbiddenResponse(scope);
    }
    c.set("auth", context);
    await next();
    return undefined;
  };
}

function errorStatus(error: OwnerAuthError): 400 | 401 | 403 | 404 | 409 {
  switch (error.code) {
    case "SETUP_TOKEN_INVALID":
    case "PASSKEY_UNKNOWN":
    case "PASSKEY_VERIFICATION_FAILED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "SETUP_REQUIRED":
    case "LAST_PASSKEY":
      return 409;
    default:
      return 400;
  }
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OwnerAuthError("INVALID_INPUT", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OwnerAuthError("INVALID_INPUT", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readSetupToken(c: Context, body: Record<string, unknown>): string | undefined {
  return optionalString(body["setupToken"]) ?? c.req.header("x-generic-ai-setup-token");
}

export interface OwnerAuthRoutes {
  readonly app: Hono;
  readonly routePrefix: string;
  /** Path of the HTML login page. */
  readonly loginPath: string;
}

/**
 * Mounts the owner auth HTTP surface:
 *
 * - `GET  {prefix}/login` login, first-time setup, and token management page
 * - `GET  {prefix}/session` current sign-in state (no secrets)
 * - `POST {prefix}/passkeys/register/options|verify` add a passkey
 * - `POST {prefix}/passkeys/login/options|verify` sign in with a passkey
 * - `POST {prefix}/logout`
 * - `GET|DELETE {prefix}/passkeys[/:id]` list or remove passkeys
 * - `GET|POST|DELETE {prefix}/tokens[/:id]` list, create, revoke API tokens
 */
export function createOwnerAuthRoutes(
  auth: OwnerAuth,
  options: OwnerAuthHttpOptions = {},
): OwnerAuthRoutes {
  const resolved = resolveHttpOptions(options);
  const prefix = resolved.routePrefix;
  const app = new Hono();

  app.use(
    `${prefix}/*`,
    bodyLimit({
      maxSize: MAX_AUTH_BODY_BYTES,
      onError: () => jsonResponse(413, { error: "Request body too large." }),
    }),
  );

  app.onError((error) => {
    if (error instanceof OwnerAuthError) {
      return jsonResponse(errorStatus(error), { error: error.message, code: error.code });
    }
    throw error;
  });

  const authenticated = (request: Request) => authenticateOwnerRequest(auth, request, resolved);

  const requireScope = async (c: Context, scope: string) => {
    const context = await authenticated(c.req.raw);
    if (context === undefined) {
      return { response: unauthorizedResponse() } as const;
    }
    if (!hasAuthScope(context, scope)) {
      return { response: forbiddenResponse(scope) } as const;
    }
    return { context } as const;
  };

  const requireSameOrigin = (c: Context): Response | undefined =>
    isSameOriginRequest(auth, c.req.raw)
      ? undefined
      : jsonResponse(403, { error: "Cross-origin auth requests are not allowed." });

  const issueSessionCookie = (c: Context, secret: string, expiresAt: string) => {
    const secure = isSecure(auth, c.req.raw, resolved);
    setCookie(c, cookieNameFor(auth, c.req.raw, resolved), secret, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Lax",
      expires: new Date(expiresAt),
    });
  };

  app.get(`${prefix}/login`, (c) => {
    const nonce = randomBytes(16).toString("base64");
    const html = renderOwnerAuthPage({
      appName: resolved.appName,
      routePrefix: prefix,
      afterLoginPath: resolved.afterLoginPath,
      nonce,
    });
    return c.html(html, 200, {
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  app.get(`${prefix}/session`, async (c) => {
    const [status, context] = await Promise.all([auth.status(), authenticated(c.req.raw)]);
    return jsonResponse(200, {
      authenticated: context !== undefined,
      setupRequired: status.setupRequired,
      ...(context === undefined
        ? {}
        : {
            subject: {
              subjectId: context.subject.subjectId,
              displayName: context.subject.displayName,
              scopes: context.subject.scopes,
            },
            credentialSource: context.credentialSource,
          }),
    });
  });

  app.post(`${prefix}/passkeys/register/options`, async (c) => {
    const blocked = requireSameOrigin(c);
    if (blocked !== undefined) {
      return blocked;
    }
    const body = await readJson(c);
    const context = await authenticated(c.req.raw);
    const setupToken = readSetupToken(c, body);
    const started = await auth.startPasskeyRegistration({
      request: c.req.raw,
      ...(context === undefined ? {} : { auth: context }),
      ...(setupToken === undefined ? {} : { setupToken }),
    });
    return jsonResponse(200, started);
  });

  app.post(`${prefix}/passkeys/register/verify`, async (c) => {
    const blocked = requireSameOrigin(c);
    if (blocked !== undefined) {
      return blocked;
    }
    const body = await readJson(c);
    const context = await authenticated(c.req.raw);
    const setupToken = readSetupToken(c, body);
    const name = optionalString(body["name"]);
    const result = await auth.finishPasskeyRegistration({
      request: c.req.raw,
      ...(context === undefined ? {} : { auth: context }),
      ...(setupToken === undefined ? {} : { setupToken }),
      challengeId: optionalString(body["challengeId"]) ?? "",
      response: body["response"] as Parameters<
        OwnerAuth["finishPasskeyRegistration"]
      >[0]["response"],
      ...(name === undefined ? {} : { name }),
    });
    issueSessionCookie(c, result.session.secret, result.session.expiresAt);
    return c.json({ passkey: result.passkey, expiresAt: result.session.expiresAt }, 200, {
      "cache-control": "no-store",
    });
  });

  app.post(`${prefix}/passkeys/login/options`, async (c) => {
    const blocked = requireSameOrigin(c);
    if (blocked !== undefined) {
      return blocked;
    }
    return jsonResponse(200, await auth.startPasskeyAuthentication({ request: c.req.raw }));
  });

  app.post(`${prefix}/passkeys/login/verify`, async (c) => {
    const blocked = requireSameOrigin(c);
    if (blocked !== undefined) {
      return blocked;
    }
    const body = await readJson(c);
    const session = await auth.finishPasskeyAuthentication({
      request: c.req.raw,
      challengeId: optionalString(body["challengeId"]) ?? "",
      response: body["response"] as Parameters<
        OwnerAuth["finishPasskeyAuthentication"]
      >[0]["response"],
    });
    issueSessionCookie(c, session.secret, session.expiresAt);
    return c.json({ expiresAt: session.expiresAt }, 200, { "cache-control": "no-store" });
  });

  app.post(`${prefix}/logout`, async (c) => {
    const blocked = requireSameOrigin(c);
    if (blocked !== undefined) {
      return blocked;
    }
    for (const name of [`__Host-${resolved.cookieName}`, resolved.cookieName]) {
      const secret = getCookie(c, name);
      if (secret !== undefined) {
        await auth.revokeSession(secret);
        deleteCookie(c, name, {
          path: "/",
          ...(name.startsWith("__Host-") ? { secure: true } : {}),
        });
      }
    }
    return c.json({ ok: true }, 200, { "cache-control": "no-store" });
  });

  app.get(`${prefix}/passkeys`, async (c) => {
    const gate = await requireScope(c, AUTH_SCOPES.tokensManage);
    if ("response" in gate) {
      return gate.response;
    }
    return jsonResponse(200, { passkeys: await auth.listPasskeys() });
  });

  app.delete(`${prefix}/passkeys/:id`, async (c) => {
    const gate = await requireScope(c, AUTH_SCOPES.tokensManage);
    if ("response" in gate) {
      return gate.response;
    }
    await auth.removePasskey(c.req.param("id"));
    return jsonResponse(200, { ok: true });
  });

  app.get(`${prefix}/tokens`, async (c) => {
    const gate = await requireScope(c, AUTH_SCOPES.tokensManage);
    if ("response" in gate) {
      return gate.response;
    }
    return jsonResponse(200, { tokens: await auth.listApiTokens() });
  });

  app.post(`${prefix}/tokens`, async (c) => {
    const gate = await requireScope(c, AUTH_SCOPES.tokensManage);
    if ("response" in gate) {
      return gate.response;
    }
    const body = await readJson(c);
    const callerScopes = gate.context.subject.scopes;
    const requested = body["scopes"];
    if (
      requested !== undefined &&
      (!Array.isArray(requested) || requested.some((scope) => typeof scope !== "string"))
    ) {
      throw new OwnerAuthError("INVALID_INPUT", "scopes must be an array of strings.");
    }
    const scopes = (requested as string[] | undefined) ?? [...callerScopes];
    const escalated = scopes.filter((scope) => !callerScopes.includes(scope));
    if (escalated.length > 0) {
      return jsonResponse(403, {
        error: `Cannot grant scopes the caller does not hold: ${escalated.join(", ")}.`,
      });
    }
    const expiresInDays = body["expiresInDays"];
    if (expiresInDays !== undefined && typeof expiresInDays !== "number") {
      throw new OwnerAuthError("INVALID_INPUT", "expiresInDays must be a number.");
    }
    const created = await auth.createApiToken({
      name: optionalString(body["name"]) ?? "",
      scopes,
      ...(expiresInDays === undefined ? {} : { expiresInDays }),
    });
    return jsonResponse(201, created);
  });

  app.delete(`${prefix}/tokens/:id`, async (c) => {
    const gate = await requireScope(c, AUTH_SCOPES.tokensManage);
    if ("response" in gate) {
      return gate.response;
    }
    return jsonResponse(200, { token: await auth.revokeApiToken(c.req.param("id")) });
  });

  return Object.freeze({ app, routePrefix: prefix, loginPath: `${prefix}/login` });
}
