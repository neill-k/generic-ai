import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGenericAILlmRuntime,
  DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
  DEFAULT_OPENAI_CODEX_MODEL,
  type CreateGenericAILlmRuntimeOptions,
  type GenericAIConfiguredBootstrap,
  type GenericAILlmRuntime,
  type GenericAILlmRuntimeAdapter,
} from "@generic-ai/core";
import { createHonoPlugin, type HonoPlugin } from "@generic-ai/plugin-hono";
import { createStarterHonoBootstrapFromYaml } from "@generic-ai/preset-starter-hono";

const providerKeyName = "GENERIC_AI_PROVIDER_API_KEY";
const modelName = "GENERIC_AI_MODEL";
const adapterName = "GENERIC_AI_RUNTIME_ADAPTER";
const workspaceRootName = "GENERIC_AI_WORKSPACE_ROOT";
const hostName = "GENERIC_AI_HOST";
const portName = "GENERIC_AI_PORT";
const fallbackHostName = "HOST";
const fallbackPortName = "PORT";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const SUPPORTED_ADAPTERS = new Set<GenericAILlmRuntimeAdapter>(["openai-codex", "pi"]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const STARTER_ROUTE_PREFIX = "/starter" as const;
export const STARTER_DEFAULT_START_DIR = PACKAGE_ROOT;

export class StarterExampleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StarterExampleConfigError";
  }
}

export interface StarterExampleEnvironment {
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly apiKey: string;
  readonly model?: string;
  readonly workspaceRoot?: string;
  readonly host: string;
  readonly port: number;
}

export interface StarterExampleServer {
  readonly app: HonoPlugin["app"];
  readonly transport: HonoPlugin;
  readonly bootstrap: GenericAIConfiguredBootstrap<GenericAILlmRuntime>;
  readonly runtime: GenericAILlmRuntime;
  readonly environment: StarterExampleEnvironment;
  readonly workspaceRoot: string;
  readonly stop: () => Promise<void>;
}

export interface StarterExampleServerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly startDir?: string;
  readonly createRuntime?: (
    options: CreateGenericAILlmRuntimeOptions,
  ) => Promise<GenericAILlmRuntime> | GenericAILlmRuntime;
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

export function loadStarterExampleEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  startDir: string = STARTER_DEFAULT_START_DIR,
): StarterExampleEnvironment {
  const apiKey = readTrimmedEnv(env, providerKeyName);
  if (apiKey === undefined) {
    throw new StarterExampleConfigError(
      `${providerKeyName} must be set before starting the starter example server.`,
    );
  }

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

  return Object.freeze({
    adapter: adapterValue as GenericAILlmRuntimeAdapter,
    apiKey,
    ...(model === undefined ? {} : { model }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    host: readTrimmedEnv(env, hostName, fallbackHostName) ?? DEFAULT_HOST,
    port: parsePort(readTrimmedEnv(env, portName, fallbackPortName)),
  });
}

export async function createStarterExampleServer(
  options: StarterExampleServerOptions = {},
): Promise<StarterExampleServer> {
  const startDir = resolve(options.startDir ?? STARTER_DEFAULT_START_DIR);
  const environment = loadStarterExampleEnvironment(options.env, startDir);
  const createRuntime = options.createRuntime ?? createGenericAILlmRuntime;
  const bootstrap = await createStarterHonoBootstrapFromYaml<GenericAILlmRuntime>({
    startDir,
    startRuntime: (input) => {
      const workspaceRoot = environment.workspaceRoot ?? input.runtimePlan.runtime.workspaceRoot;

      return createRuntime({
        adapter: environment.adapter,
        apiKey: environment.apiKey,
        model:
          environment.model ?? input.runtimePlan.primaryAgent.model ?? DEFAULT_OPENAI_CODEX_MODEL,
        cwd: workspaceRoot,
        agentDir: resolve(workspaceRoot, ".pi", "agent"),
        ...(input.runtimePlan.primaryAgent.instructions === undefined
          ? {}
          : { instructions: input.runtimePlan.primaryAgent.instructions }),
      });
    },
  });

  const runtime = await bootstrap.startRuntime();
  const workspaceRoot = environment.workspaceRoot ?? bootstrap.runtimePlan.runtime.workspaceRoot;

  const transport = createHonoPlugin({
    routePrefix: STARTER_ROUTE_PREFIX,
    health: () => ({
      transport: "@generic-ai/plugin-hono",
      streaming: true,
      adapter: runtime.adapter,
      model: runtime.model,
      workspaceRoot,
      bootstrap: bootstrap.describe(),
    }),
    run: async (payload, context) =>
      bootstrap.run(() =>
        runtime.run(normalizePrompt(payload.input), {
          signal: context.signal,
        }),
      ),
    stream: async function* (payload, context) {
      const prompt = normalizePrompt(payload.input);

      for await (const chunk of bootstrap.stream(() =>
        runtime.run(prompt, {
          signal: context.signal,
        }),
      )) {
        if (chunk.type === "event") {
          yield {
            event: chunk.event.name,
            data: chunk.event,
          };
          continue;
        }

        yield {
          event: "run.envelope",
          data: chunk.envelope,
        };
      }
    },
  });

  return Object.freeze({
    app: transport.app,
    transport,
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
