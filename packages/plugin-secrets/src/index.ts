import type { StorageContract } from "@generic-ai/sdk";

import { createSecretsBroker, type SecretsBroker, type SecretsBrokerOptions } from "./broker.js";
import { createEncryptedSecretStore, SECRETS_KEY_ENV } from "./encrypted-store.js";
import {
  createEnvSecretSource,
  createFileSecretSource,
  HOST_ONLY_SECRET_NAMES,
  PROVIDER_KEY_SECRET_NAMES,
} from "./sources.js";

export const name = "@generic-ai/plugin-secrets" as const;
export const kind = "secrets-vault" as const;

export {
  createSecretsBroker,
  type ResolveSecretOptions,
  SecretAccessError,
  type SecretsBroker,
  type SecretsBrokerOptions,
} from "./broker.js";
export {
  createEncryptedSecretStore,
  type EncryptedSecretStore,
  type EncryptedSecretStoreOptions,
  parseSecretsKey,
  SECRETS_KEY_ENV,
  SecretsKeyError,
  SecretsStoreError,
} from "./encrypted-store.js";
export { MIN_ENCODED_REDACT_LENGTH, MIN_REDACT_LENGTH, SecretRedactor } from "./redactor.js";
export {
  createEnvSecretSource,
  createFileSecretSource,
  createStaticSecretSource,
  DEFAULT_ENV_SECRET_PREFIX,
  type EnvSecretSourceOptions,
  type FileSecretSourceOptions,
  HOST_ONLY_SECRET_NAMES,
  PROVIDER_KEY_SECRET_NAMES,
} from "./sources.js";

export interface SecretsFromEnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Durable storage for the encrypted store (Postgres KV on Railway, SQLite locally). The store is
   * only created when both this and `GENERIC_AI_SECRETS_KEY` are present.
   */
  readonly storage?: StorageContract;
  /** Directory of file secrets. Defaults to `GENERIC_AI_SECRETS_DIR`, then `/run/secrets`. */
  readonly secretsDirectory?: string;
  /** Extra environment variable names to expose as secrets under their own name. */
  readonly envNames?: readonly string[];
  readonly onAccess?: SecretsBrokerOptions["onAccess"];
  readonly hostOnly?: readonly string[];
}

/**
 * The production default: environment variables (Railway variables or a local `.env`), then Docker
 * secret files, then the encrypted store when a master key and storage are configured. The first
 * source holding a name wins, so a Railway variable overrides a value set in the dashboard.
 */
export function createSecretsFromEnvironment(
  options: SecretsFromEnvironmentOptions = {},
): SecretsBroker {
  const env = options.env ?? process.env;
  const envSource = createEnvSecretSource({
    env,
    ...(options.envNames === undefined
      ? {}
      : {
          names: [...PROVIDER_KEY_SECRET_NAMES, ...HOST_ONLY_SECRET_NAMES, ...options.envNames],
        }),
  });
  const fileSource = createFileSecretSource({
    directory: options.secretsDirectory ?? env["GENERIC_AI_SECRETS_DIR"] ?? "/run/secrets",
  });
  const key = env[SECRETS_KEY_ENV];
  const writable =
    key !== undefined && key.trim().length > 0 && options.storage !== undefined
      ? createEncryptedSecretStore({ storage: options.storage, key })
      : undefined;
  return createSecretsBroker({
    sources: [envSource, fileSource],
    ...(writable === undefined ? {} : { writable }),
    ...(options.onAccess === undefined ? {} : { onAccess: options.onAccess }),
    ...(options.hostOnly === undefined ? {} : { hostOnly: options.hostOnly }),
  });
}
