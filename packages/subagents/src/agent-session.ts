import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentThinkingLevel,
  type AgentTool,
  type StreamFn,
} from "@generic-ai/agent";
import type { AssistantMessage, Message, Model } from "@generic-ai/ai";
import { type AgentActivity, agentActivity } from "./observe.js";
import type {
  ChildRunResult,
  ChildSession,
  ChildSessionFactory,
  ChildSessionRequest,
} from "./supervisor.js";
import { createSubagentTools, type SubagentToolsOptions } from "./tools.js";

type Resolvable<T> = T | ((request: ChildSessionRequest) => T);

export interface AgentChildSessionFactoryOptions {
  /** Model for children that do not ask for one. */
  readonly model: Model;
  /** Resolve the `model` a spawn asks for. Without it, only the default model's id is accepted. */
  readonly resolveModel?: ((reference: string) => Model | undefined) | undefined;
  /** System prompt for each child. Defaults to `defaultSubagentSystemPrompt`. */
  readonly systemPrompt?: Resolvable<string> | undefined;
  /** Tools each child gets besides the subagent tools. */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists
  readonly tools?: Resolvable<readonly AgentTool<any, any>[]> | undefined;
  /** Which subagent tools a child gets, or `false` for none. */
  readonly subagentTools?: SubagentToolsOptions | false | undefined;
  readonly thinkingLevel?: AgentThinkingLevel | undefined;
  readonly streamFn?: StreamFn | undefined;
  readonly getApiKey?:
    | ((provider: string) => Promise<string | undefined> | string | undefined)
    | undefined;
  readonly convertToLlm?:
    | ((messages: AgentMessage[]) => Message[] | Promise<Message[]>)
    | undefined;
  /** Called for every event of every child agent. */
  readonly onAgentEvent?: ((request: ChildSessionRequest, event: AgentEvent) => void) | undefined;
  /** Called with each child agent once it is built. */
  readonly onAgentCreated?: ((request: ChildSessionRequest, agent: Agent) => void) | undefined;
}

/** The system prompt a subagent gets by default. */
export function defaultSubagentSystemPrompt(request: ChildSessionRequest): string {
  const lines = [
    `You are a subagent named "${request.name}", working for a parent agent.`,
    "Do the task you are given. Your final message is your answer: your parent reads it, so make it complete and self-contained.",
    'Use send_agent_message with receiver_role "parent" only when you need something from your parent before you can finish.',
  ];
  if (request.cwd !== undefined) {
    lines.push(`Current working directory: ${request.cwd}`);
  }
  return lines.join("\n");
}

function resolve<T>(value: Resolvable<T>, request: ChildSessionRequest): T {
  return typeof value === "function"
    ? (value as (request: ChildSessionRequest) => T)(request)
    : value;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && "role" in message && message.role === "assistant") {
      return message as AssistantMessage;
    }
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  const text = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** A `ChildSession` around an `Agent`: one task per run, steering for messages that arrive mid-run. */
export class AgentChildSession implements ChildSession {
  readonly agent: Agent;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  async run(prompt: string, signal: AbortSignal): Promise<ChildRunResult> {
    let toolUseCount = 0;
    const unsubscribe = this.agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        toolUseCount += 1;
      }
    });
    let onAbort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = () => {
        this.agent.abort();
        resolve();
      };
    });
    signal.addEventListener("abort", onAbort, { once: true });
    const work = async () => {
      await this.agent.prompt(prompt);
      // A message can arrive after the loop's last check; deliver it before settling.
      while (!signal.aborted && this.agent.hasQueuedMessages()) {
        await this.agent.continue();
      }
    };
    try {
      if (!signal.aborted) {
        // Settle at once on abort, even if the provider is slow to notice it.
        await Promise.race([work(), aborted]);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    if (signal.aborted) {
      return { aborted: true, toolUseCount };
    }
    const last = lastAssistant(this.agent.state.messages);
    const wasAborted = last?.stopReason === "aborted";
    const answer = assistantText(last);
    const error = wasAborted ? undefined : (this.agent.state.errorMessage ?? last?.errorMessage);
    return {
      ...(answer === undefined ? {} : { answer }),
      ...(error === undefined ? {} : { error }),
      aborted: wasAborted,
      toolUseCount,
    };
  }

  steer(message: string): void {
    this.agent.steer({ role: "user", content: message, timestamp: Date.now() });
  }

  pendingMessageCount(): number {
    return this.agent.peekQueuedMessages().length;
  }

  messages(): readonly unknown[] {
    return this.agent.state.messages;
  }

  activity(): AgentActivity {
    return agentActivity(this.agent.state);
  }

  dispose(): void {
    this.agent.abort();
  }
}

/** A child session factory that runs each subagent as an `Agent` with the subagent tools. */
export function createAgentChildSessionFactory(
  options: AgentChildSessionFactoryOptions,
): ChildSessionFactory {
  return (request) => {
    let model = options.model;
    if (request.model !== undefined) {
      const resolved =
        options.resolveModel?.(request.model) ??
        (request.model === options.model.id ||
        request.model === `${options.model.provider}/${options.model.id}`
          ? options.model
          : undefined);
      if (resolved === undefined) {
        throw new Error(`spawn_agent model "${request.model}" is not available`);
      }
      model = resolved;
    }
    const baseTools = options.tools === undefined ? [] : resolve(options.tools, request);
    const subagentTools =
      options.subagentTools === false
        ? []
        : createSubagentTools(request.node, options.subagentTools);
    const names = new Set(subagentTools.map((tool) => tool.name));
    const thinkingLevel = request.thinking ?? options.thinkingLevel;
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt:
          options.systemPrompt === undefined
            ? defaultSubagentSystemPrompt(request)
            : resolve(options.systemPrompt, request),
        tools: [...baseTools.filter((tool) => !names.has(tool.name)), ...subagentTools],
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      },
      sessionId: request.id,
      ...(options.streamFn === undefined ? {} : { streamFn: options.streamFn }),
      ...(options.getApiKey === undefined ? {} : { getApiKey: options.getApiKey }),
      ...(options.convertToLlm === undefined ? {} : { convertToLlm: options.convertToLlm }),
    });
    if (options.onAgentEvent !== undefined) {
      const onAgentEvent = options.onAgentEvent;
      agent.subscribe((event) => onAgentEvent(request, event));
    }
    options.onAgentCreated?.(request, agent);
    return new AgentChildSession(agent);
  };
}
