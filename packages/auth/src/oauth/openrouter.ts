// Adapted from pi (https://github.com/badlogic/pi-mono), packages/ai/src/auth/oauth/openrouter.ts. MIT License.

/**
 * OpenRouter sign-in through its OAuth PKCE flow for third-party apps
 * (https://openrouter.ai/docs/use-cases/oauth-pkce).
 *
 * OpenRouter exchanges the authorization code for a permanent, user-controlled API key rather than
 * an expiring access and refresh token pair. The callback lands on a one-shot loopback server on a
 * free port, raced against a prompt where the user can paste the redirect URL when the browser
 * cannot reach the loopback server (for example over SSH).
 */

import type { OAuthCredential, OAuthProvider, ProviderAuthInteraction } from "../types.js";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.js";
import { generatePKCE } from "./pkce.js";

const AUTHORIZE_URL = "https://openrouter.ai/auth";
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/** Environment variable that overrides the loopback callback host (default `127.0.0.1`). */
export const OAUTH_CALLBACK_HOST_ENV = "GENERIC_AI_OAUTH_CALLBACK_HOST";

export interface OpenRouterOAuthOptions {
  /** HTTP client for the key exchange. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Loopback host for the callback server. Defaults to `GENERIC_AI_OAUTH_CALLBACK_HOST` or `127.0.0.1`. */
  callbackHost?: string;
}

interface JsonObject {
  key?: unknown;
  error?: unknown;
  error_description?: unknown;
  message?: unknown;
}

function parseAuthorizationInput(input: string): string | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }
  if (URL.canParse(value)) {
    return new URL(value).searchParams.get("code") ?? undefined;
  }
  if (value.includes("code=")) {
    return new URLSearchParams(value).get("code") ?? undefined;
  }
  return value;
}

function errorDetail(body: JsonObject): string | undefined {
  if (typeof body.error_description === "string") return body.error_description;
  if (typeof body.message === "string") return body.message;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
    const message = (body.error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  code: string,
  verifier: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  if (signal.aborted) throw new Error("Login cancelled");
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("OpenRouter OAuth token exchange timed out")),
    TOKEN_EXCHANGE_TIMEOUT_MS,
  );

  let response: Response;
  let body: JsonObject = {};
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
      signal: controller.signal,
    });
    try {
      const parsed = (await response.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        body = parsed as JsonObject;
    } catch {
      if (response.ok) throw new Error("OpenRouter OAuth returned invalid JSON");
    }
  } catch (error) {
    if (signal.aborted) throw new Error("Login cancelled");
    if (controller.signal.aborted) throw new Error("OpenRouter OAuth token exchange timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }

  if (!response.ok) {
    const detail = errorDetail(body);
    throw new Error(
      `OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (typeof body.key !== "string" || body.key.length === 0) {
    throw new Error('OpenRouter OAuth response carries no "key"');
  }
  return { type: "oauth", access: body.key, refresh: "", expires: Number.MAX_SAFE_INTEGER };
}

/** Create the OpenRouter sign-in method. */
export function createOpenRouterOAuth(options: OpenRouterOAuthOptions = {}): OAuthProvider {
  const login = async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const { verifier, challenge } = await generatePKCE();
    // OpenRouter sends no `state`; the random path keeps stray requests from completing the sign-in.
    const callback = await startOAuthCallbackServer({
      providerName: "OpenRouter",
      host: options.callbackHost ?? (process.env[OAUTH_CALLBACK_HOST_ENV] || "127.0.0.1"),
      port: 0,
      path: `/oauth/callback/${crypto.randomUUID()}`,
      complete: (code) => exchangeAuthorizationCode(fetchImpl, code, verifier, interaction.signal),
      signal: interaction.signal,
      timeoutMs: LOGIN_TIMEOUT_MS,
    });

    try {
      const authorizeUrl = new URL(AUTHORIZE_URL);
      authorizeUrl.search = new URLSearchParams({
        callback_url: callback.redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      interaction.notify({
        type: "progress",
        message: `Listening for the OpenRouter callback on ${callback.redirectUri}`,
      });
      interaction.notify({
        type: "auth_url",
        url: authorizeUrl.toString(),
        instructions:
          "Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
      });

      const result = await waitForCallbackOrManualInput(interaction, callback, {
        message:
          "Complete sign-in in your browser, or paste the authorization code or redirect URL here:",
        placeholder: callback.redirectUri,
      });
      if (result.type === "callback") return result.value;
      const code = parseAuthorizationInput(result.input);
      if (!code) throw new Error("Missing authorization code");
      interaction.notify({
        type: "progress",
        message: "Exchanging the authorization code for an API key...",
      });
      return await exchangeAuthorizationCode(fetchImpl, code, verifier, interaction.signal);
    } finally {
      callback.close();
    }
  };

  return {
    name: "OpenRouter",
    loginLabel: "Sign in with OpenRouter",
    login,
    // The key is permanent; there is nothing to refresh.
    async refresh(credential) {
      return credential;
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}

/** OpenRouter sign-in using the global `fetch`. */
export const openRouterOAuth: OAuthProvider = createOpenRouterOAuth();
