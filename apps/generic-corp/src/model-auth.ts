import { PROVIDER_API_KEY_ENV, resolveApiKey } from "@generic-ai/ai";
import {
  type CredentialStore,
  createModelAuthResolver,
  FileCredentialStore,
  logout,
  type ModelAuth,
  saveApiKey,
} from "@generic-ai/auth";

/**
 * What powers the company's agents (decision 14): an Anthropic API key, saved from the app or set
 * as `ANTHROPIC_API_KEY`. A saved key wins over the environment, which stays as the last fallback
 * so existing setups keep working.
 *
 * There is no Claude plan sign-in: Anthropic's terms don't allow third-party apps to use a Claude
 * Pro/Max plan. A plan sign-in saved by an earlier version is deleted the first time it is seen.
 */
export const MODEL_AUTH_PROVIDER = "anthropic" as const;

export type ModelAuthSource = "api_key" | "environment" | "none";

export interface ModelAuthStatus {
  readonly provider: typeof MODEL_AUTH_PROVIDER;
  /** Where agent requests get their credential from right now. */
  readonly source: ModelAuthSource;
}

export interface CompanyModelAuth {
  /** Request auth for a provider; pass as the native harness's `getAuth`. */
  getAuth(provider: string): Promise<ModelAuth | undefined>;
  status(): Promise<ModelAuthStatus>;
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
  /** API key lookup when nothing is stored. Defaults to the provider's environment variables. */
  readonly fallback?: (provider: string) => string | undefined | Promise<string | undefined>;
}

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
  const fallback = options.fallback ?? ((provider: string) => resolveApiKey(provider));
  const resolver = createModelAuthResolver({ store, fallback });

  /** Deletes a Claude plan sign-in left by an earlier version, so it is never used. */
  async function dropPlanSignIn(provider: string): Promise<void> {
    if ((await store?.read(provider))?.type === "oauth") {
      await logout(store as CredentialStore, provider);
    }
  }

  async function status(): Promise<ModelAuthStatus> {
    await dropPlanSignIn(MODEL_AUTH_PROVIDER);
    const stored = await store?.read(MODEL_AUTH_PROVIDER);
    if (stored?.type === "api_key") {
      return { provider: MODEL_AUTH_PROVIDER, source: "api_key" };
    }
    const environmentKey = await fallback(MODEL_AUTH_PROVIDER);
    return { provider: MODEL_AUTH_PROVIDER, source: environmentKey ? "environment" : "none" };
  }

  return {
    async getAuth(provider) {
      if (provider === MODEL_AUTH_PROVIDER) {
        await dropPlanSignIn(provider);
      }
      return resolver(provider);
    },
    status,

    async saveApiKey(key) {
      const trimmed = key.trim();
      if (trimmed.startsWith("sk-ant-oat")) {
        throw new ModelAuthError(
          400,
          "That is a Claude plan sign-in token, not an API key. Anthropic's terms don't allow third-party apps to use a Claude plan. Create an API key at console.anthropic.com.",
        );
      }
      if (!trimmed.startsWith("sk-ant-")) {
        throw new ModelAuthError(400, "Anthropic API keys start with sk-ant-.");
      }
      await saveApiKey(store as CredentialStore, MODEL_AUTH_PROVIDER, trimmed);
      return status();
    },

    async signOut() {
      await logout(store as CredentialStore, MODEL_AUTH_PROVIDER);
      return status();
    },
  };
}
