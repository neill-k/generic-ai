import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type AuthKeyValueStore,
  type AuthStore,
  authenticateOwnerRequest,
  createAuthStore,
  createMemoryAuthStore,
  createOwnerAuth,
  createOwnerAuthRoutes,
  type OwnerAuth,
  type OwnerAuthRoutes,
} from "@generic-ai/plugin-auth-identity";
import { createSqliteStorage } from "@generic-ai/plugin-storage-sqlite";

export const AUTH_TOKEN_ENV = "GENERIC_AI_AUTH_TOKEN";
export const OWNER_AUTH_ENV = "GENERIC_AI_OWNER_AUTH";
export const OWNER_SETUP_TOKEN_ENV = "GENERIC_AI_OWNER_SETUP_TOKEN";
export const PUBLIC_URL_ENV = "GENERIC_AI_PUBLIC_URL";
export const RAILWAY_PUBLIC_DOMAIN_ENV = "RAILWAY_PUBLIC_DOMAIN";
export const AUTH_DB_ENV = "GENERIC_AI_AUTH_DB";
export const AUTH_ROUTE_PREFIX = "/auth" as const;

export interface StarterAuthEnvironment {
  /** `owner` when passkey login and API tokens are enabled. */
  readonly mode: "none" | "owner";
  readonly publicOrigin?: string;
  readonly setupToken?: string;
  /** SQLite file for owner auth records, or `:memory:`. */
  readonly databasePath: string;
}

export class StarterAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterAuthConfigError";
  }
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function resolvePublicOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = readTrimmed(env, PUBLIC_URL_ENV);
  const railway = readTrimmed(env, RAILWAY_PUBLIC_DOMAIN_ENV);
  const raw = explicit ?? (railway === undefined ? undefined : `https://${railway}`);
  if (raw === undefined) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StarterAuthConfigError(`${PUBLIC_URL_ENV} must be an absolute URL, got "${raw}".`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StarterAuthConfigError(`${PUBLIC_URL_ENV} must use http or https.`);
  }
  return url.origin;
}

function isTruthy(raw: string | undefined): boolean {
  return raw !== undefined && ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadStarterAuthEnvironment(
  env: NodeJS.ProcessEnv,
  startDir: string,
): StarterAuthEnvironment {
  const publicOrigin = resolvePublicOrigin(env);
  const setupToken = readTrimmed(env, OWNER_SETUP_TOKEN_ENV);
  const authToken = readTrimmed(env, AUTH_TOKEN_ENV);
  const enabled =
    isTruthy(readTrimmed(env, OWNER_AUTH_ENV)) ||
    publicOrigin !== undefined ||
    setupToken !== undefined ||
    authToken !== undefined;
  const dbValue = readTrimmed(env, AUTH_DB_ENV);
  const databasePath =
    dbValue === undefined
      ? join(homedir(), ".generic-ai", "auth.sqlite")
      : dbValue === ":memory:"
        ? dbValue
        : resolve(startDir, dbValue);

  if (setupToken !== undefined && setupToken.length < 16) {
    throw new StarterAuthConfigError(`${OWNER_SETUP_TOKEN_ENV} must be at least 16 characters.`);
  }
  if (authToken !== undefined && authToken.length < 16) {
    throw new StarterAuthConfigError(`${AUTH_TOKEN_ENV} must be at least 16 characters.`);
  }

  return Object.freeze({
    mode: enabled ? "owner" : "none",
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(setupToken === undefined ? {} : { setupToken }),
    databasePath,
  });
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

/**
 * Opens the SQLite-backed auth store. The file must live outside the agent
 * workspace: agents can write there, and a writable auth store would let an
 * agent mint its own credentials.
 */
export function openStarterAuthStore(
  databasePath: string,
  workspaceRoot: string,
): { readonly store: AuthStore; readonly close: () => void } {
  if (databasePath === ":memory:") {
    return { store: createMemoryAuthStore(), close: () => undefined };
  }
  if (isInside(resolve(workspaceRoot), resolve(databasePath))) {
    throw new StarterAuthConfigError(
      `${AUTH_DB_ENV} (${databasePath}) is inside the agent workspace (${workspaceRoot}). ` +
        "Store auth records outside the workspace so agents cannot edit them.",
    );
  }

  const storage = createSqliteStorage({ path: databasePath });
  const namespace = storage.namespace("auth");
  const keyOf = (collection: string, id: string) => `${collection}/${id}`;
  const kv: AuthKeyValueStore = {
    get: async (collection, id) => namespace.get(keyOf(collection, id)),
    set: async (collection, id, value) => {
      namespace.set(keyOf(collection, id), value);
    },
    delete: async (collection, id) => namespace.delete(keyOf(collection, id)),
    list: async (collection) =>
      namespace
        .list()
        .filter((record) => record.key.startsWith(`${collection}/`))
        .map((record) => record.value),
  };
  return { store: createAuthStore(kv), close: () => storage.close() };
}

export interface StarterAuth {
  readonly auth: OwnerAuth;
  readonly routes: OwnerAuthRoutes;
  /** Resolves to `true` when the request carries a valid owner credential. */
  readonly isAuthenticated: (request: Request) => Promise<boolean>;
  readonly close: () => void;
}

export async function createStarterAuth(input: {
  readonly environment: StarterAuthEnvironment;
  readonly authToken?: string;
  readonly workspaceRoot: string;
  readonly store?: AuthStore;
  readonly log: (message: string) => void;
}): Promise<StarterAuth> {
  const opened =
    input.store === undefined
      ? openStarterAuthStore(input.environment.databasePath, input.workspaceRoot)
      : { store: input.store, close: () => undefined };

  let setupToken = input.environment.setupToken;
  const probe = createOwnerAuth({ store: opened.store });
  const { setupRequired } = await probe.status();
  if (setupRequired && setupToken === undefined) {
    setupToken = randomBytes(18).toString("base64url");
    input.log(
      [
        "No owner passkey is registered yet.",
        `Open ${input.environment.publicOrigin ?? ""}${AUTH_ROUTE_PREFIX}/login and use this one-time setup token:`,
        `  ${setupToken}`,
        `It changes on every restart until a passkey exists. Set ${OWNER_SETUP_TOKEN_ENV} to pin it.`,
      ].join("\n"),
    );
  }

  const auth = createOwnerAuth({
    store: opened.store,
    rpName: "Generic AI",
    ...(input.environment.publicOrigin === undefined
      ? {}
      : { publicOrigin: input.environment.publicOrigin }),
    ...(setupToken === undefined ? {} : { setupToken }),
    ...(input.authToken === undefined
      ? {}
      : { staticTokens: [{ id: `env:${AUTH_TOKEN_ENV}`, token: input.authToken }] }),
  });
  const routes = createOwnerAuthRoutes(auth, {
    routePrefix: AUTH_ROUTE_PREFIX,
    appName: "Generic AI",
    afterLoginPath: "/",
  });

  return Object.freeze({
    auth,
    routes,
    isAuthenticated: async (request: Request) =>
      (await authenticateOwnerRequest(auth, request)) !== undefined,
    close: opened.close,
  });
}
