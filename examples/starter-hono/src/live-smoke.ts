import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROVIDER_API_KEY_ENV } from "@generic-ai/ai";
import {
  type CanonicalEvent,
  resolveNativeModel,
  runCapabilityNativeAgentSession,
  STOP_AND_RESPOND_TOOL_NAME,
} from "@generic-ai/core";
import { createHonoPlugin } from "@generic-ai/plugin-hono";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";

const DEFAULT_LIVE_PROVIDER = "openai";
const DEFAULT_LIVE_MODEL_BY_PROVIDER = {
  openai: "gpt-5.5",
  anthropic: "claude-opus-5-5",
} as const;

export const LIVE_SMOKE_ENABLE_ENV = "GENERIC_AI_ENABLE_LIVE_SMOKE";
export const LIVE_SMOKE_PROVIDER_ENV = "GENERIC_AI_LIVE_PROVIDER";
export const LIVE_SMOKE_MODEL_ENV = "GENERIC_AI_LIVE_MODEL";
export const LIVE_SMOKE_PROVIDER_API_KEY_ENV = "GENERIC_AI_LIVE_PROVIDER_API_KEY";
export const LIVE_SMOKE_DONE_TEXT = "LIVE_SMOKE_DONE";
export const LIVE_SMOKE_FILE_PATH = "workspace/shared/live-smoke.txt";
export const LIVE_SMOKE_FILE_CONTENT = "generic-ai-live-smoke";

const NATIVE_TOOL_START_EVENT = "plugin.generic-ai-runtime.native.tool_execution_start";
const NATIVE_AGENT_END_EVENT = "plugin.generic-ai-runtime.native.agent_end";

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
  readonly reason: string;
}

export interface LiveProviderSmokeCompletedResult {
  readonly skipped: false;
  readonly provider: string;
  readonly modelId: string;
  readonly assistantText: string;
  readonly toolCalls: readonly LiveProviderToolCall[];
  readonly filePath: string;
  readonly fileContents: string;
  readonly sawAgentEnd: boolean;
}

export type LiveProviderSmokeResult =
  | LiveProviderSmokeSkippedResult
  | LiveProviderSmokeCompletedResult;

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

const SMOKE_SYSTEM_PROMPT = [
  "You are running a deterministic Generic AI live-provider smoke test.",
  "Follow the numbered instructions exactly.",
  `After all required tool calls succeed, call ${STOP_AND_RESPOND_TOOL_NAME} with response exactly ${LIVE_SMOKE_DONE_TEXT}.`,
].join(" ");

function resolveLiveApiKey(env: NodeJS.ProcessEnv, provider: string): string | undefined {
  const explicit = env[LIVE_SMOKE_PROVIDER_API_KEY_ENV]?.trim();
  if (explicit) {
    return explicit;
  }
  for (const name of PROVIDER_API_KEY_ENV[provider] ?? []) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function shouldEnableLiveSmoke(env: NodeJS.ProcessEnv): boolean {
  return env[LIVE_SMOKE_ENABLE_ENV] === "1";
}

function createSkippedResult(
  provider: string,
  modelId: string,
  reason: string,
): LiveProviderSmokeSkippedResult {
  return { skipped: true, provider, modelId, reason };
}

export async function runLiveProviderSmoke(
  options: LiveProviderSmokeOptions,
): Promise<LiveProviderSmokeResult> {
  const env = options.env ?? process.env;
  const provider = resolveLiveProvider(env);
  const modelId = resolveLiveModel(env, provider);

  if (modelId === undefined) {
    return createSkippedResult(
      provider,
      "<unset>",
      `No default live model is configured for provider "${provider}". Set ${LIVE_SMOKE_MODEL_ENV}.`,
    );
  }

  if (!shouldEnableLiveSmoke(env)) {
    return createSkippedResult(
      provider,
      modelId,
      `Set ${LIVE_SMOKE_ENABLE_ENV}=1 to opt into the live provider smoke test.`,
    );
  }

  let model: ReturnType<typeof resolveNativeModel>;
  try {
    model = resolveNativeModel(`${provider}/${modelId}`);
  } catch (error) {
    return createSkippedResult(
      provider,
      modelId,
      `Model "${provider}/${modelId}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const apiKey = resolveLiveApiKey(env, provider);
  if (apiKey === undefined) {
    const names = [LIVE_SMOKE_PROVIDER_API_KEY_ENV, ...(PROVIDER_API_KEY_ENV[provider] ?? [])];
    return createSkippedResult(
      provider,
      modelId,
      `No credentials are configured for ${provider}/${modelId}. Set one of: ${names.join(", ")}.`,
    );
  }

  const result = await runCapabilityNativeAgentSession({
    cwd: options.root,
    model,
    apiKey,
    thinkingLevel: "minimal",
    systemPrompt: SMOKE_SYSTEM_PROMPT,
    prompt: createSmokePrompt(),
    capabilities: { fileTools: createWorkspaceFileTools({ root: options.root }) },
    compaction: false,
    retry: false,
    offload: false,
  });

  if (result.failureMessage !== undefined) {
    throw new Error(result.failureMessage);
  }
  if (result.outputText === undefined) {
    throw new Error(`${STOP_AND_RESPOND_TOOL_NAME} was not called.`);
  }

  const toolCalls = collectToolCalls(result.events);
  const sawAgentEnd = result.events.some((event) => event.name === NATIVE_AGENT_END_EVENT);
  const fileContents = await readFile(path.join(options.root, LIVE_SMOKE_FILE_PATH), "utf8");
  return {
    skipped: false,
    provider,
    modelId: model.id,
    assistantText: result.outputText,
    toolCalls,
    filePath: LIVE_SMOKE_FILE_PATH,
    fileContents,
    sawAgentEnd,
  };
}

function collectToolCalls(events: readonly CanonicalEvent[]): LiveProviderToolCall[] {
  const calls: LiveProviderToolCall[] = [];
  for (const event of events) {
    if (event.name !== NATIVE_TOOL_START_EVENT) {
      continue;
    }
    const data = event.data as { readonly toolName?: unknown; readonly args?: unknown };
    if (typeof data.toolName === "string") {
      calls.push({ toolName: data.toolName, args: data.args });
    }
  }
  return calls;
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
