import { join } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createPiAgentSession } from "./pi.js";
import { createOpenAICodexRuntime } from "./openai-codex.js";
import {
  DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
  DEFAULT_OPENAI_CODEX_MODEL,
  type CreateGenericAILlmRuntimeOptions,
  type GenericAILlmRunOptions,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
} from "./types.js";

type PiAuthStorage = {
  readonly setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type PiModelRegistry = {
  readonly find: (provider: string, modelId: string) => unknown;
};

type PiResourceLoader = {
  readonly reload?: () => Promise<void>;
};

type PiSession = {
  readonly messages: readonly unknown[];
  readonly prompt: (text: string, options?: { readonly source?: string }) => Promise<void>;
};

export interface GenericAILlmRuntimeDependencies {
  readonly openai?: Parameters<typeof createOpenAICodexRuntime>[1];
  readonly pi?: {
    readonly createAgentSession?: typeof createPiAgentSession;
    readonly authStorageFactory?: (agentDir?: string) => PiAuthStorage;
    readonly modelRegistryFactory?: (
      authStorage: PiAuthStorage,
      agentDir?: string,
    ) => PiModelRegistry;
    readonly resourceLoaderFactory?: (options: {
      readonly cwd?: string;
      readonly agentDir?: string;
      readonly instructions?: string;
    }) => PiResourceLoader;
    readonly sessionManagerFactory?: () => SessionManager;
    readonly settingsManagerFactory?: () => SettingsManager;
  };
}

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function isAssistantLikeMessage(
  value: unknown,
): value is {
  readonly role: "assistant";
  readonly content: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value
  );
}

function extractLatestAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isAssistantLikeMessage(message)) {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content.filter(isTextPart).map((part) => part.text).join("");
    }
  }

  throw new Error("pi compatibility runtime did not produce an assistant response.");
}

function toRunResult(adapter: "pi", model: string, outputText: string): GenericAILlmRunResult {
  return Object.freeze({
    adapter,
    model,
    outputText,
  });
}

async function createPiCompatibilityRuntime(
  input: CreateGenericAILlmRuntimeOptions,
  dependencies: NonNullable<GenericAILlmRuntimeDependencies["pi"]> = {},
): Promise<GenericAILlmRuntime> {
  const modelId = input.model ?? DEFAULT_OPENAI_CODEX_MODEL;
  const createAgentSession = dependencies.createAgentSession ?? createPiAgentSession;

  async function createSession(): Promise<PiSession> {
    const cwd = input.cwd ?? process.cwd();
    const agentDir = input.agentDir ?? getAgentDir();
    const authStorage =
      dependencies.authStorageFactory?.(input.agentDir) ??
      AuthStorage.create(input.agentDir === undefined ? undefined : join(input.agentDir, "auth.json"));
    authStorage.setRuntimeApiKey("openai", input.apiKey);

    const modelRegistry =
      dependencies.modelRegistryFactory?.(authStorage, input.agentDir) ??
      ModelRegistry.create(
        authStorage as AuthStorage,
        input.agentDir === undefined ? undefined : join(input.agentDir, "models.json"),
      );
    const model = modelRegistry.find("openai", modelId);
    if (model === undefined) {
      throw new Error(
        `pi compatibility runtime could not resolve model "openai/${modelId}". ` +
          `Set GENERIC_AI_MODEL to a model pi knows how to resolve.`,
      );
    }

    const resourceLoader =
      dependencies.resourceLoaderFactory?.({
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.agentDir === undefined ? {} : { agentDir: input.agentDir }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      }) ??
      new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noThemes: true,
        noPromptTemplates: true,
        systemPromptOverride: () => input.instructions,
      });
    await resourceLoader.reload?.();

    const result = await createAgentSession({
      cwd,
      agentDir,
      authStorage: authStorage as never,
      modelRegistry: modelRegistry as never,
      model: model as never,
      tools: [],
      resourceLoader: resourceLoader as never,
      sessionManager: (dependencies.sessionManagerFactory?.() ?? SessionManager.inMemory()) as never,
      settingsManager:
        (dependencies.settingsManagerFactory?.() ?? SettingsManager.inMemory()) as never,
    });

    return result.session as unknown as PiSession;
  }

  async function run(prompt: string, options?: GenericAILlmRunOptions): Promise<GenericAILlmRunResult> {
    if (options?.signal?.aborted) {
      throw new Error("pi compatibility runtime aborted before prompt dispatch.");
    }

    const session = await createSession();
    await session.prompt(prompt, {
      source: "extension",
    });
    return toRunResult("pi", modelId, extractLatestAssistantText(session.messages));
  }

  return Object.freeze({
    adapter: "pi",
    model: modelId,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    run,
    async *stream(prompt: string, options?: GenericAILlmRunOptions) {
      yield {
        type: "response",
        response: await run(prompt, options),
      } as const;
    },
  });
}

export async function createGenericAILlmRuntime(
  input: CreateGenericAILlmRuntimeOptions,
  dependencies: GenericAILlmRuntimeDependencies = {},
): Promise<GenericAILlmRuntime> {
  const adapter = input.adapter ?? DEFAULT_GENERIC_AI_RUNTIME_ADAPTER;
  if (input.apiKey.trim().length === 0) {
    throw new Error("Generic AI runtime adapter requires a non-empty provider API key.");
  }

  switch (adapter) {
    case "openai-codex":
      return createOpenAICodexRuntime(input, dependencies.openai);
    case "pi":
      return createPiCompatibilityRuntime(input, dependencies.pi);
    default: {
      const exhaustive: never = adapter;
      throw new Error(`Unsupported runtime adapter "${exhaustive}".`);
    }
  }
}
