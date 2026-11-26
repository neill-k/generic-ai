// Adapted from pi (https://github.com/badlogic/pi-mono), packages/ai/src/auth/resolve.ts. MIT License.

import { operationSignal, raceWithAbortSignal } from "./abort.js";
import { AuthError } from "./errors.js";
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  LoginOptions,
  ModelAuth,
  OAuthCredential,
  OAuthProvider,
} from "./types.js";

const DEFAULT_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

export interface CredentialResolverOptions {
  store: CredentialStore;
  /** OAuth sign-in methods by provider id. A stored OAuth credential needs one to be used. */
  oauth?: Readonly<Record<string, OAuthProvider>>;
  /**
   * Consulted only when nothing is stored for the provider, for example `resolveApiKey` from
   * `@generic-ai/ai`, which reads the provider's environment variables.
   */
  fallback?: (providerId: string) => Promise<string | undefined> | string | undefined;
  /** Refresh OAuth tokens with less validity left than this. Default five minutes. */
  minValidityMs?: number;
  /** Upper bound on one refresh call. Default 15 seconds. */
  refreshTimeoutMs?: number;
}

export interface ResolvedAuth {
  auth: ModelAuth;
  /** Where the auth came from: a stored key, a stored OAuth sign-in, or the fallback. */
  source: "api_key" | "oauth" | "fallback";
}

/**
 * Resolve request auth for a provider. A stored credential owns the provider: the fallback is used
 * only when nothing is stored, never after a failed refresh, so a broken sign-in surfaces as an error
 * instead of silently switching accounts.
 */
export function resolveAuth(
  providerId: string,
  options: CredentialResolverOptions,
  signal?: AbortSignal,
): Promise<ResolvedAuth | undefined> {
  const operation = operationSignal(signal);
  return raceWithAbortSignal(resolveAuthWithSignal(providerId, options, operation), operation);
}

async function resolveAuthWithSignal(
  providerId: string,
  options: CredentialResolverOptions,
  signal: AbortSignal,
): Promise<ResolvedAuth | undefined> {
  signal.throwIfAborted();
  let stored: Credential | undefined;
  try {
    stored = await options.store.read(providerId, { signal });
  } catch (error) {
    throw new AuthError("store", `Credential store read failed for ${providerId}`, {
      cause: error,
    });
  }

  if (stored?.type === "api_key") {
    return { auth: { apiKey: stored.key }, source: "api_key" };
  }
  if (stored?.type === "oauth") {
    const oauth = options.oauth?.[providerId];
    if (!oauth) {
      throw new AuthError("oauth", `No OAuth sign-in method is registered for ${providerId}`);
    }
    return resolveStoredOAuth(providerId, oauth, stored, options, signal);
  }

  const key = await options.fallback?.(providerId);
  return key ? { auth: { apiKey: key }, source: "fallback" } : undefined;
}

async function resolveStoredOAuth(
  providerId: string,
  oauth: OAuthProvider,
  stored: OAuthCredential,
  options: CredentialResolverOptions,
  signal: AbortSignal,
): Promise<ResolvedAuth | undefined> {
  const minimumValidityMs = options.minValidityMs ?? DEFAULT_MINIMUM_VALIDITY_MS;
  const expiresSoon = (credential: OAuthCredential) =>
    Date.now() + minimumValidityMs >= credential.expires;
  let credential = stored;
  if (expiresSoon(credential)) {
    // The optimistic check said expired; the authoritative check runs under the store lock.
    const refreshed = await refreshStoredOAuthCredential(
      options.store,
      providerId,
      oauth,
      expiresSoon,
      {
        signal,
        timeoutMs: options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
      },
    );
    if (!refreshed) {
      return undefined; // signed out meanwhile
    }
    credential = refreshed;
  }
  try {
    return { auth: await oauth.toAuth(credential), source: "oauth" };
  } catch (error) {
    throw new AuthError("oauth", `OAuth auth derivation failed for ${providerId}`, {
      cause: error,
    });
  }
}

/**
 * Refresh a stored OAuth credential under the store lock and persist the result before the lock is
 * released. `needsRefresh` is re-checked under the lock, so concurrent callers and processes refresh
 * only once.
 *
 * `signal` cancels only the wait for the lock. Once a refresh starts the provider may already have
 * rotated the refresh token, so the refresh and its persistence ignore `signal` and are bounded only by
 * `timeoutMs`; otherwise a cancelled caller could throw away the only valid refresh token.
 *
 * Resolves with the stored OAuth credential afterwards, or `undefined` when the provider no longer
 * has one.
 */
export async function refreshStoredOAuthCredential(
  store: CredentialStore,
  providerId: string,
  oauth: OAuthProvider,
  needsRefresh: (credential: OAuthCredential) => boolean,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<OAuthCredential | undefined> {
  const signal = operationSignal(options.signal);
  const lockWait = new AbortController();
  const cancelLockWait = () => lockWait.abort(signal.reason);
  signal.addEventListener("abort", cancelLockWait, { once: true });
  if (signal.aborted) {
    cancelLockWait();
  }
  let post: Credential | undefined;
  try {
    post = await store.modify(
      providerId,
      async (current) => {
        signal.removeEventListener("abort", cancelLockWait);
        signal.throwIfAborted();
        if (current?.type !== "oauth") {
          return undefined; // signed out meanwhile
        }
        if (!needsRefresh(current)) {
          return undefined; // another request or process refreshed it
        }
        try {
          const refreshed = await oauth.refresh(
            current,
            AbortSignal.timeout(options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS),
          );
          return { ...refreshed, type: "oauth" };
        } catch (error) {
          throw new AuthError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
        }
      },
      { signal: lockWait.signal },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    signal.throwIfAborted();
    throw new AuthError("store", `Credential store write failed for ${providerId}`, {
      cause: error,
    });
  } finally {
    signal.removeEventListener("abort", cancelLockWait);
  }
  return post?.type === "oauth" ? post : undefined;
}

/**
 * Build a `getApiKey` callback for `@generic-ai/agent` (`AgentOptions.getApiKey`) and the native
 * session. Each call resolves auth fresh, so tokens are refreshed before every model request that
 * needs it.
 */
export function createApiKeyResolver(
  options: CredentialResolverOptions,
): (providerId: string) => Promise<string | undefined> {
  return async (providerId) => (await resolveAuth(providerId, options))?.auth.apiKey;
}

/** Run an OAuth sign-in and store the credential it produces. */
export async function login(
  store: CredentialStore,
  providerId: string,
  oauth: OAuthProvider,
  interaction: AuthInteraction,
  options?: LoginOptions,
): Promise<OAuthCredential> {
  const signal = operationSignal(interaction.signal);
  signal.throwIfAborted();
  let credential: OAuthCredential;
  try {
    credential = await oauth.login({ ...interaction, signal }, options);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new AuthError("login", `${oauth.name} sign-in failed`, { cause: error });
  }
  await store.modify(providerId, async () => credential);
  return credential;
}

/** Store an API key for a provider. */
export async function saveApiKey(
  store: CredentialStore,
  providerId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new AuthError("login", "API key is empty");
  }
  await store.modify(providerId, async () => ({ type: "api_key", key: trimmed }));
}

/** Remove a provider's stored credential. */
export function logout(store: CredentialStore, providerId: string): Promise<void> {
  return store.delete(providerId);
}
