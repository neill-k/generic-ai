// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/core/extensions/runner.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@generic-ai/agent";
import type { ImageContent, TextContent, ToolResultMessage } from "@generic-ai/ai";

import type {
  BeforeAgentStartEventResult,
  Extension,
  ExtensionAPI,
  ExtensionCommand,
  ExtensionContext,
  ExtensionError,
  ExtensionEventMap,
  ExtensionEventName,
  ExtensionFactory,
  ExtensionHandler,
  InputEventResult,
  RegisteredCommand,
  SessionBeforeCompactEvent,
  SessionBeforeCompactEventResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from "./types.js";

type AnyHandler = (event: unknown, context: ExtensionContext) => unknown;

interface HandlerEntry {
  readonly extensionPath: string;
  readonly handler: AnyHandler;
}

interface ToolEntry {
  readonly extensionPath: string;
  // biome-ignore lint/suspicious/noExplicitAny: tools carry arbitrary parameter and detail types.
  readonly tool: AgentTool<any, any>;
}

export interface ExtensionRunnerOptions {
  /** Working directory reported to extensions. Defaults to `process.cwd()`. */
  readonly cwd?: string | undefined;
}

export interface BeforeAgentStartOutcome {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
}

export type PromptOutcome =
  | { readonly kind: "handled"; readonly command?: string | undefined }
  | { readonly kind: "prompt"; readonly text: string };

/**
 * Holds loaded extensions and dispatches events to them. Handlers run in load order. A handler that
 * throws is reported to `onError` listeners and the remaining handlers still run. Each dispatch
 * works on a snapshot of the handler list, so handlers added during a dispatch run from the next
 * one, and handlers removed during a dispatch still run in the current one.
 */
export class ExtensionRunner {
  readonly #cwd: string;
  readonly #extensions: Extension[] = [];
  readonly #handlers = new Map<ExtensionEventName, HandlerEntry[]>();
  readonly #tools: ToolEntry[] = [];
  readonly #commands: RegisteredCommand[] = [];
  readonly #errorListeners = new Set<(error: ExtensionError) => void>();
  #agent: Agent | undefined;

  constructor(options: ExtensionRunnerOptions = {}) {
    this.#cwd = options.cwd ?? process.cwd();
  }

  get extensions(): readonly Extension[] {
    return this.#extensions;
  }

  /** Run an extension factory and record what it registers. Errors are reported and rethrown. */
  async load(factory: ExtensionFactory, extensionPath: string): Promise<Extension> {
    const extension: Extension = { path: extensionPath };
    try {
      await factory(this.#createApi(extensionPath));
    } catch (error) {
      this.#emitError({ extensionPath, event: "load", error: errorMessage(error) });
      throw error;
    }
    this.#extensions.push(extension);
    return extension;
  }

  onError(listener: (error: ExtensionError) => void): () => void {
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  hasHandlers(event: ExtensionEventName): boolean {
    return (this.#handlers.get(event)?.length ?? 0) > 0;
  }

  /** Extension tools, first registration of each name only. */
  // biome-ignore lint/suspicious/noExplicitAny: tools carry arbitrary parameter and detail types.
  getTools(): AgentTool<any, any>[] {
    return this.#tools.map((entry) => entry.tool);
  }

  getCommands(): readonly RegisteredCommand[] {
    return this.#commands;
  }

  getCommand(invocationName: string): RegisteredCommand | undefined {
    return this.#commands.find((command) => command.invocationName === invocationName);
  }

  createContext(): ExtensionContext {
    const agent = this.#agent;
    return {
      cwd: this.#cwd,
      signal: agent?.signal,
      getSystemPrompt: () => agent?.state.systemPrompt ?? "",
      getMessages: () => agent?.state.messages ?? [],
      sendMessage: (message) => {
        if (agent === undefined) {
          throw new Error("sendMessage needs an agent; call bindAgent first.");
        }
        agent.steer(message);
      },
    };
  }

  /** Dispatch an event whose handlers return nothing. */
  async emit<K extends ExtensionEventName>(
    event: ExtensionEventMap[K][0] & { readonly type: K },
  ): Promise<void> {
    await this.#dispatch(event.type, event, () => false);
  }

  /**
   * `input`: each handler sees the text as rewritten by the ones before it. The first `handled`
   * stops the chain.
   */
  async emitInput(text: string): Promise<InputEventResult> {
    let current = text;
    let handled = false;
    await this.#dispatch(
      "input",
      () => ({ type: "input", text: current }),
      (result) => {
        const outcome = result as InputEventResult | undefined;
        if (outcome?.action === "handled") {
          handled = true;
          return true;
        }
        if (outcome?.action === "transform") {
          current = outcome.text;
        }
        return false;
      },
    );
    if (handled) {
      return { action: "handled" };
    }
    return current === text ? { action: "continue" } : { action: "transform", text: current };
  }

  /** `before_agent_start`: system prompt replacements chain; added messages accumulate. */
  async emitBeforeAgentStart(
    prompt: string,
    systemPrompt: string,
  ): Promise<BeforeAgentStartOutcome> {
    let current = systemPrompt;
    const messages: AgentMessage[] = [];
    await this.#dispatch(
      "before_agent_start",
      () => ({ type: "before_agent_start", prompt, systemPrompt: current }),
      (result) => {
        const outcome = result as BeforeAgentStartEventResult | undefined;
        if (outcome?.systemPrompt !== undefined) {
          current = outcome.systemPrompt;
        }
        if (outcome?.messages !== undefined) {
          messages.push(...outcome.messages);
        }
        return false;
      },
    );
    return { systemPrompt: current, messages };
  }

  /** `context`: each handler sees the messages as replaced by the ones before it. */
  async emitContext(messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
    let current = [...messages];
    await this.#dispatch(
      "context",
      () => ({ type: "context", messages: current }),
      (result) => {
        const replacement = (result as { messages?: readonly AgentMessage[] } | undefined)
          ?.messages;
        if (replacement !== undefined) {
          current = [...replacement];
        }
        return false;
      },
    );
    return current;
  }

  /** `tool_call`: the first handler that blocks wins. */
  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    let blocked: ToolCallEventResult | undefined;
    await this.#dispatch("tool_call", event, (result) => {
      const outcome = result as ToolCallEventResult | undefined;
      if (outcome?.block === true) {
        blocked = outcome;
        return true;
      }
      return false;
    });
    return blocked;
  }

  /**
   * `tool_result`: patches chain. Each handler sees the result with earlier patches applied, and a
   * partial patch keeps the fields it leaves out. Returns the combined patch, or `undefined` when no
   * handler changed anything.
   */
  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    let content = event.content;
    let details = event.details;
    let isError = event.isError;
    let changed = false;
    await this.#dispatch(
      "tool_result",
      () => ({ ...event, content, details, isError }),
      (result) => {
        const patch = result as ToolResultEventResult | undefined;
        if (patch === undefined) {
          return false;
        }
        if (patch.content !== undefined) {
          content = patch.content;
          changed = true;
        }
        if ("details" in patch) {
          details = patch.details;
          changed = true;
        }
        if (patch.isError !== undefined) {
          isError = patch.isError;
          changed = true;
        }
        return false;
      },
    );
    return changed ? { content, details, isError } : undefined;
  }

  /** `session_before_compact`: any handler can cancel; custom instructions are joined. */
  async emitBeforeCompact(
    event: SessionBeforeCompactEvent,
  ): Promise<SessionBeforeCompactEventResult> {
    let cancel = false;
    const instructions: string[] = [];
    await this.#dispatch("session_before_compact", event, (result) => {
      const outcome = result as SessionBeforeCompactEventResult | undefined;
      if (outcome?.cancel === true) {
        cancel = true;
        return true;
      }
      if (outcome?.customInstructions !== undefined) {
        instructions.push(outcome.customInstructions);
      }
      return false;
    });
    return {
      ...(cancel ? { cancel } : {}),
      ...(instructions.length > 0 ? { customInstructions: instructions.join("\n\n") } : {}),
    };
  }

  /**
   * Prepare a prompt: run `input` handlers, then an extension command when the text is
   * `/name args`. Returns the text to send to the model, or `handled` when an extension consumed it.
   */
  async preparePrompt(text: string): Promise<PromptOutcome> {
    const input = await this.emitInput(text);
    if (input.action === "handled") {
      return { kind: "handled" };
    }
    const prompt = input.action === "transform" ? input.text : text;
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt);
    const command = match?.[1] === undefined ? undefined : this.getCommand(match[1]);
    if (command !== undefined) {
      try {
        await command.handler((match?.[2] ?? "").trim(), this.createContext());
      } catch (error) {
        this.#emitError({
          extensionPath: command.extensionPath,
          event: `command:${command.invocationName}`,
          error: errorMessage(error),
        });
        throw error;
      }
      return { kind: "handled", command: command.invocationName };
    }
    return { kind: "prompt", text: prompt };
  }

  /**
   * Attach to an agent: add extension tools, route the agent's context, tool-call, and tool-result
   * hooks through the extensions (after any hooks the agent already has), and forward agent events.
   * Returns a function that detaches again.
   */
  bindAgent(agent: Agent): () => void {
    this.#agent = agent;
    const existing = new Set(agent.state.tools.map((tool) => tool.name));
    const added = this.getTools().filter((tool) => {
      if (existing.has(tool.name)) {
        this.#emitError({
          extensionPath: this.#toolOwner(tool.name),
          event: "register_tool",
          error: `Tool "${tool.name}" is already provided by the session and was not added.`,
        });
        return false;
      }
      return true;
    });
    agent.state.tools = [...agent.state.tools, ...added];

    const previousTransform = agent.transformContext;
    const previousBefore = agent.beforeToolCall;
    const previousAfter = agent.afterToolCall;

    agent.transformContext = async (messages, signal) => {
      const base =
        previousTransform === undefined ? messages : await previousTransform(messages, signal);
      return this.hasHandlers("context") ? this.emitContext(base) : base;
    };
    agent.beforeToolCall = async (
      context: BeforeToolCallContext,
      signal?: AbortSignal,
    ): Promise<BeforeToolCallResult | undefined> => {
      const earlier = await previousBefore?.(context, signal);
      if (earlier?.block === true || !this.hasHandlers("tool_call")) {
        return earlier;
      }
      const blocked = await this.emitToolCall({
        type: "tool_call",
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        input: context.args,
        assistantMessage: context.assistantMessage,
      });
      if (blocked === undefined) {
        return earlier;
      }
      return {
        block: true,
        reason: blocked.reason ?? `Tool "${context.toolCall.name}" was blocked by an extension.`,
      };
    };
    agent.afterToolCall = async (
      context: AfterToolCallContext,
      signal?: AbortSignal,
    ): Promise<AfterToolCallResult | undefined> => {
      const earlier = await previousAfter?.(context, signal);
      if (!this.hasHandlers("tool_result")) {
        return earlier;
      }
      const patch = await this.emitToolResult({
        type: "tool_result",
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        input: context.args,
        content: earlier?.content ?? context.result.content,
        details:
          earlier !== undefined && "details" in earlier ? earlier.details : context.result.details,
        isError: earlier?.isError ?? context.isError,
      });
      if (patch === undefined) {
        return earlier;
      }
      return {
        ...earlier,
        content: [...(patch.content ?? [])] as (TextContent | ImageContent)[],
        details: patch.details,
        ...(patch.isError === undefined ? {} : { isError: patch.isError }),
      };
    };

    let turnIndex = 0;
    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          turnIndex = 0;
          await this.emit({ type: "agent_start" });
          break;
        case "agent_end":
          await this.emit({ type: "agent_end", messages: event.messages });
          break;
        case "turn_start":
          await this.emit({ type: "turn_start", turnIndex });
          break;
        case "turn_end":
          await this.emit({
            type: "turn_end",
            turnIndex,
            message: event.message,
            toolResults: event.toolResults as ToolResultMessage[],
          });
          turnIndex += 1;
          break;
        case "message_end":
          await this.emit({ type: "message_end", message: event.message });
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      agent.transformContext = previousTransform;
      agent.beforeToolCall = previousBefore;
      agent.afterToolCall = previousAfter;
      agent.state.tools = agent.state.tools.filter((tool) => !added.includes(tool));
      if (this.#agent === agent) {
        this.#agent = undefined;
      }
    };
  }

  /**
   * Run a prompt on a bound agent with the extension lifecycle: `input` and commands, then
   * `before_agent_start` (system prompt and extra messages), then `run`. Returns how the prompt
   * was handled.
   */
  async runPrompt(text: string, run: (text: string) => Promise<void>): Promise<PromptOutcome> {
    const agent = this.#agent;
    const prepared = await this.preparePrompt(text);
    if (prepared.kind === "handled") {
      return prepared;
    }
    if (agent !== undefined && this.hasHandlers("before_agent_start")) {
      const start = await this.emitBeforeAgentStart(prepared.text, agent.state.systemPrompt);
      agent.state.systemPrompt = start.systemPrompt;
      if (start.messages.length > 0) {
        agent.state.messages = [...agent.state.messages, ...start.messages];
      }
    }
    await run(prepared.text);
    return prepared;
  }

  #createApi(extensionPath: string): ExtensionAPI {
    return {
      on: <K extends ExtensionEventName>(event: K, handler: ExtensionHandler<K>) => {
        const entry: HandlerEntry = { extensionPath, handler: handler as AnyHandler };
        const list = this.#handlers.get(event) ?? [];
        list.push(entry);
        this.#handlers.set(event, list);
        return () => {
          const current = this.#handlers.get(event);
          if (current === undefined) {
            return;
          }
          const index = current.indexOf(entry);
          if (index !== -1) {
            current.splice(index, 1);
          }
          if (current.length === 0) {
            this.#handlers.delete(event);
          }
        };
      },
      registerTool: (tool) => {
        if (tool.parameters === undefined || tool.parameters === null) {
          this.#emitError({
            extensionPath,
            event: "register_tool",
            error: `Tool "${tool.name}" has no parameter schema.`,
          });
          return;
        }
        const owner = this.#tools.find((entry) => entry.tool.name === tool.name);
        if (owner !== undefined) {
          this.#emitError({
            extensionPath,
            event: "register_tool",
            error: `Tool "${tool.name}" is already registered by ${owner.extensionPath}; keeping the first.`,
          });
          return;
        }
        this.#tools.push({ extensionPath, tool });
      },
      registerCommand: (name: string, command: ExtensionCommand) => {
        const taken = this.#commands.filter((existing) => existing.name === name).length;
        this.#commands.push({
          ...command,
          name,
          invocationName: taken === 0 ? name : `${name}:${taken + 1}`,
          extensionPath,
        });
      },
    };
  }

  #toolOwner(name: string): string {
    return this.#tools.find((entry) => entry.tool.name === name)?.extensionPath ?? "unknown";
  }

  async #dispatch(
    eventName: ExtensionEventName,
    event: unknown | (() => unknown),
    accept: (result: unknown) => boolean,
  ): Promise<void> {
    const snapshot = [...(this.#handlers.get(eventName) ?? [])];
    if (snapshot.length === 0) {
      return;
    }
    const context = this.createContext();
    for (const entry of snapshot) {
      const payload = typeof event === "function" ? (event as () => unknown)() : event;
      let result: unknown;
      try {
        result = await entry.handler(payload, context);
      } catch (error) {
        this.#emitError({
          extensionPath: entry.extensionPath,
          event: eventName,
          error: errorMessage(error),
        });
        continue;
      }
      if (accept(result)) {
        return;
      }
    }
  }

  #emitError(error: ExtensionError): void {
    for (const listener of this.#errorListeners) {
      listener(error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
