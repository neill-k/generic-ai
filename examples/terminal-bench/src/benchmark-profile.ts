import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  createGenericAILlmRuntime,
  DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
  DEFAULT_OPENAI_CODEX_MODEL,
  type CreateGenericAILlmRuntimeOptions,
  type GenericAILlmRunResult,
  type GenericAILlmRuntime,
  type GenericAILlmRuntimeAdapter,
} from "@generic-ai/core";
import type {
  PolicyDecisionRecord,
  ResourceSelector,
  TraceDiagnostics,
  TraceEvent,
  TraceEventType,
} from "@generic-ai/sdk";
import { createStableFingerprint } from "@generic-ai/sdk";

export const DEFAULT_BENCHMARK_ARTIFACT_DIR = "/logs/artifacts/generic-ai";
export const DEFAULT_IMMUTABLE_PATHS = ["/tests", "/solution", "task.toml"] as const;

export type BenchmarkProfileStatus = "passed" | "failed" | "integrity_failed";

export interface PathSnapshot {
  readonly path: string;
  readonly kind: "missing" | "file" | "directory";
  readonly fingerprint?: string;
  readonly fileCount?: number;
}

export interface IntegrityReport {
  readonly status: "passed" | "failed";
  readonly immutablePaths: readonly string[];
  readonly before: readonly PathSnapshot[];
  readonly after: readonly PathSnapshot[];
  readonly violations: readonly string[];
}

export interface BenchmarkProfileSummary {
  readonly kind: "generic-ai.terminal-bench-summary";
  readonly runId: string;
  readonly status: BenchmarkProfileStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly adapter: GenericAILlmRuntimeAdapter;
  readonly model: string;
  readonly workspaceRoot: string;
  readonly artifactDir: string;
  readonly outputText: string;
  readonly requestId?: string;
  readonly error?: string;
}

export interface BenchmarkProfileResult {
  readonly summary: BenchmarkProfileSummary;
  readonly traceEvents: readonly TraceEvent[];
  readonly integrity: IntegrityReport;
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly trajectory: unknown;
}

export interface BenchmarkProfileOptions {
  readonly instruction: string;
  readonly workspaceRoot?: string;
  readonly outputDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createRunId?: () => string;
  readonly createRuntime?: (
    options: CreateGenericAILlmRuntimeOptions,
  ) => Promise<GenericAILlmRuntime> | GenericAILlmRuntime;
}

interface FileFingerprint {
  readonly path: string;
  readonly sha256: string;
}

function readTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAdapter(value: string | undefined): GenericAILlmRuntimeAdapter {
  if (value === undefined) {
    return DEFAULT_GENERIC_AI_RUNTIME_ADAPTER;
  }

  if (value === "openai-codex" || value === "pi") {
    return value;
  }

  throw new Error("GENERIC_AI_RUNTIME_ADAPTER must be openai-codex or pi.");
}

function splitCsv(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return DEFAULT_IMMUTABLE_PATHS;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveImmutablePath(workspaceRoot: string, path: string): string {
  return path.startsWith("/") ? path : resolve(workspaceRoot, path);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function collectFileFingerprints(root: string): Promise<readonly FileFingerprint[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: FileFingerprint[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFileFingerprints(path)));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        path,
        sha256: await hashFile(path),
      });
    }
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function snapshotPath(path: string): Promise<PathSnapshot> {
  if (!existsSync(path)) {
    return Object.freeze({
      path,
      kind: "missing",
    });
  }

  const item = await stat(path);
  if (item.isFile()) {
    return Object.freeze({
      path,
      kind: "file",
      fingerprint: await hashFile(path),
      fileCount: 1,
    });
  }

  if (item.isDirectory()) {
    const files = await collectFileFingerprints(path);
    return Object.freeze({
      path,
      kind: "directory",
      fingerprint: createStableFingerprint(
        files.map((file) => ({
          path: relative(path, file.path).split(sep).join("/"),
          sha256: file.sha256,
        })),
      ),
      fileCount: files.length,
    });
  }

  return Object.freeze({
    path,
    kind: "missing",
  });
}

async function snapshotPaths(paths: readonly string[]): Promise<readonly PathSnapshot[]> {
  return Promise.all(paths.map((path) => snapshotPath(path)));
}

function compareSnapshots(
  before: readonly PathSnapshot[],
  after: readonly PathSnapshot[],
): readonly string[] {
  const violations: string[] = [];
  for (const previous of before) {
    const current = after.find((item) => item.path === previous.path);
    if (current === undefined) {
      violations.push(`${previous.path}: missing after-run snapshot`);
      continue;
    }

    if (previous.kind !== current.kind || previous.fingerprint !== current.fingerprint) {
      violations.push(`${previous.path}: immutable path changed`);
    }
  }

  return violations;
}

function createPolicyDecisions(runId: string): readonly PolicyDecisionRecord[] {
  const sandboxResource: ResourceSelector = Object.freeze({
    kind: "sandbox",
    id: "harbor-task-container",
  });

  return Object.freeze([
    Object.freeze({
      id: `${runId}:policy:nested-sandbox`,
      runId,
      actorId: "generic-ai",
      action: "use_nested_docker_sandbox",
      resource: sandboxResource,
      effect: "deny",
      decision: "denied",
      reason:
        "Harbor owns the task container boundary for Terminal-Bench runs; nested Generic AI Docker sandboxing is disabled by default.",
      evidenceRefs: Object.freeze(["integrity.json"]),
    }),
  ]);
}

function createTraceEventFactory(input: {
  readonly runId: string;
  readonly startedAt: string;
}): (event: {
  readonly type: TraceEventType;
  readonly timestamp?: string;
  readonly latencyMs?: number;
  readonly summary: string;
  readonly policyDecisionId?: string;
}) => TraceEvent {
  let sequence = 0;
  return (event) => {
    sequence += 1;
    return Object.freeze({
      id: `${input.runId}:event:${sequence}`,
      type: event.type,
      sequence,
      timestamp: event.timestamp ?? input.startedAt,
      runId: input.runId,
      candidateId: "generic-ai",
      trialId: input.runId,
      actorId: "generic-ai",
      ...(event.policyDecisionId === undefined
        ? {}
        : { policyDecisionId: event.policyDecisionId }),
      ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
      summary: event.summary,
    });
  };
}

function createAtifTrajectory(input: {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly model: string;
  readonly instruction: string;
  readonly outputText: string;
}): unknown {
  return {
    schema_version: "ATIF-v1.4",
    session_id: input.runId,
    agent: {
      name: "generic-ai",
      version: "0.0.0",
      model_name: input.model,
      extra: {
        adapter: DEFAULT_GENERIC_AI_RUNTIME_ADAPTER,
        profile: "terminal-bench",
      },
    },
    steps: [
      {
        step_id: 1,
        timestamp: input.startedAt,
        source: "user",
        message: input.instruction,
      },
      {
        step_id: 2,
        timestamp: input.completedAt,
        source: "agent",
        model_name: input.model,
        message: input.outputText,
      },
    ],
    final_metrics: {
      total_steps: 2,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function runtimeInstructions(): string {
  return [
    "You are Generic AI running inside a Harbor task container for Terminal-Bench.",
    "Treat Harbor as the orchestration and sandbox authority.",
    "Do not start nested Docker sandboxes.",
    "Do not edit verifier files, test assets, task metadata, or solution assets unless the task explicitly authorizes it.",
    "Write a concise final summary of what you did and what verification was run.",
  ].join("\n");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputTextFromResult(result: GenericAILlmRunResult | undefined): string {
  return result?.outputText ?? "";
}

function traceDiagnostics(events: readonly TraceEvent[]): TraceDiagnostics {
  const required: readonly TraceEventType[] = [
    "benchmark.started",
    "actor.invoked",
    "actor.completed",
    "policy.decision",
    "trial.completed",
  ];
  const eventTypes = new Set(events.map((event) => event.type));
  const missing = required.filter((type) => !eventTypes.has(type));
  return Object.freeze({
    completeness: (required.length - missing.length) / required.length,
    missingRequiredEventTypes: Object.freeze(missing),
    handoffCount: 0,
    reworkCount: 0,
    policyDecisionCount: events.filter((event) => event.type === "policy.decision").length,
    artifactCount: 4,
  });
}

export async function runBenchmarkProfile(
  options: BenchmarkProfileOptions,
): Promise<BenchmarkProfileResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.createRunId?.() ?? randomUUID();
  const startedAt = now();
  const startedMs = Date.now();
  const workspaceRoot = resolve(
    options.workspaceRoot ??
      readTrimmedEnv(env, "GENERIC_AI_WORKSPACE_ROOT") ??
      process.cwd(),
  );
  const outputDir = resolve(
    options.outputDir ??
      readTrimmedEnv(env, "GENERIC_AI_BENCHMARK_ARTIFACT_DIR") ??
      DEFAULT_BENCHMARK_ARTIFACT_DIR,
  );
  const immutablePaths = splitCsv(readTrimmedEnv(env, "GENERIC_AI_BENCHMARK_IMMUTABLE_PATHS")).map(
    (path) => resolveImmutablePath(workspaceRoot, path),
  );
  const before = await snapshotPaths(immutablePaths);
  const adapter = normalizeAdapter(readTrimmedEnv(env, "GENERIC_AI_RUNTIME_ADAPTER"));
  const model = readTrimmedEnv(env, "GENERIC_AI_MODEL") ?? DEFAULT_OPENAI_CODEX_MODEL;
  const createRuntime = options.createRuntime ?? createGenericAILlmRuntime;
  const addTraceEvent = createTraceEventFactory({ runId, startedAt });
  const policyDecisions = createPolicyDecisions(runId);
  const traceEvents: TraceEvent[] = [
    addTraceEvent({
      type: "benchmark.started",
      summary: "Started Harbor-owned Terminal-Bench benchmark profile.",
    }),
    addTraceEvent({
      type: "policy.decision",
      ...(policyDecisions[0] === undefined ? {} : { policyDecisionId: policyDecisions[0].id }),
      summary: "Disabled nested Docker sandboxing for the Harbor task-container run.",
    }),
    addTraceEvent({
      type: "actor.invoked",
      summary: "Invoked Generic AI runtime for the Harbor task instruction.",
    }),
  ];

  await mkdir(outputDir, { recursive: true });

  let response: GenericAILlmRunResult | undefined;
  let errorMessage: string | undefined;
  try {
    const apiKey = readTrimmedEnv(env, "GENERIC_AI_PROVIDER_API_KEY");
    const runtime = await createRuntime({
      adapter,
      model,
      cwd: workspaceRoot,
      ...(readTrimmedEnv(env, "GENERIC_AI_AGENT_DIR") === undefined
        ? {}
        : { agentDir: resolve(readTrimmedEnv(env, "GENERIC_AI_AGENT_DIR") ?? "") }),
      ...(apiKey === undefined ? {} : { apiKey }),
      instructions: runtimeInstructions(),
    });
    try {
      response = await runtime.run(options.instruction);
    } finally {
      await runtime.close?.();
    }
  } catch (error) {
    errorMessage = toErrorMessage(error);
  }

  const after = await snapshotPaths(immutablePaths);
  const violations = compareSnapshots(before, after);
  const completedAt = now();
  const durationMs = Date.now() - startedMs;
  const status: BenchmarkProfileStatus =
    violations.length > 0 ? "integrity_failed" : errorMessage === undefined ? "passed" : "failed";

  traceEvents.push(
    addTraceEvent({
      type: "actor.completed",
      timestamp: completedAt,
      latencyMs: durationMs,
      summary:
        errorMessage === undefined
          ? "Generic AI runtime completed."
          : `Generic AI runtime failed: ${errorMessage}`,
    }),
    addTraceEvent({
      type: "artifact.created",
      timestamp: completedAt,
      summary: "Wrote Generic AI benchmark artifacts under /logs/artifacts/generic-ai.",
    }),
    addTraceEvent({
      type: "trial.completed",
      timestamp: completedAt,
      latencyMs: durationMs,
      summary: `Terminal-Bench profile completed with status ${status}.`,
    }),
  );

  const integrity: IntegrityReport = Object.freeze({
    status: violations.length === 0 ? "passed" : "failed",
    immutablePaths: Object.freeze(immutablePaths),
    before: Object.freeze(before),
    after: Object.freeze(after),
    violations: Object.freeze(violations),
  });
  const summary: BenchmarkProfileSummary = Object.freeze({
    kind: "generic-ai.terminal-bench-summary",
    runId,
    status,
    startedAt,
    completedAt,
    durationMs,
    adapter,
    model,
    workspaceRoot,
    artifactDir: outputDir,
    outputText: outputTextFromResult(response),
    ...(response?.requestId === undefined ? {} : { requestId: response.requestId }),
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  });
  const trajectory = createAtifTrajectory({
    runId,
    startedAt,
    completedAt,
    model,
    instruction: options.instruction,
    outputText: summary.outputText,
  });

  await writeJson(join(outputDir, "summary.json"), summary);
  await writeJson(join(outputDir, "trace-events.json"), traceEvents);
  await writeJson(join(outputDir, "trace-diagnostics.json"), traceDiagnostics(traceEvents));
  await writeJson(join(outputDir, "policy-decisions.json"), policyDecisions);
  await writeJson(join(outputDir, "integrity.json"), integrity);
  await writeJson(join(outputDir, "trajectory.json"), trajectory);

  return Object.freeze({
    summary,
    traceEvents: Object.freeze(traceEvents),
    integrity,
    policyDecisions,
    trajectory,
  });
}

export function artifactBasename(path: string): string {
  return basename(path);
}
