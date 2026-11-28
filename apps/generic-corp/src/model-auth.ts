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
 * What powers the company's agents (decision 14).
 *
 * - The owner's Claude plan (`claude_plan`): the owner runs `claude setup-token` on their own
 *   computer (Anthropic's sign-in) and sets the token as `CLAUDE_CODE_OAUTH_TOKEN` on the server.
 *   Claude turns then run in the Claude Agent SDK, which draws on the plan's limits. The app never
 *   runs a sign-in or stores the token; it only reads the variable. See claude-agent-sdk.ts.
 * - An Anthropic API key, saved from the app or set as `ANTHROPIC_API_KEY`, for the native
 *   runtime. A saved key wins over the environment.
 *
 * The plan token wins for Claude turns when both are set. The app itself never calls the API with
 * a plan token: a plan sign-in saved by an earlier version is deleted the first time it is seen.
 */
export const MODEL_AUTH_PROVIDER = "anthropic" as const;

export type ModelAuthSource = "claude_plan" | "api_key" | "environment" | "none";

export interface ModelAuthStatus {
  readonly provider: typeof MODEL_AUTH_PROVIDER;
  /** Where Claude turns get their credential from right now. */
  readonly source: ModelAuthSource;
  /** Whether an API key is also available (for other model calls, or after the plan's limit). */
  readonly apiKey?: boolean;
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
  /** The owner's Claude plan token (`CLAUDE_CODE_OAUTH_TOKEN`), when set on the server. */
  readonly claudePlanToken?: () => string | undefined;
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

  async function keyStatus(): Promise<ModelAuthStatus> {
    await dropPlanSignIn(MODEL_AUTH_PROVIDER);
    const stored = await store?.read(MODEL_AUTH_PROVIDER);
    if (stored?.type === "api_key") {
      return { provider: MODEL_AUTH_PROVIDER, source: "api_key" };
    }
    const environmentKey = await fallback(MODEL_AUTH_PROVIDER);
    return { provider: MODEL_AUTH_PROVIDER, source: environmentKey ? "environment" : "none" };
  }

  async function status(): Promise<ModelAuthStatus> {
    const key = await keyStatus();
    if (options.claudePlanToken?.() !== undefined) {
      return {
        provider: MODEL_AUTH_PROVIDER,
        source: "claude_plan",
        apiKey: key.source !== "none",
      };
    }
    return key;
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
          "That is a Claude plan token, not an API key. To run agents on your Claude plan, set it as the CLAUDE_CODE_OAUTH_TOKEN variable on the server instead (the app doesn't store plan tokens). For an API key, create one at console.anthropic.com.",
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
