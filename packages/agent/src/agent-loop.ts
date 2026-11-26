import {
  type AssistantMessage,
  EventStream,
  stream as defaultStream,
  type ToolResultMessage,
  validateToolArguments,
} from "@generic-ai/ai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentThinkingLevel,
  AgentTool,
  AgentToolCall,
  AgentToolCallOutcome,
  AgentToolResult,
  PrepareNextTurnContext,
  StreamFn,
} from "./types.js";

/**
 * The agent loop: one or more turns, each an assistant response plus the tool calls it made.
 * Works on AgentMessages and converts to LLM messages only at the request boundary.
 */

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

let defaultStreamFn: StreamFn = defaultStream;

/** Replace the stream function used when a caller passes none. */
/** Replace the stream function used when none is configured. `undefined` restores the built-in default. */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
  defaultStreamFn = streamFn ?? defaultStream;
}

export function getDefaultStreamFn(): StreamFn {
  return defaultStreamFn;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}

/** Start a run with new prompt messages. Returns an event stream whose result is the run's new messages. */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const events = createAgentStream();
  void runAgentLoop(prompts, context, config, (event) => events.push(event), signal, streamFn).then(
    (messages) => events.end(messages),
  );
  return events;
}

function assertContinuable(context: AgentContext): void {
  const last = context.messages.at(-1);
  if (!last) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (last.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
}

/**
 * Continue from the current context without a new prompt (retries, resumed sessions). The last
 * message must convert to a user or tool-result message.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  assertContinuable(context);
  const events = createAgentStream();
  void runAgentLoopContinue(context, config, (event) => events.push(event), signal, streamFn).then(
    (messages) => events.end(messages),
  );
  return events;
}

/** Run a prompt to completion, reporting events to `emit`. Resolves with the run's new messages. */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const current: AgentContext = { ...context, messages: [...context.messages, ...prompts] };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const message of prompts) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }
  await runLoop(current, newMessages, config, signal, emit, streamFn ?? defaultStreamFn);
  return newMessages;
}

/** Continue a context to completion, reporting events to `emit`. */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  assertContinuable(context);
  const newMessages: AgentMessage[] = [];
  const current: AgentContext = { ...context, messages: [...context.messages] };
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await runLoop(current, newMessages, config, signal, emit, streamFn ?? defaultStreamFn);
  return newMessages;
}

function withThinkingLevel(
  config: AgentLoopConfig,
  level: AgentThinkingLevel | undefined,
): AgentLoopConfig {
  if (level === undefined) {
    return config;
  }
  return { ...config, thinkingLevel: level };
}

async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn,
): Promise<void> {
  let context = initialContext;
  let config = initialConfig;
  let lastTurn: PrepareNextTurnContext | undefined;
  let explicitContinuation = false;
  // The user may have typed while the run was starting.
  let pending: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pending.length > 0) {
      let prepared: AgentMessage[] = [];
      if (lastTurn) {
        const update = await config.prepareNextTurn?.(lastTurn);
        if (update) {
          context = update.context ?? context;
          prepared = update.messages ?? [];
          config = withThinkingLevel(
            { ...config, model: update.model ?? config.model },
            update.thinkingLevel,
          );
        }
        // Preparation can be slow (compaction): pick up steering queued meanwhile, but only if the
        // earlier poll was empty, so one-at-a-time mode never delivers two messages in one turn.
        if (pending.length === 0) {
          pending = (await config.getSteeringMessages?.()) ?? [];
        }
        await emit({ type: "turn_start" });
      }

      for (const message of [...prepared, ...pending]) {
        await emit({ type: "message_start", message });
        await emit({ type: "message_end", message });
        context.messages.push(message);
        newMessages.push(message);
      }
      pending = [];

      const requestUpdate = await config.prepareRequest?.(
        { context, model: config.model, thinkingLevel: config.thinkingLevel ?? "off" },
        signal,
      );
      if (requestUpdate) {
        context = requestUpdate.context ?? context;
        config = withThinkingLevel(
          { ...config, model: requestUpdate.model ?? config.model },
          requestUpdate.thinkingLevel,
        );
      }

      const message = await streamAssistantResponse(context, config, signal, emit, streamFn);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        lastTurn = { message, toolResults: [], context, newMessages };
        await config.finishTurn?.(lastTurn, signal);
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      const toolCalls = message.content.filter(
        (block): block is AgentToolCall => block.type === "toolCall",
      );
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (toolCalls.length > 0) {
        // A "length" stop may have cut tool-call arguments short; never execute those.
        const batch =
          message.stopReason === "length"
            ? await failTruncatedToolCalls(toolCalls, emit)
            : await executeToolCalls(context, message, toolCalls, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;
        for (const result of batch.messages) {
          context.messages.push(result);
          newMessages.push(result);
        }
      }

      lastTurn = { message, toolResults, context, newMessages };
      const decision = await config.finishTurn?.(lastTurn, signal);
      await emit({ type: "turn_end", message, toolResults });
      if (decision?.action === "end") {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      explicitContinuation = decision?.action === "continue";
      pending = (await config.getSteeringMessages?.()) ?? [];
      if (hasMoreToolCalls || pending.length > 0) {
        explicitContinuation = false;
      }
    }

    const followUps = (await config.getFollowUpMessages?.()) ?? [];
    if (followUps.length > 0) {
      explicitContinuation = false;
      pending = followUps;
      continue;
    }
    // No natural request was scheduled: honour a "continue" decision with one context-only turn.
    if (explicitContinuation) {
      explicitContinuation = false;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn: StreamFn,
): Promise<AssistantMessage> {
  const messages = config.transformContext
    ? await config.transformContext(context.messages, signal)
    : context.messages;
  const llmMessages = await config.convertToLlm(messages);
  const auth = config.getAuth ? await config.getAuth(config.model.provider) : undefined;
  const apiKey =
    auth?.apiKey ||
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) ||
    config.apiKey;
  const {
    model: configModel,
    thinkingLevel,
    convertToLlm: _convert,
    transformContext: _transform,
    getApiKey: _getApiKey,
    getAuth: _getAuth,
    finishTurn: _finishTurn,
    prepareRequest: _prepareRequest,
    prepareNextTurn: _prepareNextTurn,
    getSteeringMessages: _steering,
    getFollowUpMessages: _followUps,
    toolExecution: _toolExecution,
    beforeToolCall: _before,
    afterToolCall: _after,
    ...streamOptions
  } = config;
  const model = auth?.baseUrl ? { ...configModel, baseUrl: auth.baseUrl } : configModel;
  const headers =
    auth?.headers || streamOptions.headers
      ? { ...(auth?.headers ?? {}), ...(streamOptions.headers ?? {}) }
      : undefined;
  const response = await streamFn(
    model,
    {
      ...(context.systemPrompt ? { systemPrompt: context.systemPrompt } : {}),
      messages: llmMessages,
      ...(context.tools && context.tools.length > 0
        ? {
            tools: context.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          }
        : {}),
    },
    {
      ...streamOptions,
      ...(headers ? { headers } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(thinkingLevel && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
      ...(signal ? { signal } : {}),
    },
  );
  const level = thinkingLevel ?? "off";
  const finalMessage = async () => Object.assign(await response.result(), { thinkingLevel: level });

  let partial: AssistantMessage | undefined;
  for await (const event of response) {
    switch (event.type) {
      case "start":
        partial = event.partial;
        context.messages.push(partial);
        await emit({ type: "message_start", message: { ...partial } });
        break;
      case "done":
      case "error":
        return finishAssistant(context, partial, await finalMessage(), emit);
      default:
        if (partial) {
          partial = event.partial;
          context.messages[context.messages.length - 1] = partial;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partial },
          });
        }
        break;
    }
  }
  return finishAssistant(context, partial, await finalMessage(), emit);
}

async function finishAssistant(
  context: AgentContext,
  partial: AssistantMessage | undefined,
  message: AssistantMessage,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  if (partial) {
    context.messages[context.messages.length - 1] = message;
  } else {
    context.messages.push(message);
    await emit({ type: "message_start", message: { ...message } });
  }
  await emit({ type: "message_end", message });
  return message;
}

type ToolBatch = { messages: ToolResultMessage[]; terminate: boolean };

function errorResult(message: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: message }], details: {} };
}

async function failTruncatedToolCalls(
  toolCalls: AgentToolCall[],
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const outcome: AgentToolCallOutcome = {
      toolCall,
      result: errorResult(
        `Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
      ),
      isError: true,
    };
    await emitToolExecutionEnd(outcome, emit);
    const message = toolResultMessage(outcome);
    await emitMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: false };
}

async function executeToolCalls(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const forceSequential = toolCalls.some(
    (call) =>
      context.tools?.find((tool) => tool.name === call.name)?.executionMode === "sequential",
  );
  return config.toolExecution === "sequential" || forceSequential
    ? executeSequential(context, assistantMessage, toolCalls, config, signal, emit)
    : executeParallel(context, assistantMessage, toolCalls, config, signal, emit);
}

function shouldTerminate(outcomes: AgentToolCallOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((outcome) => outcome.result.terminate === true);
}

async function executeSequential(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const outcomes: AgentToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
    const outcome =
      preparation.kind === "immediate"
        ? { toolCall, result: preparation.result, isError: true }
        : await finalizeToolCall(
            context,
            assistantMessage,
            preparation,
            await executePrepared(preparation, signal, toolUpdateSink(toolCall, emit)),
            config,
            signal,
          );
    await emitToolExecutionEnd(outcome, emit);
    const message = toolResultMessage(outcome);
    await emitMessage(message, emit);
    outcomes.push(outcome);
    messages.push(message);
  }
  return { messages, terminate: shouldTerminate(outcomes) };
}

async function executeParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ToolBatch> {
  const entries: (AgentToolCallOutcome | (() => Promise<AgentToolCallOutcome>))[] = [];
  // Preparation (validation, beforeToolCall) runs in order; execution runs concurrently.
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);
    if (preparation.kind === "immediate") {
      const outcome = { toolCall, result: preparation.result, isError: true };
      await emitToolExecutionEnd(outcome, emit);
      entries.push(outcome);
      continue;
    }
    entries.push(async () => {
      if (signal?.aborted) {
        const outcome = { toolCall, result: errorResult("Operation aborted"), isError: true };
        await emitToolExecutionEnd(outcome, emit);
        return outcome;
      }
      const executed = await executePrepared(preparation, signal, toolUpdateSink(toolCall, emit));
      const outcome = await finalizeToolCall(
        context,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(outcome, emit);
      return outcome;
    });
  }
  const outcomes = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : entry)),
  );
  const messages: ToolResultMessage[] = [];
  for (const outcome of outcomes) {
    const message = toolResultMessage(outcome);
    await emitMessage(message, emit);
    messages.push(message);
  }
  return { messages, terminate: shouldTerminate(outcomes) };
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools
  tool: AgentTool<any, any>;
  args: unknown;
};

type ImmediateOutcome = { kind: "immediate"; result: AgentToolResult<unknown> };

type ExecutedToolCall = { result: AgentToolResult<unknown>; isError: boolean; durationMs: number };

type ToolUpdateSink = (partialResult: AgentToolResult<unknown>) => Promise<void> | void;

/** The `beforeToolCall` and `afterToolCall` hooks. */
export type ToolCallHooks = Pick<AgentLoopConfig, "beforeToolCall" | "afterToolCall">;

async function prepareToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  hooks: ToolCallHooks,
  signal: AbortSignal | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools
  tools: readonly AgentTool<any, any>[] = context.tools ?? [],
): Promise<PreparedToolCall | ImmediateOutcome> {
  // Once aborted, skip preparation and hooks; every call still gets a result.
  if (signal?.aborted) {
    return { kind: "immediate", result: errorResult("Operation aborted") };
  }
  const tool = tools.find((candidate) => candidate.name === toolCall.name);
  if (!tool) {
    return { kind: "immediate", result: errorResult(`Tool ${toolCall.name} not found`) };
  }
  try {
    const prepared = tool.prepareArguments
      ? {
          ...toolCall,
          arguments: tool.prepareArguments(toolCall.arguments) as AgentToolCall["arguments"],
        }
      : toolCall;
    const args = validateToolArguments(tool, prepared);
    if (hooks.beforeToolCall) {
      const decision = await hooks.beforeToolCall(
        { assistantMessage, toolCall, args, context },
        signal,
      );
      if (signal?.aborted) {
        return { kind: "immediate", result: errorResult("Operation aborted") };
      }
      if (decision?.block) {
        const result = errorResult(decision.reason || "Tool execution was blocked");
        if (decision.terminate === true) {
          result.terminate = true;
        }
        return { kind: "immediate", result };
      }
    }
    return { kind: "prepared", toolCall, tool, args };
  } catch (error) {
    return {
      kind: "immediate",
      result: errorResult(error instanceof Error ? error.message : String(error)),
    };
  }
}

function toolUpdateSink(toolCall: AgentToolCall, emit: AgentEventSink): ToolUpdateSink {
  return (partialResult) =>
    emit({
      type: "tool_execution_update",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
      partialResult,
    });
}

async function executePrepared(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  onUpdate: ToolUpdateSink,
): Promise<ExecutedToolCall> {
  const updates: Promise<void>[] = [];
  let accepting = true;
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    const result = (await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partial) => {
        // Updates after the tool settled are ignored.
        if (accepting) {
          updates.push(Promise.resolve(onUpdate(partial)));
        }
      },
    )) as AgentToolResult<unknown>;
    const durationMs = elapsed();
    accepting = false;
    await Promise.all(updates);
    return { result, isError: result.isError === true, durationMs };
  } catch (error) {
    const durationMs = elapsed();
    accepting = false;
    await Promise.all(updates);
    return {
      result: errorResult(error instanceof Error ? error.message : String(error)),
      isError: true,
      durationMs,
    };
  }
}

async function finalizeToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCall,
  hooks: ToolCallHooks,
  signal: AbortSignal | undefined,
): Promise<AgentToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;
  if (hooks.afterToolCall) {
    try {
      const override = await hooks.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context,
        },
        signal,
      );
      if (override) {
        // Structured content not replaced along with the content may no longer match it.
        const structuredContent =
          override.structuredContent ?? (override.content ? undefined : result.structuredContent);
        const next: AgentToolResult<unknown> = {
          content: override.content ?? result.content,
          details: override.details ?? result.details,
        };
        const usage = override.usage ?? result.usage;
        const terminate = override.terminate ?? result.terminate;
        if (usage !== undefined) {
          next.usage = usage;
        }
        if (terminate !== undefined) {
          next.terminate = terminate;
        }
        if (structuredContent !== undefined) {
          next.structuredContent = structuredContent;
        }
        if (result.isError !== undefined) {
          next.isError = result.isError;
        }
        result = next;
        isError = override.isError ?? isError;
      }
    } catch (error) {
      result = errorResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }
  return { toolCall: prepared.toolCall, result, isError, durationMs: executed.durationMs };
}

/** Options for {@link runToolCall}. */
export interface RunToolCallOptions extends ToolCallHooks {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools
  tools: readonly AgentTool<any, any>[];
  assistantMessage: AssistantMessage;
  context: AgentContext;
  signal?: AbortSignal;
  onUpdate?: ToolUpdateSink;
}

/**
 * Run one tool call through the same steps as a model-issued call (argument preparation,
 * validation, `beforeToolCall`, execution, `afterToolCall`) without emitting events. Tools that call
 * other tools use it so hooks such as permission checks apply. Never rejects for tool failures.
 */
export async function runToolCall(
  toolCall: AgentToolCall,
  options: RunToolCallOptions,
): Promise<AgentToolCallOutcome> {
  const { assistantMessage, context, signal } = options;
  const preparation = await prepareToolCall(
    context,
    assistantMessage,
    toolCall,
    options,
    signal,
    options.tools,
  );
  if (preparation.kind === "immediate") {
    return { toolCall, result: preparation.result, isError: true };
  }
  const executed = await executePrepared(preparation, signal, options.onUpdate ?? (() => {}));
  return finalizeToolCall(context, assistantMessage, preparation, executed, options, signal);
}

async function emitToolExecutionEnd(
  outcome: AgentToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: outcome.toolCall.id,
    toolName: outcome.toolCall.name,
    result: outcome.result,
    isError: outcome.isError,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
  });
}

function toolResultMessage(outcome: AgentToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: outcome.toolCall.id,
    toolName: outcome.toolCall.name,
    // Untyped tools may omit content; never let null reach history or provider payloads.
    content: outcome.result.content ?? [],
    details: outcome.result.details,
    ...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
    isError: outcome.isError,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    timestamp: Date.now(),
  };
}

async function emitMessage(message: AgentMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}
