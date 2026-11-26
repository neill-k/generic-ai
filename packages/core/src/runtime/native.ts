import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@generic-ai/agent";
import {
  type AssistantMessage,
  type Model,
  type ModelOverrides,
  resolveModel,
  type ThinkingLevel,
} from "@generic-ai/ai";
import type { UsageTotals } from "@generic-ai/sdk";
import { createUsageMeter } from "../usage/meter.js";
import {
  STOP_AND_RESPOND_TOOL_NAME,
  type StopAndRespondState,
  runStopToolLoop,
} from "./stop-tool-loop.js";
import type {
  CreateGenericAILlmRuntimeOptions,
  GenericAILlmRunOptions,
  GenericAILlmRunResult,
  GenericAILlmRuntime,
  GenericAILlmStreamChunk,
} from "./types.js";

/** Default model for the native runtime when none is configured. */
export const DEFAULT_NATIVE_MODEL = "anthropic/claude-opus-5-5" as const;

export interface NativeRuntimeDependencies {
  /** Replace the provider stream (tests, proxies, recording). */
  readonly streamFn?: StreamFn;
  /** Use this model instead of resolving `options.model` (tests, custom providers). */
  readonly model?: Model;
  /** Field overrides applied to the resolved model (base URL, prices, limits, compat flags). */
  readonly modelOverrides?: ModelOverrides;
  /** Reasoning effort for every request. Omit for the provider default (no explicit thinking). */
  readonly thinkingLevel?: ThinkingLevel;
}

/**
 * Resolve a model reference. `provider/id` is used as is; a bare id is routed by its family
 * (`claude-*` to Anthropic, anything else to OpenAI) so existing `GENERIC_AI_MODEL=gpt-5.5` configs
 * keep working.
 */
export function resolveNativeModel(ref: string, overrides: ModelOverrides = {}): Model {
  if (ref.includes("/")) {
    return resolveModel(ref, overrides);
  }
  const provider = ref.startsWith("claude-") ? "anthropic" : "openai";
  return resolveModel({ provider, id: ref }, overrides);
}

function createNativeStopTool(state: StopAndRespondState): AgentTool {
  return {
    name: STOP_AND_RESPOND_TOOL_NAME,
    label: "Stop And Respond",
    description: "Stop the current agent loop and return the final user-facing response.",
    parameters: {
      type: "object",
      properties: {
        response: {
          type: "string",
          minLength: 1,
          description: "Final user-facing response to return after the agent loop stops.",
        },
        status: {
          type: "string",
          enum: ["completed", "blocked", "failed"],
          description: "Terminal status for the agent loop.",
        },
      },
      required: ["response"],
    },
    async execute(
      _toolCallId,
      params: { response: string; status?: StopAndRespondState["status"] },
    ) {
      const response = params.response.trim();
      if (response.length === 0) {
        throw new Error(`${STOP_AND_RESPOND_TOOL_NAME} requires a non-empty response.`);
      }
      state.stopped = true;
      state.response = response;
      state.status = params.status ?? "completed";
      return {
        content: [{ type: "text", text: "Agent loop stopped; final response captured." }],
        details: { status: state.status },
        terminate: true,
      };
    },
  };
}

function latestAssistant(agent: Agent): AssistantMessage | undefined {
  for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
    const message = agent.state.messages[index];
    if (message !== undefined && "role" in message && message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string {
  return (message?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * The native runtime adapter: the Generic AI agent loop (`@generic-ai/agent`) over the native
 * provider layer (`@generic-ai/ai`), with no pi dependency. Same contract as the other adapters:
 * `stop-tool-loop` mode (default) keeps feeding the conversation back until the model calls
 * `stop_and_respond`; `single-turn` returns the first assistant reply.
 */
export function createNativeRuntime(
  input: CreateGenericAILlmRuntimeOptions,
  dependencies: NativeRuntimeDependencies = {},
): GenericAILlmRuntime {
  const model =
    dependencies.model ??
    resolveNativeModel(input.model ?? DEFAULT_NATIVE_MODEL, dependencies.modelOverrides);
  const modelRef = `${model.provider}/${model.id}`;
  const apiKey = input.apiKey?.trim();

  function createAgent(stopState: StopAndRespondState | undefined): Agent {
    return new Agent({
      initialState: {
        model,
        ...(input.instructions === undefined ? {} : { systemPrompt: input.instructions }),
        ...(dependencies.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: dependencies.thinkingLevel }),
        tools: stopState === undefined ? [] : [createNativeStopTool(stopState)],
      },
      ...(dependencies.streamFn === undefined ? {} : { streamFn: dependencies.streamFn }),
      ...(apiKey === undefined || apiKey.length === 0 ? {} : { getApiKey: () => apiKey }),
      // The stop tool must run alone so `terminate` ends the turn deterministically.
      toolExecution: "sequential",
    });
  }

  async function execute(
    prompt: string,
    options: GenericAILlmRunOptions | undefined,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<GenericAILlmRunResult> {
    if (options?.signal?.aborted) {
      throw new Error("native runtime aborted before prompt dispatch.");
    }
    const turnMode = options?.turnMode ?? input.turnMode ?? "stop-tool-loop";
    const stopState: StopAndRespondState = { stopped: false };
    const agent = createAgent(turnMode === "single-turn" ? undefined : stopState);
    const unsubscribe = onEvent === undefined ? undefined : agent.subscribe(onEvent);
    const abort = () => agent.abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    // Meter every response of this run; a reached cap aborts the agent like a caller abort would.
    const meter = createUsageMeter(options?.budget === undefined ? {} : { budget: options.budget });
    const usageContext = {
      scopeId: "runtime",
      runId: "native-runtime",
      rootSessionId: "native-runtime",
      sessionId: "native-runtime",
    };
    const unmeter = meter.bindAgent(agent, usageContext);
    meter.signal.addEventListener("abort", abort, { once: true });
    const usage = (): UsageTotals => meter.totals(usageContext.runId);

    const runPrompt = async (text: string) => {
      await agent.prompt(text);
      if (meter.exceeded !== undefined && !stopState.stopped) {
        throw meter.exceeded;
      }
      const last = latestAssistant(agent);
      if (last?.stopReason === "aborted" || options?.signal?.aborted) {
        throw new Error("native runtime aborted.");
      }
      if (agent.state.errorMessage !== undefined && !stopState.stopped) {
        throw new Error(agent.state.errorMessage);
      }
    };

    try {
      if (turnMode === "single-turn") {
        await runPrompt(prompt);
        const last = latestAssistant(agent);
        return toResult(modelRef, assistantText(last), last?.responseId, usage());
      }
      const loop = await runStopToolLoop({
        prompt,
        state: stopState,
        maxTurns: options?.maxTurns ?? input.maxTurns,
        runPrompt: (text) => runPrompt(text),
      });
      if (!loop.stopped || loop.outputText === undefined) {
        throw new Error(
          `${STOP_AND_RESPOND_TOOL_NAME} was not called after ${loop.turnCount} turn(s).`,
        );
      }
      return toResult(modelRef, loop.outputText, latestAssistant(agent)?.responseId, usage());
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      meter.signal.removeEventListener("abort", abort);
      unmeter();
      unsubscribe?.();
    }
  }

  return Object.freeze({
    adapter: "native" as const,
    model: modelRef,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    run: (prompt: string, options?: GenericAILlmRunOptions) => execute(prompt, options),
    async *stream(
      prompt: string,
      options?: GenericAILlmRunOptions,
    ): AsyncIterable<GenericAILlmStreamChunk> {
      const queue: GenericAILlmStreamChunk[] = [];
      let wake: (() => void) | undefined;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      let finished = false;
      let failure: unknown;
      let result: GenericAILlmRunResult | undefined;
      void execute(prompt, options, (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          queue.push({ type: "text-delta", delta: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
          queue.push({ type: "event", event: { name: event.type, data: event } });
        }
        notify();
      }).then(
        (value) => {
          result = value;
          finished = true;
          notify();
        },
        (error: unknown) => {
          failure = error;
          finished = true;
          notify();
        },
      );
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (finished) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failure !== undefined) {
        throw failure;
      }
      if (result !== undefined) {
        yield { type: "response", response: result };
      }
    },
  });
}

function toResult(
  model: string,
  outputText: string,
  requestId: string | undefined,
  usage: UsageTotals,
): GenericAILlmRunResult {
  return Object.freeze({
    adapter: "native" as const,
    model,
    outputText,
    ...(requestId === undefined ? {} : { requestId }),
    usage,
  });
}
