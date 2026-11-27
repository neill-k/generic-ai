import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  approvalRequesterForTask,
  createApprovalGate,
  createApprovalRoutes,
  createApprovalService,
} from "@generic-ai/plugin-approvals";
import {
  type AuthStore,
  authenticateOwnerRequest,
  createOwnerAuth,
  createOwnerAuthRoutes,
  createStorageContractAuthStore,
  type OwnerAuth,
  unauthorizedResponse,
} from "@generic-ai/plugin-auth-identity";
import {
  createSecretsFromEnvironment,
  SECRETS_KEY_ENV,
  type SecretsBroker,
} from "@generic-ai/plugin-secrets";
import {
  type AgentTaskExecutor,
  ALL_AUTH_SCOPES,
  type ApprovalServiceContract,
  type AuthContext,
  DEFAULT_APPROVAL_POLICY,
  type GoalCheck,
  type GoalJudge,
} from "@generic-ai/sdk";
import type { ImpossibilityReviewer } from "@generic-ai/plugin-delegation";
import { Hono } from "hono";

import { API_ROUTE_PREFIX, createCompanyApi } from "./api.js";
import {
  type CompanyConfig,
  DEFAULT_COMPANY,
  DEFAULT_TIER_MODELS,
  parseCompanyYaml,
} from "./company.js";
import { createDashboardRoutes } from "./dashboard.js";
import { type CompanyExecutorOptions, createCompanyTaskExecutor } from "./executor.js";
import {
  COMPANY_GOAL_METRICS,
  createCompanyGoalEvidence,
  createCompanyHandInCheck,
  createModelJudge,
} from "./goals.js";
import {
  createModelImpossibilityReviewer,
  secondOpinionModel,
  workerModelOf,
} from "./second-opinion.js";
import { type AgentIsolation, describeAgentIsolation, resolveAgentIsolation } from "./isolation.js";
import {
  type CompanyModelAuth,
  createCompanyModelAuth,
  providerKeyName,
  resolveProviderKeyFromEnv,
} from "./model-auth.js";
import { type CompanyRuntime, createCompanyRuntime } from "./runtime.js";
import { type CompanyStorage, openCompanyStorage } from "./storage.js";
import { DEFAULT_TEMPLATE, listCompanyTemplates, loadCompanyTemplate } from "./templates.js";
import { type CompanyToolkit, companySecretReferences, createCompanyToolkit } from "./toolkit.js";

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
  template: "GENERIC_CORP_TEMPLATE",
  databaseUrl: "DATABASE_URL",
  publicUrl: "GENERIC_AI_PUBLIC_URL",
  railwayDomain: "RAILWAY_PUBLIC_DOMAIN",
  setupToken: "GENERIC_AI_OWNER_SETUP_TOKEN",
  authToken: "GENERIC_AI_AUTH_TOKEN",
  trustProxy: "GENERIC_AI_TRUST_PROXY",
  insecureNoAuth: "GENERIC_CORP_INSECURE_NO_AUTH",
  workers: "GENERIC_CORP_WORKERS",
  turnLeaseMs: "GENERIC_CORP_TURN_LEASE_MS",
  workerConcurrency: "GENERIC_CORP_WORKER_CONCURRENCY",
});

/** Agent turns one process runs at the same time when nothing else is configured. */
export const DEFAULT_WORKER_CONCURRENCY = 4;

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
  /** Company template to start from when there is no company file. */
  readonly template?: string;
  readonly databaseUrl?: string;
  readonly publicOrigin?: string;
  readonly setupToken?: string;
  readonly authToken?: string;
  readonly trustProxyHeaders: boolean;
  /** Owner auth is off. Only allowed on a loopback host. */
  readonly insecureNoAuth: boolean;
  /** Run agent turns in this process. */
  readonly workers: boolean;
  /**
   * How long a worker holds an agent turn between heartbeats. If the process dies mid-turn,
   * another process picks the turn up once this lapses. Defaults to 30 seconds.
   */
  readonly turnLeaseMs?: number;
  /** Agent turns this process runs at the same time. Defaults to 4. */
  readonly workerConcurrency?: number;
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
  const template = read(env, ENV.template);
  const databaseUrl = read(env, ENV.databaseUrl);
  const leaseRaw = read(env, ENV.turnLeaseMs);
  const turnLeaseMs = leaseRaw === undefined ? undefined : Number(leaseRaw);
  if (turnLeaseMs !== undefined && (!Number.isInteger(turnLeaseMs) || turnLeaseMs < 1_000)) {
    throw new GenericCorpConfigError(`${ENV.turnLeaseMs} must be a whole number of at least 1000.`);
  }
  const concurrencyRaw = read(env, ENV.workerConcurrency);
  const workerConcurrency = concurrencyRaw === undefined ? undefined : Number(concurrencyRaw);
  if (
    workerConcurrency !== undefined &&
    (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 64)
  ) {
    throw new GenericCorpConfigError(
      `${ENV.workerConcurrency} must be a whole number from 1 to 64.`,
    );
  }
  return {
    host,
    port,
    dataDir,
    ...(companyFile === undefined ? {} : { companyFile: path.resolve(companyFile) }),
    ...(template === undefined ? {} : { template }),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(setupToken === undefined ? {} : { setupToken }),
    ...(authToken === undefined ? {} : { authToken }),
    trustProxyHeaders: flag(env, ENV.trustProxy, railway !== undefined),
    insecureNoAuth,
    workers: flag(env, ENV.workers, true),
    ...(turnLeaseMs === undefined ? {} : { turnLeaseMs }),
    ...(workerConcurrency === undefined ? {} : { workerConcurrency }),
  };
}

/**
 * The company to run: the company file when one is set, else the named template, else the
 * default Generic Corp template.
 */
export async function loadCompany(environment: GenericCorpEnvironment): Promise<CompanyConfig> {
  if (environment.companyFile !== undefined) {
    return parseCompanyYaml(await readFile(environment.companyFile, "utf8"));
  }
  if (environment.template !== undefined) {
    return loadCompanyTemplate(environment.template);
  }
  return listCompanyTemplates().includes(DEFAULT_TEMPLATE)
    ? loadCompanyTemplate(DEFAULT_TEMPLATE)
    : DEFAULT_COMPANY;
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
  /** Owner approvals for outward agent actions. */
  readonly approvals: ApprovalServiceContract;
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
  /** Whether `secrets` can store values. Defaults to whether `GENERIC_AI_SECRETS_KEY` is set. */
  readonly secretsWritable?: boolean;
  /** Replaces the generic-work toolkit, for tests. */
  readonly toolkit?: CompanyToolkit;
  /**
   * Judges and checks for goals. Rubrics default to a model judge on a model other than the
   * worker's (decision 12); without a key for it, rubric checks report an error and the goal
   * stays incomplete. Impossibility claims default to a reviewer on such a model too.
   */
  readonly goals?: {
    readonly judges?: GoalJudge | Readonly<Record<string, GoalJudge>>;
    readonly impossibility?: ImpossibilityReviewer;
    readonly checks?: Readonly<Record<string, GoalCheck>>;
  };
  /** How agent commands run. Defaults to `resolveAgentIsolation` over the environment. */
  readonly agentIsolation?: AgentIsolation;
  /**
   * What powers the agents: the owner's Claude sign-in or an API key. Defaults to a credential
   * file at `<dataDir>/model-auth.json`, falling back to the provider's key in the environment
   * or the secrets vault.
   */
  readonly modelAuth?: CompanyModelAuth;
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
    const secretsWritable =
      options.secretsWritable ??
      ((options.env ?? process.env)[SECRETS_KEY_ENV] ?? "").trim().length > 0;
    for (const name of secrets.weakNames()) {
      log(`Secret ${name} is too short to redact reliably. Use a longer value.`);
    }
    const processEnv = options.env ?? process.env;
    const modelAuth =
      options.modelAuth ??
      createCompanyModelAuth({
        path: path.join(environment.dataDir, "model-auth.json"),
        fallback: async (provider) =>
          resolveProviderKeyFromEnv(provider, processEnv) ??
          (await secrets.get(providerKeyName(provider), "host")),
      });
    const agentIsolation =
      options.agentIsolation ?? resolveAgentIsolation(options.env ?? process.env);
    log(describeAgentIsolation(agentIsolation));
    toolkit =
      options.toolkit ??
      createCompanyToolkit({
        company,
        secrets,
        env: options.env ?? process.env,
        ...(agentIsolation.runAs === undefined ? {} : { runAs: agentIsolation.runAs }),
      });
    const companyToolkit = toolkit;
    // Outward actions (messages, external writes, payments, writing MCP tools) wait for the
    // owner. A gated call ends the agent's turn; the cascade parks the task as `waiting` and
    // resumes it once every request is decided.
    const approvals = createApprovalService({ runStore: storage.runStore });
    const approvalPolicy = company.approvals ?? DEFAULT_APPROVAL_POLICY;
    const executor =
      options.executor ??
      createCompanyTaskExecutor({
        capabilities: (input) =>
          createApprovalGate({
            service: approvals,
            requester: approvalRequesterForTask(input, input.actor),
            policy: approvalPolicy,
          }).wrapBindings(companyToolkit.capabilities(input)),
        secretGrants: (agentId) => companyToolkit.secretGrants(agentId),
        ...options.executorOptions,
        native: {
          getAuth: (provider) => modelAuth.getAuth(provider),
          ...options.executorOptions?.native,
        },
        runStore: storage.runStore,
        artifactsRoot: path.join(environment.dataDir, "artifacts"),
      });
    // A goal on the CEO's task is the company's goal: it is checked against the whole team's
    // work and the files handed in with submit_work (see goals.ts). Second opinions (the rubric
    // judge, the impossibility reviewer) run on a model other than the worker's.
    let runtimeRef: CompanyRuntime | undefined;
    const started = () => {
      if (runtimeRef === undefined) {
        throw new Error("The company is not running yet.");
      }
      return runtimeRef;
    };
    const agentsRoot = path.join(environment.dataDir, "agents");
    // Deliverable paths are relative to the folder that holds the agents' homes.
    const companyRoot = path.dirname(agentsRoot);
    const judgeByModel = new Map<string, GoalJudge>();
    const runtime = createCompanyRuntime({
      company,
      storage,
      agentsRoot,
      executor,
      cascade: {
        approvals,
        worker: {
          concurrency: environment.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY,
          ...(environment.turnLeaseMs === undefined ? {} : { leaseMs: environment.turnLeaseMs }),
        },
        checkHandIn: createCompanyHandInCheck({
          companyRoot,
          readableRoots: [agentsRoot],
        }),
        impossibility:
          options.goals?.impossibility ??
          createModelImpossibilityReviewer({
            modelFor: (agent) => secondOpinionModel(company, workerModelOf(company, agent)),
            getAuth: (provider) => modelAuth.getAuth(provider),
          }),
        goals: {
          ...(options.goals?.judges === undefined
            ? {
                judgesFor: ({ agent }) => {
                  const model = secondOpinionModel(company, workerModelOf(company, agent));
                  let judge = judgeByModel.get(model);
                  if (judge === undefined) {
                    judge = createModelJudge({
                      model,
                      getAuth: (provider) => modelAuth.getAuth(provider),
                    });
                    judgeByModel.set(model, judge);
                  }
                  return judge;
                },
              }
            : { judges: options.goals.judges }),
          metrics: COMPANY_GOAL_METRICS,
          ...(options.goals?.checks === undefined ? {} : { checks: options.goals.checks }),
          evidence: createCompanyGoalEvidence({
            runStore: storage.runStore,
            cascade: () => started().cascade,
            directory: () => started().directory,
            companyRoot,
            readableRoots: [agentsRoot],
          }),
        },
      },
      log,
    });
    runtimeRef = runtime;
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
          agentIsolation: agentIsolation.mode,
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
    // The approvals inbox comes before the company API, whose not-found handler covers /api.
    app.route(
      API_ROUTE_PREFIX,
      createApprovalRoutes(approvals, {
        authenticate: async (request) =>
          ownerAuth === undefined
            ? LOCAL_OWNER
            : await authenticateOwnerRequest(ownerAuth, request),
        onDecided: async (approval) => {
          await runtime.cascade.approvalDecided(approval.approvalId);
        },
      }),
    );
    app.route(
      API_ROUTE_PREFIX,
      createCompanyApi(runtime, {
        toolkit: companyToolkit,
        modelAuth,
        secrets: {
          writable: secretsWritable,
          references: companySecretReferences(company),
          list: () => secrets.list(),
          set: (name, value, setOptions) => secrets.set(name, value, setOptions),
          delete: (name) => secrets.delete(name),
        },
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
      approvals,
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
