// Adapted from pi (https://github.com/badlogic/pi-mono), packages/ai/src/auth/types.ts. MIT License.

/** Stored API key credential. */
export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

/** Token data produced by an OAuth sign-in. Providers may add their own fields. */
export interface OAuthCredentials {
  /** Refresh token; empty when the provider issues a permanent credential. */
  refresh: string;
  access: string;
  /** Expiry in epoch milliseconds. `Number.MAX_SAFE_INTEGER` for credentials that never expire. */
  expires: number;
  [key: string]: unknown;
}

/** Stored OAuth credential. */
export interface OAuthCredential extends OAuthCredentials {
  type: "oauth";
}

/** One type-tagged credential per provider id. */
export type Credential = ApiKeyCredential | OAuthCredential;

/** Non-secret credential metadata for status listings. */
export interface CredentialInfo {
  providerId: string;
  type: Credential["type"];
}

/** Optional cancellation for credential operations. */
export interface AuthOperationOptions {
  signal?: AbortSignal;
}

/**
 * App-owned credential storage keyed by provider id, one credential per provider.
 *
 * `modify` is the only write path, so every change is a serialized read-modify-write. Token refresh
 * runs inside `modify`, which stops concurrent requests (and, for stores that lock across processes,
 * concurrent processes) from refreshing a rotated token twice.
 *
 * `read` resolves `undefined` for a missing entry. Methods reject only when storage fails.
 */
export interface CredentialStore {
  /** Read the stored credential, possibly expired. */
  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;
  /** List stored credential metadata without exposing secrets. */
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;
  /**
   * Serialized write. `fn` sees the current credential and returns the new one, or `undefined` to
   * leave the entry unchanged. Resolves with the credential stored afterwards. Rejections from `fn`
   * propagate and leave the entry unchanged.
   */
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined>;
  /** Remove a credential (sign out). Serialized against `modify`. */
  delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** Request auth derived from a credential. */
export interface ModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/**
 * A prompt shown to the user during sign-in. `signal` lets the flow withdraw a pending prompt when an
 * out-of-band event settles the step, for example a pasted-code prompt raced against the browser
 * callback.
 */
export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
  | { type: "info"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/**
 * Sign-in callbacks supplied by the app. `prompt` resolves with the entered text (or the selected
 * option id) and rejects on cancel. `signal` aborts the whole sign-in.
 */
export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** Interaction passed to provider sign-in implementations, always with a signal. */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/**
 * An OAuth sign-in method. The `refresh`/`toAuth` split lets the resolver own locked refresh:
 * `refresh` produces a credential, `toAuth` derives request auth from whatever ends up stored.
 */
export interface OAuthProvider {
  /** Display name, for example "OpenRouter". */
  name: string;
  /** Label for the sign-in option, for example "Sign in with OpenRouter". */
  loginLabel?: string;
  /** Whether access is backed by a consumer subscription rather than API billing. */
  isSubscription?: boolean;
  login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
  /** Exchange the refresh token. Network call; throws on failure. Runs under the store lock. */
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  /** Side-effect-free derivation of request auth from a valid credential. */
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}
