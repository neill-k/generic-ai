import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentHarness,
  createGenericAILlmRuntime,
  DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
  DEFAULT_OPENAI_CODEX_MODEL,
  type CreateGenericAILlmRuntimeOptions,
  type GenericAIConfiguredBootstrap,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
  type GenericAILlmRuntimeAdapter,
} from "@generic-ai/core";
import {
  createHonoPlugin,
  type HonoAuthorizeHandler,
  type HonoPlugin,
} from "@generic-ai/plugin-hono";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import { createHonoWebUiTransport, createWebUiPlugin } from "@generic-ai/plugin-web-ui/server";
import type { WebUiHarnessRunnerInput, WebUiHarnessRunnerResult } from "@generic-ai/plugin-web-ui";
import { createStarterHonoBootstrapFromYaml } from "@generic-ai/preset-starter-hono";
import {
  getAgentHarnessToolEffects,
  type AgentHarnessConfig,
  type AgentHarnessRunResult,
} from "@generic-ai/sdk";

const providerKeyName = "GENERIC_AI_PROVIDER_API_KEY";
const modelName = "GENERIC_AI_MODEL";
const adapterName = "GENERIC_AI_RUNTIME_ADAPTER";
const workspaceRootName = "GENERIC_AI_WORKSPACE_ROOT";
const hostName = "GENERIC_AI_HOST";
const portName = "GENERIC_AI_PORT";
const fallbackHostName = "HOST";
const fallbackPortName = "PORT";
const unsafeExposeName = "GENERIC_AI_UNSAFE_EXPOSE";
const authTokenName = "GENERIC_AI_AUTH_TOKEN";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const SUPPORTED_ADAPTERS = new Set<GenericAILlmRuntimeAdapter>(["openai-codex", "pi"]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UI_PUBLIC_DIR = resolve(PACKAGE_ROOT, "dist", "public");
const UNAUTHORIZED_RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "www-authenticate": 'Bearer realm="generic-ai-starter"',
} as const;
const STATIC_SECURITY_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;
const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
} as const;

export const STARTER_ROUTE_PREFIX = "/starter" as const;
export const WEB_UI_ROUTE_PREFIX = "/console/api" as const;
export const STARTER_DEFAULT_START_DIR = PACKAGE_ROOT;

export class StarterExampleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterExampleConfigError";
  }
}

export interface StarterExampleEnvironment {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly apiKey?: string;
  readonly model?: string;
  readonly workspaceRoot?: string;
  readonly host: string;
  readonly port: number;
  readonly unsafeExpose: boolean;
  readonly authToken?: string;
  readonly exposure: "loopback" | "authenticated-remote" | "unsafe-remote";
}

export interface StarterExampleServer {
  readonly app: HonoPlugin["app"];
  readonly transport: HonoPlugin;
  readonly webUi: ReturnType<typeof createWebUiPlugin>;
  readonly webUiTransport: ReturnType<typeof createHonoWebUiTransport>;
  readonly fetch: (request: Request) => Promise<Response> | Response;
  readonly bootstrap: GenericAIConfiguredBootstrap<GenericAILlmRuntime>;
  readonly runtime: GenericAILlmRuntime;
  readonly environment: StarterExampleEnvironment;
  readonly workspaceRoot: string;
  readonly stop: () => Promise<void>;
}

export interface StarterExampleServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly startDir?: string;
  readonly uiPublicDir?: string;
  readonly createRuntime?: (
    options: CreateGenericAILlmRuntimeOptions,
  ) => Promise<GenericAILlmRuntime> | GenericAILlmRuntime;
  readonly createHarness?: typeof createAgentHarness;
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new StarterExampleConfigError(
      `${portName} must be an integer between 0 and 65535.`,
    );
  }

  return value;
}

function parseBooleanFlag(raw: string | undefined, key: string): boolean {
  if (raw === undefined) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  throw new StarterExampleConfigError(`${key} must be 1/true/yes or 0/false/no.`);
}

function normalizeBindHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function isIpv6Loopback(host: string): boolean {
  const normalized = host.split("%", 1)[0]?.toLowerCase();
  if (normalized === undefined || isIP(normalized) !== 6) {
    return false;
  }

  const compressedParts = normalized.split("::");
  if (compressedParts.length > 2) {
    return false;
  }

  const head = compressedParts[0]?.length === 0 ? [] : (compressedParts[0]?.split(":") ?? []);
  const tail =
    compressedParts.length === 1 || compressedParts[1]?.length === 0
      ? []
      : (compressedParts[1]?.split(":") ?? []);
  const zeroFill =
    compressedParts.length === 1 ? [] : Array(8 - head.length - tail.length).fill("0");
  const groups = [...head, ...zeroFill, ...tail];

  if (groups.length !== 8) {
    return false;
  }

  return (
    groups.slice(0, 7).every((group) => Number.parseInt(group || "0", 16) === 0) &&
    Number.parseInt(groups[7] || "0", 16) === 1
  );
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = normalizeBindHost(host).toLowerCase();
  if (normalized === "localhost" || isIpv6Loopback(normalized)) {
    return true;
  }

  if (isIP(normalized) !== 4) {
    return false;
  }

  const firstOctet = Number(normalized.split(".")[0]);
  return Number.isInteger(firstOctet) && firstOctet === 127;
}

function resolveExposure(
  host: string,
  unsafeExpose: boolean,
  authToken: string | undefined,
): StarterExampleEnvironment["exposure"] {
  if (isLoopbackBindHost(host)) {
    return "loopback";
  }

  if (authToken !== undefined) {
    return "authenticated-remote";
  }

  if (unsafeExpose) {
    return "unsafe-remote";
  }

  throw new StarterExampleConfigError(
    `${hostName}/${fallbackHostName} is set to non-loopback host "${host}". ` +
      `Set ${unsafeExposeName}=1 for deliberate unauthenticated exposure or configure ${authTokenName}.`,
  );
}

function createTokenAuthorization(authToken: string | undefined): HonoAuthorizeHandler | undefined {
  if (authToken === undefined) {
    return undefined;
  }

  return ({ request }: { readonly request: Request }): Response | undefined => {
    const authorization = request.headers.get("authorization");
    const genericAiToken = request.headers.get("x-generic-ai-token");
    if (authorization === `Bearer ${authToken}` || genericAiToken === authToken) {
      return undefined;
    }

    return new Response(
      JSON.stringify({
        error: `Missing or invalid bearer token. Set Authorization: Bearer <${authTokenName}>.`,
      }),
      {
        status: 401,
        headers: UNAUTHORIZED_RESPONSE_HEADERS,
      },
    );
  };
}

function normalizePrompt(input: unknown): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  if (input === undefined || input === null) {
    return "Summarize the Generic AI starter stack.";
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }

    return "Summarize the Generic AI starter stack.";
  }

  return JSON.stringify(input, null, 2);
}

interface StarterRuntimeActivityEvent {
  readonly event: string;
  readonly data: unknown;
}

interface StarterAsyncQueue<T> {
  readonly push: (value: T) => void;
  readonly close: () => void;
  readonly next: () => Promise<IteratorResult<T>>;
}

type StarterBootstrapStreamChunk =
  | {
      readonly type: "event";
      readonly event: {
        readonly name: string;
      };
    }
  | {
      readonly type: "envelope";
      readonly envelope: unknown;
    };

type StarterMergedStreamRead =
  | {
      readonly source: "bootstrap";
      readonly result: IteratorResult<StarterBootstrapStreamChunk>;
    }
  | {
      readonly source: "runtime";
      readonly result: IteratorResult<StarterRuntimeActivityEvent>;
    };

function createStarterAsyncQueue<T>(): StarterAsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(value) {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ done: false, value });
        return;
      }

      values.push(value);
    },
    close() {
      if (closed) {
        return;
      }

      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter({ done: true, value: undefined });
      }
    },
    async next() {
      if (values.length > 0) {
        const value = values.shift() as T;
        return { done: false, value };
      }

      if (closed) {
        return { done: true, value: undefined };
      }

      return await new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function queueStarterRuntimeActivity(
  runtimeEvents: StarterAsyncQueue<StarterRuntimeActivityEvent>,
  event: StarterRuntimeActivityEvent,
): void {
  runtimeEvents.push(event);
}

async function collectRuntimeStream(
  runtime: GenericAILlmRuntime,
  prompt: string,
  signal: AbortSignal,
  runtimeEvents: StarterAsyncQueue<StarterRuntimeActivityEvent>,
): Promise<GenericAILlmRunResult> {
  let response: GenericAILlmRunResult | undefined;

  try {
    for await (const chunk of runtime.stream(prompt, { signal })) {
      switch (chunk.type) {
        case "event":
          queueStarterRuntimeActivity(runtimeEvents, {
            event: chunk.event.name,
            data: chunk.event.data,
          });
          break;

        case "text-delta":
          queueStarterRuntimeActivity(runtimeEvents, {
            event: "runtime.text.delta",
            data: { delta: chunk.delta },
          });
          break;

        case "response":
          response = chunk.response;
          break;

        default: {
          const exhaustive: never = chunk;
          throw new Error(`Unsupported runtime stream chunk: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  } finally {
    runtimeEvents.close();
  }

  if (response === undefined) {
    throw new Error("Runtime stream completed without a response.");
  }

  return response;
}

function readStarterBootstrapStream(
  iterator: AsyncIterator<StarterBootstrapStreamChunk>,
): Promise<StarterMergedStreamRead> {
  return iterator.next().then((result) => ({
    source: "bootstrap",
    result,
  }));
}

function readStarterRuntimeActivity(
  runtimeEvents: StarterAsyncQueue<StarterRuntimeActivityEvent>,
): Promise<StarterMergedStreamRead> {
  return runtimeEvents.next().then((result) => ({
    source: "runtime",
    result,
  }));
}

async function* mergeStarterStreams(
  bootstrapStream: AsyncIterable<StarterBootstrapStreamChunk>,
  runtimeEvents: StarterAsyncQueue<StarterRuntimeActivityEvent>,
): AsyncIterable<StarterRuntimeActivityEvent> {
  const iterator = bootstrapStream[Symbol.asyncIterator]();
  let bootstrapDone = false;
  let runtimeDone = false;
  let bootstrapNext: Promise<StarterMergedStreamRead> | undefined =
    readStarterBootstrapStream(iterator);
  let runtimeNext: Promise<StarterMergedStreamRead> | undefined =
    readStarterRuntimeActivity(runtimeEvents);

  try {
    while (!bootstrapDone || !runtimeDone) {
      const pending = [bootstrapNext, runtimeNext].filter(
        (promise): promise is Promise<StarterMergedStreamRead> => promise !== undefined,
      );
      if (pending.length === 0) {
        break;
      }

      const next = await Promise.race(pending);
      if (next.source === "bootstrap") {
        if (next.result.done) {
          bootstrapDone = true;
          bootstrapNext = undefined;
          runtimeEvents.close();
          continue;
        }

        const chunk = next.result.value;
        bootstrapNext = readStarterBootstrapStream(iterator);
        yield chunk.type === "event"
          ? {
              event: chunk.event.name,
              data: chunk.event,
            }
          : {
              event: "run.envelope",
              data: chunk.envelope,
            };
        continue;
      }

      if (next.result.done) {
        runtimeDone = true;
        runtimeNext = undefined;
        continue;
      }

      runtimeNext = readStarterRuntimeActivity(runtimeEvents);
      yield next.result.value;
    }
  } finally {
    runtimeEvents.close();
    await iterator.return?.();
  }
}

function createReadOnlyHarnessCapabilities(workspaceRoot: string) {
  const files = createWorkspaceFileTools({ root: workspaceRoot });
  return {
    fileTools: {
      piTools: files.piTools.filter((tool) => {
        const effects = getAgentHarnessToolEffects(tool);
        return effects.length > 0 && effects.every((effect) => effect !== "fs.write");
      }),
    },
  };
}

function buildHarnessInstruction(input: WebUiHarnessRunnerInput): string {
  const agentLines =
    input.agent === undefined
      ? []
      : [
          `Selected agent id: ${input.agent.id}`,
          ...(input.agent.displayName === undefined
            ? []
            : [`Selected agent name: ${input.agent.displayName}`]),
          ...(input.agent.model === undefined ? [] : [`Selected agent model: ${input.agent.model}`]),
          ...(input.agent.instructions === undefined
            ? []
            : ["Selected agent instructions:", input.agent.instructions]),
          "",
        ];

  return [
    ...agentLines,
    ...(input.harness === undefined
      ? []
      : [
          `Selected harness id: ${input.harness.id}`,
          ...(input.harness.displayName === undefined
            ? []
            : [`Selected harness name: ${input.harness.displayName}`]),
          "",
        ]),
    "User task:",
    input.message.content,
  ].join("\n");
}

async function runConfiguredConsoleHarness(input: {
  readonly request: WebUiHarnessRunnerInput;
  readonly runtime: GenericAILlmRuntime;
  readonly workspaceRoot: string;
  readonly createHarness: typeof createAgentHarness;
}): Promise<WebUiHarnessRunnerResult> {
  if (input.request.harness === undefined) {
    const result = await input.runtime.run(input.request.message.content, {
      signal: input.request.signal,
      ...(input.request.agent?.execution?.turnMode === undefined
        ? {}
        : { turnMode: input.request.agent.execution.turnMode }),
      ...(input.request.agent?.execution?.maxTurns === undefined
        ? {}
        : { maxTurns: input.request.agent.execution.maxTurns }),
    });
    return {
      content: result.outputText,
      status: "completed",
      metadata: {
        adapter: result.adapter,
        model: result.model,
        runner: "runtime",
      },
    };
  }

  if (input.request.signal.aborted) {
    throw new Error("Console harness run was aborted before dispatch.");
  }

  const inheritedExecution = input.request.harness.execution ?? input.request.agent?.execution;
  const harnessConfig = {
    ...(input.request.harness as AgentHarnessConfig),
    ...(inheritedExecution === undefined ? {} : { execution: inheritedExecution }),
  } satisfies AgentHarnessConfig;
  const harness = input.createHarness(harnessConfig);
  const artifactDir = resolve(
    input.workspaceRoot,
    input.request.harness.artifactDir ?? ".generic-ai/artifacts/web-ui",
  );
  const rootAgentId =
    input.request.harness.primaryAgent ??
    input.request.agent?.id ??
    input.request.thread.selectedAgentId;
  const result = (await harness.run({
    instruction: buildHarnessInstruction(input.request),
    workspaceRoot: input.workspaceRoot,
    artifactDir,
    ...(rootAgentId === undefined ? {} : { rootAgentId }),
    capabilities: createReadOnlyHarnessCapabilities(input.workspaceRoot),
  })) as AgentHarnessRunResult;

  return {
    content:
      result.outputText.trim().length > 0
        ? result.outputText
        : result.failureMessage ?? "Harness run completed without output.",
    status: result.status === "succeeded" ? "completed" : "failed",
    metadata: {
      runner: "agent-harness",
      harnessId: result.harnessId,
      adapter: result.adapter,
      eventCount: result.events.length,
      projectionCount: result.projections.length,
      artifactCount: result.artifacts.length,
      policyDecisionCount: result.policyDecisions.length,
      ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
      ...(result.errorCategory === undefined ? {} : { errorCategory: result.errorCategory }),
    },
  };
}

function isInsideDirectory(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function contentTypeForPath(filePath: string): string {
  return STATIC_MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function staticHeaders(filePath: string, publicDir: string): Headers {
  const headers = new Headers(STATIC_SECURITY_HEADERS);
  headers.set("content-type", contentTypeForPath(filePath));

  if (isInsideDirectory(resolve(publicDir, "assets"), filePath)) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else {
    headers.set("cache-control", "no-cache");
  }

  return headers;
}

async function readStaticFile(
  filePath: string,
  requestMethod: string,
  publicDir: string,
): Promise<Response | undefined> {
  try {
    const body = requestMethod === "HEAD" ? undefined : await readFile(filePath);
    return new Response(body, {
      headers: staticHeaders(filePath, publicDir),
      status: 200,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }

    throw error;
  }
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept");
  return accept === null || accept.includes("text/html") || accept.includes("*/*");
}

function staticAssetPath(publicDir: string, pathname: string): string | undefined {
  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const routePath = decodedPathname === "/" ? "/index.html" : decodedPathname;
  const targetPath = resolve(publicDir, `.${routePath}`);
  return isInsideDirectory(publicDir, targetPath) ? targetPath : undefined;
}

export function createStarterExampleFetch(
  transportFetch: HonoPlugin["fetch"],
  options: { readonly publicDir?: string } = {},
): (request: Request) => Promise<Response> {
  const publicDir = resolve(options.publicDir ?? DEFAULT_UI_PUBLIC_DIR);
  const indexPath = resolve(publicDir, "index.html");

  return async (request) => {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith(`${STARTER_ROUTE_PREFIX}/`) ||
      url.pathname.startsWith(`${WEB_UI_ROUTE_PREFIX}/`)
    ) {
      return transportFetch(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return transportFetch(request);
    }

    const targetPath = staticAssetPath(publicDir, url.pathname);
    if (targetPath !== undefined) {
      const staticResponse = await readStaticFile(targetPath, request.method, publicDir);
      if (staticResponse !== undefined) {
        return staticResponse;
      }
    }

    if (acceptsHtml(request)) {
      const indexResponse = await readStaticFile(indexPath, request.method, publicDir);
      if (indexResponse !== undefined) {
        return indexResponse;
      }
    }

    return transportFetch(request);
  };
}

export function loadStarterExampleEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = STARTER_DEFAULT_START_DIR,
): StarterExampleEnvironment {
  const apiKey = readTrimmedEnv(env, providerKeyName);
  const adapterValue =
    readTrimmedEnv(env, adapterName) ?? DEFAULT_GENERIC_AI_RUNTIME_ADAPTER;
  if (!SUPPORTED_ADAPTERS.has(adapterValue as GenericAILlmRuntimeAdapter)) {
    throw new StarterExampleConfigError(
      `${adapterName} must be one of: ${[...SUPPORTED_ADAPTERS].join(", ")}.`,
    );
  }

  const model = readTrimmedEnv(env, modelName);
  const workspaceRootValue = readTrimmedEnv(env, workspaceRootName);
  const workspaceRoot =
    workspaceRootValue === undefined ? undefined : resolve(startDir, workspaceRootValue);
  const host = normalizeBindHost(readTrimmedEnv(env, hostName, fallbackHostName) ?? DEFAULT_HOST);
  const unsafeExpose = parseBooleanFlag(readTrimmedEnv(env, unsafeExposeName), unsafeExposeName);
  const authToken = readTrimmedEnv(env, authTokenName);
  const exposure = resolveExposure(host, unsafeExpose, authToken);

  return Object.freeze({
    adapter: adapterValue as GenericAILlmRuntimeAdapter,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(model === undefined ? {} : { model }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    host,
    port: parsePort(readTrimmedEnv(env, portName, fallbackPortName)),
    unsafeExpose,
    ...(authToken === undefined ? {} : { authToken }),
    exposure,
  });
}

export async function createStarterExampleServer(
  options: StarterExampleServerOptions = {},
): Promise<StarterExampleServer> {
  const startDir = resolve(options.startDir ?? STARTER_DEFAULT_START_DIR);
  const environment = loadStarterExampleEnvironment(options.env, startDir);
  const createRuntime = options.createRuntime ?? createGenericAILlmRuntime;
  const createHarness = options.createHarness ?? createAgentHarness;
  const bootstrap = await createStarterHonoBootstrapFromYaml<GenericAILlmRuntime>({
    startDir,
    startRuntime: (input) => {
      const workspaceRoot = environment.workspaceRoot ?? input.runtimePlan.runtime.workspaceRoot;

      return createRuntime({
        adapter: environment.adapter,
        ...(environment.apiKey === undefined ? {} : { apiKey: environment.apiKey }),
        model:
          environment.model ?? input.runtimePlan.primaryAgent.model ?? DEFAULT_OPENAI_CODEX_MODEL,
        cwd: workspaceRoot,
        ...(input.runtimePlan.primaryAgent.instructions === undefined
          ? {}
          : { instructions: input.runtimePlan.primaryAgent.instructions }),
        ...(input.runtimePlan.primaryAgent.execution?.turnMode === undefined
          ? {}
          : { turnMode: input.runtimePlan.primaryAgent.execution.turnMode }),
        ...(input.runtimePlan.primaryAgent.execution?.maxTurns === undefined
          ? {}
          : { maxTurns: input.runtimePlan.primaryAgent.execution.maxTurns }),
      });
    },
  });

  const runtime = await bootstrap.startRuntime();
  const workspaceRoot = environment.workspaceRoot ?? bootstrap.runtimePlan.runtime.workspaceRoot;
  const authorize = createTokenAuthorization(environment.authToken);

  const transport = createHonoPlugin({
    routePrefix: STARTER_ROUTE_PREFIX,
    ...(authorize === undefined ? {} : { authorize }),
    health: () => ({
      transport: "@generic-ai/plugin-hono",
      streaming: true,
      adapter: runtime.adapter,
      model: runtime.model,
      exposure: environment.exposure,
    }),
    run: async (payload, context) =>
      bootstrap.run(() =>
        runtime.run(normalizePrompt(payload.input), {
          signal: context.signal,
        }),
      ),
    stream: async function* (payload, context) {
      const prompt = normalizePrompt(payload.input);
      const runtimeEvents = createStarterAsyncQueue<StarterRuntimeActivityEvent>();
      const stream = bootstrap.stream(() =>
        collectRuntimeStream(runtime, prompt, context.signal, runtimeEvents),
      );

      for await (const chunk of mergeStarterStreams(stream, runtimeEvents)) {
        yield chunk;
      }
    },
  });
  const webUi = createWebUiPlugin({
    workspaceRoot,
    ...(environment.authToken === undefined ? {} : { sessionToken: environment.authToken }),
    harnessRunner: (request) =>
      runConfiguredConsoleHarness({
        request,
        runtime,
        workspaceRoot,
        createHarness,
      }),
  });
  const webUiTransport = createHonoWebUiTransport(webUi, {
    routePrefix: "/console/api",
    security: {
      sessionToken: webUi.sessionToken,
      allowRemote: environment.exposure !== "loopback",
      ...(authorize === undefined
        ? {}
        : {
            authorize: (request) =>
              authorize({
                request,
                requestId: randomUUID(),
                mode: "sync",
                signal: request.signal,
              }),
          }),
    },
  });
  transport.app.route("/", webUiTransport.app);
  const fetch = createStarterExampleFetch(transport.fetch, {
    ...(options.uiPublicDir === undefined ? {} : { publicDir: options.uiPublicDir }),
  });

  return Object.freeze({
    app: transport.app,
    fetch,
    transport,
    webUi,
    webUiTransport,
    bootstrap,
    runtime,
    environment,
    workspaceRoot,
    stop: async () => {
      await runtime.close?.();
      await bootstrap.stop();
    },
  });
}
