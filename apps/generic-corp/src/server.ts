import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  type AuthStore,
  authenticateOwnerRequest,
  createOwnerAuth,
  createOwnerAuthRoutes,
  createStorageContractAuthStore,
  type OwnerAuth,
  unauthorizedResponse,
} from "@generic-ai/plugin-auth-identity";
import { createSecretsFromEnvironment, type SecretsBroker } from "@generic-ai/plugin-secrets";
import { type AgentTaskExecutor, ALL_AUTH_SCOPES, type AuthContext } from "@generic-ai/sdk";
import { Hono } from "hono";

import { API_ROUTE_PREFIX, createCompanyApi } from "./api.js";
import { type CompanyConfig, DEFAULT_COMPANY, parseCompanyYaml } from "./company.js";
import { createDashboardRoutes } from "./dashboard.js";
import { type CompanyExecutorOptions, createCompanyTaskExecutor } from "./executor.js";
import { type CompanyRuntime, createCompanyRuntime } from "./runtime.js";
import { type CompanyStorage, openCompanyStorage } from "./storage.js";
import { type CompanyToolkit, createCompanyToolkit } from "./toolkit.js";

/**
 * Composes the Generic Corp server from the environment: storage (Postgres
 * when `DATABASE_URL` is set, else SQLite under the data directory), the
 * company and its agents, owner auth, the API, and health endpoints.
 */
export const ENV = Object.freeze({
  host: "GENERIC_CORP_HOST",
  port: "PORT",
  dataDir: "GENERIC_CORP_DATA_DIR",
  companyFile: "GENERIC_CORP_COMPANY_FILE",
  databaseUrl: "DATABASE_URL",
  publicUrl: "GENERIC_AI_PUBLIC_URL",
  railwayDomain: "RAILWAY_PUBLIC_DOMAIN",
  setupToken: "GENERIC_AI_OWNER_SETUP_TOKEN",
  authToken: "GENERIC_AI_AUTH_TOKEN",
  trustProxy: "GENERIC_AI_TRUST_PROXY",
  insecureNoAuth: "GENERIC_CORP_INSECURE_NO_AUTH",
  workers: "GENERIC_CORP_WORKERS",
});

export const AUTH_ROUTE_PREFIX = "/auth" as const;

export class GenericCorpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenericCorpConfigError";
  }
}

export interface GenericCorpEnvironment {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly companyFile?: string;
  readonly databaseUrl?: string;
  readonly publicOrigin?: string;
  readonly setupToken?: string;
  readonly authToken?: string;
  readonly trustProxyHeaders: boolean;
  /** Owner auth is off. Only allowed on a loopback host. */
  readonly insecureNoAuth: boolean;
  /** Run agent turns in this process. */
  readonly workers: boolean;
}

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function flag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = read(env, key)?.toLowerCase();
  if (value === undefined) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  throw new GenericCorpConfigError(`${key} must be true or false.`);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadGenericCorpEnvironment(env: NodeJS.ProcessEnv): GenericCorpEnvironment {
  const host = read(env, ENV.host) ?? (read(env, ENV.railwayDomain) ? "0.0.0.0" : "127.0.0.1");
  const portRaw = read(env, ENV.port) ?? "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new GenericCorpConfigError(`${ENV.port} must be a port number.`);
  }
  const dataDir = path.resolve(read(env, ENV.dataDir) ?? path.join(homedir(), ".generic-corp"));
  const railway = read(env, ENV.railwayDomain);
  const rawOrigin =
    read(env, ENV.publicUrl) ?? (railway === undefined ? undefined : `https://${railway}`);
  let publicOrigin: string | undefined;
  if (rawOrigin !== undefined) {
    try {
      publicOrigin = new URL(rawOrigin).origin;
    } catch {
      throw new GenericCorpConfigError(`${ENV.publicUrl} must be an absolute URL.`);
    }
  }
  const setupToken = read(env, ENV.setupToken);
  const authToken = read(env, ENV.authToken);
  for (const [key, value] of [
    [ENV.setupToken, setupToken],
    [ENV.authToken, authToken],
  ] as const) {
    if (value !== undefined && value.length < 16) {
      throw new GenericCorpConfigError(`${key} must be at least 16 characters.`);
    }
  }
  const insecureNoAuth = flag(env, ENV.insecureNoAuth, false);
  if (insecureNoAuth && !LOOPBACK_HOSTS.has(host)) {
    throw new GenericCorpConfigError(
      `${ENV.insecureNoAuth} is only allowed when the server listens on loopback, not ${host}.`,
    );
  }
  const companyFile = read(env, ENV.companyFile);
  const databaseUrl = read(env, ENV.databaseUrl);
  return {
    host,
    port,
    dataDir,
    ...(companyFile === undefined ? {} : { companyFile: path.resolve(companyFile) }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(setupToken === undefined ? {} : { setupToken }),
    ...(authToken === undefined ? {} : { authToken }),
    trustProxyHeaders: flag(env, ENV.trustProxy, railway !== undefined),
    insecureNoAuth,
    workers: flag(env, ENV.workers, true),
  };
}

export async function loadCompany(environment: GenericCorpEnvironment): Promise<CompanyConfig> {
  if (environment.companyFile === undefined) {
    return DEFAULT_COMPANY;
  }
  return parseCompanyYaml(await readFile(environment.companyFile, "utf8"));
}

/** The local owner used when auth is off on loopback. */
const LOCAL_OWNER: AuthContext = Object.freeze({
  subject: Object.freeze({
    subjectId: "owner",
    displayName: "Local owner",
    actorType: "human" as const,
    scopes: ALL_AUTH_SCOPES,
    claims: Object.freeze({}),
  }),
  credentialSource: "custom" as const,
  credentialId: `env:${ENV.insecureNoAuth}`,
  audit: Object.freeze({}),
});

export interface GenericCorpServer {
  readonly app: Hono;
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly runtime: CompanyRuntime;
  readonly storage: CompanyStorage;
  readonly environment: GenericCorpEnvironment;
  readonly auth?: OwnerAuth;
  stop(): Promise<void>;
}

export interface CreateGenericCorpServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly environment?: GenericCorpEnvironment;
  readonly company?: CompanyConfig;
  /** Replaces the native-runtime executor, for tests and alternate runtimes. */
  readonly executor?: AgentTaskExecutor;
  readonly executorOptions?: Omit<CompanyExecutorOptions, "runStore" | "artifactsRoot">;
  readonly authStore?: AuthStore;
  /** The secrets vault. Defaults to environment, files and the encrypted store in storage. */
  readonly secrets?: SecretsBroker;
  /** Replaces the generic-work toolkit, for tests. */
  readonly toolkit?: CompanyToolkit;
  readonly log?: (message: string) => void;
}

export async function createGenericCorpServer(
  options: CreateGenericCorpServerOptions = {},
): Promise<GenericCorpServer> {
  const log = options.log ?? ((message: string) => console.log(message));
  const environment = options.environment ?? loadGenericCorpEnvironment(options.env ?? process.env);
  const company = options.company ?? (await loadCompany(environment));
  const storage = await openCompanyStorage({
    ...(environment.databaseUrl === undefined ? {} : { databaseUrl: environment.databaseUrl }),
    sqlitePath: path.join(environment.dataDir, "company.sqlite"),
  });

  let toolkit: CompanyToolkit | undefined;
  try {
    const secrets =
      options.secrets ??
      createSecretsFromEnvironment({ env: options.env ?? process.env, storage: storage.kv });
    for (const name of secrets.weakNames()) {
      log(`Secret ${name} is too short to redact reliably. Use a longer value.`);
    }
    toolkit =
      options.toolkit ??
      createCompanyToolkit({ company, secrets, env: options.env ?? process.env });
    const companyToolkit = toolkit;
    const executor =
      options.executor ??
      createCompanyTaskExecutor({
        capabilities: (input) => companyToolkit.capabilities(input),
        secretGrants: (agentId) => companyToolkit.secretGrants(agentId),
        ...options.executorOptions,
        runStore: storage.runStore,
        artifactsRoot: path.join(environment.dataDir, "artifacts"),
      });
    const runtime = createCompanyRuntime({
      company,
      storage,
      agentsRoot: path.join(environment.dataDir, "agents"),
      executor,
      log,
    });
    await runtime.initialize();

    let auth: OwnerAuth | undefined;
    const app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/ready", async (c) => {
      const health = await storage.health();
      return c.json(
        {
          ok: health.ok,
          storage: storage.driver,
          ...(health.error ? { error: health.error } : {}),
        },
        health.ok ? 200 : 503,
      );
    });

    if (environment.insecureNoAuth) {
      log(`Owner auth is OFF (${ENV.insecureNoAuth}). Only use this on your own machine.`);
    } else {
      const store = options.authStore ?? createStorageContractAuthStore(storage.kv);
      let setupToken = environment.setupToken;
      if ((await createOwnerAuth({ store }).status()).setupRequired && setupToken === undefined) {
        setupToken = randomBytes(18).toString("base64url");
        log(
          [
            "No owner passkey is registered yet.",
            `Open ${environment.publicOrigin ?? `http://${environment.host}:${environment.port}`}${AUTH_ROUTE_PREFIX}/login and use this one-time setup token:`,
            `  ${setupToken}`,
            `It changes on every restart until a passkey exists. Set ${ENV.setupToken} to pin it.`,
          ].join("\n"),
        );
      }
      auth = createOwnerAuth({
        store,
        rpName: company.name,
        ...(environment.publicOrigin === undefined
          ? {}
          : { publicOrigin: environment.publicOrigin }),
        ...(setupToken === undefined ? {} : { setupToken }),
        ...(environment.authToken === undefined
          ? {}
          : { staticTokens: [{ id: `env:${ENV.authToken}`, token: environment.authToken }] }),
      });
      const routes = createOwnerAuthRoutes(auth, {
        routePrefix: AUTH_ROUTE_PREFIX,
        appName: company.name,
        afterLoginPath: "/",
        trustProxyHeaders: environment.trustProxyHeaders,
      });
      app.route("/", routes.app);
    }

    const ownerAuth = auth;
    app.route(
      API_ROUTE_PREFIX,
      createCompanyApi(runtime, {
        toolkit: companyToolkit,
        authenticate: async (request) => {
          if (ownerAuth === undefined) {
            return LOCAL_OWNER;
          }
          return (await authenticateOwnerRequest(ownerAuth, request)) ?? unauthorizedResponse();
        },
      }),
    );

    app.route("/", createDashboardRoutes());

    if (environment.workers) {
      runtime.start();
    }

    return {
      app,
      fetch: (request) => app.fetch(request),
      runtime,
      storage,
      environment,
      ...(auth === undefined ? {} : { auth }),
      async stop() {
        await runtime.stop();
        await companyToolkit.close();
        await storage.close();
      },
    };
  } catch (error) {
    await toolkit?.close();
    await storage.close();
    throw error;
  }
}
