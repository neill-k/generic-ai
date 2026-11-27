import { randomUUID } from "node:crypto";

import { PROVIDER_API_KEY_ENV, resolveApiKey } from "@generic-ai/ai";
import {
  anthropicOAuth,
  type CredentialStore,
  createModelAuthResolver,
  FileCredentialStore,
  login,
  logout,
  type ModelAuth,
  type OAuthProvider,
  saveApiKey,
} from "@generic-ai/auth";

/**
 * What powers the company's agents (decision 14): the owner's Claude subscription, signed in from
 * the dashboard, or an Anthropic API key. Both are stored in one credential file on the data
 * volume; a stored credential wins over `ANTHROPIC_API_KEY` in the environment, which stays as the
 * last fallback so existing setups keep working.
 *
 * Signing in with Claude uses Anthropic's copy-code flow, which works when the server runs in
 * Docker or on another machine: the owner opens the sign-in link, approves, and pastes the code
 * Anthropic shows back into the dashboard.
 */
export const MODEL_AUTH_PROVIDER = "anthropic" as const;

export type ModelAuthSource = "subscription" | "api_key" | "environment" | "none";

export interface ModelAuthStatus {
  readonly provider: typeof MODEL_AUTH_PROVIDER;
  /** Where agent requests get their credential from right now. */
  readonly source: ModelAuthSource;
  /** When the subscription's access token next needs a refresh (refreshed automatically). */
  readonly expiresAt?: string;
  /** A Claude sign-in that was started and is waiting for its code. */
  readonly pendingSignIn?: boolean;
}

export interface ClaudeSignInStart {
  readonly flowId: string;
  /** Open this in a browser, sign in to Claude, and copy the code shown at the end. */
  readonly url: string;
}

export interface CompanyModelAuth {
  /** Request auth for a provider; pass as the native harness's `getAuth`. */
  getAuth(provider: string): Promise<ModelAuth | undefined>;
  status(): Promise<ModelAuthStatus>;
  startClaudeSignIn(): Promise<ClaudeSignInStart>;
  finishClaudeSignIn(flowId: string, code: string): Promise<ModelAuthStatus>;
  saveApiKey(key: string): Promise<ModelAuthStatus>;
  signOut(): Promise<ModelAuthStatus>;
}

export class ModelAuthError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
    this.name = "ModelAuthError";
  }
}

export interface CreateCompanyModelAuthOptions {
  /** Where credentials are kept. Defaults to a file at `path`. */
  readonly store?: CredentialStore;
  /** Credential file, normally `<dataDir>/model-auth.json`. Used when `store` is not given. */
  readonly path?: string;
  /** The Claude sign-in. Replaceable for tests; defaults to Anthropic's. */
  readonly claude?: OAuthProvider;
  /** API key lookup when nothing is stored. Defaults to the provider's environment variables. */
  readonly fallback?: (provider: string) => string | undefined | Promise<string | undefined>;
  /** How long a started sign-in waits for its code. Defaults to 15 minutes. */
  readonly signInTimeoutMs?: number;
}

interface PendingSignIn {
  readonly flowId: string;
  readonly provideCode: (code: string) => void;
  readonly cancel: (reason: Error) => void;
  readonly done: Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
}

const COPY_CODE_METHOD = "copy_code";

/** The usual environment variable or secret name for a provider's API key, like ANTHROPIC_API_KEY. */
export function providerKeyName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** A provider's API key from an environment, checking the names the provider accepts. */
export function resolveProviderKeyFromEnv(
  provider: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const name of PROVIDER_API_KEY_ENV[provider] ?? [providerKeyName(provider)]) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function createCompanyModelAuth(options: CreateCompanyModelAuthOptions): CompanyModelAuth {
  const store =
    options.store ??
    (options.path === undefined ? undefined : new FileCredentialStore({ path: options.path }));
  if (store === undefined) {
    throw new Error("createCompanyModelAuth needs a store or a path.");
  }
  const claude = options.claude ?? anthropicOAuth;
  const fallback = options.fallback ?? ((provider: string) => resolveApiKey(provider));
  const timeoutMs = options.signInTimeoutMs ?? 15 * 60_000;
  const resolver = createModelAuthResolver({
    store,
    oauth: { [MODEL_AUTH_PROVIDER]: claude },
    fallback,
  });
  let pending: PendingSignIn | undefined;

  const clearPending = (flow: PendingSignIn) => {
    clearTimeout(flow.timer);
    if (pending === flow) {
      pending = undefined;
    }
  };

  async function status(): Promise<ModelAuthStatus> {
    const stored = await store?.read(MODEL_AUTH_PROVIDER);
    const pendingSignIn = pending === undefined ? {} : { pendingSignIn: true };
    if (stored?.type === "oauth") {
      return {
        provider: MODEL_AUTH_PROVIDER,
        source: "subscription",
        expiresAt: new Date(stored.expires).toISOString(),
        ...pendingSignIn,
      };
    }
    if (stored?.type === "api_key") {
      return { provider: MODEL_AUTH_PROVIDER, source: "api_key", ...pendingSignIn };
    }
    const environmentKey = await fallback(MODEL_AUTH_PROVIDER);
    return {
      provider: MODEL_AUTH_PROVIDER,
      source: environmentKey ? "environment" : "none",
      ...pendingSignIn,
    };
  }

  return {
    getAuth: (provider) => resolver(provider),
    status,

    async startClaudeSignIn() {
      pending?.cancel(new Error("A new sign-in was started."));
      const flowId = randomUUID();
      const abort = new AbortController();
      let provideCode: (code: string) => void = () => {};
      const codeEntered = new Promise<string>((resolve, reject) => {
        provideCode = resolve;
        abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
      });
      let announceUrl: (url: string) => void = () => {};
      const urlReady = new Promise<string>((resolve) => {
        announceUrl = resolve;
      });
      const done = login(store, MODEL_AUTH_PROVIDER, claude, {
        signal: abort.signal,
        async prompt(prompt) {
          if (prompt.type === "select") {
            const copyCode = prompt.options.find((option) => option.id === COPY_CODE_METHOD);
            return copyCode?.id ?? prompt.options[0]?.id ?? COPY_CODE_METHOD;
          }
          return codeEntered;
        },
        notify(event) {
          if (event.type === "auth_url") {
            announceUrl(event.url);
          }
        },
      }).then(() => undefined);
      const timer = setTimeout(
        () => abort.abort(new Error("The Claude sign-in timed out. Start it again.")),
        timeoutMs,
      );
      timer.unref?.();
      const flow: PendingSignIn = {
        flowId,
        provideCode: (code) => provideCode(code),
        cancel: (reason) => abort.abort(reason),
        done,
        timer,
      };
      pending = flow;
      done.then(
        () => clearPending(flow),
        () => clearPending(flow),
      );
      const url = await Promise.race([
        urlReady,
        done.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      if (url === undefined) {
        throw new ModelAuthError(502, "The Claude sign-in ended before it gave a link.");
      }
      return { flowId, url };
    },

    async finishClaudeSignIn(flowId, code) {
      const flow = pending;
      if (flow === undefined || flow.flowId !== flowId) {
        throw new ModelAuthError(404, "That sign-in is no longer open. Start it again.");
      }
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        throw new ModelAuthError(400, "Paste the code Claude showed after you signed in.");
      }
      flow.provideCode(trimmed);
      try {
        await flow.done;
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new ModelAuthError(
          502,
          `Claude did not accept that code. Start the sign-in again. (${message.slice(0, 300)})`,
        );
      }
      return status();
    },

    async saveApiKey(key) {
      const trimmed = key.trim();
      if (!trimmed.startsWith("sk-ant-")) {
        throw new ModelAuthError(400, "Anthropic API keys start with sk-ant-.");
      }
      await saveApiKey(store, MODEL_AUTH_PROVIDER, trimmed);
      return status();
    },

    async signOut() {
      pending?.cancel(new Error("Signed out."));
      await logout(store, MODEL_AUTH_PROVIDER);
      return status();
    },
  };
}
