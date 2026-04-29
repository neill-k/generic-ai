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
  type GenericAIAgentTurnMode,
  type GenericAILlmRunOptions,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
  type GenericAILlmStreamChunk,
} from "./types.js";
import {
  createStopAndRespondTool,
  type StopAndRespondState,
  runStopToolLoop,
  STOP_AND_RESPOND_TOOL_NAME,
} from "./stop-tool-loop.js";

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
  readonly subscribe?: (listener: (event: unknown) => void) => () => void;
  readonly getLastAssistantText?: () => string | undefined;
  readonly dispose?: () => void;
};

interface AsyncEventQueue<T> {
  readonly push: (value: T) => void;
  readonly close: () => void;
  readonly next: () => Promise<IteratorResult<T>>;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function createAsyncEventQueue<T>(): AsyncEventQueue<T> {
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

function readStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readBooleanField(value: Record<string, unknown>, key: string): boolean | undefined {
  const field = value[key];
  return typeof field === "boolean" ? field : undefined;
}

function readNumberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function readArrayLength(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return Array.isArray(field) ? field.length : undefined;
}

function writeIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function serializePiSessionEvent(event: unknown): Record<string, unknown> {
  if (!isRecord(event)) {
    return { type: "unknown" };
  }

  const eventType = readStringField(event, "type") ?? "unknown";
  const serialized: Record<string, unknown> = { type: eventType };

  switch (eventType) {
    case "queue_update": {
      const steering = event["steering"];
      const followUp = event["followUp"];
      if (Array.isArray(steering)) {
        serialized["steering"] = [...steering];
      }
      if (Array.isArray(followUp)) {
        serialized["followUp"] = [...followUp];
      }
      break;
    }

    case "compaction_start":
      writeIfDefined(serialized, "reason", readStringField(event, "reason"));
      break;

    case "compaction_end":
      writeIfDefined(serialized, "reason", readStringField(event, "reason"));
      writeIfDefined(serialized, "aborted", readBooleanField(event, "aborted"));
      writeIfDefined(serialized, "willRetry", readBooleanField(event, "willRetry"));
      writeIfDefined(serialized, "errorMessage", readStringField(event, "errorMessage"));
      break;

    case "auto_retry_start":
      writeIfDefined(serialized, "attempt", readNumberField(event, "attempt"));
      writeIfDefined(serialized, "maxAttempts", readNumberField(event, "maxAttempts"));
      writeIfDefined(serialized, "delayMs", readNumberField(event, "delayMs"));
      writeIfDefined(serialized, "errorMessage", readStringField(event, "errorMessage"));
      break;

    case "auto_retry_end":
      writeIfDefined(serialized, "success", readBooleanField(event, "success"));
      writeIfDefined(serialized, "attempt", readNumberField(event, "attempt"));
      writeIfDefined(serialized, "finalError", readStringField(event, "finalError"));
      break;

    case "message_start":
    case "message_end": {
      const message = event["message"];
      if (isRecord(message)) {
        writeIfDefined(serialized, "role", readStringField(message, "role"));
      }
      break;
    }

    case "message_update": {
      const assistantEvent = event["assistantMessageEvent"];
      if (isRecord(assistantEvent)) {
        writeIfDefined(
          serialized,
          "assistantMessageEventType",
          readStringField(assistantEvent, "type"),
        );
        writeIfDefined(serialized, "delta", readStringField(assistantEvent, "delta"));
      }
      break;
    }

    case "tool_execution_start":
    case "tool_execution_update":
      writeIfDefined(serialized, "toolCallId", readStringField(event, "toolCallId"));
      writeIfDefined(serialized, "toolName", readStringField(event, "toolName"));
      break;

    case "tool_execution_end":
      writeIfDefined(serialized, "toolCallId", readStringField(event, "toolCallId"));
      writeIfDefined(serialized, "toolName", readStringField(event, "toolName"));
      writeIfDefined(serialized, "isError", readBooleanField(event, "isError"));
      break;

    case "turn_end":
      writeIfDefined(serialized, "toolResultCount", readArrayLength(event, "toolResults"));
      break;

    case "agent_end":
      writeIfDefined(serialized, "messageCount", readArrayLength(event, "messages"));
      break;
  }

  return serialized;
}

function createRuntimeEventChunk(event: unknown): GenericAILlmStreamChunk {
  const eventType =
    isRecord(event) && typeof event["type"] === "string" ? event["type"] : "unknown";
  return {
    type: "event",
    event: {
      name: `pi.${eventType}`,
      data: serializePiSessionEvent(event),
    },
  };
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
  stopState?: StopAndRespondState,
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

  const stopTool = stopState === undefined ? undefined : createStopAndRespondTool(stopState);
  const result = await createAgentSession({
    cwd,
    agentDir,
    authStorage: authStorage as never,
    modelRegistry: modelRegistry as never,
    model: model as never,
    tools: stopTool === undefined ? [] : [STOP_AND_RESPOND_TOOL_NAME],
    ...(stopTool === undefined ? {} : { customTools: [stopTool] as never }),
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
    readonly turnMode?: GenericAIAgentTurnMode;
    readonly maxTurns?: number;
  },
  dependencies: OpenAICodexRuntimeDependencies = {},
): GenericAILlmRuntime {
  const model = input.model ?? DEFAULT_OPENAI_CODEX_MODEL;
  const run: GenericAILlmRuntime["run"] = async (prompt, options) => {
    if (options?.signal?.aborted) {
      throw createAbortError("before");
    }

    const turnMode = options?.turnMode ?? input.turnMode ?? "stop-tool-loop";
    const stopState: StopAndRespondState = { stopped: false };
    const { modelId, session } = await createSession(
      input,
      dependencies,
      turnMode === "single-turn" ? undefined : stopState,
    );
    try {
      if (turnMode === "single-turn") {
        await awaitPromptWithAbort(
          session.prompt(prompt, {
            source: "extension",
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          }),
          options?.signal,
          () => session.dispose?.(),
        );
        return toRunResult(modelId, extractLatestAssistantText(session), undefined);
      }

      const loop = await runStopToolLoop({
        prompt,
        state: stopState,
        maxTurns: options?.maxTurns ?? input.maxTurns,
        promptOptions: {
          source: "extension",
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        },
        runPrompt: async (loopPrompt, promptOptions) =>
          await awaitPromptWithAbort(
            session.prompt(loopPrompt, promptOptions),
            options?.signal,
            () => session.dispose?.(),
          ),
      });
      if (!loop.stopped || loop.outputText === undefined) {
        throw new Error(
          `${STOP_AND_RESPOND_TOOL_NAME} was not called after ${loop.turnCount} turn(s).`,
        );
      }

      return toRunResult(modelId, loop.outputText, undefined);
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
      if (options?.signal?.aborted) {
        throw createAbortError("before");
      }

      const turnMode = options?.turnMode ?? input.turnMode ?? "stop-tool-loop";
      const stopState: StopAndRespondState = { stopped: false };
      const { modelId, session } = await createSession(
        input,
        dependencies,
        turnMode === "single-turn" ? undefined : stopState,
      );
      const queue = createAsyncEventQueue<GenericAILlmStreamChunk>();
      const unsubscribe = session.subscribe?.((event) => {
        queue.push(createRuntimeEventChunk(event));
      });
      let promptError: unknown;
      let response: GenericAILlmRunResult | undefined;
      const promptPromise = (async () => {
        if (turnMode === "single-turn") {
          await awaitPromptWithAbort(
            session.prompt(prompt, {
              source: "extension",
              ...(options?.signal === undefined ? {} : { signal: options.signal }),
            }),
            options?.signal,
            () => session.dispose?.(),
          );
          response = toRunResult(modelId, extractLatestAssistantText(session), undefined);
          return;
        }

        const loop = await runStopToolLoop({
          prompt,
          state: stopState,
          maxTurns: options?.maxTurns ?? input.maxTurns,
          promptOptions: {
            source: "extension",
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
          },
          runPrompt: async (loopPrompt, promptOptions) =>
            await awaitPromptWithAbort(
              session.prompt(loopPrompt, promptOptions),
              options?.signal,
              () => session.dispose?.(),
            ),
        });
        if (!loop.stopped || loop.outputText === undefined) {
          throw new Error(
            `${STOP_AND_RESPOND_TOOL_NAME} was not called after ${loop.turnCount} turn(s).`,
          );
        }

        response = toRunResult(modelId, loop.outputText, undefined);
      })().then(
        () => {
          queue.close();
        },
        (error: unknown) => {
          promptError = error;
          queue.close();
        },
      );

      try {
        while (true) {
          const next = await queue.next();
          if (next.done) {
            break;
          }

          yield next.value;
        }

        await promptPromise;
        if (promptError !== undefined) {
          throw promptError;
        }
        if (response === undefined) {
          throw new Error("Pi OpenAI Codex runtime stream completed without a response.");
        }

        yield {
          type: "response",
          response,
        } as const;
      } finally {
        unsubscribe?.();
        session.dispose?.();
      }
    },
  });
}
