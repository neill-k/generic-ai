// Adapted from pi (badlogic/pi-mono, packages/coding-agent/examples/extensions/plan-mode/index.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.
//
// pi's plan mode drives a TUI: it swaps the active tool set, shows a widget and asks what to do
// next. This version is headless. Plan mode blocks the write tools and non-allowlisted bash
// through `tool_call`, so the agent can explore but not change anything; the host reads the
// extracted plan from the controller and starts execution with `execute()` or `/plan execute`.

import type { AgentMessage } from "@generic-ai/agent";

import {
  allStepsComplete,
  extractTodoItems,
  isSafeCommand,
  markCompletedSteps,
  type TodoItem,
} from "./plan-mode-utils.js";
import type { ExtensionFactory } from "./types.js";

export const PLAN_MODE_CONTEXT_MARKER = "[PLAN MODE ACTIVE]";
export const PLAN_EXECUTION_CONTEXT_MARKER = "[EXECUTING PLAN - Full tool access enabled]";

const PLAN_MODE_CONTEXT = `${PLAN_MODE_CONTEXT_MARKER}
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- The edit and write tools are disabled
- Other tools remain available
- Bash is restricted to an allowlist of read-only commands

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.`;

export type PlanModePhase = "off" | "planning" | "executing";

export interface PlanModeState {
  readonly phase: PlanModePhase;
  /** Steps of the latest plan, with their completion. */
  readonly todos: readonly TodoItem[];
}

export interface PlanModeOptions {
  /** Start in plan mode. */
  readonly enabled?: boolean | undefined;
  /** Restore a saved state, for example after a session resumes. Wins over `enabled`. */
  readonly initialState?: PlanModeState | undefined;
  /** Tools refused in plan mode. Defaults to `edit` and `write`. */
  readonly blockedTools?: readonly string[] | undefined;
  /** Tools whose `command` input must pass the read-only allowlist. Defaults to `bash`. */
  readonly bashTools?: readonly string[] | undefined;
  /** Called when a plan-mode answer contains a plan. */
  readonly onPlan?: ((todos: readonly TodoItem[]) => void) | undefined;
  /** Called whenever the phase or step completion changes, for saving the state. */
  readonly onStateChange?: ((state: PlanModeState) => void) | undefined;
}

export interface PlanModeController {
  /** Register with `factories` (or `ExtensionRunner.loadFactory`). */
  readonly extension: ExtensionFactory;
  state(): PlanModeState;
  /** Enter plan mode and clear any previous plan. */
  enable(): void;
  /** Leave plan mode or execution and clear the plan. */
  disable(): void;
  /**
   * Leave plan mode and execute the latest plan. Returns the prompt to send next, or `undefined`
   * when there is no plan.
   */
  execute(): string | undefined;
}

function isAssistant(message: AgentMessage): message is AgentMessage & {
  role: "assistant";
  content: readonly { type: string; text?: string; thinking?: string }[];
} {
  return message.role === "assistant" && Array.isArray(message.content);
}

/** Text and thinking blocks: with reasoning models, plans and [DONE:n] tags often land in thinking. */
function assistantText(message: AgentMessage): string {
  if (!isAssistant(message)) return "";
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "thinking") return block.thinking ?? "";
      return "";
    })
    .join("\n");
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) =>
      block.type === "text" ? (block.text ?? "") : "",
    )
    .join("");
}

function contextMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function executionPrompt(todos: readonly TodoItem[]): string {
  const remaining = todos.filter((todo) => !todo.completed);
  const first = remaining[0];
  return `Execute the plan.

Remaining steps:
${remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n")}

Start with: ${first?.text ?? ""}
After completing a step, include a [DONE:n] tag in your response.`;
}

/**
 * Plan mode, after pi's: `/plan` toggles a read-only phase in which edits, writes and
 * non-allowlisted bash commands are refused and the model is asked for a numbered "Plan:". The
 * steps are extracted when the run ends; `execute()` (or `/plan execute`) restores full access and
 * tracks `[DONE:n]` markers until every step is done.
 */
export function createPlanMode(options: PlanModeOptions = {}): PlanModeController {
  const blocked = new Set(options.blockedTools ?? ["edit", "write"]);
  const bashTools = new Set(options.bashTools ?? ["bash"]);
  let phase: PlanModePhase =
    options.initialState?.phase ?? (options.enabled === true ? "planning" : "off");
  let todos: TodoItem[] = (options.initialState?.todos ?? []).map((todo) => ({ ...todo }));

  const state = (): PlanModeState => ({ phase, todos: todos.map((todo) => ({ ...todo })) });
  const changed = () => options.onStateChange?.(state());

  const enable = () => {
    phase = "planning";
    todos = [];
    changed();
  };
  const disable = () => {
    phase = "off";
    todos = [];
    changed();
  };
  const execute = (): string | undefined => {
    if (todos.length === 0) return undefined;
    phase = "executing";
    changed();
    return executionPrompt(todos);
  };

  const extension: ExtensionFactory = (api) => {
    api.registerCommand("plan", {
      description:
        "Toggle plan mode (read-only exploration). `/plan execute` runs the latest plan.",
      handler: (args) => {
        const action = args.trim().toLowerCase();
        if (action === "execute") {
          execute();
        } else if (action === "on") {
          enable();
        } else if (action === "off") {
          disable();
        } else if (phase === "planning") {
          disable();
        } else {
          enable();
        }
      },
    });

    api.on("tool_call", (event) => {
      if (phase !== "planning") return undefined;
      if (blocked.has(event.toolName)) {
        return {
          block: true,
          reason: `Plan mode: ${event.toolName} is disabled. Use /plan to leave plan mode first.`,
        };
      }
      if (bashTools.has(event.toolName)) {
        const command = (event.input as { command?: unknown } | undefined)?.command;
        if (typeof command !== "string" || !isSafeCommand(command)) {
          return {
            block: true,
            reason: `Plan mode: command blocked (not allowlisted). Use /plan to leave plan mode first.\nCommand: ${String(command)}`,
          };
        }
      }
      return undefined;
    });

    // Drop stale plan-mode instructions once plan mode is off.
    api.on("context", (event) => {
      if (phase === "planning") return undefined;
      return {
        messages: event.messages.filter(
          (message) =>
            message.role !== "user" || !messageText(message).includes(PLAN_MODE_CONTEXT_MARKER),
        ),
      };
    });

    api.on("before_agent_start", () => {
      if (phase === "planning") {
        return { messages: [contextMessage(PLAN_MODE_CONTEXT)] };
      }
      if (phase === "executing" && todos.length > 0) {
        const remaining = todos.filter((todo) => !todo.completed);
        return {
          messages: [
            contextMessage(`${PLAN_EXECUTION_CONTEXT_MARKER}

Remaining steps:
${remaining.map((todo) => `${todo.step}. ${todo.text}`).join("\n")}

Execute each step in order.
After completing a step, include a [DONE:n] tag in your response.`),
          ],
        };
      }
      return undefined;
    });

    api.on("turn_end", (event) => {
      if (phase !== "executing" || todos.length === 0) return;
      if (markCompletedSteps(assistantText(event.message), todos) > 0) changed();
    });

    api.on("agent_end", (event) => {
      const last = [...event.messages].reverse().find(isAssistant);
      if (phase === "executing" && todos.length > 0) {
        // The model may wrap up without [DONE:n] tags ("All steps complete").
        if (last !== undefined && allStepsComplete(assistantText(last))) {
          for (const todo of todos) todo.completed = true;
        }
        if (todos.every((todo) => todo.completed)) {
          phase = "off";
          changed();
        }
        return;
      }
      if (phase !== "planning" || last === undefined) return;
      const extracted = extractTodoItems(assistantText(last));
      if (extracted.length === 0) return;
      todos = extracted;
      changed();
      options.onPlan?.(state().todos);
    });
  };

  return { extension, state, enable, disable, execute };
}
