import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { isSecretName, type SecretSource } from "@generic-ai/sdk";

/** Provider keys the native model layer reads, plus Generic AI's own fallback key. */
export const PROVIDER_KEY_SECRET_NAMES: readonly string[] = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GENERIC_AI_PROVIDER_API_KEY",
]);

/**
 * Host credentials that must be scrubbed everywhere but that no agent may ever resolve, whatever
 * its grants say. They are loaded from the environment for redaction only.
 */
export const HOST_ONLY_SECRET_NAMES: readonly string[] = Object.freeze([
  "DATABASE_URL",
  "GENERIC_AI_SECRETS_KEY",
  "GENERIC_AI_AUTH_TOKEN",
  "GENERIC_AI_OWNER_SETUP_TOKEN",
  "GENERIC_AI_TEST_POSTGRES_URL",
]);

/** Environment variables prefixed with this become secrets named by the rest of the variable. */
export const DEFAULT_ENV_SECRET_PREFIX = "GENERIC_AI_SECRET_";

export interface EnvSecretSourceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Exact variable names exposed as secrets under their own name. Defaults to the provider keys and
   * host-only credentials above. Nothing else in the environment is ever exposed.
   */
  readonly names?: readonly string[];
  /** `GENERIC_AI_SECRET_GITHUB_TOKEN` becomes secret `GITHUB_TOKEN`. Set `false` to turn off. */
  readonly prefix?: string | false;
  readonly id?: string;
}

/**
 * Secrets from environment variables: on Railway these are the service's variables, locally an
 * `.env` file loaded by Docker Compose. Only listed names and prefixed variables are exposed, so
 * `PATH`, `HOME` and the rest of the environment never become secrets.
 */
export function createEnvSecretSource(options: EnvSecretSourceOptions = {}): SecretSource {
  const env = options.env ?? process.env;
  const names = new Set(options.names ?? [...PROVIDER_KEY_SECRET_NAMES, ...HOST_ONLY_SECRET_NAMES]);
  const prefix =
    options.prefix === false ? undefined : (options.prefix ?? DEFAULT_ENV_SECRET_PREFIX);

  const variableFor = (name: string): string | undefined => {
    if (names.has(name)) {
      return name;
    }
    if (prefix !== undefined) {
      return `${prefix}${name}`;
    }
    return undefined;
  };

  return Object.freeze({
    id: options.id ?? "env",
    get(name: string): string | undefined {
      const variable = variableFor(name);
      const value = variable === undefined ? undefined : env[variable];
      return value === undefined || value.length === 0 ? undefined : value;
    },
    list(): readonly string[] {
      const listed = new Set<string>();
      for (const name of names) {
        if (env[name] !== undefined && env[name] !== "") {
          listed.add(name);
        }
      }
      if (prefix !== undefined) {
        for (const [key, value] of Object.entries(env)) {
          if (key.startsWith(prefix) && value !== undefined && value !== "") {
            const name = key.slice(prefix.length);
            if (isSecretName(name)) {
              listed.add(name);
            }
          }
        }
      }
      return [...listed];
    },
  });
}

export interface FileSecretSourceOptions {
  /** Directory holding one file per secret, named by the secret. Defaults to `/run/secrets`. */
  readonly directory?: string;
  readonly id?: string;
}

/**
 * Secrets from files, one per secret: Docker and Compose mount `secrets:` at `/run/secrets/<name>`.
 * A missing directory is an empty source. One trailing newline is stripped from each value.
 */
export function createFileSecretSource(options: FileSecretSourceOptions = {}): SecretSource {
  const directory = options.directory ?? "/run/secrets";

  return Object.freeze({
    id: options.id ?? "file",
    async get(name: string): Promise<string | undefined> {
      if (!isSecretName(name)) {
        return undefined;
      }
      try {
        const value = (await readFile(path.join(directory, name), "utf8")).replace(/\r?\n$/, "");
        return value.length === 0 ? undefined : value;
      } catch (error) {
        if (isMissing(error)) {
          return undefined;
        }
        throw error;
      }
    },
    async list(): Promise<readonly string[]> {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && isSecretName(entry.name))
          .map((entry) => entry.name);
      } catch (error) {
        if (isMissing(error)) {
          return [];
        }
        throw error;
      }
    },
  });
}

/** In-memory source for tests and embedding. */
export function createStaticSecretSource(
  values: Readonly<Record<string, string>>,
  id = "static",
): SecretSource {
  const map = new Map(Object.entries(values));
  return Object.freeze({
    id,
    get: (name: string) => map.get(name),
    list: () => [...map.keys()],
  });
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
