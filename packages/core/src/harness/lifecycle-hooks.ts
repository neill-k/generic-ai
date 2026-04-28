import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  AgentLifecycleHookContext,
  AgentLifecycleHookDecision,
  AgentLifecycleHookDecisionRecord,
  AgentLifecycleHookDeclaration,
  AgentLifecycleHookFailureMode,
  AgentLifecycleHookOutput,
  AgentLifecycleHookRunResult,
  AgentLifecycleHooksConfig,
  AgentLifecycleInProcessHookHandler,
  JsonObject,
  JsonValue,
  ToolDefinition,
} from "@generic-ai/sdk";

import type { CanonicalEventStream } from "../events/index.js";

export interface AgentLifecycleHookExecutorOptions {
  readonly eventStream?: CanonicalEventStream;
  readonly inProcessHandlers?: readonly AgentLifecycleInProcessHookHandler[];
  readonly now?: () => Date;
}

export interface AgentLifecycleHookExecutor {
  readonly enabled: boolean;
  run(context: AgentLifecycleHookContext): Promise<AgentLifecycleHookRunResult>;
  snapshot(): readonly AgentLifecycleHookDecisionRecord[];
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

type HookOutputWithExit = AgentLifecycleHookOutput & { readonly exitCode?: number };

const DEFAULT_TIMEOUT_MS = 5000;
const pendingSessionId = "pending-session";
const pendingRootSessionId = "pending-root-session";

export function createAgentLifecycleHookExecutor(
  config: AgentLifecycleHooksConfig | undefined,
  options: AgentLifecycleHookExecutorOptions = {},
): AgentLifecycleHookExecutor {
  const hooks = Object.freeze((config?.hooks ?? []).filter((hook) => hook.enabled !== false));
  const decisions: AgentLifecycleHookDecisionRecord[] = [];
  const inProcessHandlers = new Map(
    (options.inProcessHandlers ?? []).map((handler) => [handler.id, handler]),
  );
  const now = options.now ?? (() => new Date());

  async function run(context: AgentLifecycleHookContext): Promise<AgentLifecycleHookRunResult> {
    const matchingHooks = hooks.filter((hook) => matchesHook(hook, context));
    if (matchingHooks.length === 0) {
      return Object.freeze({
        blocked: false,
        decisions: Object.freeze([]),
      });
    }

    const commandRuns = new Map<
      string,
      Promise<AgentLifecycleHookOutput & { exitCode?: number }>
    >();
    const runOne = async (
      hook: AgentLifecycleHookDeclaration,
    ): Promise<AgentLifecycleHookDecisionRecord> => {
      const startedAt = now();
      await emitHookEvent("hook.execution.started", context, {
        hookId: hook.id,
        lifecycleEvent: context.event,
        handlerType: hook.handler.type,
      });

      try {
        const output: HookOutputWithExit =
          hook.handler.type === "command"
            ? await runCommandHook({
                hook,
                context,
                commandRuns,
                timeoutMs: timeoutForHook(config, hook),
              })
            : hook.handler.type === "in-process"
              ? await runInProcessHook(hook, context, inProcessHandlers)
              : unsupportedHandlerOutput(hook);
        const completedAt = now();
        const normalized = normalizeHookOutput(output);
        const record = createDecisionRecord({
          hook,
          event: context.event,
          output: normalized,
          startedAt,
          completedAt,
          ...(output.exitCode === undefined ? {} : { exitCode: output.exitCode }),
        });
        decisions.push(record);
        await emitHookEvent("hook.decision", context, decisionEventData(record));
        await emitHookEvent("hook.execution.completed", context, decisionEventData(record));
        return record;
      } catch (error) {
        const completedAt = now();
        const failureMode = failureModeForHook(config, hook, context);
        const decision: AgentLifecycleHookDecision =
          failureMode === "fail-closed" ? "block" : "observe";
        const record = createDecisionRecord({
          hook,
          event: context.event,
          output: {
            decision,
            reason:
              failureMode === "fail-closed"
                ? `Hook failed closed: ${toErrorMessage(error)}`
                : `Hook failed open: ${toErrorMessage(error)}`,
            error: toErrorMessage(error),
          },
          startedAt,
          completedAt,
        });
        decisions.push(record);
        await emitHookEvent("hook.execution.failed", context, decisionEventData(record));
        return record;
      }
    };

    const records = await Promise.all(matchingHooks.map((hook) => runOne(hook)));
    const blocked = records.some((record) => record.decision === "block");
    const prompt = lastDefined(records.map((record) => record.prompt));
    const input = lastDefined(records.map((record) => record.input));
    const additionalContextValues = records
      .map((record) => record.additionalContext)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    return Object.freeze({
      blocked,
      ...(prompt === undefined ? {} : { prompt }),
      ...(input === undefined ? {} : { input }),
      ...(additionalContextValues.length === 0
        ? {}
        : { additionalContext: additionalContextValues.join("\n") }),
      decisions: Object.freeze(records),
    });
  }

  async function emitHookEvent(
    name:
      | "hook.execution.started"
      | "hook.execution.completed"
      | "hook.execution.failed"
      | "hook.decision",
    context: AgentLifecycleHookContext,
    data: JsonObject,
  ): Promise<void> {
    await options.eventStream?.emit({
      runId: context.runId,
      scopeId: context.scopeId,
      rootSessionId: context.rootSessionId ?? pendingRootSessionId,
      sessionId: context.sessionId ?? pendingSessionId,
      ...(context.parentSessionId === undefined
        ? {}
        : { parentSessionId: context.parentSessionId }),
      name,
      origin: {
        namespace: "core",
        subsystem: "agent-lifecycle-hooks",
      },
      data,
    });
  }

  return Object.freeze({
    enabled: hooks.length > 0,
    run,
    snapshot: () => Object.freeze([...decisions]),
  });
}

export function appendHookContext(prompt: string, additionalContext: string | undefined): string {
  if (additionalContext === undefined || additionalContext.trim().length === 0) {
    return prompt;
  }

  return `${prompt}\n\nAdditional hook context:\n${additionalContext}`;
}

export function wrapToolWithLifecycleHooks<
  TTool extends ToolDefinition | { readonly name?: string },
>(
  tool: TTool,
  input: {
    readonly executor: AgentLifecycleHookExecutor;
    readonly baseContext: Omit<AgentLifecycleHookContext, "event">;
  },
): TTool {
  if (!input.executor.enabled || typeof (tool as { execute?: unknown }).execute !== "function") {
    return tool;
  }

  const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute.bind(tool);
  const wrapped = Object.create(Object.getPrototypeOf(tool)) as TTool & {
    execute: (...args: unknown[]) => unknown;
  };
  Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(tool));
  Object.defineProperty(wrapped, "execute", {
    enumerable: true,
    configurable: true,
    writable: true,
    async value(...args: unknown[]) {
      const toolCallId = typeof args[0] === "string" ? args[0] : undefined;
      const originalInput = toJsonValue(args[1]);
      const context = {
        ...input.baseContext,
        toolName: getToolName(tool),
        ...(toolCallId === undefined ? {} : { toolCallId }),
        input: originalInput,
      };
      const pre = await input.executor.run({
        ...context,
        event: "PreToolUse",
      });
      if (pre.blocked) {
        throw new Error(firstDecisionReason(pre.decisions) ?? `Hook blocked ${context.toolName}.`);
      }

      const nextArgs = [...args];
      if (pre.input !== undefined) {
        nextArgs[1] = pre.input;
      }

      try {
        const result = await execute(...nextArgs);
        const post = await input.executor.run({
          ...context,
          event: "PostToolUse",
          input: toJsonValue(nextArgs[1]),
          result: toJsonValue(result),
        });
        if (post.blocked) {
          throw new Error(
            firstDecisionReason(post.decisions) ?? `Hook blocked ${context.toolName}.`,
          );
        }
        return result;
      } catch (error) {
        await input.executor.run({
          ...context,
          event: "PostToolUse",
          input: toJsonValue(nextArgs[1]),
          result: {
            error: toErrorMessage(error),
          },
        });
        throw error;
      }
    },
  });
  return wrapped as TTool;
}

function matchesHook(
  hook: AgentLifecycleHookDeclaration,
  context: AgentLifecycleHookContext,
): boolean {
  if (!hook.events.includes(context.event)) {
    return false;
  }

  const matcher = hook.matcher;
  if (matcher === undefined) {
    return true;
  }

  return (
    matchesOptional(matcher.actorId, context.actorId) &&
    matchesOptional(matcher.roleId, context.roleId) &&
    matchesOptional(matcher.toolName, context.toolName) &&
    matchesOptional(matcher.action, context.action) &&
    matchesOptional(matcher.resourceKind, context.resource?.kind) &&
    matchesOptional(matcher.resourceId, context.resource?.id)
  );
}

function matchesOptional(expected: string | undefined, actual: string | undefined): boolean {
  return expected === undefined || expected === actual;
}

async function runCommandHook(input: {
  readonly hook: AgentLifecycleHookDeclaration;
  readonly context: AgentLifecycleHookContext;
  readonly commandRuns: Map<string, Promise<AgentLifecycleHookOutput & { exitCode?: number }>>;
  readonly timeoutMs: number;
}): Promise<AgentLifecycleHookOutput & { exitCode?: number }> {
  if (input.hook.handler.type !== "command") {
    return {};
  }

  const handler = input.hook.handler;
  const key = JSON.stringify({
    command: handler.command,
    args: handler.args ?? [],
    cwd: handler.cwd,
    env: handler.env ?? {},
    shell: handler.shell ?? false,
  });
  const existing = input.commandRuns.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const run = runCommand(handler.command, handler.args ?? [], {
    ...(handler.cwd === undefined ? {} : { cwd: handler.cwd }),
    ...(handler.env === undefined ? {} : { env: handler.env }),
    ...(handler.shell === undefined ? {} : { shell: handler.shell }),
    timeoutMs: input.timeoutMs,
    stdin: `${JSON.stringify(input.context)}\n`,
  }).then((result) => normalizeCommandResult(result));
  input.commandRuns.set(key, run);
  return run;
}

async function runInProcessHook(
  hook: AgentLifecycleHookDeclaration,
  context: AgentLifecycleHookContext,
  handlers: ReadonlyMap<string, AgentLifecycleInProcessHookHandler>,
): Promise<AgentLifecycleHookOutput> {
  if (hook.handler.type !== "in-process") {
    return {};
  }

  const handler = handlers.get(hook.handler.ref);
  if (handler === undefined) {
    throw new Error(`No in-process hook handler is registered for "${hook.handler.ref}".`);
  }

  return (await handler.handle(context)) ?? {};
}

function unsupportedHandlerOutput(hook: AgentLifecycleHookDeclaration): AgentLifecycleHookOutput {
  return {
    decision: "observe",
    reason: `Handler type "${hook.handler.type}" is modeled in the SDK but not implemented by the core command executor yet.`,
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly shell?: boolean;
    readonly timeoutMs: number;
    readonly stdin: string;
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
      });
    });
    child.stdin.end(options.stdin);
  });
}

function normalizeCommandResult(
  result: CommandResult,
): AgentLifecycleHookOutput & { exitCode?: number } {
  if (result.timedOut) {
    throw new Error("Hook command timed out.");
  }

  const trimmedStdout = result.stdout.trim();
  const parsed = trimmedStdout.length === 0 ? {} : parseCommandJson(trimmedStdout);
  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) {
    return {
      decision: parsed.decision ?? "allow",
      ...parsed,
      exitCode,
    };
  }

  if (exitCode === 2) {
    return {
      decision: parsed.decision ?? "block",
      reason: parsed.reason ?? "Hook command exited with code 2.",
      ...parsed,
      exitCode,
    };
  }

  throw new Error(
    `Hook command failed with exit code ${exitCode}: ${result.stderr.trim() || trimmedStdout}`,
  );
}

function parseCommandJson(stdout: string): AgentLifecycleHookOutput {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Hook command stdout must be a JSON object when present.");
  }

  return parsed as AgentLifecycleHookOutput;
}

function normalizeHookOutput(
  output: AgentLifecycleHookOutput & { readonly error?: string },
): AgentLifecycleHookOutput & { readonly error?: string } {
  return {
    ...output,
    decision: output.decision ?? "allow",
  };
}

function createDecisionRecord(input: {
  readonly hook: AgentLifecycleHookDeclaration;
  readonly event: AgentLifecycleHookContext["event"];
  readonly output: AgentLifecycleHookOutput & { readonly error?: string };
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly exitCode?: number;
}): AgentLifecycleHookDecisionRecord {
  const decision = input.output.decision ?? "allow";
  const status = statusForDecision(decision, input.output.error);
  return Object.freeze({
    id: `${input.hook.id}:${input.completedAt.getTime()}:${randomUUID()}`,
    hookId: input.hook.id,
    event: input.event,
    handlerType: input.hook.handler.type,
    status,
    decision,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: input.completedAt.getTime() - input.startedAt.getTime(),
    ...(input.output.reason === undefined ? {} : { reason: input.output.reason }),
    ...(input.output.prompt === undefined ? {} : { prompt: input.output.prompt }),
    ...(input.output.input === undefined ? {} : { input: input.output.input }),
    ...(input.output.additionalContext === undefined
      ? {}
      : { additionalContext: input.output.additionalContext }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.output.error === undefined ? {} : { error: input.output.error }),
    ...(input.output.metadata === undefined ? {} : { metadata: input.output.metadata }),
  });
}

function statusForDecision(
  decision: AgentLifecycleHookDecision,
  error: string | undefined,
): AgentLifecycleHookDecisionRecord["status"] {
  if (error !== undefined) {
    return "failed";
  }
  switch (decision) {
    case "block":
      return "blocked";
    case "rewrite":
      return "rewritten";
    case "append_context":
      return "appended_context";
    case "observe":
      return "observed";
    case "allow":
      return "allowed";
  }
}

function timeoutForHook(
  config: AgentLifecycleHooksConfig | undefined,
  hook: AgentLifecycleHookDeclaration,
): number {
  return (
    hook.timeoutMs ?? hook.handler.timeoutMs ?? config?.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
}

function failureModeForHook(
  config: AgentLifecycleHooksConfig | undefined,
  hook: AgentLifecycleHookDeclaration,
  context: AgentLifecycleHookContext,
): AgentLifecycleHookFailureMode {
  return (
    hook.failureMode ??
    hook.handler.failureMode ??
    config?.defaults?.failureMode ??
    (context.event === "PreToolUse" || context.event === "PermissionRequest"
      ? "fail-closed"
      : "fail-open")
  );
}

function decisionEventData(record: AgentLifecycleHookDecisionRecord): JsonObject {
  return {
    hookDecisionId: record.id,
    hookId: record.hookId,
    lifecycleEvent: record.event,
    handlerType: record.handlerType,
    status: record.status,
    decision: record.decision,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function firstDecisionReason(
  decisions: readonly AgentLifecycleHookDecisionRecord[],
): string | undefined {
  return decisions.find((decision) => decision.reason !== undefined)?.reason;
}

function lastDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function getToolName(tool: { readonly name?: string }): string {
  const name = tool.name?.trim();
  return name && name.length > 0 ? name : "unknown-tool";
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isRecord(value)) {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      output[key] = toJsonValue(entry);
    }
    return output;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
