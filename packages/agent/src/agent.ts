import type { ImageContent, Message, Model, StreamOptions, TextContent } from "@generic-ai/ai";
import { getDefaultStreamFn, runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentState,
  AgentThinkingLevel,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  FinishTurn,
  PrepareNextTurnContext,
  PrepareRequest,
  QueueMode,
  StreamFn,
  ToolExecutionMode,
} from "./types.js";

/** Keep only messages an LLM understands. */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
}

const UNKNOWN_MODEL: Model = {
  id: "unknown",
  name: "unknown",
  api: "unknown",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

type MutableAgentState = AgentState & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage | undefined;
  pendingToolCalls: Set<string>;
  errorMessage?: string | undefined;
};

export type AgentInitialState = Partial<
  Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "tools" | "messages">
>;

function createState(initial: AgentInitialState | undefined): MutableAgentState {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
  let tools: AgentTool<any, any>[] = initial?.tools?.slice() ?? [];
  let messages: AgentMessage[] = initial?.messages?.slice() ?? [];
  return {
    systemPrompt: initial?.systemPrompt ?? "",
    model: initial?.model ?? UNKNOWN_MODEL,
    thinkingLevel: initial?.thinkingLevel ?? "off",
    get tools() {
      return tools;
    },
    set tools(next) {
      tools = next.slice();
    },
    get messages() {
      return messages;
    },
    set messages(next) {
      messages = next.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

export interface AgentOptions {
  initialState?: AgentInitialState;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Defaults to `stream` from `@generic-ai/ai`. */
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Extra provider options for every request (maxTokens, temperature, headers, fetch, ...). */
  streamOptions?: Omit<StreamOptions, "signal" | "reasoning" | "sessionId">;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  finishTurn?: FinishTurn;
  prepareRequest?: PrepareRequest;
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
  /** Default "one-at-a-time". */
  steeringMode?: QueueMode;
  /** Default "one-at-a-time". */
  followUpMode?: QueueMode;
  /** Stable id for prompt-cache affinity. */
  sessionId?: string;
  /** Default "parallel". */
  toolExecution?: ToolExecutionMode;
}

class PendingMessageQueue {
  #messages: AgentMessage[] = [];
  mode: QueueMode;

  constructor(mode: QueueMode) {
    this.mode = mode;
  }

  enqueue(message: AgentMessage): void {
    this.#messages.push(message);
  }

  hasItems(): boolean {
    return this.#messages.length > 0;
  }

  peek(): AgentMessage[] {
    if (this.mode === "all") {
      return this.#messages.slice();
    }
    const first = this.#messages[0];
    return first ? [first] : [];
  }

  drain(): AgentMessage[] {
    const drained = this.peek();
    this.#messages = this.#messages.slice(drained.length);
    return drained;
  }

  clear(): void {
    this.#messages = [];
  }
}

type ActiveRun = { promise: Promise<void>; resolve: () => void; abortController: AbortController };

type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

/**
 * Stateful agent: owns the transcript, tools, and model; runs prompts through the agent loop; and
 * queues steering (delivered after the current tools finish) and follow-up (delivered when the
 * agent would stop) messages. Listeners are awaited in order, so `agent_end` listeners are part of
 * the run.
 */
export class Agent {
  readonly #state: MutableAgentState;
  readonly #listeners = new Set<AgentListener>();
  readonly #steering: PendingMessageQueue;
  readonly #followUps: PendingMessageQueue;
  #activeRun: ActiveRun | undefined;

  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext: AgentOptions["transformContext"];
  streamFn: StreamFn;
  getApiKey: AgentOptions["getApiKey"];
  streamOptions: AgentOptions["streamOptions"];
  beforeToolCall: AgentOptions["beforeToolCall"];
  afterToolCall: AgentOptions["afterToolCall"];
  finishTurn: AgentOptions["finishTurn"];
  prepareRequest: AgentOptions["prepareRequest"];
  prepareNextTurn: AgentOptions["prepareNextTurn"];
  sessionId: string | undefined;
  toolExecution: ToolExecutionMode;

  constructor(options: AgentOptions = {}) {
    this.#state = createState(options.initialState);
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.transformContext = options.transformContext;
    this.streamFn = options.streamFn ?? getDefaultStreamFn();
    this.getApiKey = options.getApiKey;
    this.streamOptions = options.streamOptions;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.finishTurn = options.finishTurn;
    this.prepareRequest = options.prepareRequest;
    this.prepareNextTurn = options.prepareNextTurn;
    this.#steering = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.#followUps = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.sessionId = options.sessionId;
    this.toolExecution = options.toolExecution ?? "parallel";
  }

  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(listener: AgentListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get state(): AgentState {
    return this.#state;
  }

  get steeringMode(): QueueMode {
    return this.#steering.mode;
  }

  set steeringMode(mode: QueueMode) {
    this.#steering.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.#followUps.mode;
  }

  set followUpMode(mode: QueueMode) {
    this.#followUps.mode = mode;
  }

  /** Queue a message to inject after the current turn's tool calls finish. */
  steer(message: AgentMessage): void {
    this.#steering.enqueue(message);
  }

  /** Queue a message to process when the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.#followUps.enqueue(message);
  }

  clearSteeringQueue(): void {
    this.#steering.clear();
  }

  clearFollowUpQueue(): void {
    this.#followUps.clear();
  }

  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  hasQueuedMessages(): boolean {
    return this.#steering.hasItems() || this.#followUps.hasItems();
  }

  /** The messages the next drain point would deliver. */
  peekQueuedMessages(): AgentMessage[] {
    const steering = this.#steering.peek();
    return steering.length > 0 ? steering : this.#followUps.peek();
  }

  /** Abort signal of the active run. */
  get signal(): AbortSignal | undefined {
    return this.#activeRun?.abortController.signal;
  }

  abort(): void {
    this.#activeRun?.abortController.abort();
  }

  /** Resolves when the active run (including awaited listeners) has settled. */
  waitForIdle(): Promise<void> {
    return this.#activeRun?.promise ?? Promise.resolve();
  }

  /** Clear the transcript, queues, and error state. Throws while a run is active. */
  reset(): void {
    if (this.#activeRun) {
      throw new Error("Agent is already processing. Wait for completion before resetting.");
    }
    this.#state.messages = [];
    this.#state.isStreaming = false;
    this.#state.streamingMessage = undefined;
    this.#state.pendingToolCalls = new Set();
    this.#state.errorMessage = undefined;
    this.clearAllQueues();
  }

  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.#activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    await this.#runPrompt(normalizePromptInput(input, images));
  }

  /**
   * Continue from the current transcript. If it ends with an assistant message, queued steering
   * or follow-up messages are delivered instead; with none queued this throws.
   */
  async continue(): Promise<void> {
    if (this.#activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }
    const last = this.#state.messages.at(-1);
    if (!last) {
      throw new Error("No messages to continue from");
    }
    if (last.role === "assistant") {
      const steering = this.#steering.drain();
      if (steering.length > 0) {
        await this.#runPrompt(steering, { skipInitialSteeringPoll: true });
        return;
      }
      const followUps = this.#followUps.drain();
      if (followUps.length > 0) {
        await this.#runPrompt(followUps);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this.#runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.#contextSnapshot(),
        this.#loopConfig(),
        (event) => this.#process(event),
        signal,
        this.streamFn,
      );
    });
  }

  async #runPrompt(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.#runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.#contextSnapshot(),
        this.#loopConfig(options),
        (event) => this.#process(event),
        signal,
        this.streamFn,
      );
    });
  }

  #contextSnapshot(): AgentContext {
    return {
      ...(this.#state.systemPrompt ? { systemPrompt: this.#state.systemPrompt } : {}),
      messages: this.#state.messages.slice(),
      tools: this.#state.tools.slice(),
    };
  }

  #loopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
    const thinkingLevel: AgentThinkingLevel = this.#state.thinkingLevel;
    const prepareNextTurn = this.prepareNextTurn;
    return {
      ...(this.streamOptions ?? {}),
      model: this.#state.model,
      thinkingLevel,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      toolExecution: this.toolExecution,
      convertToLlm: this.convertToLlm,
      ...(this.transformContext ? { transformContext: this.transformContext } : {}),
      ...(this.getApiKey ? { getApiKey: this.getApiKey } : {}),
      ...(this.beforeToolCall ? { beforeToolCall: this.beforeToolCall } : {}),
      ...(this.afterToolCall ? { afterToolCall: this.afterToolCall } : {}),
      ...(this.finishTurn ? { finishTurn: this.finishTurn } : {}),
      ...(this.prepareRequest ? { prepareRequest: this.prepareRequest } : {}),
      ...(prepareNextTurn
        ? { prepareNextTurn: (context) => prepareNextTurn(context, this.signal) }
        : {}),
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.#steering.drain();
      },
      getFollowUpMessages: async () => this.#followUps.drain(),
    };
  }

  async #runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#activeRun) {
      throw new Error("Agent is already processing.");
    }
    const abortController = new AbortController();
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.#activeRun = { promise, resolve, abortController };
    this.#state.isStreaming = true;
    this.#state.streamingMessage = undefined;
    this.#state.errorMessage = undefined;
    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.#handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.#state.isStreaming = false;
      this.#state.streamingMessage = undefined;
      this.#state.pendingToolCalls = new Set();
      this.#activeRun?.resolve();
      this.#activeRun = undefined;
    }
  }

  async #handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const model = this.#state.model;
    const failure: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.#process({ type: "message_start", message: failure });
    await this.#process({ type: "message_end", message: failure });
    await this.#process({ type: "turn_end", message: failure, toolResults: [] });
    await this.#process({ type: "agent_end", messages: [failure] });
  }

  async #process(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this.#state.streamingMessage = event.message;
        break;
      case "message_end":
        this.#state.streamingMessage = undefined;
        this.#state.messages.push(event.message);
        break;
      case "tool_execution_start":
        this.#state.pendingToolCalls = new Set(this.#state.pendingToolCalls).add(event.toolCallId);
        break;
      case "tool_execution_end": {
        const pending = new Set(this.#state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this.#state.pendingToolCalls = pending;
        break;
      }
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) {
          this.#state.errorMessage = event.message.errorMessage;
        }
        break;
      case "agent_end":
        this.#state.streamingMessage = undefined;
        break;
      default:
        break;
    }
    const signal = this.#activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside an active run");
    }
    for (const listener of this.#listeners) {
      await listener(event, signal);
    }
  }
}

function normalizePromptInput(
  input: string | AgentMessage | AgentMessage[],
  images?: ImageContent[],
): AgentMessage[] {
  if (Array.isArray(input)) {
    return input;
  }
  if (typeof input !== "string") {
    return [input];
  }
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }];
  if (images && images.length > 0) {
    content.push(...images);
  }
  return [{ role: "user", content, timestamp: Date.now() }];
}
