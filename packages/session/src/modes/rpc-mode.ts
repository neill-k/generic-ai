// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/modes/rpc/rpc-mode.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// RPC mode: drive an agent over JSON lines. Commands come in on `input`; responses and every agent
// event go out on `output`. Used by IDE integrations and other programs that embed the harness.

import type { AgentMessage, AgentThinkingLevel } from "@generic-ai/agent";
import { getModel, type ImageContent, type Model, type ProviderId } from "@generic-ai/ai";

import { compactIfNeeded, compactNow } from "../agent-session.js";
import {
  type AgentModeHost,
  bindPersistence,
  lastAssistantText,
  runHostPrompt,
  sessionStats,
  THINKING_LEVELS,
} from "./host.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
  RpcCommand,
  RpcErrorResponse,
  RpcPromptErrorEvent,
  RpcResponse,
  RpcResponseData,
  RpcSessionState,
} from "./rpc-types.js";

export interface RpcModeOptions {
  /** Where commands arrive. Defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadableStream & import("node:stream").Readable;
  /** Where responses and events go. Defaults to `process.stdout`. */
  readonly output?: { write(chunk: string): unknown };
}

function userMessage(text: string, images?: ImageContent[]): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
  };
}

function messageText(message: AgentMessage): string | undefined {
  if (message.role !== "user") return undefined;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("");
}

function defaultResolveModel(provider: string, modelId: string): Model | undefined {
  return getModel(provider as ProviderId, modelId);
}

function sameModel(left: Model, right: Model): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/**
 * Serve the RPC protocol until `input` ends, then wait for the running prompt, stop persisting and
 * call `host.dispose`.
 */
export async function runRpcMode(host: AgentModeHost, options: RpcModeOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const agent = host.agent;
  const write = (value: unknown): void => {
    output.write(serializeJsonLine(value));
  };

  const success = <K extends keyof RpcResponseData>(
    id: string | undefined,
    command: K,
    data?: RpcResponseData[K],
  ): RpcResponse =>
    ({
      ...(id === undefined ? {} : { id }),
      type: "response",
      command,
      success: true,
      ...(data === undefined ? {} : { data }),
    }) as RpcResponse;
  const failure = (id: string | undefined, command: string, error: string): RpcErrorResponse => ({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command,
    success: false,
    error,
  });

  // Texts of queued messages, so `clear_queue` can hand them back. They leave when the agent
  // delivers them (a user `message_start` with the same text).
  let steering: string[] = [];
  let followUps: string[] = [];
  let autoCompaction = host.compaction !== undefined;
  let compacting = false;
  let running: Promise<void> | undefined;

  const unsubscribeEvents = agent.subscribe((event) => {
    if (event.type === "message_start") {
      const text = messageText(event.message);
      if (text !== undefined) {
        const steerIndex = steering.indexOf(text);
        if (steerIndex !== -1) steering.splice(steerIndex, 1);
        else {
          const followIndex = followUps.indexOf(text);
          if (followIndex !== -1) followUps.splice(followIndex, 1);
        }
      }
    }
    write(event);
  });
  const stopPersisting = bindPersistence(host);

  const compactionOptions = () => {
    if (host.compaction === undefined) return undefined;
    return {
      ...host.compaction,
      model: agent.state.model,
      thinkingLevel: agent.state.thinkingLevel,
    };
  };

  const runPrompt = (id: string | undefined, text: string, images?: ImageContent[]) => {
    running = (async () => {
      try {
        await runHostPrompt(host, text, images);
        const settings = compactionOptions();
        if (autoCompaction && settings !== undefined && host.sessionManager !== undefined) {
          compacting = true;
          try {
            await compactIfNeeded(agent, host.sessionManager, settings);
          } finally {
            compacting = false;
          }
        }
      } catch (error) {
        const event: RpcPromptErrorEvent = {
          type: "prompt_error",
          ...(id === undefined ? {} : { id }),
          error: error instanceof Error ? error.message : String(error),
        };
        write(event);
      } finally {
        running = undefined;
      }
    })();
  };

  const queue = (behavior: "steer" | "followUp", text: string, images?: ImageContent[]) => {
    if (behavior === "steer") {
      agent.steer(userMessage(text, images));
      steering.push(text);
    } else {
      agent.followUp(userMessage(text, images));
      followUps.push(text);
    }
  };

  const availableModels = (): Model[] => {
    const models = host.availableModels?.() ?? [agent.state.model];
    return [...models];
  };

  const setModel = (model: Model) => {
    agent.state.model = model;
    host.sessionManager?.appendModelChange(model.provider, model.id);
  };

  const setThinkingLevel = (level: AgentThinkingLevel) => {
    agent.state.thinkingLevel = level;
    host.sessionManager?.appendThinkingLevelChange(level);
  };

  const handle = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
    const id = command.id;
    switch (command.type) {
      case "prompt": {
        if (agent.state.isStreaming || running !== undefined) {
          if (command.streamingBehavior === undefined) {
            return failure(
              id,
              "prompt",
              "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
            );
          }
          queue(command.streamingBehavior, command.message, command.images);
          return success(id, "prompt", { disposition: "queued" });
        }
        write(success(id, "prompt", { disposition: "started" }));
        runPrompt(id, command.message, command.images);
        return undefined;
      }
      case "steer":
        queue("steer", command.message, command.images);
        return success(id, "steer", { disposition: "queued" });
      case "follow_up":
        queue("followUp", command.message, command.images);
        return success(id, "follow_up", { disposition: "queued" });
      case "abort":
        agent.abort();
        await agent.waitForIdle();
        return success(id, "abort");
      case "clear_queue": {
        const cleared = { steering, followUp: followUps };
        steering = [];
        followUps = [];
        agent.clearAllQueues();
        return success(id, "clear_queue", cleared);
      }
      case "new_session": {
        if (agent.state.isStreaming || running !== undefined) {
          agent.abort();
          await (running ?? agent.waitForIdle());
        }
        host.sessionManager?.newSession(
          command.parentSession === undefined
            ? undefined
            : { parentSession: command.parentSession },
        );
        agent.reset();
        steering = [];
        followUps = [];
        return success(id, "new_session", { cancelled: false });
      }
      case "get_state": {
        const manager = host.sessionManager;
        const sessionFile = manager?.getSessionFile();
        const sessionName = manager?.getSessionName();
        const state: RpcSessionState = {
          model: agent.state.model,
          thinkingLevel: agent.state.thinkingLevel,
          isStreaming: agent.state.isStreaming,
          isCompacting: compacting,
          steeringMode: agent.steeringMode,
          followUpMode: agent.followUpMode,
          ...(sessionFile === undefined ? {} : { sessionFile }),
          ...(manager === undefined ? {} : { sessionId: manager.getSessionId() }),
          ...(sessionName === undefined ? {} : { sessionName }),
          autoCompactionEnabled: autoCompaction,
          messageCount: agent.state.messages.length,
          pendingMessageCount: steering.length + followUps.length,
        };
        return success(id, "get_state", state);
      }
      case "set_model": {
        const resolve = host.resolveModel ?? defaultResolveModel;
        const model = resolve(command.provider, command.modelId);
        if (model === undefined) {
          return failure(
            id,
            "set_model",
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        }
        setModel(model);
        return success(id, "set_model", model);
      }
      case "cycle_model": {
        const models = availableModels();
        if (models.length < 2) return success(id, "cycle_model", null);
        const index = models.findIndex((model) => sameModel(model, agent.state.model));
        const next = models[(index + 1) % models.length];
        if (next === undefined) return success(id, "cycle_model", null);
        setModel(next);
        return success(id, "cycle_model", {
          model: next,
          thinkingLevel: agent.state.thinkingLevel,
        });
      }
      case "get_available_models":
        return success(id, "get_available_models", { models: availableModels() });
      case "set_thinking_level":
        if (!THINKING_LEVELS.includes(command.level)) {
          return failure(id, "set_thinking_level", `Unknown thinking level: ${command.level}`);
        }
        setThinkingLevel(command.level);
        return success(id, "set_thinking_level");
      case "cycle_thinking_level": {
        if (agent.state.model.reasoning !== true) return success(id, "cycle_thinking_level", null);
        const index = THINKING_LEVELS.indexOf(agent.state.thinkingLevel);
        const level = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length] ?? "off";
        setThinkingLevel(level);
        return success(id, "cycle_thinking_level", { level });
      }
      case "get_available_thinking_levels":
        return success(id, "get_available_thinking_levels", {
          levels: agent.state.model.reasoning === true ? [...THINKING_LEVELS] : ["off"],
        });
      case "set_steering_mode":
        agent.steeringMode = command.mode;
        return success(id, "set_steering_mode");
      case "set_follow_up_mode":
        agent.followUpMode = command.mode;
        return success(id, "set_follow_up_mode");
      case "compact": {
        const settings = compactionOptions();
        if (host.sessionManager === undefined) {
          return failure(id, "compact", "Compaction needs a session manager");
        }
        if (agent.state.isStreaming || running !== undefined) {
          return failure(id, "compact", "Cannot compact while the agent is processing");
        }
        compacting = true;
        try {
          const result = await compactNow(agent, host.sessionManager, {
            ...(settings ?? { model: agent.state.model, thinkingLevel: agent.state.thinkingLevel }),
            ...(command.customInstructions === undefined
              ? {}
              : { customInstructions: command.customInstructions }),
          });
          return success(
            id,
            "compact",
            result === undefined
              ? null
              : {
                  summary: result.summary,
                  firstKeptEntryId: result.firstKeptEntryId,
                  tokensBefore: result.tokensBefore,
                },
          );
        } finally {
          compacting = false;
        }
      }
      case "set_auto_compaction":
        autoCompaction = command.enabled;
        return success(id, "set_auto_compaction");
      case "get_session_stats":
        return success(id, "get_session_stats", sessionStats(host));
      case "get_entries": {
        const entries = host.sessionManager?.getEntries() ?? [];
        if (command.since === undefined) return success(id, "get_entries", { entries });
        const index = entries.findIndex((entry) => entry.id === command.since);
        if (index === -1) {
          return failure(id, "get_entries", `Entry not found: ${command.since}`);
        }
        return success(id, "get_entries", { entries: entries.slice(index + 1) });
      }
      case "get_last_assistant_text":
        return success(id, "get_last_assistant_text", {
          text: lastAssistantText(agent.state.messages) ?? null,
        });
      case "set_session_name": {
        const name = command.name.trim();
        if (name.length === 0)
          return failure(id, "set_session_name", "Session name cannot be empty");
        if (host.sessionManager === undefined) {
          return failure(id, "set_session_name", "Naming a session needs a session manager");
        }
        host.sessionManager.appendSessionInfo(name);
        return success(id, "set_session_name");
      }
      case "get_messages":
        return success(id, "get_messages", { messages: [...agent.state.messages] });
      case "get_commands":
        return success(id, "get_commands", { commands: [...(host.commands?.() ?? [])] });
      default: {
        const unknown = command as { type?: unknown };
        return failure(id, String(unknown.type), `Unknown command: ${String(unknown.type)}`);
      }
    }
  };

  // Commands run one at a time, in arrival order; a prompt returns as soon as it has started.
  let chain: Promise<void> = Promise.resolve();
  const onLine = (line: string) => {
    if (line.trim().length === 0) return;
    let command: RpcCommand;
    try {
      command = JSON.parse(line) as RpcCommand;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write(failure(undefined, "parse", `Failed to parse command: ${message}`));
      return;
    }
    if (typeof command !== "object" || command === null || typeof command.type !== "string") {
      write(failure(undefined, "parse", "Command must be an object with a string type"));
      return;
    }
    chain = chain.then(async () => {
      try {
        const response = await handle(command);
        if (response !== undefined) write(response);
      } catch (error) {
        write(
          failure(command.id, command.type, error instanceof Error ? error.message : String(error)),
        );
      }
    });
  };

  const detach = attachJsonlLineReader(input, onLine);
  try {
    await new Promise<void>((resolve) => {
      if (input.readableEnded) resolve();
      else input.once("end", () => resolve());
    });
    await chain;
    await running;
    await agent.waitForIdle();
  } finally {
    detach();
    unsubscribeEvents();
    stopPersisting();
    await host.dispose?.();
  }
}
