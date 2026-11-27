// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/modes/rpc/rpc-client.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// A typed client for RPC mode. It talks to a child process that serves `runRpcMode` on its stdio,
// or to any pair of streams (an in-process server, a socket).

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { AgentEvent, AgentMessage, AgentThinkingLevel } from "@generic-ai/agent";
import type { ImageContent, Model } from "@generic-ai/ai";

import type { SessionStats } from "./host.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
  RpcCommandBody,
  RpcPromptDisposition,
  RpcPromptErrorEvent,
  RpcResponse,
  RpcResponseData,
  RpcSessionState,
} from "./rpc-types.js";

export interface RpcClientStreams {
  /** The server's input: commands are written here. */
  readonly input: Writable;
  /** The server's output: responses and events are read from here. */
  readonly output: Readable;
}

export interface RpcClientSpawnOptions {
  /** Executable that serves RPC mode on its stdio. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Added to `process.env`. */
  readonly env?: Record<string, string>;
}

export type RpcClientEvent = AgentEvent | RpcPromptErrorEvent;
export type RpcEventListener = (event: RpcClientEvent) => void;

interface PendingRequest {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

export class RpcClient {
  #input: Writable | undefined;
  #process: ChildProcess | undefined;
  #stopReading: (() => void) | undefined;
  #listeners: RpcEventListener[] = [];
  #pending = new Map<string, PendingRequest>();
  #nextId = 0;
  #stderr = "";
  #closedError: Error | undefined;

  /** Connect to a server already running on these streams. */
  static connect(streams: RpcClientStreams): RpcClient {
    const client = new RpcClient();
    client.#attach(streams.input, streams.output);
    return client;
  }

  /** Start a child process that serves RPC mode and connect to it. */
  static async spawn(options: RpcClientSpawnOptions): Promise<RpcClient> {
    const client = new RpcClient();
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    client.#process = child;
    child.stderr?.on("data", (data: Buffer) => {
      client.#stderr += data.toString();
    });
    child.once("exit", (code, signal) => {
      client.#close(
        new Error(
          `Agent process exited (code ${code ?? "none"}, signal ${signal ?? "none"}). Stderr: ${client.#stderr}`,
        ),
      );
    });
    child.once("error", (error) => {
      client.#close(new Error(`Agent process error: ${error.message}. Stderr: ${client.#stderr}`));
    });
    if (child.stdin === null || child.stdout === null) {
      throw new Error("Agent process has no stdio pipes");
    }
    client.#attach(child.stdin, child.stdout);
    return client;
  }

  #attach(input: Writable, output: Readable): void {
    this.#input = input;
    this.#stopReading = attachJsonlLineReader(output, (line) => this.#handleLine(line));
    output.once("end", () => this.#close(new Error("Agent output ended")));
  }

  #close(error: Error): void {
    this.#closedError ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null) return;
    const record = data as { type?: unknown; id?: unknown };
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.#pending.get(record.id);
      if (pending !== undefined) {
        this.#pending.delete(record.id);
        pending.resolve(data as RpcResponse);
        return;
      }
    }
    if (record.type === "response") return;
    for (const listener of [...this.#listeners]) listener(data as RpcClientEvent);
  }

  /** Text the child process wrote to stderr. */
  getStderr(): string {
    return this.#stderr;
  }

  /** Listen to agent events. Returns the function that stops listening. */
  onEvent(listener: RpcEventListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index !== -1) this.#listeners.splice(index, 1);
    };
  }

  /** Send a command and return its data; a failed command rejects with the server's error. */
  async send<K extends keyof RpcResponseData>(
    command: Extract<RpcCommandBody, { type: K }>,
  ): Promise<RpcResponseData[K]> {
    if (this.#closedError !== undefined) throw this.#closedError;
    const input = this.#input;
    if (input === undefined) throw new Error("Client is not connected");
    const id = `req_${++this.#nextId}`;
    const response = await new Promise<RpcResponse>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      input.write(serializeJsonLine({ ...command, id }));
    });
    if (!response.success) throw new Error(response.error);
    return (response as { data?: RpcResponseData[K] }).data as RpcResponseData[K];
  }

  async prompt(
    message: string,
    options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
  ): Promise<RpcPromptDisposition> {
    const result = await this.send({ type: "prompt", message, ...options });
    return result.disposition;
  }

  async steer(message: string, images?: ImageContent[]): Promise<void> {
    await this.send({ type: "steer", message, ...(images === undefined ? {} : { images }) });
  }

  async followUp(message: string, images?: ImageContent[]): Promise<void> {
    await this.send({ type: "follow_up", message, ...(images === undefined ? {} : { images }) });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    return this.send({ type: "clear_queue" });
  }

  newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    return this.send({
      type: "new_session",
      ...(parentSession === undefined ? {} : { parentSession }),
    });
  }

  getState(): Promise<RpcSessionState> {
    return this.send({ type: "get_state" });
  }

  setModel(provider: string, modelId: string): Promise<Model> {
    return this.send({ type: "set_model", provider, modelId });
  }

  cycleModel(): Promise<{ model: Model; thinkingLevel: AgentThinkingLevel } | null> {
    return this.send({ type: "cycle_model" });
  }

  async getAvailableModels(): Promise<Model[]> {
    return (await this.send({ type: "get_available_models" })).models;
  }

  async setThinkingLevel(level: AgentThinkingLevel): Promise<void> {
    await this.send({ type: "set_thinking_level", level });
  }

  async compact(customInstructions?: string): Promise<RpcResponseData["compact"]> {
    return this.send({
      type: "compact",
      ...(customInstructions === undefined ? {} : { customInstructions }),
    });
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.send({ type: "set_auto_compaction", enabled });
  }

  getSessionStats(): Promise<SessionStats> {
    return this.send({ type: "get_session_stats" });
  }

  async getMessages(): Promise<AgentMessage[]> {
    return (await this.send({ type: "get_messages" })).messages;
  }

  async getLastAssistantText(): Promise<string | null> {
    return (await this.send({ type: "get_last_assistant_text" })).text;
  }

  async setSessionName(name: string): Promise<void> {
    await this.send({ type: "set_session_name", name });
  }

  /** Resolve at the next `agent_end`; reject on a `prompt_error` or after `timeoutMs`. */
  waitForIdle(timeoutMs = 60_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the agent to finish`));
      }, timeoutMs);
      const stop = this.onEvent((event) => {
        if (event.type === "agent_end" || event.type === "prompt_error") {
          clearTimeout(timer);
          stop();
          if (event.type === "prompt_error") reject(new Error(event.error));
          else resolve();
        }
      });
    });
  }

  /** Send a prompt and wait for the agent to finish it. Returns the events it produced. */
  async promptAndWait(
    message: string,
    options?: { images?: ImageContent[]; timeoutMs?: number },
  ): Promise<RpcClientEvent[]> {
    const events: RpcClientEvent[] = [];
    const stop = this.onEvent((event) => events.push(event));
    try {
      const idle = this.waitForIdle(options?.timeoutMs);
      await this.prompt(
        message,
        options?.images === undefined ? undefined : { images: options.images },
      );
      await idle;
      return events;
    } finally {
      stop();
    }
  }

  /** Close the server's input and, for a child process, end it. */
  async stop(): Promise<void> {
    this.#stopReading?.();
    this.#stopReading = undefined;
    this.#input?.end();
    const child = this.#process;
    if (child === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
