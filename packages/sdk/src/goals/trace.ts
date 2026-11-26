import type { JsonObject, JsonValue } from "../contracts/shared.js";
import type { CanonicalEvent } from "../events/taxonomy.js";
import type { AgentHarnessEventProjection } from "../harness/types.js";
import { jsonDeepEqual } from "./json-schema-check.js";
import type { GoalTraceActionMatcher, GoalTraceEntry } from "./types.js";

const TERMINAL_TOOLS = new Set(["bash", "terminal", "shell"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argsFrom(data: Readonly<Record<string, unknown>>): JsonObject | undefined {
  for (const key of ["args", "input", "arguments", "params"]) {
    const candidate = data[key];
    if (isPlainObject(candidate)) {
      return candidate as JsonObject;
    }
    if (typeof candidate === "string") {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isPlainObject(parsed)) {
          return parsed as JsonObject;
        }
      } catch {
        // not JSON; ignore
      }
    }
  }
  return undefined;
}

function stringField(
  data: Readonly<Record<string, unknown>>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function entry(fields: {
  sequence?: number | undefined;
  type: string;
  toolName?: string | undefined;
  roleId?: string | undefined;
  args?: JsonObject | undefined;
  isError?: boolean | undefined;
  eventId?: string | undefined;
}): GoalTraceEntry {
  return Object.freeze({
    type: fields.type,
    ...(fields.sequence === undefined ? {} : { sequence: fields.sequence }),
    ...(fields.toolName === undefined ? {} : { toolName: fields.toolName }),
    ...(fields.roleId === undefined ? {} : { roleId: fields.roleId }),
    ...(fields.args === undefined ? {} : { args: fields.args }),
    ...(fields.isError === undefined ? {} : { isError: fields.isError }),
    ...(fields.eventId === undefined ? {} : { eventId: fields.eventId }),
  });
}

/** Normalizes the typed projections an `AgentHarnessRunResult` carries. */
export function goalTraceFromProjections(
  projections: readonly AgentHarnessEventProjection[],
): GoalTraceEntry[] {
  return projections.map((projection) =>
    entry({
      sequence: projection.sequence,
      type: projection.type,
      toolName: projection.toolName ?? stringField(projection.data, "toolName"),
      roleId: projection.roleId ?? stringField(projection.data, "roleId", "actorId"),
      args: argsFrom(projection.data),
      isError: projection.type.endsWith(".failed") || projection.data["isError"] === true,
      eventId: projection.id,
    }),
  );
}

/**
 * Normalizes canonical events. Raw runtime events that carry
 * `data.type = tool_execution_start | tool_execution_end` become
 * `tool.call.*` or `terminal.command.*` entries, matching the harness
 * projection rules.
 */
export function goalTraceFromCanonicalEvents(events: readonly CanonicalEvent[]): GoalTraceEntry[] {
  return events.map((event) => {
    const toolName = stringField(event.data, "toolName");
    const runtimeType = event.data["type"];
    const failed = event.data["isError"] === true;
    let type: string = event.name;
    if (runtimeType === "tool_execution_start") {
      type =
        toolName !== undefined && TERMINAL_TOOLS.has(toolName)
          ? "terminal.command.started"
          : "tool.call.started";
    } else if (runtimeType === "tool_execution_end") {
      const family =
        toolName !== undefined && TERMINAL_TOOLS.has(toolName) ? "terminal.command" : "tool.call";
      type = `${family}.${failed ? "failed" : "completed"}`;
    }
    return entry({
      sequence: event.sequence,
      type,
      toolName,
      roleId: stringField(event.data, "roleId", "actorId"),
      args: argsFrom(event.data),
      isError: failed || type.endsWith(".failed"),
      eventId: event.eventId,
    });
  });
}

function statusOf(type: string): "started" | "completed" | "failed" | undefined {
  if (type.endsWith(".started")) {
    return "started";
  }
  if (type.endsWith(".completed")) {
    return "completed";
  }
  if (type.endsWith(".failed")) {
    return "failed";
  }
  return undefined;
}

function argsInclude(actual: JsonObject | undefined, expected: JsonObject): boolean {
  if (actual === undefined) {
    return false;
  }
  return Object.entries(expected).every(([key, expectedValue]) => {
    const actualValue: JsonValue | undefined = actual[key];
    if (isPlainObject(expectedValue) && isPlainObject(actualValue)) {
      return argsInclude(actualValue as JsonObject, expectedValue as JsonObject);
    }
    return jsonDeepEqual(actualValue, expectedValue);
  });
}

export function matchesTraceEntry(
  matcher: GoalTraceActionMatcher,
  traceEntry: GoalTraceEntry,
): boolean {
  if (matcher.event !== undefined && traceEntry.type !== matcher.event) {
    return false;
  }
  if (matcher.tool !== undefined) {
    if (traceEntry.toolName !== matcher.tool) {
      return false;
    }
    const wanted = matcher.status ?? (matcher.event === undefined ? "completed" : "any");
    if (wanted !== "any" && statusOf(traceEntry.type) !== wanted) {
      return false;
    }
  } else if (matcher.status !== undefined && matcher.status !== "any") {
    if (statusOf(traceEntry.type) !== matcher.status) {
      return false;
    }
  }
  if (matcher.role !== undefined && traceEntry.roleId !== matcher.role) {
    return false;
  }
  if (matcher.argsInclude !== undefined && !argsInclude(traceEntry.args, matcher.argsInclude)) {
    return false;
  }
  return true;
}

export function describeTraceMatcher(matcher: GoalTraceActionMatcher): string {
  if (matcher.description !== undefined && matcher.description.length > 0) {
    return matcher.description;
  }
  const parts: string[] = [];
  if (matcher.tool !== undefined) {
    parts.push(
      `tool ${matcher.tool}${matcher.status === undefined || matcher.status === "completed" ? "" : ` (${matcher.status})`}`,
    );
  }
  if (matcher.event !== undefined) {
    parts.push(`event ${matcher.event}`);
  }
  if (matcher.role !== undefined) {
    parts.push(`by role ${matcher.role}`);
  }
  if (matcher.argsInclude !== undefined) {
    parts.push(`with args ${JSON.stringify(matcher.argsInclude)}`);
  }
  return parts.join(" ");
}

const WRITE_TOOL_PATTERN =
  /(write|edit|patch|replace|delete|remove|move|rename|create|append|mkdir|rm)/i;
const PATH_ARG_KEYS = [
  "path",
  "file_path",
  "filePath",
  "file",
  "target",
  "destination",
  "dest",
  "from",
  "to",
  "paths",
];
const SHELL_WRITE_PATTERN =
  /(>|\btee\b|\brm\b|\bmv\b|\bcp\b|\bsed\s+-i|\bperl\s+-p?i|\btruncate\b|\bchmod\b|\bchown\b|\bln\b|\bgit\s+(checkout|restore|rm|mv)\b|\bpatch\b|\bdd\b|\binstall\b)/;

export function normalizeWorkspacePath(path: string): string {
  let normalized = path.replaceAll("\\", "/").trim();
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/{2,}/g, "/");
}

export function isProtectedPath(path: string, protectedPaths: readonly string[]): boolean {
  const candidate = normalizeWorkspacePath(path);
  return protectedPaths.some((rawProtected) => {
    const protectedPath = normalizeWorkspacePath(rawProtected);
    if (protectedPath.endsWith("/")) {
      const directory = protectedPath.slice(0, -1);
      return (
        candidate === directory ||
        candidate.startsWith(protectedPath) ||
        candidate.endsWith(`/${directory}`) ||
        candidate.includes(`/${protectedPath}`)
      );
    }
    return candidate === protectedPath || candidate.endsWith(`/${protectedPath}`);
  });
}

function pathArgs(args: JsonObject | undefined): string[] {
  if (args === undefined) {
    return [];
  }
  const found: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      found.push(value);
    } else if (Array.isArray(value)) {
      found.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  return found;
}

export interface ProtectedPathViolation {
  readonly path: string;
  readonly toolName: string;
  readonly sequence?: number;
  readonly eventId?: string;
}

/**
 * Finds trace evidence of writes to protected paths: write-like file tools
 * whose path arguments hit a protected path, and shell commands that mention
 * a protected path next to a write operator. This is a tripwire, not a
 * sandbox; hosts should also mount validator files read-only or outside the
 * agent's workspace.
 */
export function findProtectedPathViolations(
  trace: readonly GoalTraceEntry[],
  protectedPaths: readonly string[],
): ProtectedPathViolation[] {
  if (protectedPaths.length === 0) {
    return [];
  }
  const violations: ProtectedPathViolation[] = [];
  const record = (traceEntry: GoalTraceEntry, path: string) => {
    violations.push(
      Object.freeze({
        path,
        toolName: traceEntry.toolName ?? "unknown",
        ...(traceEntry.sequence === undefined ? {} : { sequence: traceEntry.sequence }),
        ...(traceEntry.eventId === undefined ? {} : { eventId: traceEntry.eventId }),
      }),
    );
  };

  for (const traceEntry of trace) {
    // Attempts count as much as successes, so every lifecycle entry is checked.
    const toolName = traceEntry.toolName;
    if (toolName === undefined) {
      continue;
    }
    if (TERMINAL_TOOLS.has(toolName)) {
      const command = traceEntry.args?.["command"] ?? traceEntry.args?.["cmd"];
      if (typeof command !== "string" || !SHELL_WRITE_PATTERN.test(command)) {
        continue;
      }
      const tokens = command.split(/[\s;|&<>()'"`=]+/).filter((token) => token.length > 0);
      const hit = tokens.find((token) => isProtectedPath(token, protectedPaths));
      if (hit !== undefined) {
        record(traceEntry, hit);
      }
      continue;
    }
    if (!WRITE_TOOL_PATTERN.test(toolName)) {
      continue;
    }
    for (const path of pathArgs(traceEntry.args)) {
      if (isProtectedPath(path, protectedPaths)) {
        record(traceEntry, path);
      }
    }
  }

  // The same attempt usually shows up as started and completed; report once.
  const unique = new Map<string, ProtectedPathViolation>();
  for (const violation of violations) {
    const key = `${violation.toolName}\u0000${normalizeWorkspacePath(violation.path)}`;
    if (!unique.has(key)) {
      unique.set(key, violation);
    }
  }
  return [...unique.values()];
}

/**
 * Finds any trace evidence of touching the given paths, read or write: file
 * tools whose path arguments hit a path, and shell commands that mention one.
 * Evals use it for answer keys and held-out fixtures the agent must never see.
 */
export function findPathAccesses(
  trace: readonly GoalTraceEntry[],
  paths: readonly string[],
): ProtectedPathViolation[] {
  if (paths.length === 0) {
    return [];
  }
  const unique = new Map<string, ProtectedPathViolation>();
  const record = (traceEntry: GoalTraceEntry, path: string) => {
    const toolName = traceEntry.toolName ?? "unknown";
    const key = `${toolName}\u0000${normalizeWorkspacePath(path)}`;
    if (unique.has(key)) {
      return;
    }
    unique.set(
      key,
      Object.freeze({
        path,
        toolName,
        ...(traceEntry.sequence === undefined ? {} : { sequence: traceEntry.sequence }),
        ...(traceEntry.eventId === undefined ? {} : { eventId: traceEntry.eventId }),
      }),
    );
  };
  for (const traceEntry of trace) {
    const toolName = traceEntry.toolName;
    if (toolName === undefined) {
      continue;
    }
    if (TERMINAL_TOOLS.has(toolName)) {
      const command = traceEntry.args?.["command"] ?? traceEntry.args?.["cmd"];
      if (typeof command !== "string") {
        continue;
      }
      const tokens = command.split(/[\s;|&<>()'"`=]+/).filter((token) => token.length > 0);
      const hit = tokens.find((token) => isProtectedPath(token, paths));
      if (hit !== undefined) {
        record(traceEntry, hit);
      }
      continue;
    }
    for (const path of pathArgs(traceEntry.args)) {
      if (isProtectedPath(path, paths)) {
        record(traceEntry, path);
      }
    }
  }
  return [...unique.values()];
}
