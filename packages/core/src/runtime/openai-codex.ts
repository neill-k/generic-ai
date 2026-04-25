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
import {
  DEFAULT_OPENAI_CODEX_MODEL,
  type GenericAILlmRunOptions,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
} from "./types.js";

const OPENAI_CODEX_PI_PROVIDER = "openai-codex";

type PiAuthStorage = {
  readonly setRuntimeApiKey: (provider: string, apiKey: string) => void;
};

type PiModelRegistry = {
  readonly find: (provider: string, modelId: string) => unknown;
  readonly hasConfiguredAuth?: (model: unknown) => boolean;
};

type PiResourceLoader = {
  readonly reload?: () => Promise<void>;
};

type PiSession = {
  readonly messages: readonly unknown[];
  readonly prompt: (
    text: string,
    options?: { readonly source?: string; readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly getLastAssistantText?: () => string | undefined;
  readonly dispose?: () => void;
};

export interface OpenAICodexRuntimeDependencies {
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

function isAssistantLikeMessage(value: unknown): value is {
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

function extractLatestAssistantText(session: PiSession): string {
  const direct = session.getLastAssistantText?.();
  if (direct !== undefined) {
    return direct;
  }

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (!isAssistantLikeMessage(message)) {
      continue;
    }

    if (typeof message.content === "string") {
      return message.content;
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter(isTextPart)
        .map((part) => part.text)
        .join("");
    }
  }

  throw new Error("Pi OpenAI Codex runtime did not produce an assistant response.");
}

function toRunResult(
  model: string,
  outputText: string,
  requestId: string | undefined,
): GenericAILlmRunResult {
  return Object.freeze({
    adapter: "openai-codex" as const,
    model,
    outputText,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function setApiKey(authStorage: PiAuthStorage, apiKey: string | undefined): void {
  const trimmed = apiKey?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    authStorage.setRuntimeApiKey(OPENAI_CODEX_PI_PROVIDER, trimmed);
  }
}

function createAbortError(phase: "before" | "during"): Error {
  return new Error(`Pi OpenAI Codex runtime aborted ${phase} prompt dispatch.`);
}

async function awaitPromptWithAbort(
  promptPromise: Promise<void>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<void> {
  if (signal === undefined) {
    await promptPromise;
    return;
  }

  if (signal.aborted) {
    onAbort();
    throw createAbortError("before");
  }

  let removeAbortListener: () => void = () => undefined;
  try {
    await Promise.race([
      promptPromise,
      new Promise<never>((_resolve, reject) => {
        const handleAbort = () => {
          onAbort();
          reject(createAbortError("during"));
        };
        signal.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
      }),
    ]);
  } finally {
    removeAbortListener();
  }
}

async function createSession(
  input: {
    readonly apiKey?: string;
    readonly model?: string;
    readonly instructions?: string;
    readonly cwd?: string;
    readonly agentDir?: string;
  },
  dependencies: OpenAICodexRuntimeDependencies,
): Promise<{ readonly modelId: string; readonly session: PiSession }> {
  const cwd = input.cwd ?? process.cwd();
  const agentDir = input.agentDir ?? getAgentDir();
  const modelId = input.model ?? DEFAULT_OPENAI_CODEX_MODEL;
  const createAgentSession = dependencies.createAgentSession ?? createPiAgentSession;
  const authStorage =
    dependencies.authStorageFactory?.(agentDir) ?? AuthStorage.create(join(agentDir, "auth.json"));
  setApiKey(authStorage, input.apiKey);

  const modelRegistry =
    dependencies.modelRegistryFactory?.(authStorage, agentDir) ??
    ModelRegistry.create(authStorage as AuthStorage, join(agentDir, "models.json"));
  const model = modelRegistry.find(OPENAI_CODEX_PI_PROVIDER, modelId);
  if (model === undefined || model === null) {
    throw new Error(
      `Pi could not resolve model "${OPENAI_CODEX_PI_PROVIDER}/${modelId}". ` +
        "Run `pi login` for the OpenAI Codex provider or set GENERIC_AI_MODEL to a Pi-known model.",
    );
  }

  if ((modelRegistry as PiModelRegistry).hasConfiguredAuth?.(model) === false) {
    throw new Error(
      `Pi has no configured auth for "${OPENAI_CODEX_PI_PROVIDER}/${modelId}". ` +
        "Run `pi login` or provide GENERIC_AI_PROVIDER_API_KEY.",
    );
  }

  const resourceLoader =
    dependencies.resourceLoaderFactory?.({
      cwd,
      agentDir,
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
    settingsManager: (dependencies.settingsManagerFactory?.() ??
      SettingsManager.inMemory()) as never,
  });

  return {
    modelId,
    session: result.session as unknown as PiSession,
  };
}

export function createOpenAICodexRuntime(
  input: {
    readonly apiKey?: string;
    readonly model?: string;
    readonly instructions?: string;
    readonly cwd?: string;
    readonly agentDir?: string;
  },
  dependencies: OpenAICodexRuntimeDependencies = {},
): GenericAILlmRuntime {
  const model = input.model ?? DEFAULT_OPENAI_CODEX_MODEL;
  const run: GenericAILlmRuntime["run"] = async (prompt, options) => {
    if (options?.signal?.aborted) {
      throw createAbortError("before");
    }

    const { modelId, session } = await createSession(input, dependencies);
    try {
      await awaitPromptWithAbort(
        session.prompt(prompt, {
          source: "extension",
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        }),
        options?.signal,
        () => session.dispose?.(),
      );
      return toRunResult(modelId, extractLatestAssistantText(session), undefined);
    } finally {
      session.dispose?.();
    }
  };

  return Object.freeze({
    adapter: "openai-codex",
    model,
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
