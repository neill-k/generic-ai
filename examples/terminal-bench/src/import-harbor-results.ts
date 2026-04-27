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
  readonly report: BenchmarkReport;
}

type JsonRecord = Record<string, unknown>;

const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_REPORTS_ROOT = resolve(EXAMPLE_ROOT, "reports", "imported");

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
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function collectFileArtifacts(root: string, baseUri: string): Promise<readonly ArtifactReference[]> {
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

function extractMetrics(resultJson: unknown, artifactRefs: readonly string[]): readonly MetricValue[] {
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
  const addEvent = eventFactory({
    runId: input.runId,
    trialId,
    startSequence: loadedEvents.reduce((max, event) => Math.max(max, event.sequence), 0),
    timestamp: input.timestamp,
  });
  const events: TraceEvent[] = [...loadedEvents];
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
      requireTraceCompleteness: false,
      allowSingleRunRecommendation: false,
    }),
    report: Object.freeze({
      formats: Object.freeze(["json", "markdown"] as const),
      includeRecommendations: true,
    }),
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJobName(jobDir: string): Promise<string> {
  const config = await readJsonIfExists(join(jobDir, "config.json"));
  if (isRecord(config) && typeof config["job_name"] === "string") {
    return config["job_name"];
  }

  return basename(jobDir);
}

export async function importHarborResults(
  options: HarborImportOptions,
): Promise<HarborImportResult> {
  const jobDir = resolve(options.jobDir);
  const jobName = await readJobName(jobDir);
  const outputDir = resolve(options.outputDir ?? join(DEFAULT_REPORTS_ROOT, jobName));
  const timestamp = options.now?.() ?? new Date().toISOString();
  const runId = `harbor:${createStableFingerprint(jobDir).slice(0, 12)}`;
  const trialDirs = await listTrialDirs(jobDir);
  const trialResults = await Promise.all(
    trialDirs.map((trialDir) => importTrial({ jobDir, trialDir, runId, timestamp })),
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

  await mkdir(outputDir, { recursive: true });
  await writeJson(join(outputDir, "mission.json"), mission);
  await writeJson(join(outputDir, "benchmark.json"), benchmark);
  await writeJson(join(outputDir, "trial-results.json"), trialResults);
  await writeJson(join(outputDir, "benchmark-report.json"), report);
  await writeFile(join(outputDir, "benchmark-report.md"), renderBenchmarkReportMarkdown(report));

  return Object.freeze({
    jobDir,
    outputDir,
    mission,
    benchmark,
    trialResults: Object.freeze(trialResults),
    report,
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
