import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  BashOperations,
  PolicyDecisionRecord,
  ResourceSelector,
  TraceDiagnostics,
  TraceEvent,
  TraceEventType,
} from "@generic-ai/sdk";
import { createLocalBashOperations, createStableFingerprint } from "@generic-ai/sdk";

export const DEFAULT_BENCHMARK_ARTIFACT_DIR = "/logs/artifacts/generic-ai";
export const DEFAULT_BENCHMARK_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_BENCHMARK_MAX_COMMAND_OUTPUT_BYTES = 65_536;
export const DEFAULT_IMMUTABLE_PATHS = ["/tests", "/solution", "task.toml"] as const;
const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const BENCHMARK_SKILLS_DIR = resolve(EXAMPLE_ROOT, "skills");
const COMMAND_OBSERVATIONS_FILE = "command-observations.json";
const COMMAND_OUTPUT_DIR = "terminal-command-output";

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
  readonly commandBudget: BenchmarkCommandBudgetConfig;
  readonly commandObservationArtifact: string;
  readonly commandObservationCount: number;
  readonly commandTimeoutCount: number;
  readonly outputClippedCommandCount: number;
  readonly budgetExhaustedCommandCount: number;
  readonly outputText: string;
  readonly requestId?: string;
  readonly error?: string;
}

export interface BenchmarkCommandBudgetConfig {
  readonly commandTimeoutMs?: number;
  readonly trialTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
}

export interface BenchmarkCommandObservation {
  readonly kind: "generic-ai.terminal-command-observation";
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "timed_out" | "budget_exhausted";
  readonly exitCode: number | null;
  readonly timeoutMs?: number;
  readonly trialBudgetRemainingMs?: number;
  readonly timedOut: boolean;
  readonly budgetExhausted: boolean;
  readonly output: {
    readonly observedBytes: number;
    readonly deliveredBytes: number;
    readonly maxBytes?: number;
    readonly clipped: boolean;
    readonly redacted: boolean;
    readonly artifactId?: string;
    readonly artifactUri?: string;
    readonly localPath?: string;
  };
}

export interface BenchmarkProfileResult {
  readonly summary: BenchmarkProfileSummary;
  readonly traceEvents: readonly TraceEvent[];
  readonly integrity: IntegrityReport;
  readonly policyDecisions: readonly PolicyDecisionRecord[];
  readonly commandObservations: readonly BenchmarkCommandObservation[];
  readonly trajectory: unknown;
}

export interface BenchmarkProfileOptions {
  readonly instruction: string;
  readonly workspaceRoot?: string;
  readonly outputDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createRunId?: () => string;
  readonly commandTimeoutMs?: number;
  readonly trialTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
  readonly terminalOperations?: BashOperations;
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

function readPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = readTrimmedEnv(env, key);
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }

  return parsed;
}

function resolveCommandBudget(
  options: BenchmarkProfileOptions,
  env: NodeJS.ProcessEnv,
): BenchmarkCommandBudgetConfig {
  const trialTimeoutMs =
    options.trialTimeoutMs ?? readPositiveIntegerEnv(env, "GENERIC_AI_BENCHMARK_TRIAL_TIMEOUT_MS");

  return Object.freeze({
    commandTimeoutMs:
      options.commandTimeoutMs ??
      readPositiveIntegerEnv(env, "GENERIC_AI_BENCHMARK_COMMAND_TIMEOUT_MS") ??
      DEFAULT_BENCHMARK_COMMAND_TIMEOUT_MS,
    ...(trialTimeoutMs === undefined ? {} : { trialTimeoutMs }),
    maxCommandOutputBytes:
      options.maxCommandOutputBytes ??
      readPositiveIntegerEnv(env, "GENERIC_AI_BENCHMARK_MAX_COMMAND_OUTPUT_BYTES") ??
      DEFAULT_BENCHMARK_MAX_COMMAND_OUTPUT_BYTES,
  });
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

function secretValues(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.entries(env)
    .filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value)
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

function redactOutput(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function minDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) {
    return undefined;
  }

  return Math.min(...defined);
}

function timeoutSeconds(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000));
}

function commandNotice(message: string): Buffer {
  return Buffer.from(`\n[Generic AI benchmark observation: ${message}]\n`, "utf8");
}

function createCommandArtifactRef(input: {
  readonly runId: string;
  readonly observationId: string;
  readonly outputDir: string;
}): { readonly id: string; readonly uri: string; readonly localPath: string } {
  const id = `${input.observationId}-raw-output`;
  return Object.freeze({
    id,
    uri: `generic-ai-artifact://${input.runId}/${COMMAND_OUTPUT_DIR}/${id}`,
    localPath: join(input.outputDir, COMMAND_OUTPUT_DIR, `${id}.log`),
  });
}

function createBenchmarkTerminalOperations(input: {
  readonly baseOperations: BashOperations;
  readonly budget: BenchmarkCommandBudgetConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly outputDir: string;
  readonly runId: string;
  readonly now: () => string;
  readonly observations: BenchmarkCommandObservation[];
}): BashOperations {
  const profileSecrets = secretValues(input.env);
  const trialStartedMs = Date.now();
  let commandIndex = 0;

  return Object.freeze({
    async exec(
      command: string,
      cwd: string,
      options: Parameters<BashOperations["exec"]>[2],
    ): Promise<{ readonly exitCode: number | null }> {
      commandIndex += 1;
      const observationId = `command-${commandIndex}`;
      const startedAt = input.now();
      const startedMs = Date.now();
      const elapsedTrialMs = startedMs - trialStartedMs;
      const remainingTrialMs =
        input.budget.trialTimeoutMs === undefined
          ? undefined
          : input.budget.trialTimeoutMs - elapsedTrialMs;
      const requestedTimeoutMs =
        options.timeout === undefined ? undefined : Math.max(1, options.timeout * 1000);
      const effectiveTimeoutMs = minDefined([
        input.budget.commandTimeoutMs,
        requestedTimeoutMs,
        remainingTrialMs,
      ]);
      const secrets = [...profileSecrets, ...secretValues(options.env ?? {})];
      const rawOutput = createCommandArtifactRef({
        runId: input.runId,
        observationId,
        outputDir: input.outputDir,
      });
      await mkdir(dirname(rawOutput.localPath), { recursive: true });

      let observedBytes = 0;
      let deliveredBytes = 0;
      let clipped = false;
      let clipNoticeSent = false;

      const sendNotice = (message: string) => options.onData(commandNotice(message));
      const recordObservation = (result: {
        readonly exitCode: number | null;
        readonly completedAt: string;
        readonly durationMs: number;
        readonly timedOut: boolean;
        readonly budgetExhausted: boolean;
      }) => {
        const status = result.budgetExhausted
          ? "budget_exhausted"
          : result.timedOut
            ? "timed_out"
            : "completed";
        input.observations.push(
          Object.freeze({
            kind: "generic-ai.terminal-command-observation",
            id: observationId,
            command,
            cwd,
            startedAt,
            completedAt: result.completedAt,
            durationMs: result.durationMs,
            status,
            exitCode: result.exitCode,
            ...(effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs }),
            ...(remainingTrialMs === undefined
              ? {}
              : { trialBudgetRemainingMs: Math.max(0, remainingTrialMs) }),
            timedOut: result.timedOut,
            budgetExhausted: result.budgetExhausted,
            output: Object.freeze({
              observedBytes,
              deliveredBytes,
              ...(input.budget.maxCommandOutputBytes === undefined
                ? {}
                : { maxBytes: input.budget.maxCommandOutputBytes }),
              clipped,
              redacted: true,
              ...(observedBytes === 0
                ? {}
                : {
                    artifactId: rawOutput.id,
                    artifactUri: rawOutput.uri,
                    localPath: rawOutput.localPath,
                  }),
            }),
          }),
        );
      };

      if (remainingTrialMs !== undefined && remainingTrialMs <= 0) {
        sendNotice(
          `trial wall-clock budget was exhausted before "${command}" could start; no command was executed.`,
        );
        const completedAt = input.now();
        recordObservation({
          exitCode: null,
          completedAt,
          durationMs: Date.now() - startedMs,
          timedOut: false,
          budgetExhausted: true,
        });
        return { exitCode: null };
      }

      const effectiveTimeoutSeconds = timeoutSeconds(effectiveTimeoutMs);
      const result = await input.baseOperations.exec(command, cwd, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(effectiveTimeoutSeconds === undefined ? {} : { timeout: effectiveTimeoutSeconds }),
        onData: (data) => {
          const redacted = redactOutput(data.toString("utf8"), secrets);
          const redactedBuffer = Buffer.from(redacted, "utf8");
          appendFileSync(rawOutput.localPath, redactedBuffer);
          observedBytes += redactedBuffer.byteLength;

          if (input.budget.maxCommandOutputBytes === undefined) {
            deliveredBytes += redactedBuffer.byteLength;
            options.onData(redactedBuffer);
            return;
          }

          const remainingBytes = input.budget.maxCommandOutputBytes - deliveredBytes;
          if (remainingBytes > 0) {
            const deliver = redactedBuffer.subarray(0, remainingBytes);
            deliveredBytes += deliver.byteLength;
            options.onData(deliver);
          }

          if (!clipNoticeSent && observedBytes > input.budget.maxCommandOutputBytes) {
            clipped = true;
            clipNoticeSent = true;
            sendNotice(
              `command output clipped at ${input.budget.maxCommandOutputBytes} bytes; redacted full output artifact: ${rawOutput.uri}.`,
            );
          }
        },
      });
      const completedAt = input.now();
      const durationMs = Date.now() - startedMs;
      const budgetExhausted =
        result.exitCode === null &&
        remainingTrialMs !== undefined &&
        effectiveTimeoutMs === remainingTrialMs;
      const timedOut = result.exitCode === null && !budgetExhausted;

      if (budgetExhausted) {
        sendNotice(
          `trial wall-clock budget expired while running "${command}"; exitCode is null and the run should repair or stop with a budget-exhausted reason.`,
        );
      } else if (timedOut) {
        sendNotice(
          `command timed out after ${effectiveTimeoutMs ?? "the configured"} ms; exitCode is null and the run should retry with a narrower command or stop with a timeout reason.`,
        );
      }

      recordObservation({
        exitCode: result.exitCode,
        completedAt,
        durationMs,
        timedOut,
        budgetExhausted,
      });

      return result;
    },
  });
}

function runtimeInstructions(): string {
  return [
    "You are Generic AI running inside a Harbor task container for Terminal-Bench.",
    "Treat Harbor as the orchestration and sandbox authority.",
    "Do not start nested Docker sandboxes.",
    "Do not edit verifier files, test assets, task metadata, or solution assets unless the task explicitly authorizes it.",
    "Use bounded terminal commands. If a command output is clipped, timed out, or the trial budget is exhausted, treat the Generic AI benchmark observation in the tool output as live evidence for the next repair step.",
    "Verify from a clean external-grader posture: do not trust stale files or logs produced by an earlier builder check.",
    "If a verification command creates transient runtime outputs, remove stale copies before the check and clean them up before finishing when the external verifier is expected to create them itself.",
    "Write a concise final summary of what you did and what verification was run.",
  ].join("\n");
}

function createBenchmarkCapabilities(input: {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly outputDir: string;
  readonly runId: string;
  readonly now: () => string;
  readonly budget: BenchmarkCommandBudgetConfig;
  readonly observations: BenchmarkCommandObservation[];
  readonly terminalOperations?: BashOperations;
}) {
  const operations = createBenchmarkTerminalOperations({
    baseOperations: input.terminalOperations ?? createLocalBashOperations(),
    budget: input.budget,
    env: input.env,
    outputDir: input.outputDir,
    runId: input.runId,
    now: input.now,
    observations: input.observations,
  });
  const terminal = createTerminalToolPlugin({
    root: input.workspaceRoot,
    operations,
    env: input.env,
    ...(input.budget.commandTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: input.budget.commandTimeoutMs }),
    unrestrictedLocal: true,
  });
  const files = createWorkspaceFileTools({ root: input.workspaceRoot });
  const repoMap = createRepoMapPlugin({ root: input.workspaceRoot, maxFiles: 500 });
  const storage = createMemoryStorage();
  const messaging = createMessagingService({ storage });
  const memory = createFileMemoryStore({ root: input.workspaceRoot });
  const skills = createAgentSkillsPlugin({
    root: input.workspaceRoot,
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

function appendTraceEventsFromCommandObservations(input: {
  readonly observations: readonly BenchmarkCommandObservation[];
  readonly addTraceEvent: ReturnType<typeof createTraceEventFactory>;
  readonly completedAt: string;
}): readonly TraceEvent[] {
  return Object.freeze(
    input.observations
      .filter(
        (observation) =>
          observation.timedOut || observation.budgetExhausted || observation.output.clipped,
      )
      .map((observation) => {
        const outcomes = [
          ...(observation.timedOut ? ["timed out"] : []),
          ...(observation.budgetExhausted ? ["exhausted trial budget"] : []),
          ...(observation.output.clipped ? ["output clipped"] : []),
        ].join(", ");
        return input.addTraceEvent({
          type: "diagnostic",
          timestamp: input.completedAt,
          actorId: "generic-ai",
          ...(observation.output.artifactId === undefined
            ? {}
            : { artifactId: observation.output.artifactId }),
          summary: `Terminal command ${observation.id} ${outcomes}: ${observation.command}`,
        });
      }),
  );
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
  const commandBudget = resolveCommandBudget(options, env);
  const commandObservations: BenchmarkCommandObservation[] = [];
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
      ...(commandBudget.trialTimeoutMs === undefined
        ? {}
        : {
            deadline: new Date(Date.now() + commandBudget.trialTimeoutMs).toISOString(),
            budget: { maxWallTimeMs: commandBudget.trialTimeoutMs },
          }),
      capabilities: createBenchmarkCapabilities({
        workspaceRoot,
        env,
        outputDir,
        runId,
        now,
        budget: commandBudget,
        observations: commandObservations,
        ...(options.terminalOperations === undefined
          ? {}
          : { terminalOperations: options.terminalOperations }),
      }),
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
          commandBudget: {
            ...(commandBudget.commandTimeoutMs === undefined
              ? {}
              : { commandTimeoutMs: commandBudget.commandTimeoutMs }),
            ...(commandBudget.trialTimeoutMs === undefined
              ? {}
              : { trialTimeoutMs: commandBudget.trialTimeoutMs }),
            ...(commandBudget.maxCommandOutputBytes === undefined
              ? {}
              : { maxCommandOutputBytes: commandBudget.maxCommandOutputBytes }),
          },
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
    ...appendTraceEventsFromCommandObservations({
      observations: commandObservations,
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
      artifactId: "terminal-command-observations",
      summary: `Wrote ${commandObservations.length} Terminal-Bench command observation records.`,
    }),
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
  const commandObservationSnapshot = Object.freeze([...commandObservations]);
  const commandTimeoutCount = commandObservationSnapshot.filter(
    (observation) => observation.timedOut,
  ).length;
  const outputClippedCommandCount = commandObservationSnapshot.filter(
    (observation) => observation.output.clipped,
  ).length;
  const budgetExhaustedCommandCount = commandObservationSnapshot.filter(
    (observation) => observation.budgetExhausted,
  ).length;
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
    commandBudget,
    commandObservationArtifact: COMMAND_OBSERVATIONS_FILE,
    commandObservationCount: commandObservationSnapshot.length,
    commandTimeoutCount,
    outputClippedCommandCount,
    budgetExhaustedCommandCount,
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

  await writeJson(join(outputDir, COMMAND_OBSERVATIONS_FILE), commandObservationSnapshot);
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
    commandObservations: commandObservationSnapshot,
    trajectory,
  });
}

export function artifactBasename(path: string): string {
  return basename(path);
}
