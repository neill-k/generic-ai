import type { Awaitable, JsonValue } from "../contracts/shared.js";
import { createStableFingerprint } from "./compiler.js";
import { GenericAIToolError, createToolErrorEnvelope } from "./tool-errors.js";
import {
  type AgentHarnessCapabilityEffect,
  type AgentHarnessEffectMetadata,
  getAgentHarnessToolEffects,
} from "./types.js";

/**
 * Effects that leave the agent system: a message reaches a person, an external record changes, or
 * money is spent. Running one of these twice is visible to the outside world, so a turn that is
 * retried after a crash must never repeat them silently. See ADR 0059.
 */
export const OUTWARD_TOOL_EFFECTS: readonly AgentHarnessCapabilityEffect[] = Object.freeze([
  "message.send",
  "external.write",
  "payment.spend",
]);

const OUTWARD = new Set<string>(OUTWARD_TOOL_EFFECTS);

/**
 * `not-performed` means the tool ran but declined to perform its effect, for example because the
 * owner's approval is still pending (ADR 0061). A retry runs such a call again instead of
 * replaying it.
 */
export type ToolEffectRecordStatus = "started" | "completed" | "failed" | "not-performed";

/**
 * Key a tool sets to `true` in its result's `details` when it did not perform its effect, such as
 * an approval gate that only filed a request. The journal then records the call as
 * `not-performed` rather than `completed`.
 */
export const TOOL_EFFECT_NOT_PERFORMED_KEY = "effectNotPerformed";

export function isToolEffectNotPerformed(result: unknown): boolean {
  const details = (result as { readonly details?: unknown } | null | undefined)?.details;
  return (
    typeof details === "object" &&
    details !== null &&
    (details as Record<string, unknown>)[TOOL_EFFECT_NOT_PERFORMED_KEY] === true
  );
}

/** One outward tool call, as the journal remembers it. */
export interface ToolEffectRecord {
  readonly kind: "tool-effect-record";
  /** `<tool>:<args hash>:<occurrence>`, stable across attempts of the same turn. */
  readonly callKey: string;
  readonly toolName: string;
  /** sha256 over the canonical JSON of the call's arguments. */
  readonly argsHash: string;
  /** 1 for the first call with these arguments in the turn, 2 for the second, and so on. */
  readonly occurrence: number;
  readonly effects: readonly AgentHarnessCapabilityEffect[];
  readonly status: ToolEffectRecordStatus;
  readonly toolCallId?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  /** The tool's result, as JSON, once it completed. */
  readonly result?: JsonValue;
  readonly errorMessage?: string;
}

/**
 * Durable memory of outward tool calls for one turn. The harness writes a `started` record before
 * a call runs and a `completed` or `failed` record after, so a retried attempt of the same turn can
 * tell a call that finished from one that may or may not have happened.
 */
export interface ToolEffectJournal {
  /** What the journal covers, for example `task-1:turn-3`. Shown in messages and events. */
  readonly scopeId: string;
  read(callKey: string): Awaitable<ToolEffectRecord | undefined>;
  write(record: ToolEffectRecord): Awaitable<void>;
  /** Called when a guard replays a recorded call or refuses an uncertain one. */
  observe?(event: ToolEffectGuardEvent): Awaitable<void>;
}

export type ToolEffectGuardEvent =
  | { readonly type: "recorded"; readonly record: ToolEffectRecord }
  | { readonly type: "replayed"; readonly record: ToolEffectRecord }
  | { readonly type: "uncertain"; readonly record: ToolEffectRecord };

export interface ToolEffectGuardOptions {
  /** Which tools to journal. Defaults to tools with an outward effect. */
  readonly shouldJournal?: (tool: unknown) => boolean;
  readonly onEvent?: (event: ToolEffectGuardEvent) => Awaitable<void>;
  readonly now?: () => Date;
}

export interface ToolEffectGuard {
  readonly journal: ToolEffectJournal;
  /** Wraps one tool. Tools that are not journaled come back unchanged. */
  wrap<TTool>(tool: TTool): TTool;
  wrapAll<TTool>(tools: readonly TTool[]): TTool[];
}

/** True when the tool declares at least one outward effect. */
export function hasOutwardToolEffect(tool: unknown): boolean {
  return getAgentHarnessToolEffects(tool).some((effect) => OUTWARD.has(effect));
}

export function toolEffectCallKey(toolName: string, argsHash: string, occurrence: number): string {
  return `${toolName}:${argsHash}:${occurrence}`;
}

/**
 * Wraps tools so that outward calls are recorded in a journal and never repeated blindly when the
 * same turn runs again:
 *
 * - a call whose earlier attempt completed returns the recorded result without running again;
 * - a call whose earlier attempt failed throws the recorded error again;
 * - a call whose earlier attempt declined to act (`not-performed`, such as a pending approval) runs
 *   again, so the gate in front of the effect decides afresh;
 * - a call whose earlier attempt started but never reported back is not run. The agent gets an
 *   error saying the action may already have happened and should be checked first. Calling the
 *   tool again with the same arguments after that runs it, because that is a new call.
 *
 * Calls are matched by tool name, argument hash, and how many identical calls came before it in
 * the attempt, so a model that repeats its earlier calls in a different order still matches.
 * Each guard counts occurrences for one attempt; create one guard per run.
 */
export function createToolEffectGuard(
  journal: ToolEffectJournal,
  options: ToolEffectGuardOptions = {},
): ToolEffectGuard {
  const shouldJournal = options.shouldJournal ?? hasOutwardToolEffect;
  const now = options.now ?? (() => new Date());
  const occurrences = new Map<string, number>();
  const wrapped = new WeakMap<object, unknown>();

  const nextOccurrence = (toolName: string, argsHash: string): number => {
    const key = `${toolName}:${argsHash}`;
    const next = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, next);
    return next;
  };

  const emit = async (event: ToolEffectGuardEvent) => {
    if (journal.observe !== undefined) {
      await journal.observe(event);
    }
    if (options.onEvent !== undefined) {
      await options.onEvent(event);
    }
  };

  function wrap<TTool>(tool: TTool): TTool {
    if (
      typeof tool !== "object" ||
      tool === null ||
      typeof (tool as { execute?: unknown }).execute !== "function" ||
      !shouldJournal(tool)
    ) {
      return tool;
    }
    const cached = wrapped.get(tool);
    if (cached !== undefined) {
      return cached as TTool;
    }

    const execute = (tool as unknown as { execute: (...args: unknown[]) => unknown }).execute.bind(
      tool,
    );
    const toolName = toolNameOf(tool);
    const effects = getAgentHarnessToolEffects(tool as AgentHarnessEffectMetadata);
    const guarded = Object.create(Object.getPrototypeOf(tool)) as TTool;
    Object.defineProperties(guarded, Object.getOwnPropertyDescriptors(tool));
    Object.defineProperty(guarded, "execute", {
      enumerable: true,
      configurable: true,
      writable: true,
      async value(...args: unknown[]) {
        const toolCallId = typeof args[0] === "string" ? args[0] : undefined;
        const argsHash = createStableFingerprint(args[1] ?? null);
        const occurrence = nextOccurrence(toolName, argsHash);
        const callKey = toolEffectCallKey(toolName, argsHash, occurrence);
        const previous = await journal.read(callKey);

        if (previous?.status === "completed") {
          await emit({ type: "replayed", record: previous });
          return previous.result ?? null;
        }
        if (previous?.status === "failed") {
          await emit({ type: "replayed", record: previous });
          throw new GenericAIToolError(
            createToolErrorEnvelope({
              kind: "unknown",
              safeMessage: `${previous.errorMessage ?? `${toolName} failed.`} (This is the recorded result of the same call from an earlier attempt of this turn; it was not run again.)`,
              retryable: false,
              metadata: { toolName, callKey, replayed: true },
            }),
          );
        }
        if (previous?.status === "started") {
          await emit({ type: "uncertain", record: previous });
          throw new GenericAIToolError(
            createToolErrorEnvelope({
              kind: "unknown",
              safeMessage:
                `An earlier attempt of this turn started ${toolName} with these same arguments ` +
                `at ${previous.startedAt} and stopped before it reported a result, so the action ` +
                "may already have happened. It was not run again. Check whether it took effect " +
                "before you decide to retry it; calling it again will run it.",
              retryable: false,
              userActionable: true,
              metadata: { toolName, callKey, uncertain: true },
            }),
          );
        }

        const started: ToolEffectRecord = {
          kind: "tool-effect-record",
          callKey,
          toolName,
          argsHash,
          occurrence,
          effects,
          status: "started",
          ...(toolCallId === undefined ? {} : { toolCallId }),
          startedAt: now().toISOString(),
        };
        await journal.write(started);

        let result: unknown;
        try {
          result = await execute(...args);
        } catch (error) {
          const failed: ToolEffectRecord = {
            ...started,
            status: "failed",
            completedAt: now().toISOString(),
            errorMessage: error instanceof Error ? error.message : String(error),
          };
          await journal.write(failed);
          await emit({ type: "recorded", record: failed });
          throw error;
        }
        const completed: ToolEffectRecord = {
          ...started,
          status: isToolEffectNotPerformed(result) ? "not-performed" : "completed",
          completedAt: now().toISOString(),
          result: toJsonValue(result),
        };
        await journal.write(completed);
        await emit({ type: "recorded", record: completed });
        return result;
      },
    });
    wrapped.set(tool, guarded);
    return guarded;
  }

  return Object.freeze({
    journal,
    wrap,
    wrapAll: <TTool>(tools: readonly TTool[]) => tools.map((tool) => wrap(tool)),
  });
}

/** An in-memory journal for tests and single-process hosts. */
export function createMemoryToolEffectJournal(
  scopeId = "memory",
): ToolEffectJournal & { readonly records: () => readonly ToolEffectRecord[] } {
  const records = new Map<string, ToolEffectRecord>();
  return Object.freeze({
    scopeId,
    read: (callKey: string) => records.get(callKey),
    write: (record: ToolEffectRecord) => {
      records.set(record.callKey, record);
    },
    records: () => [...records.values()],
  });
}

function toolNameOf(tool: unknown): string {
  const value = tool as { readonly name?: unknown; readonly id?: unknown };
  if (typeof value.name === "string" && value.name.length > 0) {
    return value.name;
  }
  if (typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  return "tool";
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}
