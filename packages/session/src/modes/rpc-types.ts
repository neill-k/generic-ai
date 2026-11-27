// Adapted from pi (badlogic/pi-mono, packages/coding-agent/src/modes/rpc/rpc-types.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// The RPC protocol for headless use: commands arrive as JSON lines on the input stream, and
// responses and agent events leave as JSON lines on the output stream. This is the subset of pi's
// protocol that a library host can serve (no bash, fork, tree, HTML export or extension UI).

import type { AgentMessage, AgentThinkingLevel, QueueMode } from "@generic-ai/agent";
import type { ImageContent, Model } from "@generic-ai/ai";

import type { SessionEntry } from "../session-manager.js";
import type { RpcCommandInfo, SessionStats } from "./host.js";

export type RpcCommand =
  // Prompting
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "clear_queue" }
  | { id?: string; type: "new_session"; parentSession?: string }
  // State
  | { id?: string; type: "get_state" }
  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  // Thinking
  | { id?: string; type: "set_thinking_level"; level: AgentThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_thinking_levels" }
  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: QueueMode }
  | { id?: string; type: "set_follow_up_mode"; mode: QueueMode }
  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "get_entries"; since?: string }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  // Messages
  | { id?: string; type: "get_messages" }
  // Commands available through `prompt`
  | { id?: string; type: "get_commands" };

export type RpcCommandType = RpcCommand["type"];

/** `started`: the prompt runs now. `queued`: it waits for the running prompt. */
export type RpcPromptDisposition = "started" | "queued";

export interface RpcSessionState {
  model?: Model;
  thinkingLevel: AgentThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** The data each successful command answers with. */
export interface RpcResponseData {
  prompt: { disposition: RpcPromptDisposition };
  steer: { disposition: "queued" };
  follow_up: { disposition: "queued" };
  abort: undefined;
  clear_queue: { steering: string[]; followUp: string[] };
  new_session: { cancelled: boolean };
  get_state: RpcSessionState;
  set_model: Model;
  cycle_model: { model: Model; thinkingLevel: AgentThinkingLevel } | null;
  get_available_models: { models: Model[] };
  set_thinking_level: undefined;
  cycle_thinking_level: { level: AgentThinkingLevel } | null;
  get_available_thinking_levels: { levels: AgentThinkingLevel[] };
  set_steering_mode: undefined;
  set_follow_up_mode: undefined;
  compact: { summary: string; firstKeptEntryId: string; tokensBefore: number } | null;
  set_auto_compaction: undefined;
  get_session_stats: SessionStats;
  get_entries: { entries: SessionEntry[] };
  get_last_assistant_text: { text: string | null };
  set_session_name: undefined;
  get_messages: { messages: AgentMessage[] };
  get_commands: { commands: RpcCommandInfo[] };
}

export type RpcSuccessResponse = {
  [K in RpcCommandType]: RpcResponseData[K] extends undefined
    ? { id?: string; type: "response"; command: K; success: true }
    : { id?: string; type: "response"; command: K; success: true; data: RpcResponseData[K] };
}[RpcCommandType];

export interface RpcErrorResponse {
  id?: string;
  type: "response";
  /** The command's type, or `"parse"` for a line that was not valid JSON. */
  command: string;
  success: false;
  error: string;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

/** A prompt that answered `started` and then failed outside the agent loop (an extension, say). */
export interface RpcPromptErrorEvent {
  type: "prompt_error";
  id?: string;
  error: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Commands without their correlation id, as a client sends them. */
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;
