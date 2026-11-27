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
import type { ImpossibilityReviewer } from "@generic-ai/plugin-delegation";
import {
  createSecretsFromEnvironment,
  SECRETS_KEY_ENV,
  type SecretsBroker,
} from "@generic-ai/plugin-secrets";
import {
  type AgentTaskExecutor,
  ALL_AUTH_SCOPES,
  type AuthContext,
  type GoalCheck,
  type GoalJudge,
} from "@generic-ai/sdk";
import { Hono } from "hono";

import { API_ROUTE_PREFIX, createCompanyApi } from "./api.js";
import {
  type BackgroundModel,
  createBackgroundGate,
  createBackgroundTimer,
  createMemoryBackgroundStore,
  createModelBackground,
  DEFAULT_BACKGROUND_MODEL,
} from "./background.js";
import {
  BackupError,
  type CompanyBackups,
  createCompanyBackups,
  readBackupSettings,
} from "./backups.js";
import { type CompanyCheckup, createCompanyCheckup } from "./checkup.js";
import { type CompanyConfig, DEFAULT_COMPANY, parseCompanyYaml } from "./company.js";
import { createDashboardRoutes } from "./dashboard.js";
import { createDreaming } from "./dreaming.js";
import { companyLayout, createCompanyDrive } from "./drive.js";
import {
  type AgentNetwork,
  type AgentNetworkProbe,
  createEgressProxy,
  describeAgentNetwork,
  type EgressProxy,
  readAgentNetworkPolicy,
  readEgressPort,
  resolveAgentNetwork,
} from "./egress.js";
import { type CompanyExecutorOptions, createCompanyTaskExecutor } from "./executor.js";
import { createGithubConnector, type GithubConnector } from "./github.js";
import {
  COMPANY_GOAL_METRICS,
  createCompanyGoalEvidence,
  createCompanyHandInCheck,
  createModelJudge,
} from "./goals.js";
import { createCompanyHarvest } from "./harvest.js";
import { type AgentIsolation, describeAgentIsolation, resolveAgentIsolation } from "./isolation.js";
import { createCompanyMemory } from "./memory.js";
import { createMemoryTools } from "./memory-tools.js";
import {
  type CompanyModelAuth,
  createCompanyModelAuth,
  providerKeyName,
  resolveProviderKeyFromEnv,
} from "./model-auth.js";
import {
  DEFAULT_PERMISSIONS,
  gateToolsWithPermissions,
  openPermissionStore,
  type PermissionStore,
  permissionsBriefing,
} from "./permissions.js";
import { createPreferenceScanner, type OwnerMessage } from "./preferences.js";
import { openQualityStore } from "./quality.js";
import { createRefusalLog, type RefusalLog } from "./refusals.js";
import { resolveCompanyRlm } from "./rlm.js";
import { type CompanyRuntime, createCompanyRuntime } from "./runtime.js";
import {
  createModelImpossibilityReviewer,
  secondOpinionModel,
  workerModelOf,
} from "./second-opinion.js";
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
  noProgressMinutes: "GENERIC_CORP_NO_PROGRESS_MINUTES",
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
  /**
   * Loopback port of the egress proxy agent commands go through (`GENERIC_CORP_EGRESS_PORT`,
   * default 3128; the image's firewall rule names it). Left out, a free port is picked.
   */
  readonly egressPort?: number;
  /**
   * Minutes a turn may go without any tool activity before it is stopped and retried (the
   * no-progress check that replaced the turn time limit). Defaults to 15.
   */
  readonly noProgressMinutes?: number;
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
  const noProgressRaw = read(env, ENV.noProgressMinutes);
  const noProgressMinutes = noProgressRaw === undefined ? undefined : Number(noProgressRaw);
  if (
    noProgressMinutes !== undefined &&
    (!Number.isFinite(noProgressMinutes) || noProgressMinutes < 1 || noProgressMinutes > 1440)
  ) {
    throw new GenericCorpConfigError(`${ENV.noProgressMinutes} must be a number from 1 to 1440.`);
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
    egressPort: readEgressPort(env),
    ...(noProgressMinutes === undefined ? {} : { noProgressMinutes }),
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
  /** The owner's permissions, which every agent tool call is checked against. */
  readonly permissions: PermissionStore;
  /** Actions refused on the spot, for the owner to read. */
  readonly refusals: RefusalLog;
  /** How agent commands reach the network. */
  readonly agentNetwork: AgentNetwork;
  readonly backups: CompanyBackups;
  stop(): Promise<void>;
}

export interface CreateGenericCorpServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly environment?: GenericCorpEnvironment;
  readonly company?: CompanyConfig;
  /** Replaces the native-runtime executor, for tests and alternate runtimes. */
  readonly executor?: AgentTaskExecutor;
  readonly executorOptions?: Omit<
    CompanyExecutorOptions,
    "runStore" | "artifactsRoot" | "sessionsRoot"
  >;
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
  /**
   * The model background memory work uses (the preference scanner, dreaming). Defaults to
   * `GENERIC_CORP_MEMORY_MODEL` or a small Claude model on the owner's sign-in. Background jobs
   * only run while workers run.
   */
  readonly backgroundModel?: BackgroundModel;
  /** Why background memory work may not spend now (spending limits, company pause). */
  readonly canSpendInBackground?: () => Promise<string | undefined> | string | undefined;
  /** How agent commands run. Defaults to `resolveAgentIsolation` over the environment. */
  readonly agentIsolation?: AgentIsolation;
  /** Replaces the check that the agent user's firewall rule holds, for tests. */
  readonly agentNetworkProbe?: AgentNetworkProbe;
  /**
   * What powers the agents: the owner's Claude sign-in or an API key. Defaults to a credential
   * file at `<dataDir>/model-auth.json`, falling back to the provider's key in the environment
   * or the secrets vault.
   */
  readonly modelAuth?: CompanyModelAuth;
  /**
   * Whether agents have memory: the handbook and private-memory section in each prompt, and the
   * remember and forget tools. Defaults to true; the baseline comparison turns it off to measure
   * what memory is worth.
   */
  readonly agentMemory?: boolean;
  /**
   * The owner's checkup (the live baseline comparison, `/api/checkup`). Defaults to one that runs
   * the company's own template with this server's model sign-in; `false` leaves it out.
   */
  readonly checkup?: CompanyCheckup | false;
  /**
   * An egress proxy to share instead of starting one, for a server started inside another (the
   * checkup's companies). It is neither started nor stopped here.
   */
  readonly egressProxy?: Pick<EgressProxy, "envFor">;
  /**
   * Nightly backups of the database and the company's files. Defaults to the schedule the
   * `GENERIC_CORP_BACKUP*` variables describe (backups.ts).
   */
  readonly backups?: CompanyBackups;
  /**
   * The GitHub connector. Defaults to a credential file at `<dataDir>/connectors/github.json`
   * (or `GENERIC_CORP_GITHUB_TOKEN`). Tests pass one with a fake `fetch`.
   */
  readonly github?: GithubConnector;
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
  let egress: EgressProxy | undefined;
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
    const layout = companyLayout(environment.dataDir);
    const drive = createCompanyDrive({ layout, kv: storage.kv });
    const processEnv = options.env ?? process.env;
    let publishBackupStatus: ((status: Readonly<Record<string, unknown>>) => void) | undefined;
    const backups =
      options.backups ??
      createCompanyBackups({
        dataDir: environment.dataDir,
        database:
          environment.databaseUrl === undefined
            ? { driver: "sqlite", path: path.join(environment.dataDir, "company.sqlite") }
            : { driver: "postgres", connectionString: environment.databaseUrl },
        settings: (() => {
          try {
            return readBackupSettings(processEnv, environment.dataDir);
          } catch (error) {
            if (error instanceof BackupError) {
              throw new GenericCorpConfigError(error.message);
            }
            throw error;
          }
        })(),
        log,
        onChange: (status) => publishBackupStatus?.({ ...status }),
      });
    const modelAuth =
      options.modelAuth ??
      createCompanyModelAuth({
        path: path.join(environment.dataDir, "model-auth.json"),
        fallback: async (provider) =>
          resolveProviderKeyFromEnv(provider, processEnv) ??
          (await secrets.get(providerKeyName(provider), "host")),
      });
    const github =
      options.github ??
      createGithubConnector({
        credentialPath: path.join(environment.dataDir, "connectors", "github.json"),
        env: processEnv,
      });
    const agentIsolation =
      options.agentIsolation ?? resolveAgentIsolation(options.env ?? process.env);
    log(describeAgentIsolation(agentIsolation));
    // The wall between the company and the outside world: agent shell commands reach the
    // network only through the egress proxy and its allowlist (egress.ts).
    const refusals = createRefusalLog(storage.kv);
    // Permissions and standing rules live in host storage, which no agent tool can reach.
    const permissions = await openPermissionStore(
      storage.kv,
      company.permissions ?? DEFAULT_PERMISSIONS,
    );
    const networkPolicy = readAgentNetworkPolicy(options.env ?? process.env);
    const agentNetwork = await resolveAgentNetwork(
      networkPolicy,
      agentIsolation,
      options.agentNetworkProbe,
    );
    log(describeAgentNetwork(agentNetwork));
    // A server started inside another (the checkup's companies) shares that server's proxy: the
    // agent firewall only lets the agent user reach the one fixed egress port.
    const sharedEgress = networkPolicy === "off" ? undefined : options.egressProxy;
    if (networkPolicy !== "off" && sharedEgress === undefined) {
      const proxy = createEgressProxy({
        allow: () => permissions.current().shellHosts,
        port: environment.egressPort ?? 0,
        onRefused: (refusal) => {
          void refusals
            .record({
              kind: "network",
              ...(refusal.agentId === undefined ? {} : { agentId: refusal.agentId }),
              category: "network",
              action: `${refusal.method} ${refusal.host}:${refusal.port}`,
              reason: refusal.reason,
            })
            .catch(() => undefined);
        },
      });
      await proxy.start();
      egress = proxy;
    }
    const egressProxy: Pick<EgressProxy, "envFor"> | undefined = sharedEgress ?? egress;
    // Every role's Python workspace runs behind the same wall: as the agent user, with the
    // command limits and this agent's egress proxy settings (rlm.ts).
    const rlm = resolveCompanyRlm(options.env ?? process.env, agentIsolation, {
      ...(egressProxy === undefined
        ? {}
        : { agentEnv: (agentId: string) => egressProxy.envFor(agentId) }),
    });
    log(rlm.description);
    toolkit =
      options.toolkit ??
      createCompanyToolkit({
        company,
        secrets,
        env: options.env ?? process.env,
        // Every agent works from the company root: the shared drive and every agent's home.
        toolRoot: () => layout.root,
        github,
        ...(agentIsolation.runAs === undefined ? {} : { runAs: agentIsolation.runAs }),
        ...(egressProxy === undefined
          ? {}
          : { commandEnv: (agentId: string) => egressProxy.envFor(agentId) }),
      });
    const companyToolkit = toolkit;
    // One memory system (decision 17): the company handbook and each agent's private memory, in
    // host storage where agent shells cannot reach it. Agents change their own through tools.
    const memory = createCompanyMemory({
      kv: storage.kv,
      legacyNotes: (agentId) =>
        readFile(path.join(layout.agentsRoot, agentId, "context.md"), "utf8"),
    });
    // Scripts an agent writes are kept once its task is accepted (decision 28), outside the
    // company folder, for dreaming to turn into saved procedures.
    const harvest = createCompanyHarvest({
      kv: storage.kv,
      companyRoot: layout.root,
      root: path.join(environment.dataDir, "harvest"),
    });
    const withMemoryTools = (
      bindings: ReturnType<CompanyToolkit["capabilities"]>,
      input: Parameters<CompanyToolkit["capabilities"]>[0],
    ): ReturnType<CompanyToolkit["capabilities"]> => ({
      ...harvest.wrapBindings(bindings, input),
      customTools: [
        ...(bindings.customTools ?? []),
        ...(options.agentMemory === false
          ? []
          : createMemoryTools({ memory, agentId: input.agentId, taskId: input.taskId })),
      ],
    });
    // Every tool call is checked against the owner's permissions. An action outside them is
    // refused on the spot and logged; nothing waits for the owner (design decision 37).
    const defaultExecutor = createCompanyTaskExecutor({
      capabilities: (input) =>
        gateToolsWithPermissions(withMemoryTools(companyToolkit.capabilities(input), input), {
          permissions: () => permissions.current(),
          refusals,
          agentId: input.agentId,
          taskId: input.taskId,
          verifyGreenChecks: (call) => github.verifyGreenChecks(call),
        }),
      secretGrants: (agentId) => companyToolkit.secretGrants(agentId),
      ...(environment.noProgressMinutes === undefined
        ? {}
        : { noProgress: { idleMs: environment.noProgressMinutes * 60_000 } }),
      ...options.executorOptions,
      native: {
        getAuth: (provider) => modelAuth.getAuth(provider),
        ...(rlm.option === undefined ? {} : { rlm: rlm.option }),
        ...options.executorOptions?.native,
      },
      runStore: storage.runStore,
      artifactsRoot: path.join(environment.dataDir, "artifacts"),
      sessionsRoot: path.join(environment.dataDir, "sessions"),
    });
    const baseExecutor: AgentTaskExecutor =
      options.executor ??
      ((input) =>
        defaultExecutor({
          ...input,
          prompt: `${permissionsBriefing(permissions.current())}\n${input.prompt}`,
        }));
    // The owner's quality dial picks the model for each turn (decision 22).
    const quality = await openQualityStore(storage.kv, company);
    const executor: AgentTaskExecutor = (input) =>
      baseExecutor({ ...input, model: quality.modelFor(input.agentId) });
    const workerModel = (agent: { readonly id: string; readonly model?: string }) =>
      workerModelOf(company, { ...agent, model: quality.modelFor(agent.id) });
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
    // Deliverable paths are relative to the company root, as agents write them.
    const companyRoot = layout.root;
    const judgeByModel = new Map<string, GoalJudge>();
    const runtime = createCompanyRuntime({
      company,
      storage,
      agentsRoot: layout.agentsRoot,
      drive,
      memory,
      ...(options.agentMemory === false ? { memoryInPrompts: false } : {}),
      harvest,
      executor,
      quality: (agentId) => {
        const level = quality.levelOf(agentId);
        return { ...(level === undefined ? {} : { level }), model: quality.modelFor(agentId) };
      },
      cascade: {
        worker: {
          concurrency: environment.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY,
          ...(environment.turnLeaseMs === undefined ? {} : { leaseMs: environment.turnLeaseMs }),
        },
        checkHandIn: createCompanyHandInCheck({
          companyRoot,
        }),
        impossibility:
          options.goals?.impossibility ??
          createModelImpossibilityReviewer({
            modelFor: (agent) => secondOpinionModel(company, workerModel(agent)),
            getAuth: (provider) => modelAuth.getAuth(provider),
          }),
        goals: {
          ...(options.goals?.judges === undefined
            ? {
                judgesFor: ({ agent }) => {
                  const model = secondOpinionModel(company, workerModel(agent));
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
          }),
        },
      },
      log,
    });
    runtimeRef = runtime;
    await runtime.initialize();
    publishBackupStatus = (status) => runtime.events.publish("backups.updated", status);

    // Background memory work (decisions 18 and 19): frugal, pausable, one job at a time.
    const background = createMemoryBackgroundStore({ kv: storage.kv });
    const backgroundGate = createBackgroundGate({
      store: background,
      ...(options.canSpendInBackground === undefined
        ? {}
        : { canSpend: options.canSpendInBackground }),
    });
    const backgroundModel =
      options.backgroundModel ??
      createModelBackground({
        model: processEnv["GENERIC_CORP_MEMORY_MODEL"]?.trim() || DEFAULT_BACKGROUND_MODEL,
        getAuth: (provider) => modelAuth.getAuth(provider),
      });
    const scanner = createPreferenceScanner({
      memory,
      store: background,
      model: backgroundModel,
      gate: backgroundGate,
      messages: async () => {
        const threads = await runtime.threads.list();
        const messages: OwnerMessage[] = threads.flatMap((thread) =>
          thread.messages.map((message) => ({
            messageId: message.messageId,
            threadId: thread.threadId,
            text: message.text,
            createdAt: message.createdAt,
            agentId: runtime.ceoId,
          })),
        );
        return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      },
      agents: async () =>
        (await runtime.directory.list()).map((agent) => ({
          id: agent.id,
          title: agent.title ?? agent.role,
        })),
    });
    const sessionsRoot = path.join(environment.dataDir, "sessions");
    const dreaming = createDreaming({
      memory,
      store: background,
      model: backgroundModel,
      gate: backgroundGate,
      sessionsRoot,
      harvest,
      agents: async () => (await runtime.directory.list()).map((agent) => agent.id),
      lastActive: async (agentId) => {
        const tasks = await runtime.listTasks({ agentId, limit: 50 });
        if (tasks.some((task) => ["queued", "running", "waiting"].includes(task.status))) {
          return "working";
        }
        const latest = tasks
          .map((task) => task.completedAt ?? task.updatedAt)
          .sort()
          .at(-1);
        return latest === undefined ? undefined : new Date(latest);
      },
    });
    const dreamingTimer = createBackgroundTimer(
      async () => Math.min(30, (await background.settings()).dreaming.idleMinutes) * 60_000,
      async () => {
        await dreaming.tick();
      },
      (error) => log(`Dreaming failed: ${String(error)}`),
    );
    const scannerTimer = createBackgroundTimer(
      async () => (await background.settings()).scanner.intervalMinutes * 60_000,
      async () => {
        if ((await background.settings()).scanner.enabled) {
          await scanner.scan();
        }
      },
      (error) => log(`Preference scan failed: ${String(error)}`),
    );

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
          agentNetwork: agentNetwork.mode,
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
    // The live baseline comparison, run only when the owner presses "run the checkup".
    const checkup =
      options.checkup === false
        ? undefined
        : (options.checkup ??
          createCompanyCheckup({
            kv: storage.kv,
            modelAuth,
            env: options.env ?? process.env,
            ...(egressProxy === undefined ? {} : { egressProxy }),
            log,
          }));
    app.route(
      API_ROUTE_PREFIX,
      createCompanyApi(runtime, {
        toolkit: companyToolkit,
        memoryBackground: {
          store: background,
          scan: async () => scanner.scan(),
          dream: async (agentId) => dreaming.dream(agentId, { force: true }),
        },
        refusals,
        modelAuth,
        permissions,
        ...(checkup === undefined ? {} : { checkup }),
        backups,
        github,
        companyRoot: layout.root,
        quality,
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
      scannerTimer.start();
      dreamingTimer.start();
    }
    backups.start();
    if (backups.settings.enabled) {
      log(
        `Backups: nightly at ${String(backups.settings.hour).padStart(2, "0")}:00 server time into ${backups.settings.dir}, keeping ${backups.settings.keep}.`,
      );
    } else {
      log("Backups: nightly backups are off (GENERIC_CORP_BACKUPS=off).");
    }

    return {
      app,
      fetch: (request) => app.fetch(request),
      runtime,
      storage,
      environment,
      ...(auth === undefined ? {} : { auth }),
      permissions,
      refusals,
      agentNetwork,
      backups,
      async stop() {
        await backups.stop();
        await scannerTimer.stop();
        await dreamingTimer.stop();
        await runtime.stop();
        await companyToolkit.close();
        await egress?.stop();
        await storage.close();
      },
    };
  } catch (error) {
    await toolkit?.close();
    await egress?.stop();
    await storage.close();
    throw error;
  }
}
