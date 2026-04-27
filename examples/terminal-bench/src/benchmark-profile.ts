import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_OPENAI_CODEX_MODEL,
  runAgentHarness,
  type RunAgentHarnessOptions,
} from "@generic-ai/core";
import { createAgentSkillsPlugin } from "@generic-ai/plugin-agent-skills";
import { createMcpRegistry } from "@generic-ai/plugin-mcp";
import { createFileMemoryStore } from "@generic-ai/plugin-memory-files";
import { createMessagingService } from "@generic-ai/plugin-messaging";
import { createRepoMapPlugin } from "@generic-ai/plugin-repo-map";
import { createMemoryStorage } from "@generic-ai/plugin-storage-memory";
import { createTerminalToolPlugin } from "@generic-ai/plugin-tools-terminal";
import { createWorkspaceFileTools } from "@generic-ai/plugin-tools-files";
import type {
  AgentHarnessAdapterKind,
  AgentHarnessEventProjection,
  AgentHarnessRunResult,
  PolicyDecisionRecord,
  ResourceSelector,
  TraceDiagnostics,
  TraceEvent,
  TraceEventType,
} from "@generic-ai/sdk";
import { createStableFingerprint } from "@generic-ai/sdk";

export const DEFAULT_BENCHMARK_ARTIFACT_DIR = "/logs/artifacts/generic-ai";
export const DEFAULT_IMMUTABLE_PATHS = ["/tests", "/solution", "task.toml"] as const;
const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const BENCHMARK_SKILLS_DIR = resolve(EXAMPLE_ROOT, "skills");

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
  readonly adapter: AgentHarnessAdapterKind;
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
  readonly runHarness?: (
    options: RunAgentHarnessOptions,
  ) => Promise<AgentHarnessRunResult<unknown>> | AgentHarnessRunResult<unknown>;
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

function normalizeAdapter(value: string | undefined): AgentHarnessAdapterKind {
  if (value === undefined || value === "openai-codex" || value === "pi") {
    return "pi";
  }

  if (value === "external") {
    return value;
  }

  throw new Error("GENERIC_AI_RUNTIME_ADAPTER must be openai-codex, pi, or external.");
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
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
  readonly actorId?: string;
  readonly artifactId?: string;
  readonly parentEventId?: string;
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
      actorId: event.actorId ?? "generic-ai",
      ...(event.artifactId === undefined ? {} : { artifactId: event.artifactId }),
      ...(event.parentEventId === undefined ? {} : { parentEventId: event.parentEventId }),
      ...(event.policyDecisionId === undefined ? {} : { policyDecisionId: event.policyDecisionId }),
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
  readonly projections: readonly AgentHarnessEventProjection[];
}): unknown {
  const projectedSteps = input.projections
    .filter(
      (projection) =>
        projection.type.startsWith("tool.call.") ||
        projection.type.startsWith("terminal.command.") ||
        projection.type.startsWith("handoff."),
    )
    .map((projection, index) =>
      Object.freeze({
        step_id: index + 2,
        timestamp: projection.occurredAt,
        source: "agent",
        message: projection.summary,
        extra: {
          event_name: projection.eventName,
          projection_type: projection.type,
          role_id: projection.roleId,
          tool_name: projection.toolName,
          data: projection.data,
        },
      }),
    );

  return {
    schema_version: "ATIF-v1.4",
    session_id: input.runId,
    agent: {
      name: "generic-ai",
      version: "0.0.0",
      model_name: input.model,
      extra: {
        adapter: "pi",
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
      ...projectedSteps,
      {
        step_id: projectedSteps.length + 2,
        timestamp: input.completedAt,
        source: "agent",
        model_name: input.model,
        message: input.outputText,
      },
    ],
    final_metrics: {
      total_steps: projectedSteps.length + 2,
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
    "Verify from a clean external-grader posture: do not trust stale files or logs produced by an earlier builder check.",
    "If a verification command creates transient runtime outputs, remove stale copies before the check and clean them up before finishing when the external verifier is expected to create them itself.",
    "Write a concise final summary of what you did and what verification was run.",
  ].join("\n");
}

function createBenchmarkCapabilities(workspaceRoot: string, env: NodeJS.ProcessEnv) {
  const terminal = createTerminalToolPlugin({
    root: workspaceRoot,
    env,
    defaultTimeoutMs: 120_000,
    unrestrictedLocal: true,
  });
  const files = createWorkspaceFileTools({ root: workspaceRoot });
  const repoMap = createRepoMapPlugin({ root: workspaceRoot, maxFiles: 500 });
  const storage = createMemoryStorage();
  const messaging = createMessagingService({ storage });
  const memory = createFileMemoryStore({ root: workspaceRoot });
  const skills = createAgentSkillsPlugin({
    root: workspaceRoot,
    skillDirs: [BENCHMARK_SKILLS_DIR],
    includeProject: true,
    includeUser: false,
    includeGlobal: false,
  });
  const mcp = createMcpRegistry();

  return {
    terminalTools: terminal,
    fileTools: files,
    customTools: [repoMap.tool],
    messaging,
    memory,
    skills,
    mcp,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendTraceEventsFromHarness(input: {
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly addTraceEvent: ReturnType<typeof createTraceEventFactory>;
  readonly completedAt: string;
}): readonly TraceEvent[] {
  const traceEvents: TraceEvent[] = [];

  for (const decision of input.policyDecisions) {
    traceEvents.push(
      input.addTraceEvent({
        type: "policy.decision",
        timestamp: input.completedAt,
        policyDecisionId: decision.id,
        summary: `${decision.decision}: ${decision.reason}`,
      }),
    );
  }

  for (const projection of input.projections) {
    if (projection.type === "tool.call.started" || projection.type === "terminal.command.started") {
      traceEvents.push(
        input.addTraceEvent({
          type: "tool.invoked",
          timestamp: projection.occurredAt,
          actorId: projection.roleId ?? "generic-ai",
          summary: `Tool invoked: ${projection.toolName ?? projection.eventName}.`,
        }),
      );
      continue;
    }

    if (projection.type.startsWith("handoff.")) {
      traceEvents.push(
        input.addTraceEvent({
          type: "protocol.action.planned",
          timestamp: projection.occurredAt,
          actorId: projection.roleId ?? "generic-ai",
          summary: projection.summary,
        }),
      );
    }
  }

  return Object.freeze(traceEvents);
}

function outputTextFromResult(result: AgentHarnessRunResult<unknown> | undefined): string {
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
    handoffCount: events.filter((event) => event.type === "protocol.action.planned").length,
    reworkCount: 0,
    policyDecisionCount: events.filter((event) => event.type === "policy.decision").length,
    artifactCount: events.filter((event) => event.type === "artifact.created").length,
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
    options.workspaceRoot ?? readTrimmedEnv(env, "GENERIC_AI_WORKSPACE_ROOT") ?? process.cwd(),
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
  const invokeHarness = options.runHarness ?? runAgentHarness;
  const addTraceEvent = createTraceEventFactory({ runId, startedAt });
  const traceEvents: TraceEvent[] = [
    addTraceEvent({
      type: "benchmark.started",
      summary: "Started Harbor-owned Terminal-Bench benchmark profile.",
    }),
    addTraceEvent({
      type: "actor.invoked",
      summary: "Invoked Generic AI agent harness for the Harbor task instruction.",
    }),
  ];

  await mkdir(outputDir, { recursive: true });

  let response: AgentHarnessRunResult<unknown> | undefined;
  let errorMessage: string | undefined;
  try {
    response = await invokeHarness({
      instruction: `${runtimeInstructions()}\n\nTerminal-Bench task instruction:\n${options.instruction}`,
      workspaceRoot,
      runId,
      rootScopeId: "terminal-bench",
      rootAgentId: "generic-ai",
      artifactDir: outputDir,
      capabilities: createBenchmarkCapabilities(workspaceRoot, env),
      harness: {
        id: "terminal-bench",
        adapter,
        model,
        policyProfile: "benchmark-container",
        allowNetwork: false,
        allowMcp: false,
        artifactDir: outputDir,
        roles: [
          {
            id: "planner",
            kind: "planner",
            description: "Plan the Terminal-Bench task and identify likely verifier expectations.",
            readOnly: true,
          },
          {
            id: "explorer",
            kind: "explorer",
            description: "Inspect files, tests, and repo structure without mutating files.",
            readOnly: true,
          },
          {
            id: "builder",
            kind: "builder",
            description: "Implement the task changes in the shared Harbor workspace.",
          },
          {
            id: "verifier",
            kind: "verifier",
            description: "Run targeted verification and summarize failures without editing files.",
            readOnly: true,
          },
        ],
        metadata: {
          benchmark: "terminal-bench",
          harborArtifactDir: outputDir,
        },
      },
    });
  } catch (error) {
    errorMessage = toErrorMessage(error);
  }

  const after = await snapshotPaths(immutablePaths);
  const violations = compareSnapshots(before, after);
  const completedAt = now();
  const durationMs = Date.now() - startedMs;
  const status: BenchmarkProfileStatus =
    violations.length > 0
      ? "integrity_failed"
      : errorMessage === undefined && response?.status !== "failed"
        ? "passed"
        : "failed";
  const policyDecisions = response?.policyDecisions ?? createPolicyDecisions(runId);
  traceEvents.push(
    ...appendTraceEventsFromHarness({
      projections: response?.projections ?? [],
      policyDecisions,
      addTraceEvent,
      completedAt,
    }),
  );

  traceEvents.push(
    addTraceEvent({
      type: "actor.completed",
      timestamp: completedAt,
      latencyMs: durationMs,
      summary:
        errorMessage === undefined && response?.failureMessage === undefined
          ? "Generic AI agent harness completed."
          : `Generic AI agent harness failed: ${errorMessage ?? response?.failureMessage}`,
    }),
    ...(response?.artifacts ?? []).map((artifact) =>
      addTraceEvent({
        type: "artifact.created",
        timestamp: completedAt,
        artifactId: artifact.id,
        summary: `Wrote harness artifact ${artifact.uri}.`,
      }),
    ),
    addTraceEvent({
      type: "artifact.created",
      timestamp: completedAt,
      artifactId: "terminal-bench-artifacts",
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
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  });
  const trajectory = createAtifTrajectory({
    runId,
    startedAt,
    completedAt,
    model,
    instruction: options.instruction,
    outputText: summary.outputText,
    projections: response?.projections ?? [],
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
