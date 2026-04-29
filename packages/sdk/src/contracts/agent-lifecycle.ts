import type { Awaitable, JsonObject, JsonValue } from "./shared.js";
import type { PolicyDecisionRecord, ResourceSelector } from "../harness/types.js";

export const AGENT_LIFECYCLE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
] as const;

export const AGENT_LIFECYCLE_HOOK_HANDLER_TYPES = [
  "command",
  "in-process",
  "http",
  "mcp",
  "prompt",
  "agent",
] as const;

export const AGENT_LIFECYCLE_HOOK_DECISIONS = [
  "allow",
  "block",
  "rewrite",
  "append_context",
  "observe",
] as const;

export const AGENT_LIFECYCLE_HOOK_FAILURE_MODES = ["fail-open", "fail-closed"] as const;

export type AgentLifecycleHookEvent = (typeof AGENT_LIFECYCLE_HOOK_EVENTS)[number];
export type AgentLifecycleHookHandlerType = (typeof AGENT_LIFECYCLE_HOOK_HANDLER_TYPES)[number];
export type AgentLifecycleHookDecision = (typeof AGENT_LIFECYCLE_HOOK_DECISIONS)[number];
export type AgentLifecycleHookFailureMode = (typeof AGENT_LIFECYCLE_HOOK_FAILURE_MODES)[number];

export interface AgentLifecycleHookDefaults {
  readonly timeoutMs?: number;
  readonly failureMode?: AgentLifecycleHookFailureMode;
}

export interface AgentLifecycleHookMatcher {
  readonly actorId?: string;
  readonly roleId?: string;
  readonly toolName?: string;
  readonly action?: string;
  readonly resourceKind?: ResourceSelector["kind"];
  readonly resourceId?: string;
}

export interface AgentLifecycleHookCommandHandler {
  readonly type: "command";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: boolean;
  readonly timeoutMs?: number;
  readonly failureMode?: AgentLifecycleHookFailureMode;
}

export interface AgentLifecycleHookInProcessHandler {
  readonly type: "in-process";
  readonly ref: string;
  readonly timeoutMs?: number;
  readonly failureMode?: AgentLifecycleHookFailureMode;
}

export interface AgentLifecycleHookFutureHandler {
  readonly type: Exclude<AgentLifecycleHookHandlerType, "command" | "in-process">;
  readonly ref: string;
  readonly timeoutMs?: number;
  readonly failureMode?: AgentLifecycleHookFailureMode;
  readonly config?: JsonObject;
}

export type AgentLifecycleHookHandler =
  | AgentLifecycleHookCommandHandler
  | AgentLifecycleHookInProcessHandler
  | AgentLifecycleHookFutureHandler;

export interface AgentLifecycleHookDeclaration {
  readonly id: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly events: readonly AgentLifecycleHookEvent[];
  readonly matcher?: AgentLifecycleHookMatcher;
  readonly handler: AgentLifecycleHookHandler;
  readonly timeoutMs?: number;
  readonly failureMode?: AgentLifecycleHookFailureMode;
  readonly metadata?: JsonObject;
}

export interface AgentLifecycleHooksConfig {
  readonly schemaVersion?: "v1";
  readonly defaults?: AgentLifecycleHookDefaults;
  readonly hooks: readonly AgentLifecycleHookDeclaration[];
  readonly metadata?: JsonObject;
}

export interface AgentLifecycleHookContext {
  readonly event: AgentLifecycleHookEvent;
  readonly runId: string;
  readonly scopeId: string;
  readonly rootSessionId?: string;
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  readonly actorId?: string;
  readonly roleId?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly action?: string;
  readonly resource?: ResourceSelector;
  readonly prompt?: string;
  readonly input?: JsonValue;
  readonly result?: JsonValue;
  readonly policyDecision?: PolicyDecisionRecord;
  readonly metadata?: JsonObject;
}

export interface AgentLifecycleHookOutput {
  readonly decision?: AgentLifecycleHookDecision;
  readonly reason?: string;
  readonly prompt?: string;
  readonly input?: JsonValue;
  readonly additionalContext?: string;
  readonly metadata?: JsonObject;
}

export interface AgentLifecycleInProcessHookHandler {
  readonly id: string;
  handle(context: AgentLifecycleHookContext): Awaitable<AgentLifecycleHookOutput | undefined>;
}

export interface AgentLifecycleHookDecisionRecord {
  readonly id: string;
  readonly hookId: string;
  readonly event: AgentLifecycleHookEvent;
  readonly handlerType: AgentLifecycleHookHandlerType;
  readonly status:
    | "allowed"
    | "blocked"
    | "rewritten"
    | "appended_context"
    | "observed"
    | "skipped"
    | "failed";
  readonly decision: AgentLifecycleHookDecision;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly prompt?: string;
  readonly input?: JsonValue;
  readonly additionalContext?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly metadata?: JsonObject;
}

export interface AgentLifecycleHookRunResult {
  readonly blocked: boolean;
  readonly prompt?: string;
  readonly input?: JsonValue;
  readonly additionalContext?: string;
  readonly decisions: readonly AgentLifecycleHookDecisionRecord[];
}
