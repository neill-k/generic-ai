#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBenchmarkReport,
  createStableFingerprint,
  HARNESS_SCHEMA_VERSION,
  renderBenchmarkReportMarkdown,
  type AgentHarnessEventProjection,
  type ArtifactReference,
  type BenchmarkReport,
  type BenchmarkSpec,
  type BenchmarkTrialResult,
  type MetricValue,
  type MissionSpec,
  type TraceDiagnostics,
  type TraceEvent,
  type TraceEventType,
} from "@generic-ai/sdk";
import {
  createCommandTranscriptFromTraceEvents,
  renderCommandTranscriptsMarkdown,
  type CommandTranscript,
} from "./command-transcript.js";

export interface HarborImportOptions {
  readonly jobDir: string;
  readonly outputDir?: string;
  readonly now?: () => string;
}

export interface HarborImportResult {
  readonly jobDir: string;
  readonly outputDir: string;
  readonly mission: MissionSpec;
  readonly benchmark: BenchmarkSpec;
  readonly trialResults: readonly BenchmarkTrialResult[];
  readonly trialTranscripts: readonly CommandTranscript[];
  readonly smokeArtifactProof: SmokeArtifactProof;
  readonly report: BenchmarkReport;
  readonly validation: HarborValidationSummary;
}

type JsonRecord = Record<string, unknown>;
type ValidationGateKind = "smoke" | "quick" | "validation" | "full" | "custom";

const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_REPORTS_ROOT = resolve(EXAMPLE_ROOT, "reports", "imported");
const REQUIRED_SMOKE_ARTIFACTS = Object.freeze([
  "summary.json",
  "trace-events.json",
  "trace-diagnostics.json",
  "policy-decisions.json",
  "integrity.json",
  "trajectory.json",
]);

export interface SmokeArtifactFileCheck {
  readonly path: string;
  readonly present: boolean;
  readonly artifactId?: string;
}

export interface SmokeArtifactTrialProof {
  readonly trialId: string;
  readonly complete: boolean;
  readonly requiredArtifacts: readonly SmokeArtifactFileCheck[];
  readonly harnessArtifactRefs: readonly string[];
  readonly traceEventCount: number;
  readonly traceCompleteness: number;
  readonly reward?: number;
  readonly success?: number;
}

export interface SmokeArtifactProof {
  readonly kind: "generic-ai.terminal-bench-smoke-artifact-proof";
  readonly jobDir: string;
  readonly generatedAt: string;
  readonly requiredArtifacts: readonly string[];
  readonly completeTrialCount: number;
  readonly trialCount: number;
  readonly trials: readonly SmokeArtifactTrialProof[];
  readonly decisionBoundary: string;
}

export interface MetricDistributionSummary {
  readonly samples: number;
  readonly values: readonly number[];
  readonly mean?: number;
  readonly standardDeviation?: number;
  readonly min?: number;
  readonly max?: number;
  readonly distribution: Readonly<Record<string, number>>;
}

export interface TraceCompletenessSummary {
  readonly samples: number;
  readonly average: number;
  readonly min: number;
  readonly completeTrials: number;
}

export interface ValidationTaskPinning {
  readonly status: "pinned" | "sampled" | "unknown";
  readonly taskNames: readonly string[];
  readonly declaredTaskCount?: number;
}

export interface ValidationFlakeSignal {
  readonly taskId: string;
  readonly successValues: readonly number[];
  readonly rewardValues: readonly number[];
  readonly reason: string;
}

export interface HarborValidationSummary {
  readonly kind: "generic-ai.terminal-bench-validation-summary";
  readonly jobName: string;
  readonly gate: ValidationGateKind;
  readonly trialCount: number;
  readonly thresholds: {
    readonly minimumTrialsForRecommendation: number;
    readonly requireTraceCompleteness: boolean;
  };
  readonly pinnedTaskSet: ValidationTaskPinning;
  readonly reward: MetricDistributionSummary;
  readonly success: MetricDistributionSummary;
  readonly traceCompleteness: TraceCompletenessSummary;
  readonly flakeSignals: readonly ValidationFlakeSignal[];
  readonly insufficientEvidenceReasons: readonly string[];
  readonly recommendationQuality: "sufficient" | "insufficient";
  readonly limitations: readonly string[];
  readonly nextActions: readonly string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }

    throw error;
  }
}

function findFirstNumber(value: unknown, names: ReadonlySet<string>): number | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumber(item, names);
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
    if (names.has(key.toLowerCase()) && typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findFirstNumber(item, names);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function findFirstBoolean(value: unknown, names: ReadonlySet<string>): boolean | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstBoolean(item, names);
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
    if (names.has(key.toLowerCase()) && typeof item === "boolean") {
      return item;
    }
  }

  for (const item of Object.values(value)) {
    const found = findFirstBoolean(item, names);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function collectFileArtifacts(
  root: string,
  baseUri: string,
): Promise<readonly ArtifactReference[]> {
  if (!existsSync(root)) {
    return [];
  }

  const item = await stat(root);
  if (item.isFile()) {
    const id = `artifact:${createStableFingerprint(`${baseUri}:${root}`).slice(0, 16)}`;
    return [
      Object.freeze({
        id,
        kind: "file",
        uri: baseUri,
        sha256: await sha256(root),
        redaction: "metadata_only",
        summary: `Imported Harbor artifact ${baseUri}.`,
      }),
    ];
  }

  if (!item.isDirectory()) {
    return [];
  }

  const artifacts: ArtifactReference[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const nextPath = join(root, entry.name);
    const nextUri = `${baseUri}/${entry.name}`;
    artifacts.push(...(await collectFileArtifacts(nextPath, nextUri)));
  }

  return artifacts;
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["type"] === "string" &&
    typeof value["sequence"] === "number" &&
    typeof value["timestamp"] === "string" &&
    typeof value["runId"] === "string" &&
    typeof value["summary"] === "string"
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isAgentHarnessEventProjection(value: unknown): value is AgentHarnessEventProjection {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["sequence"] === "number" &&
    typeof value["type"] === "string" &&
    typeof value["eventName"] === "string" &&
    typeof value["occurredAt"] === "string" &&
    typeof value["summary"] === "string" &&
    isRecord(value["data"])
  );
}

function eventFactory(input: {
  readonly runId: string;
  readonly trialId: string;
  readonly startSequence: number;
  readonly timestamp: string;
}): (event: {
  readonly type: TraceEventType;
  readonly summary: string;
  readonly latencyMs?: number;
}) => TraceEvent {
  let sequence = input.startSequence;
  return (event) => {
    sequence += 1;
    return Object.freeze({
      id: `${input.runId}:${input.trialId}:harbor:${sequence}`,
      type: event.type,
      sequence,
      timestamp: input.timestamp,
      runId: input.runId,
      candidateId: "generic-ai",
      trialId: input.trialId,
      actorId: "generic-ai",
      ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
      summary: event.summary,
    });
  };
}

function hasEvent(events: readonly TraceEvent[], type: TraceEventType): boolean {
  return events.some((event) => event.type === type);
}

function traceDiagnostics(events: readonly TraceEvent[], artifactCount: number): TraceDiagnostics {
  const required: readonly TraceEventType[] = [
    "trial.started",
    "actor.completed",
    "grader.completed",
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
    artifactCount,
  });
}

async function loadTraceEvents(trialDir: string): Promise<readonly TraceEvent[]> {
  const candidates = [
    join(trialDir, "artifacts", "generic-ai", "trace-events.json"),
    join(trialDir, "agent", "generic-ai", "trace-events.json"),
    join(trialDir, "agent", "trace-events.json"),
  ];

  for (const candidate of candidates) {
    const json = await readJsonIfExists(candidate);
    if (Array.isArray(json) && json.every(isTraceEvent)) {
      return json;
    }
  }

  return [];
}

async function loadHarnessProjections(
  trialDir: string,
): Promise<readonly AgentHarnessEventProjection[]> {
  const candidates = [
    join(trialDir, "artifacts", "generic-ai", "harness", "harness-projections.json"),
    join(trialDir, "agent", "generic-ai", "harness", "harness-projections.json"),
    join(trialDir, "agent", "harness", "harness-projections.json"),
  ];

  for (const candidate of candidates) {
    const json = await readJsonIfExists(candidate);
    if (Array.isArray(json) && json.every(isAgentHarnessEventProjection)) {
      return json;
    }
  }

  return [];
}

function metric(
  metricId: string,
  value: number | undefined,
  evidenceRefs: readonly string[],
): MetricValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Object.freeze({
    metricId,
    value,
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

function extractMetrics(
  resultJson: unknown,
  artifactRefs: readonly string[],
): readonly MetricValue[] {
  const reward = findFirstNumber(resultJson, new Set(["reward", "score"]));
  const duration = findFirstNumber(resultJson, new Set(["duration_sec", "duration_seconds"]));
  const costUsd = findFirstNumber(resultJson, new Set(["cost_usd", "cost"]));
  const successBool = findFirstBoolean(resultJson, new Set(["success", "passed"]));
  const success = successBool ?? (reward === undefined ? undefined : reward > 0);
  const values = [
    metric("reward", reward, artifactRefs),
    metric("success", success === undefined ? undefined : Number(success), artifactRefs),
    metric("duration_sec", duration, artifactRefs),
    metric("cost_usd", costUsd, artifactRefs),
  ];

  return Object.freeze(values.filter((value): value is MetricValue => value !== undefined));
}

function metricValues(
  trialResults: readonly BenchmarkTrialResult[],
  metricId: string,
): readonly number[] {
  return Object.freeze(
    trialResults
      .map((result) => result.metrics.find((metric) => metric.metricId === metricId)?.value)
      .filter((value): value is number => value !== undefined),
  );
}

function averageNumber(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[]): number | undefined {
  if (values.length < 2) {
    return undefined;
  }

  const mean = averageNumber(values);
  if (mean === undefined) {
    return undefined;
  }

  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function distributionKey(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function summarizeMetric(values: readonly number[]): MetricDistributionSummary {
  const mean = averageNumber(values);
  const standardDeviation = sampleStandardDeviation(values);
  const distribution: Record<string, number> = {};
  for (const value of values) {
    const key = distributionKey(value);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  return Object.freeze({
    samples: values.length,
    values: Object.freeze([...values]),
    ...(mean === undefined ? {} : { mean }),
    ...(standardDeviation === undefined ? {} : { standardDeviation }),
    ...(values.length === 0 ? {} : { min: Math.min(...values), max: Math.max(...values) }),
    distribution: Object.freeze(distribution),
  });
}

function summarizeTraceCompleteness(
  trialResults: readonly BenchmarkTrialResult[],
): TraceCompletenessSummary {
  const values = trialResults.map((result) => result.diagnostics.completeness);
  if (values.length === 0) {
    return Object.freeze({
      samples: 0,
      average: 0,
      min: 0,
      completeTrials: 0,
    });
  }

  return Object.freeze({
    samples: values.length,
    average: averageNumber(values) ?? 0,
    min: Math.min(...values),
    completeTrials: values.filter((value) => value >= 1).length,
  });
}

function validationGateKind(jobName: string): ValidationGateKind {
  const normalized = jobName.toLowerCase();
  if (normalized.includes("smoke")) {
    return "smoke";
  }

  if (normalized.includes("quick")) {
    return "quick";
  }

  if (normalized.includes("validation") || normalized.includes("calibration")) {
    return "validation";
  }

  if (normalized.includes("full")) {
    return "full";
  }

  return "custom";
}

function numberFromRecord(record: JsonRecord, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function stringArrayFromRecord(record: JsonRecord, names: readonly string[]): readonly string[] {
  for (const name of names) {
    const value = record[name];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return Object.freeze([...value]);
    }
  }

  return Object.freeze([]);
}

function extractTaskPinning(configJson: unknown): ValidationTaskPinning {
  if (!isRecord(configJson) || !Array.isArray(configJson["datasets"])) {
    return Object.freeze({
      status: "unknown",
      taskNames: Object.freeze([]),
    });
  }

  const taskNames: string[] = [];
  let declaredTaskCount: number | undefined;
  for (const dataset of configJson["datasets"]) {
    if (!isRecord(dataset)) {
      continue;
    }

    taskNames.push(...stringArrayFromRecord(dataset, ["task_names", "taskNames"]));
    declaredTaskCount ??= numberFromRecord(dataset, ["n_tasks", "nTasks"]);
  }

  return Object.freeze({
    status:
      taskNames.length > 0 ? "pinned" : declaredTaskCount === undefined ? "unknown" : "sampled",
    taskNames: Object.freeze([...new Set(taskNames)]),
    ...(declaredTaskCount === undefined ? {} : { declaredTaskCount }),
  });
}

function trialTaskId(trialId: string): string {
  return trialId.split("__")[0] ?? trialId;
}

function flakeSignals(
  trialResults: readonly BenchmarkTrialResult[],
): readonly ValidationFlakeSignal[] {
  const byTask = new Map<string, BenchmarkTrialResult[]>();
  for (const result of trialResults) {
    const taskId = trialTaskId(result.trialId);
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), result]);
  }

  const signals: ValidationFlakeSignal[] = [];
  for (const [taskId, results] of byTask) {
    const successValues = metricValues(results, "success");
    const rewardValues = metricValues(results, "reward");
    const successFlipped = new Set(successValues).size > 1;
    const rewardFlipped =
      rewardValues.length > 1 && Math.min(...rewardValues) <= 0 && Math.max(...rewardValues) > 0;
    if (!successFlipped && !rewardFlipped) {
      continue;
    }

    signals.push(
      Object.freeze({
        taskId,
        successValues,
        rewardValues,
        reason:
          "Repeated attempts produced both passing and failing evidence; rerun this task before making recommendation-quality claims.",
      }),
    );
  }

  return Object.freeze(signals.sort((left, right) => left.taskId.localeCompare(right.taskId)));
}

function traceEventTypeFromProjection(
  projection: AgentHarnessEventProjection,
): TraceEventType | undefined {
  if (projection.type === "policy.decision") {
    return "policy.decision";
  }

  if (projection.type === "artifact.created") {
    return "artifact.created";
  }

  if (projection.type.startsWith("tool.call.") || projection.type.startsWith("terminal.command.")) {
    return "tool.invoked";
  }

  if (projection.type.startsWith("handoff.")) {
    return "protocol.action.planned";
  }

  if (projection.type === "session.completed" || projection.type === "session.failed") {
    return "actor.completed";
  }

  return undefined;
}

function hasEquivalentProjectionEvent(
  events: readonly TraceEvent[],
  projection: AgentHarnessEventProjection,
  type: TraceEventType,
): boolean {
  const artifactId = projection.data["artifactId"];
  const policyDecisionId = projection.data["policyDecisionId"];

  return events.some((event) => {
    if (event.type !== type) {
      return false;
    }

    if (type === "artifact.created" && isString(artifactId)) {
      return event.artifactId === artifactId;
    }

    if (type === "policy.decision" && isString(policyDecisionId)) {
      return event.policyDecisionId === policyDecisionId;
    }

    return event.summary === projection.summary;
  });
}

function traceEventsFromHarnessProjections(input: {
  readonly projections: readonly AgentHarnessEventProjection[];
  readonly existingEvents: readonly TraceEvent[];
  readonly addEvent: ReturnType<typeof eventFactory>;
}): readonly TraceEvent[] {
  const traceEvents: TraceEvent[] = [];

  for (const projection of input.projections) {
    const type = traceEventTypeFromProjection(projection);
    if (
      type === undefined ||
      hasEquivalentProjectionEvent(input.existingEvents, projection, type)
    ) {
      continue;
    }

    const artifactId = projection.data["artifactId"];
    const policyDecisionId = projection.data["policyDecisionId"];
    traceEvents.push(
      Object.freeze({
        ...input.addEvent({
          type,
          summary: projection.summary,
        }),
        timestamp: projection.occurredAt,
        actorId: projection.roleId ?? "generic-ai",
        ...(isString(artifactId) ? { artifactId } : {}),
        ...(isString(policyDecisionId) ? { policyDecisionId } : {}),
      }),
    );
  }

  return Object.freeze(traceEvents);
}

async function listTrialDirs(jobDir: string): Promise<readonly string[]> {
  const dirs: string[] = [];
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const trialDir = join(jobDir, entry.name);
    if (existsSync(join(trialDir, "result.json")) || existsSync(join(trialDir, "config.json"))) {
      dirs.push(trialDir);
    }
  }

  return dirs.sort((left, right) => left.localeCompare(right));
}

async function importTrial(input: {
  readonly jobDir: string;
  readonly trialDir: string;
  readonly runId: string;
  readonly timestamp: string;
}): Promise<BenchmarkTrialResult> {
  const trialId = basename(input.trialDir);
  const resultJson = await readJsonIfExists(join(input.trialDir, "result.json"));
  const artifacts = [
    ...(await collectFileArtifacts(join(input.trialDir, "agent"), `${trialId}/agent`)),
    ...(await collectFileArtifacts(join(input.trialDir, "verifier"), `${trialId}/verifier`)),
    ...(await collectFileArtifacts(join(input.trialDir, "artifacts"), `${trialId}/artifacts`)),
  ];
  const artifactRefs = artifacts.map((artifact) => artifact.id);
  const loadedEvents = await loadTraceEvents(input.trialDir);
  const harnessProjections = await loadHarnessProjections(input.trialDir);
  const addEvent = eventFactory({
    runId: input.runId,
    trialId,
    startSequence: loadedEvents.reduce((max, event) => Math.max(max, event.sequence), 0),
    timestamp: input.timestamp,
  });
  const events: TraceEvent[] = [...loadedEvents];
  events.push(
    ...traceEventsFromHarnessProjections({
      projections: harnessProjections,
      existingEvents: events,
      addEvent,
    }),
  );
  const reward = findFirstNumber(resultJson, new Set(["reward", "score"]));
  const duration = findFirstNumber(resultJson, new Set(["duration_sec", "duration_seconds"]));

  if (!hasEvent(events, "trial.started")) {
    events.unshift(
      addEvent({
        type: "trial.started",
        summary: "Imported Harbor trial result.",
      }),
    );
  }

  if (!hasEvent(events, "grader.completed")) {
    events.push(
      addEvent({
        type: "grader.completed",
        summary:
          reward === undefined
            ? "Imported Harbor verifier result without a reward metric."
            : `Imported Harbor verifier reward ${reward}.`,
      }),
    );
  }

  if (!hasEvent(events, "trial.completed")) {
    events.push(
      addEvent({
        type: "trial.completed",
        ...(duration === undefined ? {} : { latencyMs: duration * 1000 }),
        summary: "Completed Harbor result import for trial.",
      }),
    );
  }

  return Object.freeze({
    candidateId: "generic-ai",
    harnessId: "harbor-installed-agent",
    trialId,
    metrics: extractMetrics(resultJson, artifactRefs),
    traceEvents: Object.freeze(events.sort((left, right) => left.sequence - right.sequence)),
    artifacts: Object.freeze(artifacts),
    diagnostics: traceDiagnostics(events, artifacts.length),
  });
}

function projectionCounts(
  projections: readonly AgentHarnessEventProjection[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const projection of projections) {
    counts.set(projection.type, (counts.get(projection.type) ?? 0) + 1);
  }

  return counts;
}

function renderHarnessProjectionsMarkdown(
  rows: readonly {
    readonly trialId: string;
    readonly projections: readonly AgentHarnessEventProjection[];
  }[],
): string {
  const lines = ["# Terminal-Bench Harness Projections", ""];

  if (rows.length === 0) {
    lines.push("No Harbor-collected Generic AI harness projections were found.", "");
    return lines.join("\n");
  }

  lines.push("| Trial | Projection type | Count |", "| --- | --- | --- |");
  for (const row of rows) {
    const counts = projectionCounts(row.projections);
    if (counts.size === 0) {
      lines.push(`| ${row.trialId} | none | 0 |`);
      continue;
    }

    for (const [type, count] of [...counts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      lines.push(`| ${row.trialId} | ${type} | ${count} |`);
    }
  }

  lines.push("", "## Timeline", "");
  for (const row of rows) {
    lines.push(`### ${row.trialId}`, "");
    if (row.projections.length === 0) {
      lines.push("- No projections found.", "");
      continue;
    }

    for (const projection of row.projections) {
      const role = projection.roleId === undefined ? "" : ` role=${projection.roleId}`;
      const tool = projection.toolName === undefined ? "" : ` tool=${projection.toolName}`;
      lines.push(
        `- ${projection.occurredAt} ${projection.type}${role}${tool}: ${projection.summary}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function createMission(): MissionSpec {
  return Object.freeze({
    kind: "generic-ai.mission",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: "terminal-bench.harbor",
    objective: "Run Generic AI as a Harbor installed agent against Terminal-Bench tasks.",
    objectiveClass: "coding",
    constraints: Object.freeze([
      "Harbor owns task orchestration and the task container boundary.",
      "Generic AI imports Harbor artifacts into SDK benchmark reports after the run.",
      "Nested Generic AI Docker sandboxing is disabled by default.",
    ]),
    providerPolicy: Object.freeze({
      adapter: "openai-codex",
      model: "gpt-5.5",
      network: "open",
      cache: "allow",
    }),
  });
}

function createBenchmark(input: {
  readonly jobName: string;
  readonly trialCount: number;
}): BenchmarkSpec {
  const gate = validationGateKind(input.jobName);
  const requiresValidationCompleteness = gate === "validation" || gate === "full";
  const metricDefinitions: NonNullable<BenchmarkSpec["metricDefinitions"]> = Object.freeze([
    {
      id: "reward",
      name: "Verifier reward",
      unit: "ratio",
      direction: "higher_is_better",
      source: "grader",
      description: "Reward reported by Harbor verifier output.",
    },
    {
      id: "success",
      name: "Success",
      unit: "boolean",
      direction: "higher_is_better",
      source: "grader",
    },
    {
      id: "duration_sec",
      name: "Duration",
      unit: "seconds",
      direction: "lower_is_better",
      source: "runtime",
    },
    {
      id: "cost_usd",
      name: "Cost",
      unit: "usd",
      direction: "lower_is_better",
      source: "runtime",
    },
  ]);

  return Object.freeze({
    kind: "generic-ai.benchmark",
    schemaVersion: HARNESS_SCHEMA_VERSION,
    id: `terminal-bench.harbor.${input.jobName}`,
    missionRef: "terminal-bench.harbor",
    hypothesis:
      "Harbor trial evidence can be normalized into Generic AI benchmark reports without promoting benchmark-specific code into public packages.",
    candidates: Object.freeze([
      Object.freeze({
        id: "generic-ai",
        harnessRef: "harbor-installed-agent",
        label: "Generic AI Harbor installed agent",
      }),
    ]),
    primaryMetric: "reward",
    metricDefinitions,
    guardrailMetrics: Object.freeze(["success", "duration_sec", "cost_usd"]),
    trials: Object.freeze({
      count: Math.max(input.trialCount, 1),
      pairing: "independent",
    }),
    validity: Object.freeze({
      minimumTrialsForRecommendation: 5,
      requireTraceCompleteness: requiresValidationCompleteness,
      allowSingleRunRecommendation: false,
    }),
    report: Object.freeze({
      formats: Object.freeze(["json", "markdown"] as const),
      includeRecommendations: true,
    }),
  });
}

function validationLimitations(input: {
  readonly gate: ValidationGateKind;
  readonly trialCount: number;
  readonly minimumTrials: number;
  readonly pinnedTaskSet: ValidationTaskPinning;
  readonly requireTraceCompleteness: boolean;
  readonly traceCompleteness: TraceCompletenessSummary;
}): readonly string[] {
  const limitations: string[] = [];
  if (input.gate !== "validation" && input.gate !== "full") {
    limitations.push(
      "This profile is a smoke signal, not a recommendation-quality Terminal-Bench validation gate.",
    );
  }

  if (input.trialCount < input.minimumTrials) {
    limitations.push(
      `Only ${input.trialCount} trial(s) were imported; ${input.minimumTrials} are required before recommendations.`,
    );
  }

  if (input.pinnedTaskSet.status !== "pinned") {
    limitations.push("The Harbor config did not expose an explicit pinned task_names set.");
  }

  if (input.requireTraceCompleteness && input.traceCompleteness.completeTrials < input.trialCount) {
    limitations.push("One or more imported trials are missing required trace event types.");
  }

  return Object.freeze(limitations);
}

function validationNextActions(input: {
  readonly limitations: readonly string[];
  readonly flakeSignals: readonly ValidationFlakeSignal[];
}): readonly string[] {
  const nextActions: string[] = [];
  if (input.flakeSignals.length > 0) {
    nextActions.push("Rerun tasks with mixed pass/fail evidence before reporting a stable delta.");
  }

  if (input.limitations.some((limitation) => limitation.includes("pinned task_names"))) {
    nextActions.push("Run the validation profile with explicit dataset.task_names.");
  }

  if (input.limitations.some((limitation) => limitation.includes("trial"))) {
    nextActions.push("Import at least five validation trials for the same configuration.");
  }

  if (input.limitations.some((limitation) => limitation.includes("trace event"))) {
    nextActions.push("Fix trace completeness before using the report for recommendations.");
  }

  if (nextActions.length === 0) {
    nextActions.push(
      "Compare this validation report with a same-profile baseline before claiming movement.",
    );
  }

  return Object.freeze(nextActions);
}

function createValidationSummary(input: {
  readonly jobName: string;
  readonly configJson: unknown;
  readonly benchmark: BenchmarkSpec;
  readonly trialResults: readonly BenchmarkTrialResult[];
  readonly report: BenchmarkReport;
}): HarborValidationSummary {
  const gate = validationGateKind(input.jobName);
  const minimumTrials = input.benchmark.validity?.minimumTrialsForRecommendation ?? 3;
  const requireTraceCompleteness = input.benchmark.validity?.requireTraceCompleteness === true;
  const pinnedTaskSet = extractTaskPinning(input.configJson);
  const traceCompleteness = summarizeTraceCompleteness(input.trialResults);
  const signals = flakeSignals(input.trialResults);
  const limitations = validationLimitations({
    gate,
    trialCount: input.trialResults.length,
    minimumTrials,
    pinnedTaskSet,
    requireTraceCompleteness,
    traceCompleteness,
  });
  const nextActions = validationNextActions({ limitations, flakeSignals: signals });

  return Object.freeze({
    kind: "generic-ai.terminal-bench-validation-summary",
    jobName: input.jobName,
    gate,
    trialCount: input.trialResults.length,
    thresholds: Object.freeze({
      minimumTrialsForRecommendation: minimumTrials,
      requireTraceCompleteness,
    }),
    pinnedTaskSet,
    reward: summarizeMetric(metricValues(input.trialResults, "reward")),
    success: summarizeMetric(metricValues(input.trialResults, "success")),
    traceCompleteness,
    flakeSignals: signals,
    insufficientEvidenceReasons: Object.freeze([...input.report.insufficientEvidence]),
    recommendationQuality:
      input.report.insufficientEvidence.length === 0 ? "sufficient" : "insufficient",
    limitations,
    nextActions,
  });
}

function formatMetricSummary(summary: MetricDistributionSummary): string {
  const mean = summary.mean === undefined ? "missing" : String(summary.mean);
  const standardDeviation =
    summary.standardDeviation === undefined ? "n/a" : String(summary.standardDeviation);
  const distribution = Object.entries(summary.distribution)
    .map(([value, count]) => `${value}: ${count}`)
    .join(", ");
  return `samples=${summary.samples}; mean=${mean}; standardDeviation=${standardDeviation}; distribution=${distribution || "empty"}`;
}

function renderValidationSummaryMarkdown(summary: HarborValidationSummary): string {
  const pinned =
    summary.pinnedTaskSet.taskNames.length > 0
      ? summary.pinnedTaskSet.taskNames.join(", ")
      : `${summary.pinnedTaskSet.status}${
          summary.pinnedTaskSet.declaredTaskCount === undefined
            ? ""
            : ` (${summary.pinnedTaskSet.declaredTaskCount} sampled task(s))`
        }`;
  const lines = [
    "## Terminal-Bench Validation Gate",
    "",
    `- Gate: ${summary.gate}`,
    `- Trial count: ${summary.trialCount}`,
    `- Minimum trials for recommendation: ${summary.thresholds.minimumTrialsForRecommendation}`,
    `- Require trace completeness: ${summary.thresholds.requireTraceCompleteness}`,
    `- Pinned task set: ${pinned}`,
    `- Reward distribution: ${formatMetricSummary(summary.reward)}`,
    `- Success distribution: ${formatMetricSummary(summary.success)}`,
    `- Trace completeness: samples=${summary.traceCompleteness.samples}; average=${summary.traceCompleteness.average}; min=${summary.traceCompleteness.min}; completeTrials=${summary.traceCompleteness.completeTrials}`,
    `- Recommendation quality: ${summary.recommendationQuality}`,
    "",
  ];

  if (summary.flakeSignals.length > 0) {
    lines.push(
      "### Flake Rerun Signals",
      "",
      ...summary.flakeSignals.map((signal) => `- ${signal.taskId}: ${signal.reason}`),
      "",
    );
  }

  if (summary.insufficientEvidenceReasons.length > 0) {
    lines.push(
      "### Insufficient Evidence Reasons",
      "",
      ...summary.insufficientEvidenceReasons.map((reason) => `- ${reason}`),
      "",
    );
  }

  if (summary.limitations.length > 0) {
    lines.push("### Limitations", "", ...summary.limitations.map((item) => `- ${item}`), "");
  }

  lines.push("### Next Actions", "", ...summary.nextActions.map((item) => `- ${item}`), "");

  return `${lines.join("\n")}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function metricValue(
  trial: BenchmarkTrialResult,
  metricId: string,
): number | undefined {
  return trial.metrics.find((metric) => metric.metricId === metricId)?.value;
}

function createSmokeArtifactProof(input: {
  readonly jobDir: string;
  readonly generatedAt: string;
  readonly trialResults: readonly BenchmarkTrialResult[];
}): SmokeArtifactProof {
  const trials = input.trialResults.map((trial) => {
    const artifactByUri = new Map(trial.artifacts.map((artifact) => [artifact.uri, artifact]));
    const requiredArtifacts = REQUIRED_SMOKE_ARTIFACTS.map((name) => {
      const uri = `${trial.trialId}/artifacts/generic-ai/${name}`;
      const artifact = artifactByUri.get(uri);
      return Object.freeze({
        path: uri,
        present: artifact !== undefined,
        ...(artifact === undefined ? {} : { artifactId: artifact.id }),
      });
    });
    const harnessArtifactRefs = trial.artifacts
      .filter((artifact) => artifact.uri.startsWith(`${trial.trialId}/artifacts/generic-ai/harness/`))
      .map((artifact) => artifact.id);
    const reward = metricValue(trial, "reward");
    const success = metricValue(trial, "success");

    return Object.freeze({
      trialId: trial.trialId,
      complete:
        requiredArtifacts.every((artifact) => artifact.present) && harnessArtifactRefs.length > 0,
      requiredArtifacts: Object.freeze(requiredArtifacts),
      harnessArtifactRefs: Object.freeze(harnessArtifactRefs),
      traceEventCount: trial.traceEvents.length,
      traceCompleteness: trial.diagnostics.completeness,
      ...(reward === undefined ? {} : { reward }),
      ...(success === undefined ? {} : { success }),
    });
  });

  return Object.freeze({
    kind: "generic-ai.terminal-bench-smoke-artifact-proof",
    jobDir: input.jobDir,
    generatedAt: input.generatedAt,
    requiredArtifacts: REQUIRED_SMOKE_ARTIFACTS,
    completeTrialCount: trials.filter((trial) => trial.complete).length,
    trialCount: trials.length,
    trials: Object.freeze(trials),
    decisionBoundary:
      "Smoke proof records live artifact completeness only; reward and success are smoke evidence, not validation-quality or SOTA claims.",
  });
}

function renderSmokeArtifactProofMarkdown(proof: SmokeArtifactProof): string {
  const lines = [
    "# Terminal-Bench Smoke Artifact Proof",
    "",
    `Job directory: \`${proof.jobDir}\``,
    `Generated at: \`${proof.generatedAt}\``,
    "",
    `Complete trials: ${proof.completeTrialCount}/${proof.trialCount}`,
    "",
    proof.decisionBoundary,
    "",
    "| Trial | Complete | Reward | Success | Trace events | Trace completeness | Harness refs | Missing required artifacts |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];

  for (const trial of proof.trials) {
    const missing = trial.requiredArtifacts
      .filter((artifact) => !artifact.present)
      .map((artifact) => basename(artifact.path));
    lines.push(
      [
        `\`${trial.trialId}\``,
        trial.complete ? "yes" : "no",
        trial.reward ?? "n/a",
        trial.success ?? "n/a",
        trial.traceEventCount,
        trial.traceCompleteness.toFixed(2),
        trial.harnessArtifactRefs.length,
        missing.length === 0 ? "none" : missing.join(", "),
      ].join(" | "),
    );
  }

  lines.push("");
  return lines.join("\n");
}

function readJobNameFromConfig(config: unknown, fallback: string): string {
  if (isRecord(config) && typeof config["job_name"] === "string") {
    return config["job_name"];
  }

  return fallback;
}

export async function importHarborResults(
  options: HarborImportOptions,
): Promise<HarborImportResult> {
  const jobDir = resolve(options.jobDir);
  const configJson = await readJsonIfExists(join(jobDir, "config.json"));
  const jobName = readJobNameFromConfig(configJson, basename(jobDir));
  const outputDir = resolve(options.outputDir ?? join(DEFAULT_REPORTS_ROOT, jobName));
  const timestamp = options.now?.() ?? new Date().toISOString();
  const runId = `harbor:${createStableFingerprint(jobDir).slice(0, 12)}`;
  const trialDirs = await listTrialDirs(jobDir);
  const trialResults = await Promise.all(
    trialDirs.map((trialDir) => importTrial({ jobDir, trialDir, runId, timestamp })),
  );
  const harnessProjectionRows = await Promise.all(
    trialDirs.map(async (trialDir) =>
      Object.freeze({
        trialId: basename(trialDir),
        projections: await loadHarnessProjections(trialDir),
      }),
    ),
  );
  const mission = createMission();
  const benchmark = createBenchmark({
    jobName,
    trialCount: trialResults.length,
  });
  const report = createBenchmarkReport({
    benchmark,
    mission,
    generatedAt: timestamp,
    results: trialResults,
  });
  const trialTranscripts = trialResults.map((trialResult) =>
    createCommandTranscriptFromTraceEvents({
      runId,
      trialId: trialResult.trialId,
      generatedAt: timestamp,
      events: trialResult.traceEvents,
    }),
  );
  const smokeArtifactProof = createSmokeArtifactProof({
    jobDir,
    generatedAt: timestamp,
    trialResults,
  });
  const validation = createValidationSummary({
    jobName,
    configJson,
    benchmark,
    trialResults,
    report,
  });

  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, "mission.json"), mission);
  await writeJson(join(outputDir, "benchmark.json"), benchmark);
  await writeJson(join(outputDir, "trial-results.json"), trialResults);
  await writeJson(join(outputDir, "trial-harness-projections.json"), harnessProjectionRows);
  await writeFile(
    join(outputDir, "trial-harness-projections.md"),
    renderHarnessProjectionsMarkdown(harnessProjectionRows),
    "utf-8",
  );
  await writeJson(join(outputDir, "trial-command-transcripts.json"), trialTranscripts);
  await writeFile(
    join(outputDir, "trial-command-transcripts.md"),
    renderCommandTranscriptsMarkdown(trialTranscripts),
    "utf-8",
  );
  await writeJson(join(outputDir, "benchmark-report.json"), report);
  await writeJson(join(outputDir, "validation-summary.json"), validation);
  await writeFile(
    join(outputDir, "benchmark-report.md"),
    `${renderBenchmarkReportMarkdown(report)}${renderValidationSummaryMarkdown(validation)}`,
  );
  await writeJson(join(outputDir, "smoke-artifact-proof.json"), smokeArtifactProof);
  await writeFile(
    join(outputDir, "smoke-artifact-proof.md"),
    renderSmokeArtifactProofMarkdown(smokeArtifactProof),
  );

  return Object.freeze({
    jobDir,
    outputDir,
    mission,
    benchmark,
    trialResults: Object.freeze(trialResults),
    trialTranscripts: Object.freeze(trialTranscripts),
    smokeArtifactProof,
    report,
    validation,
  });
}

function usage(): string {
  return [
    "Usage: generic-ai-import-harbor-results --job-dir <path> [--output-dir <path>]",
    "",
    "Reads Harbor job/trial artifacts and writes Generic AI benchmark report files.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): HarborImportOptions {
  const options: {
    jobDir?: string;
    outputDir?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
        break;
      case "--job-dir":
        if (next === undefined) {
          throw new Error("--job-dir requires a value.");
        }
        options.jobDir = next;
        index += 1;
        break;
      case "--output-dir":
        if (next === undefined) {
          throw new Error("--output-dir requires a value.");
        }
        options.outputDir = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.jobDir === undefined) {
    throw new Error("Provide --job-dir.");
  }

  return {
    jobDir: options.jobDir,
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
  };
}

export function reportRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  importHarborResults(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(`Wrote Generic AI benchmark report to ${result.outputDir}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
