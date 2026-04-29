import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createStopAndRespondTool,
  runStopToolLoop,
  STOP_AND_RESPOND_TOOL_NAME,
  type StopAndRespondState,
} from "@generic-ai/core";
import { createHonoPlugin } from "@generic-ai/plugin-hono";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@generic-ai/sdk/pi";

const DEFAULT_LIVE_PROVIDER = "openai-codex";
const DEFAULT_LIVE_MODEL_BY_PROVIDER = {
  "openai-codex": "gpt-5.5",
  openai: "gpt-5.5",
} as const;

export const LIVE_SMOKE_ENABLE_ENV = "GENERIC_AI_ENABLE_LIVE_SMOKE";
export const LIVE_SMOKE_PROVIDER_ENV = "GENERIC_AI_LIVE_PROVIDER";
export const LIVE_SMOKE_MODEL_ENV = "GENERIC_AI_LIVE_MODEL";
export const LIVE_SMOKE_AGENT_DIR_ENV = "GENERIC_AI_LIVE_AGENT_DIR";
export const LIVE_SMOKE_PROVIDER_API_KEY_ENV = "GENERIC_AI_LIVE_PROVIDER_API_KEY";
export const LIVE_SMOKE_DONE_TEXT = "LIVE_SMOKE_DONE";
export const LIVE_SMOKE_FILE_PATH = "workspace/shared/live-smoke.txt";
export const LIVE_SMOKE_FILE_CONTENT = "generic-ai-live-smoke";

export interface LiveProviderSmokeOptions {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LiveProviderToolCall {
  readonly toolName: string;
  readonly args: unknown;
}

export interface LiveProviderSmokeSkippedResult {
  readonly skipped: true;
  readonly provider: string;
  readonly modelId: string;
  readonly agentDir: string;
  readonly reason: string;
}

export interface LiveProviderSmokeCompletedResult {
  readonly skipped: false;
  readonly provider: string;
  readonly modelId: string;
  readonly agentDir: string;
  readonly assistantText: string;
  readonly toolCalls: readonly LiveProviderToolCall[];
  readonly filePath: string;
  readonly fileContents: string;
  readonly sawAgentEnd: boolean;
}

export type LiveProviderSmokeResult =
  | LiveProviderSmokeSkippedResult
  | LiveProviderSmokeCompletedResult;

function getDefaultAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

function resolveLiveProvider(env: NodeJS.ProcessEnv): string {
  return env[LIVE_SMOKE_PROVIDER_ENV]?.trim() || DEFAULT_LIVE_PROVIDER;
}

function resolveLiveModel(env: NodeJS.ProcessEnv, provider: string): string | undefined {
  const override = env[LIVE_SMOKE_MODEL_ENV]?.trim();
  if (override && override.length > 0) {
    return override;
  }

  return DEFAULT_LIVE_MODEL_BY_PROVIDER[provider as keyof typeof DEFAULT_LIVE_MODEL_BY_PROVIDER];
}

function createSmokePrompt(): string {
  return [
    "Run the Generic AI live smoke test.",
    `1. Call the write tool once to create ${LIVE_SMOKE_FILE_PATH} with exact contents ${LIVE_SMOKE_FILE_CONTENT}.`,
    `2. Call the read tool on ${LIVE_SMOKE_FILE_PATH} to verify the contents.`,
    `3. Call ${STOP_AND_RESPOND_TOOL_NAME} with response exactly ${LIVE_SMOKE_DONE_TEXT}.`,
  ].join(" ");
}

function createSmokeResourceLoader(root: string, agentDir: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: root,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: [
      "You are running a deterministic Generic AI live-provider smoke test.",
      "Follow the numbered instructions exactly.",
      `After all required tool calls succeed, call ${STOP_AND_RESPOND_TOOL_NAME} with response exactly ${LIVE_SMOKE_DONE_TEXT}.`,
    ].join(" "),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: () => [],
  });
}

function shouldEnableLiveSmoke(env: NodeJS.ProcessEnv): boolean {
  return env[LIVE_SMOKE_ENABLE_ENV] === "1";
}

function createSkippedResult(
  provider: string,
  modelId: string,
  agentDir: string,
  reason: string,
): LiveProviderSmokeSkippedResult {
  return {
    skipped: true,
    provider,
    modelId,
    agentDir,
    reason,
  };
}

export async function runLiveProviderSmoke(
  options: LiveProviderSmokeOptions,
): Promise<LiveProviderSmokeResult> {
  const env = options.env ?? process.env;
  const provider = resolveLiveProvider(env);
  const modelId = resolveLiveModel(env, provider);
  const agentDir = env[LIVE_SMOKE_AGENT_DIR_ENV]?.trim() || getDefaultAgentDir();

  if (modelId === undefined) {
    return createSkippedResult(
      provider,
      "<unset>",
      agentDir,
      `No default live model is configured for provider "${provider}". Set ${LIVE_SMOKE_MODEL_ENV}.`,
    );
  }

  if (!shouldEnableLiveSmoke(env)) {
    return createSkippedResult(
      provider,
      modelId,
      agentDir,
      `Set ${LIVE_SMOKE_ENABLE_ENV}=1 to opt into the live provider smoke test.`,
    );
  }

  const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
  const runtimeApiKey = env[LIVE_SMOKE_PROVIDER_API_KEY_ENV]?.trim();
  if (runtimeApiKey && runtimeApiKey.length > 0) {
    authStorage.setRuntimeApiKey(provider, runtimeApiKey);
  }

  const modelRegistry = ModelRegistry.create(authStorage);
  const model = modelRegistry.find(provider, modelId);
  if (model === undefined) {
    return createSkippedResult(
      provider,
      modelId,
      agentDir,
      `Model "${provider}/${modelId}" is unavailable in the pi model registry.`,
    );
  }

  if (!modelRegistry.hasConfiguredAuth(model)) {
    return createSkippedResult(
      provider,
      modelId,
      agentDir,
      [
        `No credentials are configured for ${provider}/${modelId}.`,
        `Use pi login or provide ${LIVE_SMOKE_AGENT_DIR_ENV} / ${LIVE_SMOKE_PROVIDER_API_KEY_ENV}.`,
      ].join(" "),
    );
  }

  const resourceLoader = createSmokeResourceLoader(options.root, agentDir);
  await resourceLoader.reload();

  const fileTools = createWorkspaceFileTools({ root: options.root });
  const stopState: StopAndRespondState = { stopped: false };
  const stopTool = createStopAndRespondTool(stopState);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0 },
  });
  const { session } = await createAgentSession({
    cwd: options.root,
    agentDir,
    model,
    thinkingLevel: "minimal",
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [...fileTools.piTools.map((tool) => tool.name), STOP_AND_RESPOND_TOOL_NAME],
    customTools: [...fileTools.piTools, stopTool] as never,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  const toolCalls: LiveProviderToolCall[] = [];
  let sawAgentEnd = false;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      toolCalls.push({
        toolName: event.toolName,
        args: event.args,
      });
    }

    if (event.type === "agent_end") {
      sawAgentEnd = true;
    }
  });

  let assistantText = "";
  try {
    const loop = await runStopToolLoop({
      prompt: createSmokePrompt(),
      state: stopState,
      runPrompt: (prompt) => session.prompt(prompt),
    });
    if (!loop.stopped || loop.outputText === undefined) {
      throw new Error(
        `${STOP_AND_RESPOND_TOOL_NAME} was not called after ${loop.turnCount} turn(s).`,
      );
    }
    assistantText = loop.outputText;
  } finally {
    unsubscribe();
    session.dispose();
  }

  const fileContents = await readFile(path.join(options.root, LIVE_SMOKE_FILE_PATH), "utf8");
  return {
    skipped: false,
    provider,
    modelId: model.id,
    agentDir,
    assistantText,
    toolCalls,
    filePath: LIVE_SMOKE_FILE_PATH,
    fileContents,
    sawAgentEnd,
  };
}

export function createLiveProviderSmokeTransport(options: LiveProviderSmokeOptions) {
  return createHonoPlugin({
    routePrefix: "/starter/live",
    run: async () => runLiveProviderSmoke(options),
    stream: async function* () {
      const result = await runLiveProviderSmoke(options);

      yield {
        event: "status",
        data: {
          provider: result.provider,
          modelId: result.modelId,
          skipped: result.skipped,
        },
      };

      if (!result.skipped) {
        for (const toolCall of result.toolCalls) {
          yield {
            event: "tool",
            data: toolCall,
          };
        }
      }

      yield {
        event: "done",
        data: result,
      };
    },
  });
}
