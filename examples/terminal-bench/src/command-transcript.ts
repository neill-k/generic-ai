import type { AgentHarnessEventProjection, TraceEvent } from "@generic-ai/sdk";

export type CommandTranscriptEntryPhase =
  | "started"
  | "completed"
  | "failed"
  | "observed"
  | "planned";

export interface CommandTranscriptEntry {
  readonly id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly phase: CommandTranscriptEntryPhase;
  readonly sourceType: string;
  readonly summary: string;
  readonly actorId?: string;
  readonly roleId?: string;
  readonly toolName?: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly latencyMs?: number;
  readonly timeout?: boolean;
  readonly exitCode?: number;
  readonly stdoutExcerpt?: string;
  readonly stderrExcerpt?: string;
  readonly artifactRefs: readonly string[];
}

export interface CommandTranscript {
  readonly kind: "generic-ai.terminal-bench.command-transcript";
  readonly schemaVersion: "0.1";
  readonly runId: string;
  readonly trialId?: string;
  readonly generatedAt: string;
  readonly redaction: "secret-patterns-and-excerpts";
  readonly entries: readonly CommandTranscriptEntry[];
}

const MAX_EXCERPT_CHARS = 2000;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b([A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@)\b/g,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"',\s}]+/gi,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (_match, prefix: string | undefined) => {
      if (prefix !== undefined && /^(api|token|secret|password)/i.test(prefix)) {
        return `${prefix}=<redacted>`;
      }
      return "<redacted>";
    }),
    value,
  );
}

function excerpt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const redacted = redactText(value);
  return redacted.length > MAX_EXCERPT_CHARS
    ? `${redacted.slice(0, MAX_EXCERPT_CHARS)}... [truncated]`
    : redacted;
}

function findValue(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, names);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findValue(item, names);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function textValue(data: unknown, names: readonly string[]): string | undefined {
  const found = findValue(data, new Set(names.map((name) => name.toLowerCase())));
  if (typeof found === "string") {
    return excerpt(found);
  }

  if (
    Array.isArray(found) &&
    found.every((item): item is string | number | boolean => ["string", "number", "boolean"].includes(typeof item))
  ) {
    return excerpt(found.join(" "));
  }

  if (isRecord(found) || Array.isArray(found)) {
    return excerpt(JSON.stringify(found));
  }

  return undefined;
}

function numberValue(data: unknown, names: readonly string[]): number | undefined {
  const found = findValue(data, new Set(names.map((name) => name.toLowerCase())));
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function booleanValue(data: unknown, names: readonly string[]): boolean | undefined {
  const found = findValue(data, new Set(names.map((name) => name.toLowerCase())));
  return typeof found === "boolean" ? found : undefined;
}

function collectArtifactRefs(value: unknown, keyHint = ""): readonly string[] {
  const refs = new Set<string>();

  function visit(item: unknown, key: string): void {
    if (typeof item === "string") {
      if (key.includes("artifact")) {
        refs.add(redactText(item));
      }
      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, key);
      }
      return;
    }

    if (!isRecord(item)) {
      return;
    }

    const recordId = item["id"] ?? item["uri"] ?? item["path"];
    if (key.includes("artifact") && typeof recordId === "string") {
      refs.add(redactText(recordId));
    }

    for (const [childKey, child] of Object.entries(item)) {
      visit(child, childKey.toLowerCase());
    }
  }

  visit(value, keyHint.toLowerCase());
  return Object.freeze([...refs].sort());
}

function phaseFromProjection(type: string): CommandTranscriptEntryPhase {
  if (type.endsWith(".started")) {
    return "started";
  }

  if (type.endsWith(".completed")) {
    return "completed";
  }

  if (type.endsWith(".failed")) {
    return "failed";
  }

  if (type.startsWith("handoff.")) {
    return "planned";
  }

  return "observed";
}

function phaseFromTraceEvent(type: string): CommandTranscriptEntryPhase {
  if (type === "actor.invoked" || type === "trial.started") {
    return "started";
  }

  if (
    type === "actor.completed" ||
    type === "trial.completed" ||
    type === "grader.completed" ||
    type === "benchmark.completed"
  ) {
    return "completed";
  }

  if (type === "protocol.action.planned") {
    return "planned";
  }

  return "observed";
}

function projectionToEntry(
  projection: AgentHarnessEventProjection,
  _index: number,
): CommandTranscriptEntry {
  const command = textValue(projection.data, ["command", "cmd", "shellcommand", "input"]);
  const cwd = textValue(projection.data, ["cwd", "workdir", "workingdirectory"]);
  const stdout = textValue(projection.data, ["stdout", "stdoutexcerpt", "output", "result"]);
  const stderr = textValue(projection.data, ["stderr", "stderrexcerpt", "error"]);
  const latencyMs = numberValue(projection.data, ["latencyms", "durationms"]);
  const timeout = booleanValue(projection.data, ["timeout", "timedout"]);
  const exitCode = numberValue(projection.data, ["exitcode", "code", "statuscode"]);
  const phase = phaseFromProjection(projection.type);

  return Object.freeze({
    id: projection.id,
    sequence: projection.sequence,
    timestamp: projection.occurredAt,
    phase,
    sourceType: projection.type,
    summary: redactText(projection.summary),
    ...(projection.roleId === undefined ? {} : { roleId: projection.roleId }),
    ...(projection.toolName === undefined ? {} : { toolName: projection.toolName }),
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(phase === "started" ? { startedAt: projection.occurredAt } : {}),
    ...(phase === "completed" || phase === "failed" ? { completedAt: projection.occurredAt } : {}),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stdout === undefined ? {} : { stdoutExcerpt: stdout }),
    ...(stderr === undefined ? {} : { stderrExcerpt: stderr }),
    artifactRefs: collectArtifactRefs(projection.data),
  });
}

function traceEventToEntry(event: TraceEvent, index: number): CommandTranscriptEntry {
  return Object.freeze({
    id: event.id,
    sequence: event.sequence || index + 1,
    timestamp: event.timestamp,
    phase: phaseFromTraceEvent(event.type),
    sourceType: event.type,
    summary: redactText(event.summary),
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
    ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
    artifactRefs: Object.freeze(event.artifactId === undefined ? [] : [event.artifactId]),
  });
}

export function createCommandTranscriptFromProjections(input: {
  readonly runId: string;
  readonly trialId?: string;
  readonly generatedAt: string;
  readonly projections: readonly AgentHarnessEventProjection[];
}): CommandTranscript {
  const entries = input.projections
    .filter(
      (projection) =>
        projection.type.startsWith("terminal.command.") ||
        projection.type.startsWith("tool.call.") ||
        projection.type.startsWith("handoff."),
    )
    .map(projectionToEntry)
    .sort((left, right) => left.sequence - right.sequence);

  return Object.freeze({
    kind: "generic-ai.terminal-bench.command-transcript",
    schemaVersion: "0.1",
    runId: input.runId,
    ...(input.trialId === undefined ? {} : { trialId: input.trialId }),
    generatedAt: input.generatedAt,
    redaction: "secret-patterns-and-excerpts",
    entries: Object.freeze(entries),
  });
}

export function createCommandTranscriptFromTraceEvents(input: {
  readonly runId: string;
  readonly trialId?: string;
  readonly generatedAt: string;
  readonly events: readonly TraceEvent[];
}): CommandTranscript {
  const entries = input.events
    .filter(
      (event) =>
        event.type === "tool.invoked" ||
        event.type === "protocol.action.planned" ||
        event.type === "policy.decision" ||
        event.type === "artifact.created" ||
        event.type === "grader.completed" ||
        event.type === "actor.invoked" ||
        event.type === "actor.completed" ||
        event.type === "trial.started" ||
        event.type === "trial.completed",
    )
    .map(traceEventToEntry)
    .sort((left, right) => left.sequence - right.sequence);

  return Object.freeze({
    kind: "generic-ai.terminal-bench.command-transcript",
    schemaVersion: "0.1",
    runId: input.runId,
    ...(input.trialId === undefined ? {} : { trialId: input.trialId }),
    generatedAt: input.generatedAt,
    redaction: "secret-patterns-and-excerpts",
    entries: Object.freeze(entries),
  });
}

function renderEntry(entry: CommandTranscriptEntry, index: number): string {
  const lines = [
    `${index + 1}. [${entry.timestamp}] ${entry.sourceType} (${entry.phase})`,
    `   actor: ${entry.roleId ?? entry.actorId ?? "generic-ai"}`,
    `   summary: ${entry.summary}`,
  ];

  if (entry.toolName !== undefined) {
    lines.push(`   tool: ${entry.toolName}`);
  }

  if (entry.command !== undefined) {
    lines.push(`   command: ${entry.command}`);
  }

  if (entry.cwd !== undefined) {
    lines.push(`   cwd: ${entry.cwd}`);
  }

  if (entry.exitCode !== undefined) {
    lines.push(`   exit_code: ${entry.exitCode}`);
  }

  if (entry.timeout !== undefined) {
    lines.push(`   timeout: ${entry.timeout}`);
  }

  if (entry.stdoutExcerpt !== undefined) {
    lines.push(`   stdout: ${entry.stdoutExcerpt}`);
  }

  if (entry.stderrExcerpt !== undefined) {
    lines.push(`   stderr: ${entry.stderrExcerpt}`);
  }

  if (entry.artifactRefs.length > 0) {
    lines.push(`   artifacts: ${entry.artifactRefs.join(", ")}`);
  }

  return lines.join("\n");
}

export function renderCommandTranscriptMarkdown(transcript: CommandTranscript): string {
  const header = [
    "# Command Transcript",
    "",
    `Run: ${transcript.runId}`,
    ...(transcript.trialId === undefined ? [] : [`Trial: ${transcript.trialId}`]),
    `Generated: ${transcript.generatedAt}`,
    `Entries: ${transcript.entries.length}`,
    "",
  ];

  if (transcript.entries.length === 0) {
    return `${header.join("\n")}No command, tool, handoff, or verifier events were available.\n`;
  }

  return `${header.join("\n")}${transcript.entries.map(renderEntry).join("\n\n")}\n`;
}

export function renderCommandTranscriptsMarkdown(
  transcripts: readonly CommandTranscript[],
): string {
  return transcripts.map(renderCommandTranscriptMarkdown).join("\n");
}
