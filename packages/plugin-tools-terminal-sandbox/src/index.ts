import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  helpers,
  mergeSandboxPolicy,
  parseSandboxPolicy,
  SANDBOX_POLICY_SCHEMA,
  type ConfigSchemaContract,
  type SandboxFileIOMode,
  type PluginContract,
  type SandboxArtifact,
  type SandboxContract,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxExecutionStatus,
  type SandboxOutputListener,
  type SandboxPolicy,
  type SandboxRuntime,
  type SandboxRuntimeConfig,
  type SandboxSession,
  type SandboxSessionRequest,
} from "@generic-ai/sdk";
import {
  createWorkspaceLayout,
  resolveWorkspacePath,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

export const name = "@generic-ai/plugin-tools-terminal-sandbox" as const;
export const kind = "tools-terminal-sandbox" as const;

export const SANDBOX_WORKSPACE_MOUNT_PATH = "/workspace";
export const SANDBOX_OUTPUT_MOUNT_PATH = "/workspace-output";
export const SANDBOX_OUTPUT_ENV_VAR = "GENERIC_AI_SANDBOX_OUTPUT_DIR";
export const SANDBOX_DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const SANDBOX_SNAPSHOT_EXCLUDED_TOP_LEVEL_NAMES = Object.freeze([".git", "node_modules"]);
export const SANDBOX_ALLOWLIST_PROXY_IMAGE = "node:24-bookworm-slim";
export const SANDBOX_KEEPALIVE_COMMAND = Object.freeze([
  "sh",
  "-lc",
  "trap 'exit 0' TERM INT; while :; do sleep 1; done",
]);
export const SANDBOX_ALLOWLIST_PROXY_ALIAS = "sandbox-egress-proxy";
export const SANDBOX_ALLOWLIST_PROXY_PORT = 3128;
export const SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX = "generic-ai-sandbox";
export const SANDBOX_ALLOWLIST_PROXY_READY_TIMEOUT_MS = 5_000;
export const SANDBOX_WRITABLE_TMPFS_MB = 16;

const SANDBOX_ALLOWLIST_PROXY_MOUNT_PATH = "/generic-ai-network-proxy";
const SANDBOX_ALLOWLIST_PROXY_LOGS_MOUNT_PATH = "/generic-ai-network-logs";
const SANDBOX_ALLOWLIST_PROXY_SCRIPT_NAME = "proxy.mjs";
const SANDBOX_ALLOWLIST_PROXY_CONFIG_NAME = "config.json";
const SANDBOX_ALLOWLIST_PROXY_BLOCK_LOG_NAME = "blocked.log";
const SANDBOX_ALLOWLIST_PROXY_CONFIG_ENV_VAR = "GENERIC_AI_PROXY_CONFIG";

export const SANDBOX_DEFAULT_IMAGES = Object.freeze({
  bash: "node:24-bookworm-slim",
  node: "node:24-bookworm-slim",
  python: "python:3.12-slim",
}) satisfies Readonly<Record<SandboxRuntime, string>>;

export const SANDBOX_DEFAULT_POLICY = Object.freeze({
  resources: {
    timeoutMs: 30_000,
    timeoutGraceMs: 5_000,
    memoryMb: 512,
    cpuCores: 1,
    diskMb: 100,
  },
  network: {
    mode: "isolated",
  },
  files: {
    mode: "readonly-mount",
    maxInputBytes: SANDBOX_DEFAULT_MAX_INPUT_BYTES,
    outputDir: path.join("workspace", "shared", "sandbox-results"),
  },
} as const satisfies SandboxPolicy);

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export interface SandboxTerminalPluginConfig {
  readonly backend: "docker";
  readonly defaultRuntime: SandboxRuntime;
  readonly images: Readonly<Record<SandboxRuntime, string>>;
  readonly defaultPolicy: SandboxPolicy;
  readonly ensureImages: boolean;
}

type SandboxTerminalConfigRecord = Record<string, unknown> & {
  backend?: unknown;
  defaultPolicy?: unknown;
  defaultRuntime?: unknown;
  ensureImages?: unknown;
  images?: unknown;
};

export interface SandboxTerminalPluginOptions {
  readonly root: WorkspaceRootInput;
  readonly config?: Partial<SandboxTerminalPluginConfig>;
  readonly dockerOperations?: SandboxDockerOperations;
  readonly sessionIdFactory?: () => string;
  readonly now?: () => number;
}

export interface SandboxRunRequest {
  readonly runtime?: SandboxRuntime;
  readonly sessionId?: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly policy?: SandboxPolicy;
  readonly runtimeConfig?: SandboxRuntimeConfig;
  readonly onOutput?: SandboxOutputListener;
  readonly signal?: AbortSignal;
}

export interface SandboxTerminalPlugin extends SandboxContract {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly config: SandboxTerminalPluginConfig;
  readonly pluginContract: PluginContract<SandboxTerminalPluginConfig>;
  readonly pluginDefinition: typeof sandboxTerminalPluginDefinition;
  run(request: SandboxRunRequest): Promise<SandboxExecutionResult>;
  listSessions(): readonly SandboxSession[];
  destroyAll(): Promise<void>;
}

export interface SandboxDockerBindMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly?: boolean;
}

export interface SandboxDockerTmpfsMount {
  readonly type: "tmpfs";
  readonly target: string;
  readonly sizeMb?: number;
}

export type SandboxDockerMount = SandboxDockerBindMount | SandboxDockerTmpfsMount;

export interface SandboxDockerCreateContainerRequest {
  readonly image: string;
  readonly sessionId: string;
  readonly mounts: readonly SandboxDockerMount[];
  readonly env?: Readonly<Record<string, string>>;
  readonly networkMode?: "none" | "bridge";
  readonly networkName?: string;
  readonly networkAliases?: readonly string[];
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly readOnlyRootfs?: boolean;
  readonly command?: readonly string[];
}

export interface SandboxDockerCreateNetworkRequest {
  readonly name: string;
  readonly internal?: boolean;
}

export interface SandboxDockerExecRequest {
  readonly containerId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly onOutput?: SandboxOutputListener;
  readonly signal?: AbortSignal;
}

export interface SandboxDockerExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxContainerUsageSnapshot {
  readonly cpuTimeMs?: number;
  readonly memoryCurrentMb?: number;
  readonly peakMemoryMb?: number;
  readonly diskWrittenMb?: number;
}

export interface SandboxContainerState {
  readonly running?: boolean;
  readonly oomKilled?: boolean;
}

export interface SandboxDockerOperations {
  isAvailable(): Promise<boolean>;
  ensureImage(image: string): Promise<void>;
  createNetwork(request: SandboxDockerCreateNetworkRequest): Promise<string>;
  connectContainerToNetwork(
    containerId: string,
    networkName: string,
    aliases?: readonly string[],
  ): Promise<void>;
  createContainer(request: SandboxDockerCreateContainerRequest): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  exec(request: SandboxDockerExecRequest): Promise<SandboxDockerExecResult>;
  stopContainer(containerId: string, graceMs?: number): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  removeNetwork(networkName: string): Promise<void>;
  copyFromContainer(
    containerId: string,
    sourcePath: string,
    destinationPath: string,
  ): Promise<void>;
  inspectContainer(containerId: string): Promise<SandboxContainerState | undefined>;
  readUsageSnapshot(containerId: string): Promise<SandboxContainerUsageSnapshot | undefined>;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

const TAR_BLOCK_SIZE = 512;
const NODE_ARTIFACT_ARCHIVE_SCRIPT = `
const fs = require("node:fs");
const posixPath = require("node:path").posix;
const root = process.argv[1];
function emit(value) {
  console.log(JSON.stringify(value));
}
function walk(absolutePath, relativePath) {
  const info = fs.lstatSync(absolutePath);
  if (info.isSymbolicLink()) {
    emit({ type: "link", path: relativePath });
    return;
  }
  if (info.isDirectory()) {
    if (relativePath.length > 0) {
      emit({ type: "dir", path: relativePath });
    }
    for (const entry of fs.readdirSync(absolutePath)) {
      walk(posixPath.join(absolutePath, entry), relativePath.length === 0 ? entry : posixPath.join(relativePath, entry));
    }
    return;
  }
  if (info.isFile()) {
    emit({ type: "file", path: relativePath, data: fs.readFileSync(absolutePath).toString("base64") });
  }
}
if (root !== undefined && fs.existsSync(root)) {
  const baseName = posixPath.basename(posixPath.normalize(root)) || "root";
  walk(root, baseName);
}
`.trim();
const PYTHON_ARTIFACT_ARCHIVE_SCRIPT = `
import base64
import json
import os
import sys
root = sys.argv[1] if len(sys.argv) > 1 else None
def emit(value):
    print(json.dumps(value, separators=(",", ":")))
def walk(absolute_path, relative_path):
    if os.path.islink(absolute_path):
        emit({"type": "link", "path": relative_path})
        return
    if os.path.isdir(absolute_path):
        if relative_path:
            emit({"type": "dir", "path": relative_path})
        for entry in os.listdir(absolute_path):
            walk(os.path.join(absolute_path, entry), entry if not relative_path else f"{relative_path}/{entry}")
        return
    if os.path.isfile(absolute_path):
        with open(absolute_path, "rb") as handle:
            data = base64.b64encode(handle.read()).decode("ascii")
        emit({"type": "file", "path": relative_path, "data": data})
if root and os.path.exists(root):
    base_name = os.path.basename(os.path.normpath(root)) or "root"
    walk(root, base_name)
`.trim();

interface ActiveSandboxSession {
  readonly session: SandboxSession;
  readonly policy: SandboxPolicy;
  readonly fileMode: SandboxFileIOMode;
  readonly workspaceMountRoot: string;
  readonly workspaceMountReadOnly: boolean;
  readonly mountsWorkspace: boolean;
  readonly copyOutPaths: readonly string[];
  readonly cleanupRoot: string;
  readonly defaultCwd: string;
  readonly defaultHostCwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly protectedEnv: Readonly<Record<string, string>>;
  readonly allowlistNetworkName?: string;
  readonly allowlistProxyContainerId?: string;
  readonly allowlistBlockedLogPath?: string;
  allowlistBlockedLogOffset: number;
}

interface UsageSummary {
  readonly startCpuTimeMs?: number;
  readonly lastCpuTimeMs?: number;
  readonly peakMemoryMb?: number;
  readonly diskWrittenMb?: number;
}

interface TruncatedOutput {
  readonly text: string;
  readonly truncated: boolean;
}

interface SizeLimitedCopyTracker {
  totalBytes: number;
}

interface AllowlistNetworkResources {
  readonly networkName: string;
  readonly proxyContainerId: string;
  readonly blockedLogPath: string;
  readonly proxyEnv: Readonly<Record<string, string>>;
}

const DEFAULT_CONFIG: SandboxTerminalPluginConfig = Object.freeze({
  backend: "docker",
  defaultRuntime: "bash",
  images: SANDBOX_DEFAULT_IMAGES,
  defaultPolicy: SANDBOX_DEFAULT_POLICY,
  ensureImages: true,
});

export class SandboxUnavailableError extends Error {
  readonly code = "sandbox-unavailable";

  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxConfigurationError extends Error {
  readonly code = "sandbox-configuration";

  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigurationError";
  }
}

export class SandboxSessionConflictError extends Error {
  readonly code = "sandbox-session-conflict";

  constructor(message: string) {
    super(message);
    this.name = "SandboxSessionConflictError";
  }
}

export class SandboxArtifactSyncError extends Error {
  readonly code = "sandbox-artifact-sync";

  constructor(message: string) {
    super(message);
    this.name = "SandboxArtifactSyncError";
  }
}

const SANDBOX_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/u;
const WINDOWS_DRIVE_LETTER_PATTERN = /^[A-Za-z]:[\\/]|^[A-Za-z]:$/u;
const WINDOWS_UNC_PATH_PATTERN = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u;

export function validateSessionId(sessionId: string): string {
  if (typeof sessionId !== "string") {
    throw new SandboxConfigurationError("Sandbox sessionId must be a string.");
  }
  if (sessionId.length === 0) {
    throw new SandboxConfigurationError("Sandbox sessionId must be non-empty.");
  }
  if (!SANDBOX_SESSION_ID_PATTERN.test(sessionId)) {
    throw new SandboxConfigurationError(
      `Sandbox sessionId "${sessionId}" must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/: start with an ASCII letter or digit, contain only letters, digits, '-', '_', and be at most 63 characters long (Docker-safe).`,
    );
  }
  return sessionId;
}

function assertRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function mergeStringRecord(
  base: Readonly<Record<string, string>> | undefined,
  next: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (base === undefined) {
    return next;
  }
  if (next === undefined) {
    return base;
  }

  return {
    ...base,
    ...next,
  };
}

function parseRuntimeImages(input: unknown): Readonly<Record<SandboxRuntime, string>> {
  if (input === undefined) {
    return SANDBOX_DEFAULT_IMAGES;
  }

  const candidate = assertRecord(input, "sandbox terminal config.images");
  const parsed: Record<SandboxRuntime, string> = { ...SANDBOX_DEFAULT_IMAGES };

  for (const runtime of Object.keys(parsed) as SandboxRuntime[]) {
    const value = candidate[runtime];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`sandbox terminal config.images.${runtime} must be a non-empty string.`);
    }
    parsed[runtime] = value;
  }

  return parsed;
}

function parseConfig(input: unknown): SandboxTerminalPluginConfig {
  if (input === undefined) {
    return DEFAULT_CONFIG;
  }

  const candidate = assertRecord(input, "sandbox terminal config") as SandboxTerminalConfigRecord;
  const backend = candidate.backend;
  if (backend !== undefined && backend !== "docker") {
    throw new Error('sandbox terminal config.backend must be "docker".');
  }

  const defaultRuntime = candidate.defaultRuntime;
  if (
    defaultRuntime !== undefined &&
    defaultRuntime !== "bash" &&
    defaultRuntime !== "node" &&
    defaultRuntime !== "python"
  ) {
    throw new Error('sandbox terminal config.defaultRuntime must be "bash", "node", or "python".');
  }

  const ensureImages = candidate.ensureImages;
  if (ensureImages !== undefined && typeof ensureImages !== "boolean") {
    throw new Error("sandbox terminal config.ensureImages must be a boolean.");
  }

  const defaultPolicy =
    candidate.defaultPolicy === undefined
      ? DEFAULT_CONFIG.defaultPolicy
      : (mergeSandboxPolicy(
          DEFAULT_CONFIG.defaultPolicy,
          parseSandboxPolicy(candidate.defaultPolicy),
        ) ?? DEFAULT_CONFIG.defaultPolicy);

  return {
    backend: "docker",
    defaultRuntime: (defaultRuntime as SandboxRuntime | undefined) ?? DEFAULT_CONFIG.defaultRuntime,
    images: parseRuntimeImages(candidate.images),
    defaultPolicy,
    ensureImages: ensureImages ?? DEFAULT_CONFIG.ensureImages,
  };
}

export const sandboxTerminalConfigSchema: ConfigSchemaContract<SandboxTerminalPluginConfig> =
  helpers.defineConfigSchema<SandboxTerminalPluginConfig>({
    kind: "config-schema",
    id: `${name}.config`,
    description: "Configuration for the Docker-backed sandbox terminal plugin.",
    schema: {
      type: "object",
      properties: {
        backend: { type: "string", enum: ["docker"] },
        defaultRuntime: { type: "string", enum: ["bash", "node", "python"] },
        images: {
          type: "object",
          properties: {
            bash: { type: "string", minLength: 1 },
            node: { type: "string", minLength: 1 },
            python: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        defaultPolicy: SANDBOX_POLICY_SCHEMA,
        ensureImages: { type: "boolean" },
      },
      additionalProperties: false,
    },
    defaults: DEFAULT_CONFIG,
    parse: parseConfig,
    merge(base: SandboxTerminalPluginConfig, next: Partial<SandboxTerminalPluginConfig>) {
      return parseConfig({
        ...base,
        ...next,
        images: {
          ...base.images,
          ...(next.images ?? {}),
        },
        defaultPolicy:
          mergeSandboxPolicy(base.defaultPolicy, next.defaultPolicy) ?? base.defaultPolicy,
      });
    },
  });

export const sandboxTerminalPluginContract = helpers.definePlugin<SandboxTerminalPluginConfig>({
  manifest: {
    kind: "plugin",
    id: name,
    name: "@generic-ai/plugin-tools-terminal-sandbox",
    description: "Docker-backed sandbox terminal execution.",
    dependencies: [{ id: "@generic-ai/plugin-workspace-fs" }],
    tags: ["sandbox", "terminal", "docker"],
  },
  configSchema: sandboxTerminalConfigSchema,
  lifecycle: helpers.defineLifecycle({
    async start() {
      return;
    },
    async stop() {
      return;
    },
  }),
});

export const sandboxTerminalPluginDefinition = Object.freeze({
  manifest: {
    id: name,
    description: "Docker-backed sandbox terminal execution.",
    dependencies: ["@generic-ai/plugin-workspace-fs"],
  },
});

function formatCombinedOutput(stdout: string, stderr: string): string {
  if (stdout.length === 0) {
    return stderr;
  }
  if (stderr.length === 0) {
    return stdout;
  }
  return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}\n${stderr}`;
}

function resolveStatus(
  result: SandboxDockerExecResult,
  timedOut: boolean,
  unavailable: boolean,
  oomKilled: boolean,
): SandboxExecutionStatus {
  if (unavailable) {
    return "unavailable";
  }
  if (timedOut) {
    return "timed_out";
  }
  if (oomKilled) {
    return "oom";
  }
  if (result.exitCode === 0) {
    return "succeeded";
  }
  const stderr = result.stderr.toLowerCase();
  if (stderr.includes("out of memory") || /(^|\W)oom($|\W)/u.test(stderr)) {
    return "oom";
  }
  if (result.exitCode === null) {
    return "signaled";
  }
  return "failed";
}

function toDockerStopSeconds(graceMs: number | undefined): string {
  if (graceMs === undefined) {
    return "0";
  }

  if (graceMs <= 0) {
    return "0";
  }

  return String(Math.max(1, Math.ceil(graceMs / 1000)));
}

function parseOptionalMetric(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseUsageSnapshot(output: string): SandboxContainerUsageSnapshot | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    values.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const cpuTimeMs = parseOptionalMetric(values.get("cpuTimeMs"));
  const memoryCurrentMb = parseOptionalMetric(values.get("memoryCurrentMb"));
  const peakMemoryMb = parseOptionalMetric(values.get("peakMemoryMb"));
  const diskWrittenMb = parseOptionalMetric(values.get("diskWrittenMb"));
  if (
    cpuTimeMs === undefined &&
    memoryCurrentMb === undefined &&
    peakMemoryMb === undefined &&
    diskWrittenMb === undefined
  ) {
    return undefined;
  }

  return {
    ...(cpuTimeMs === undefined ? {} : { cpuTimeMs }),
    ...(memoryCurrentMb === undefined ? {} : { memoryCurrentMb }),
    ...(peakMemoryMb === undefined ? {} : { peakMemoryMb }),
    ...(diskWrittenMb === undefined ? {} : { diskWrittenMb }),
  };
}

function parseContainerState(output: string): SandboxContainerState | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let candidate: {
    OOMKilled?: unknown;
    Running?: unknown;
  };
  try {
    candidate = JSON.parse(trimmed) as typeof candidate;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxUnavailableError(
      `Docker inspect returned invalid container state JSON: ${message}`,
    );
  }
  return {
    ...(typeof candidate.Running === "boolean" ? { running: candidate.Running } : {}),
    ...(typeof candidate.OOMKilled === "boolean" ? { oomKilled: candidate.OOMKilled } : {}),
  };
}

async function safeReadUsageSnapshot(
  docker: SandboxDockerOperations,
  containerId: string,
): Promise<SandboxContainerUsageSnapshot | undefined> {
  try {
    return await docker.readUsageSnapshot(containerId);
  } catch {
    return undefined;
  }
}

function summarizeUsage(
  snapshots: readonly SandboxContainerUsageSnapshot[],
): UsageSummary | undefined {
  if (snapshots.length === 0) {
    return undefined;
  }

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const peakMemoryMb = snapshots.reduce<number | undefined>((peak, snapshot) => {
    const value = snapshot.peakMemoryMb ?? snapshot.memoryCurrentMb;
    if (value === undefined) {
      return peak;
    }
    return peak === undefined ? value : Math.max(peak, value);
  }, undefined);
  const diskWrittenMb = snapshots.reduce<number | undefined>((peak, snapshot) => {
    const value = snapshot.diskWrittenMb;
    if (value === undefined) {
      return peak;
    }
    return peak === undefined ? value : Math.max(peak, value);
  }, undefined);

  return {
    ...(first?.cpuTimeMs === undefined ? {} : { startCpuTimeMs: first.cpuTimeMs }),
    ...(last?.cpuTimeMs === undefined ? {} : { lastCpuTimeMs: last.cpuTimeMs }),
    ...(peakMemoryMb === undefined ? {} : { peakMemoryMb }),
    ...(diskWrittenMb === undefined ? {} : { diskWrittenMb }),
  };
}

function buildResourceUsage(
  usage: UsageSummary | undefined,
  durationMs: number,
): NonNullable<SandboxExecutionResult["resourceUsage"]> {
  const cpuTimeMs =
    usage?.lastCpuTimeMs !== undefined
      ? usage.startCpuTimeMs === undefined
        ? usage.lastCpuTimeMs
        : Math.max(0, usage.lastCpuTimeMs - usage.startCpuTimeMs)
      : undefined;

  return {
    wallClockMs: durationMs,
    ...(cpuTimeMs === undefined ? {} : { cpuTimeMs }),
    ...(usage?.peakMemoryMb === undefined
      ? {}
      : {
          peakMemoryMb: usage.peakMemoryMb,
          // Deprecated alias populated for backward compatibility; see
          // SandboxResourceUsage.maxMemoryMb JSDoc in @generic-ai/sdk.
          maxMemoryMb: usage.peakMemoryMb,
        }),
    ...(usage?.diskWrittenMb === undefined ? {} : { diskWrittenMb: usage.diskWrittenMb }),
  };
}

function decorateExecutionStderr(
  stderr: string,
  options: {
    readonly timedOut: boolean;
    readonly timeoutMs: number | undefined;
    readonly timeoutGraceMs: number | undefined;
    readonly oomKilled: boolean;
    readonly memoryMb: number | undefined;
    readonly diskMb: number | undefined;
    readonly diskWrittenMb: number | undefined;
    readonly diskExceeded: boolean;
  },
): string {
  const messages: string[] = [];
  const trimmed = stderr.trim();
  if (trimmed.length > 0) {
    messages.push(trimmed);
  }

  if (options.timedOut) {
    const timeoutLabel =
      options.timeoutMs === undefined
        ? "Sandbox timed out."
        : `Sandbox timed out after ${options.timeoutMs}ms.`;
    const graceLabel =
      options.timeoutGraceMs === undefined
        ? "The container was terminated."
        : `A SIGTERM grace period of ${options.timeoutGraceMs}ms was applied before SIGKILL.`;
    messages.push(`${timeoutLabel} ${graceLabel}`);
  } else if (options.oomKilled) {
    const limitLabel =
      options.memoryMb === undefined
        ? "Sandbox exceeded its memory limit."
        : `Sandbox exceeded its ${options.memoryMb}MiB memory limit.`;
    messages.push(`${limitLabel} Reduce memory use or raise sandbox policy.resources.memoryMb.`);
  } else if (options.diskExceeded) {
    const limitLabel =
      options.diskMb === undefined
        ? "Sandbox exceeded its disk limit."
        : `Sandbox exceeded its ${options.diskMb}MiB disk limit.`;
    const usageLabel =
      options.diskWrittenMb === undefined
        ? ""
        : ` Measured output usage was ${options.diskWrittenMb}MiB.`;
    messages.push(
      `${limitLabel}${usageLabel} No space left in sandbox output directory; reduce generated artifacts or raise sandbox policy.resources.diskMb.`,
    );
  }

  return messages.join(trimmed.length > 0 ? "\n" : "");
}

function truncateOutput(text: string, maxOutputBytes: number | undefined): TruncatedOutput {
  if (maxOutputBytes === undefined) {
    return {
      text,
      truncated: false,
    };
  }

  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxOutputBytes) {
    return {
      text,
      truncated: false,
    };
  }

  let boundary = Math.min(maxOutputBytes, encoded.length);
  while (boundary > 0 && boundary < encoded.length) {
    const byte = encoded[boundary];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    boundary -= 1;
  }

  return {
    text: encoded.subarray(0, boundary).toString("utf8"),
    truncated: true,
  };
}

interface RunProcessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly timeoutKillGraceMs?: number;
}

async function runProcess(
  command: string,
  args: readonly string[],
  signalOrOptions?: AbortSignal | RunProcessOptions,
): Promise<ProcessResult> {
  const options: RunProcessOptions =
    signalOrOptions === undefined
      ? {}
      : signalOrOptions instanceof AbortSignal
        ? { signal: signalOrOptions }
        : signalOrOptions;
  const signal = options.signal;
  const timeoutMs = options.timeoutMs;
  const timeoutKillGraceMs = options.timeoutKillGraceMs ?? 500;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (spawnError) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        error: spawnError instanceof Error ? spawnError : new Error(String(spawnError)),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let capturedError: Error | undefined;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        ...(capturedError === undefined ? {} : { error: capturedError }),
      });
    };

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch (killError) {
          capturedError = killError instanceof Error ? killError : new Error(String(killError));
        }

        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore — process may already be gone
          }
          finish(null);
        }, timeoutKillGraceMs);
      }, timeoutMs);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      capturedError = error;
      // If the error fires before/without a close event (e.g. ENOENT), resolve now.
      // When a close follows, the settled guard prevents a double-resolve.
      finish(null);
    });
    child.once("close", (exitCode) => {
      finish(exitCode);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function buildBase64TarArchiveCommand(sourcePath: string): string {
  const quotedSourcePath = shellQuote(sourcePath);
  return [
    `if [ -d ${quotedSourcePath} ]; then`,
    `tar -C "$(dirname ${quotedSourcePath})" -cf - "$(basename ${quotedSourcePath})" | base64`,
    `elif [ -e ${quotedSourcePath} ]; then`,
    `tar -C "$(dirname ${quotedSourcePath})" -cf - "$(basename ${quotedSourcePath})" | base64`,
    "fi",
  ].join(" ");
}

function readTarString(input: Buffer): string {
  const nullIndex = input.indexOf(0);
  return input.subarray(0, nullIndex === -1 ? input.length : nullIndex).toString("utf8");
}

function isTarZeroBlock(input: Buffer): boolean {
  return input.every((value) => value === 0);
}

function readTarOctal(input: Buffer): number {
  const raw = readTarString(input).trim();
  if (raw.length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed)) {
    throw new SandboxArtifactSyncError(`Docker produced an invalid tar archive size "${raw}".`);
  }
  return parsed;
}

function parsePaxAttributes(input: Buffer): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  let offset = 0;
  while (offset < input.length) {
    const spaceIndex = input.indexOf(32, offset);
    if (spaceIndex === -1) {
      break;
    }
    const lengthText = input.subarray(offset, spaceIndex).toString("utf8");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > input.length) {
      break;
    }
    const record = input
      .subarray(spaceIndex + 1, offset + length)
      .toString("utf8")
      .trimEnd();
    const separatorIndex = record.indexOf("=");
    if (separatorIndex > 0) {
      attributes[record.slice(0, separatorIndex)] = record.slice(separatorIndex + 1);
    }
    offset += length;
  }
  return attributes;
}

function resolveTarEntryPath(destinationRoot: string, entryName: string): string | undefined {
  const strippedName = entryName.replace(/^\.\/+/u, "");
  const normalizedName = path.posix.normalize(strippedName);
  if (normalizedName === ".") {
    return undefined;
  }
  if (
    path.posix.isAbsolute(entryName) ||
    normalizedName === ".." ||
    normalizedName.startsWith("../") ||
    WINDOWS_DRIVE_LETTER_PATTERN.test(normalizedName)
  ) {
    throw new SandboxArtifactSyncError(
      `Docker produced an unsafe sandbox artifact path "${entryName}".`,
    );
  }

  const resolvedRoot = path.resolve(destinationRoot);
  const resolvedPath = path.resolve(resolvedRoot, ...normalizedName.split("/"));
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SandboxArtifactSyncError(
      `Docker produced a sandbox artifact path outside the destination: "${entryName}".`,
    );
  }
  return resolvedPath;
}

async function extractJsonArtifactArchiveToDirectory(
  archive: string,
  destinationRoot: string,
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  for (const line of archive.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }

    const entry = JSON.parse(trimmedLine) as {
      readonly data?: unknown;
      readonly path?: unknown;
      readonly type?: unknown;
    };
    if (typeof entry.path !== "string" || typeof entry.type !== "string") {
      throw new SandboxArtifactSyncError("Docker produced an invalid sandbox artifact record.");
    }

    const destinationPath = resolveTarEntryPath(destinationRoot, entry.path);
    if (destinationPath === undefined) {
      continue;
    }

    if (entry.type === "dir") {
      await mkdir(destinationPath, { recursive: true });
    } else if (entry.type === "file") {
      if (typeof entry.data !== "string") {
        throw new SandboxArtifactSyncError("Docker produced a file artifact without data.");
      }
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await writeFile(destinationPath, Buffer.from(entry.data, "base64"));
    } else if (entry.type === "link") {
      throw new SandboxConfigurationError(
        `Refusing to copy link "${entry.path}" out of the sandbox output archive.`,
      );
    } else {
      throw new SandboxArtifactSyncError(
        `Docker produced an unsupported sandbox artifact record type "${entry.type}".`,
      );
    }
  }
}

async function extractTarArchiveToDirectory(
  archive: Buffer,
  destinationRoot: string,
): Promise<void> {
  await mkdir(destinationRoot, { recursive: true });
  let offset = 0;
  let pendingPath: string | undefined;

  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isTarZeroBlock(header)) {
      return;
    }

    const size = readTarOctal(header.subarray(124, 136));
    const typeFlagByte = header[156];
    const typeFlag =
      typeFlagByte === undefined || typeFlagByte === 0 ? "0" : String.fromCharCode(typeFlagByte);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new SandboxArtifactSyncError("Docker produced a truncated sandbox artifact archive.");
    }
    const data = archive.subarray(dataStart, dataEnd);
    const nextOffset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeFlag === "L") {
      pendingPath = readTarString(data);
      offset = nextOffset;
      continue;
    }

    if (typeFlag === "x") {
      const paxPath = parsePaxAttributes(data)["path"];
      if (paxPath !== undefined) {
        pendingPath = paxPath;
      }
      offset = nextOffset;
      continue;
    }

    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const entryName = pendingPath ?? (prefix.length === 0 ? name : `${prefix}/${name}`);
    pendingPath = undefined;
    const destinationPath = resolveTarEntryPath(destinationRoot, entryName);

    if (destinationPath !== undefined) {
      if (typeFlag === "5") {
        await mkdir(destinationPath, { recursive: true });
      } else if (typeFlag === "0" || typeFlag === "") {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, data);
      } else if (typeFlag === "1" || typeFlag === "2") {
        throw new SandboxConfigurationError(
          `Refusing to copy link "${entryName}" out of the sandbox output archive.`,
        );
      }
    }

    offset = nextOffset;
  }

  throw new SandboxArtifactSyncError("Docker produced an unterminated sandbox artifact archive.");
}

async function extractBase64TarArchiveToDirectory(
  encodedArchive: string,
  destinationRoot: string,
): Promise<void> {
  const normalizedArchive = encodedArchive.replace(/\s+/gu, "");
  if (normalizedArchive.length === 0) {
    return;
  }

  await extractTarArchiveToDirectory(Buffer.from(normalizedArchive, "base64"), destinationRoot);
}

function buildMountArg(mount: SandboxDockerMount): string {
  if ("type" in mount && mount.type === "tmpfs") {
    return `type=tmpfs,target=${mount.target}${mount.sizeMb === undefined ? "" : `,tmpfs-size=${mount.sizeMb * 1024 * 1024}`}`;
  }

  if (!("source" in mount)) {
    throw new Error("Bind mount is missing a source path.");
  }

  return `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`;
}

function toContainerPath(root: string, hostPath: string): string {
  const relative = path.relative(root, hostPath);
  if (relative.length === 0) {
    return SANDBOX_WORKSPACE_MOUNT_PATH;
  }

  return path.posix.join(
    SANDBOX_WORKSPACE_MOUNT_PATH,
    ...relative.split(path.sep).filter((segment) => segment.length > 0),
  );
}

async function resolveHostCwd(root: string, cwd?: string): Promise<string> {
  return resolveSafeWorkspacePath(root, cwd ?? ".");
}

async function resolveContainerCwd(root: string, cwd?: string): Promise<string> {
  const hostPath = await resolveHostCwd(root, cwd);
  return toContainerPath(root, hostPath);
}

function normalizeRelativeSandboxPath(relativePath: string): string {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (path.isAbsolute(trimmed)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" must be workspace-relative, not absolute.`,
    );
  }
  if (WINDOWS_DRIVE_LETTER_PATTERN.test(trimmed)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" must not include a Windows drive letter.`,
    );
  }
  if (WINDOWS_UNC_PATH_PATTERN.test(trimmed)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" must not include a Windows UNC path.`,
    );
  }

  const normalized = path.normalize(trimmed);
  if (normalized === "." || normalized.length === 0) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" resolves to an absolute path.`,
    );
  }
  if (WINDOWS_DRIVE_LETTER_PATTERN.test(normalized)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" must not include a Windows drive letter.`,
    );
  }
  if (WINDOWS_UNC_PATH_PATTERN.test(normalized)) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" must not include a Windows UNC path.`,
    );
  }

  const segments = normalized.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) {
    throw new SandboxConfigurationError(
      `Sandbox relative path "${relativePath}" escapes the workspace root.`,
    );
  }

  return normalized.replace(/^[\\/]+/u, "");
}

function dedupeRelativeSandboxPaths(paths: readonly string[] | undefined): readonly string[] {
  if (paths === undefined || paths.length === 0) {
    return Object.freeze([]);
  }

  const sorted = Array.from(
    new Set(
      paths
        .map((candidate) => normalizeRelativeSandboxPath(candidate))
        .filter((candidate) => candidate.length > 0),
    ),
  ).sort((left, right) => {
    const depth = left.split(path.sep).length - right.split(path.sep).length;
    return depth !== 0 ? depth : left.localeCompare(right);
  });
  const pruned: string[] = [];

  for (const candidate of sorted) {
    if (
      pruned.some(
        (existing) => candidate === existing || candidate.startsWith(`${existing}${path.sep}`),
      )
    ) {
      continue;
    }
    pruned.push(candidate);
  }

  return Object.freeze(pruned);
}

function isRelativeSandboxPathWithin(candidate: string, ancestor: string): boolean {
  if (ancestor.length === 0) {
    return candidate.length === 0;
  }

  return candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`);
}

function resolveOutputBaseRelativePath(policy: SandboxPolicy): string {
  return normalizeRelativeSandboxPath(
    policy.files?.outputDir ??
      SANDBOX_DEFAULT_POLICY.files?.outputDir ??
      path.join("workspace", "shared"),
  );
}

function normalizeNetworkAllowlist(allowlist: readonly string[] | undefined): readonly string[] {
  if (allowlist === undefined || allowlist.length === 0) {
    return Object.freeze([]);
  }

  return Object.freeze(
    Array.from(
      new Set(
        allowlist.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0),
      ),
    ),
  );
}

function buildAllowlistProxyEnv(): Readonly<Record<string, string>> {
  const proxyUrl = `http://${SANDBOX_ALLOWLIST_PROXY_ALIAS}:${SANDBOX_ALLOWLIST_PROXY_PORT}`;
  const noProxy = "localhost,127.0.0.1,::1";
  return Object.freeze({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  });
}

function buildAllowlistProxyScript(): string {
  return [
    'import dns from "node:dns/promises";',
    'import fs from "node:fs/promises";',
    'import http from "node:http";',
    'import https from "node:https";',
    'import net from "node:net";',
    "",
    "const configPath = process.env.GENERIC_AI_PROXY_CONFIG;",
    "if (!configPath) {",
    '  throw new Error("GENERIC_AI_PROXY_CONFIG is required.");',
    "}",
    "",
    'const config = JSON.parse(await fs.readFile(configPath, "utf8"));',
    "const allowlist = Array.isArray(config.allowlist) ? config.allowlist : [];",
    "const listenPort = Number(config.port ?? 3128);",
    'const blockedLogPath = String(config.blockedLogPath ?? "/tmp/generic-ai-blocked.log");',
    "const upstreamSocketTimeoutMs = Number(config.upstreamSocketTimeoutMs ?? 30000);",
    "",
    "function parseAllowlistEntry(entry) {",
    '  const trimmed = String(entry ?? "").trim().toLowerCase();',
    "  if (trimmed.length === 0) {",
    "    return undefined;",
    "  }",
    '  if (trimmed.startsWith("[")) {',
    '    const closing = trimmed.indexOf("]");',
    "    if (closing === -1) {",
    "      return { host: trimmed, port: undefined };",
    "    }",
    "    const host = trimmed.slice(1, closing);",
    "    const portText = trimmed.slice(closing + 1).replace(/^:/, '');",
    "    const port = portText.length === 0 ? undefined : Number(portText);",
    "    return Number.isInteger(port) ? { host, port } : { host, port: undefined };",
    "  }",
    "  const firstColon = trimmed.indexOf(':');",
    "  const lastColon = trimmed.lastIndexOf(':');",
    "  if (firstColon > 0 && firstColon === lastColon) {",
    "    const host = trimmed.slice(0, firstColon);",
    "    const port = Number(trimmed.slice(firstColon + 1));",
    "    return Number.isInteger(port) ? { host, port } : { host: trimmed, port: undefined };",
    "  }",
    "  return { host: trimmed, port: undefined };",
    "}",
    "",
    "const normalizedAllowlist = allowlist.map(parseAllowlistEntry).filter(Boolean);",
    "",
    "function normalizeIpHost(hostname) {",
    '  return String(hostname ?? "").toLowerCase().replace(/^\\[/u, "").replace(/\\]$/u, "");',
    "}",
    "",
    "function isRestrictedIpv4(address) {",
    "  const parts = address.split('.').map((part) => Number(part));",
    "  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {",
    "    return true;",
    "  }",
    "  const [a, b, c] = parts;",
    "  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224;",
    "}",
    "",
    "function isRestrictedIpv6(address) {",
    "  const normalized = address.toLowerCase();",
    "  if (normalized.startsWith('::ffff:')) {",
    "    return isRestrictedIpv4(normalized.slice('::ffff:'.length));",
    "  }",
    "  const firstHextet = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);",
    "  const isLinkLocal = Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf;",
    "  return normalized === '::' || normalized === '::1' || isLinkLocal || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff') || normalized.startsWith('2001:db8:');",
    "}",
    "",
    "function isRestrictedIpAddress(address) {",
    "  const family = net.isIP(address);",
    "  if (family === 4) {",
    "    return isRestrictedIpv4(address);",
    "  }",
    "  if (family === 6) {",
    "    return isRestrictedIpv6(address);",
    "  }",
    "  return true;",
    "}",
    "",
    "function isExplicitlyAllowedIp(address, port) {",
    "  const normalizedAddress = normalizeIpHost(address);",
    "  return normalizedAllowlist.some((entry) => {",
    "    if (!entry || net.isIP(normalizeIpHost(entry.host)) === 0) {",
    "      return false;",
    "    }",
    "    return normalizeIpHost(entry.host) === normalizedAddress && (entry.port === undefined || entry.port === port);",
    "  });",
    "}",
    "",
    "async function resolveAllowedHost(hostname, port) {",
    "  const normalizedHost = normalizeIpHost(hostname);",
    "  if (net.isIP(normalizedHost) !== 0) {",
    "    if (isRestrictedIpAddress(normalizedHost) && !isExplicitlyAllowedIp(normalizedHost, port)) {",
    "      throw new Error('restricted-ip:' + normalizedHost);",
    "    }",
    "    return normalizedHost;",
    "  }",
    "  const records = await dns.lookup(normalizedHost, { all: true, verbatim: false });",
    "  if (records.length === 0) {",
    "    throw new Error('dns-empty:' + normalizedHost);",
    "  }",
    "  const blocked = records.find((record) => isRestrictedIpAddress(record.address) && !isExplicitlyAllowedIp(record.address, port));",
    "  if (blocked) {",
    "    throw new Error('restricted-ip:' + blocked.address);",
    "  }",
    "  const preferredRecord = records.find((record) => record.family === 4) ?? records[0];",
    "  return preferredRecord.address;",
    "}",
    "",
    "function installSocketTimeout(socket, destination, phase) {",
    "  if (!Number.isFinite(upstreamSocketTimeoutMs) || upstreamSocketTimeoutMs <= 0) {",
    "    return;",
    "  }",
    "  socket.setTimeout(upstreamSocketTimeoutMs, () => {",
    "    void logBlocked(destination, phase + '-timeout');",
    "    socket.destroy(new Error('Sandbox allowlist proxy socket timeout for ' + destination));",
    "  });",
    "}",
    "",
    "function matchesHost(hostname, pattern) {",
    '  if (pattern.startsWith("*.")) {',
    "    const suffix = pattern.slice(1);",
    "    return hostname.endsWith(suffix) && hostname.length > suffix.length;",
    "  }",
    "  return hostname === pattern;",
    "}",
    "",
    "function isAllowed(hostname, port) {",
    "  const normalizedHost = hostname.toLowerCase();",
    "  return normalizedAllowlist.some((entry) => {",
    "    if (!entry || !matchesHost(normalizedHost, entry.host)) {",
    "      return false;",
    "    }",
    "    return entry.port === undefined || entry.port === port;",
    "  });",
    "}",
    "",
    "async function logBlocked(target, reason) {",
    '  const line = [new Date().toISOString(), target, reason].join(" ") + "\\n";',
    "  await fs.appendFile(blockedLogPath, line, 'utf8');",
    "}",
    "",
    "function filterProxyHeaders(headers) {",
    "  const filtered = { ...headers };",
    "  delete filtered['proxy-authorization'];",
    "  delete filtered['proxy-connection'];",
    "  return filtered;",
    "}",
    "",
    "const server = http.createServer(async (req, res) => {",
    "  let target;",
    "  try {",
    '    target = new URL(req.url ?? "", "http://" + (req.headers.host ?? "invalid"));',
    "  } catch {",
    '    res.writeHead(400, { "content-type": "text/plain" });',
    '    res.end("Invalid proxy request target.\\n");',
    "    return;",
    "  }",
    "",
    '  const port = Number(target.port || (target.protocol === "https:" ? "443" : "80"));',
    '  const destination = target.hostname + ":" + port;',
    "  if (!isAllowed(target.hostname, port)) {",
    "    await logBlocked(destination, 'blocked');",
    '    res.writeHead(403, { "content-type": "text/plain" });',
    '    res.end("Blocked by Generic AI sandbox allowlist: " + destination + "\\n");',
    "    return;",
    "  }",
    "",
    "  let resolvedAddress;",
    "  try {",
    "    resolvedAddress = await resolveAllowedHost(target.hostname, port);",
    "  } catch (error) {",
    "    const reason = error instanceof Error ? error.message : String(error);",
    "    await logBlocked(destination, 'blocked-resolution:' + reason);",
    '    res.writeHead(403, { "content-type": "text/plain" });',
    '    res.end("Blocked by Generic AI sandbox allowlist after DNS resolution: " + destination + "\\n");',
    "    return;",
    "  }",
    "",
    '  const transport = target.protocol === "https:" ? https : http;',
    "  const upstream = transport.request(target, {",
    "    method: req.method,",
    "    headers: filterProxyHeaders(req.headers),",
    "    lookup(_hostname, _options, callback) {",
    "      callback(null, resolvedAddress, net.isIP(resolvedAddress));",
    "    },",
    "  }, (upstreamRes) => {",
    "    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);",
    "    upstreamRes.pipe(res);",
    "  });",
    "  installSocketTimeout(upstream, destination, 'http-upstream');",
    "  upstream.on('error', async (error) => {",
    "    await logBlocked(destination, 'error:' + error.message);",
    '    res.writeHead(502, { "content-type": "text/plain" });',
    '    res.end("Proxy upstream error for " + destination + ": " + error.message + "\\n");',
    "  });",
    "  req.pipe(upstream);",
    "});",
    "",
    "server.on('connect', async (req, clientSocket, head) => {",
    "  const target = String(req.url ?? '');",
    "  const separator = target.lastIndexOf(':');",
    "  const hostname = separator === -1 ? target : target.slice(0, separator);",
    "  const port = Number(separator === -1 ? '443' : target.slice(separator + 1));",
    '  const normalizedHost = hostname.replace(/^\\[/u, "").replace(/\\]$/u, "");',
    '  const destination = normalizedHost + ":" + port;',
    "  if (!isAllowed(normalizedHost, port)) {",
    "    await logBlocked(destination, 'blocked-connect');",
    '    clientSocket.write("HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n");',
    '    clientSocket.end("Blocked by Generic AI sandbox allowlist: " + destination + "\\n");',
    "    return;",
    "  }",
    "",
    "  let resolvedAddress;",
    "  try {",
    "    resolvedAddress = await resolveAllowedHost(normalizedHost, port);",
    "  } catch (error) {",
    "    const reason = error instanceof Error ? error.message : String(error);",
    "    await logBlocked(destination, 'blocked-connect-resolution:' + reason);",
    '    clientSocket.write("HTTP/1.1 403 Forbidden\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n");',
    '    clientSocket.end("Blocked by Generic AI sandbox allowlist after DNS resolution: " + destination + "\\n");',
    "    return;",
    "  }",
    "",
    "  const upstream = net.connect({ host: resolvedAddress, port }, () => {",
    '    clientSocket.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");',
    "    if (head.length > 0) {",
    "      upstream.write(head);",
    "    }",
    "    upstream.pipe(clientSocket);",
    "    clientSocket.pipe(upstream);",
    "  });",
    "",
    "  installSocketTimeout(upstream, destination, 'connect-upstream');",
    "  installSocketTimeout(clientSocket, destination, 'connect-client');",
    "  upstream.on('error', async (error) => {",
    "    await logBlocked(destination, 'connect-error:' + error.message);",
    '    clientSocket.write("HTTP/1.1 502 Bad Gateway\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n");',
    '    clientSocket.end("Proxy upstream error for " + destination + ": " + error.message + "\\n");',
    "  });",
    "",
    "  clientSocket.on('error', () => upstream.destroy());",
    "});",
    "",
    "server.listen(listenPort, '0.0.0.0');",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    "process.on('SIGINT', () => server.close(() => process.exit(0)));",
  ].join("\n");
}

function buildAllowlistProxyReadinessCommand(): string {
  return [
    "node -e",
    JSON.stringify(
      [
        "const net = require('node:net');",
        `const socket = net.connect(${SANDBOX_ALLOWLIST_PROXY_PORT}, '127.0.0.1');`,
        "socket.setTimeout(250);",
        "socket.once('connect', () => { socket.end(); process.exit(0); });",
        "socket.once('timeout', () => { socket.destroy(); process.exit(1); });",
        "socket.once('error', () => process.exit(1));",
      ].join(" "),
    ),
  ].join(" ");
}

async function waitForAllowlistProxyReady(
  docker: SandboxDockerOperations,
  proxyContainerId: string,
): Promise<void> {
  const deadline = Date.now() + SANDBOX_ALLOWLIST_PROXY_READY_TIMEOUT_MS;
  const command = buildAllowlistProxyReadinessCommand();
  let lastError = "";

  while (Date.now() <= deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    const probeTimeoutMs = Math.max(1, Math.min(500, remainingMs));

    try {
      const result = await docker.exec({
        containerId: proxyContainerId,
        command,
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (result.exitCode === 0) {
        return;
      }
      lastError = result.stderr.trim() || result.stdout.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      lastError =
        message.length === 0
          ? `allowlist proxy readiness probe timed out after ${probeTimeoutMs}ms`
          : message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new SandboxUnavailableError(
    `Sandbox allowlist proxy "${proxyContainerId}" did not become ready on port ${SANDBOX_ALLOWLIST_PROXY_PORT} within ${SANDBOX_ALLOWLIST_PROXY_READY_TIMEOUT_MS}ms${lastError.length === 0 ? "." : `: ${lastError}`}`,
  );
}

function enforceStagedInputLimit(
  tracker: SizeLimitedCopyTracker,
  maxInputBytes: number | undefined,
  nextBytes: number,
  relativePath: string,
): void {
  if (maxInputBytes === undefined) {
    tracker.totalBytes += nextBytes;
    return;
  }

  const projectedBytes = tracker.totalBytes + nextBytes;
  if (projectedBytes > maxInputBytes) {
    const label = relativePath.length === 0 ? "workspace snapshot" : relativePath;
    throw new Error(
      `Sandbox file policy exceeded maxInputBytes while staging "${label}". Limit ${maxInputBytes} bytes, attempted ${projectedBytes} bytes.`,
    );
  }

  tracker.totalBytes = projectedBytes;
}

async function stageWorkspacePath(
  workspaceRoot: string,
  destinationRoot: string,
  relativePath: string,
  tracker: SizeLimitedCopyTracker,
  maxInputBytes: number | undefined,
  excludedRelativePaths: readonly string[] = Object.freeze([]),
): Promise<void> {
  const normalizedPath = normalizeRelativeSandboxPath(relativePath);
  if (
    excludedRelativePaths.some((excludedPath) =>
      isRelativeSandboxPathWithin(normalizedPath, excludedPath),
    )
  ) {
    return;
  }
  const lexicalSourcePath =
    normalizedPath.length === 0
      ? resolveWorkspacePath(workspaceRoot)
      : resolveWorkspacePath(workspaceRoot, normalizedPath);
  const sourceInfo = await lstat(lexicalSourcePath);

  if (sourceInfo.isSymbolicLink()) {
    throw new SandboxConfigurationError(
      `Refusing to stage symbolic link "${normalizedPath || "."}" into the sandbox workspace.`,
    );
  }

  const sourcePath =
    normalizedPath.length === 0
      ? await resolveSafeWorkspacePath(workspaceRoot)
      : await resolveSafeWorkspacePath(workspaceRoot, normalizedPath);
  const destinationPath =
    normalizedPath.length === 0 ? destinationRoot : path.join(destinationRoot, normalizedPath);

  if (sourceInfo.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath =
        normalizedPath.length === 0 ? entry.name : path.join(normalizedPath, entry.name);
      await stageWorkspacePath(
        workspaceRoot,
        destinationRoot,
        childRelativePath,
        tracker,
        maxInputBytes,
        excludedRelativePaths,
      );
    }
    return;
  }

  if (!sourceInfo.isFile()) {
    return;
  }

  enforceStagedInputLimit(tracker, maxInputBytes, sourceInfo.size, normalizedPath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { dereference: true, force: true, recursive: false });
}

async function ensureStagedWorkingDirectory(
  workspaceRoot: string,
  stagingRoot: string,
  hostCwd: string,
): Promise<void> {
  const relativeCwd = normalizeRelativeSandboxPath(path.relative(workspaceRoot, hostCwd));
  if (relativeCwd.length === 0) {
    return;
  }

  await mkdir(path.join(stagingRoot, relativeCwd), { recursive: true });
}

async function stageReadonlyWorkspaceSnapshot(
  workspaceRoot: string,
  destinationRoot: string,
  tracker: SizeLimitedCopyTracker,
  maxInputBytes: number | undefined,
  excludedRelativePaths: readonly string[],
): Promise<void> {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (SANDBOX_SNAPSHOT_EXCLUDED_TOP_LEVEL_NAMES.includes(entry.name)) {
      continue;
    }

    await stageWorkspacePath(
      workspaceRoot,
      destinationRoot,
      entry.name,
      tracker,
      maxInputBytes,
      excludedRelativePaths,
    );
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function prepareAllowlistProxyFiles(
  cleanupRoot: string,
  allowlist: readonly string[],
): Promise<{ readonly blockedLogPath: string; readonly mounts: readonly SandboxDockerMount[] }> {
  const proxyRoot = path.join(cleanupRoot, "allowlist-proxy");
  const logsRoot = path.join(cleanupRoot, "allowlist-logs");
  await mkdir(proxyRoot, { recursive: true });
  await mkdir(logsRoot, { recursive: true });

  const scriptPath = path.join(proxyRoot, SANDBOX_ALLOWLIST_PROXY_SCRIPT_NAME);
  const configPath = path.join(proxyRoot, SANDBOX_ALLOWLIST_PROXY_CONFIG_NAME);
  const blockedLogPath = path.join(logsRoot, SANDBOX_ALLOWLIST_PROXY_BLOCK_LOG_NAME);

  await writeFile(scriptPath, buildAllowlistProxyScript(), "utf8");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        allowlist,
        port: SANDBOX_ALLOWLIST_PROXY_PORT,
        blockedLogPath: path.posix.join(
          SANDBOX_ALLOWLIST_PROXY_LOGS_MOUNT_PATH,
          SANDBOX_ALLOWLIST_PROXY_BLOCK_LOG_NAME,
        ),
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    blockedLogPath,
    mounts: Object.freeze([
      {
        source: proxyRoot,
        target: SANDBOX_ALLOWLIST_PROXY_MOUNT_PATH,
        readOnly: true,
      },
      {
        source: logsRoot,
        target: SANDBOX_ALLOWLIST_PROXY_LOGS_MOUNT_PATH,
      },
    ]),
  };
}

async function readAllowlistBlockLog(active: ActiveSandboxSession): Promise<string | undefined> {
  if (active.allowlistBlockedLogPath === undefined) {
    return undefined;
  }
  if (!(await pathExists(active.allowlistBlockedLogPath))) {
    return undefined;
  }

  const fileInfo = await stat(active.allowlistBlockedLogPath);
  if (fileInfo.size < active.allowlistBlockedLogOffset) {
    active.allowlistBlockedLogOffset = 0;
  }
  if (fileInfo.size <= active.allowlistBlockedLogOffset) {
    return undefined;
  }

  const startOffset = active.allowlistBlockedLogOffset;
  const byteLength = fileInfo.size - startOffset;
  const buffer = Buffer.alloc(byteLength);
  const handle = await open(active.allowlistBlockedLogPath, "r");
  let bytesRead = 0;
  try {
    const result = await handle.read(buffer, 0, byteLength, startOffset);
    bytesRead = result.bytesRead;
  } finally {
    await handle.close();
  }

  active.allowlistBlockedLogOffset = startOffset + bytesRead;
  const nextChunk = buffer.subarray(0, bytesRead).toString("utf8").trim();
  if (nextChunk.length === 0) {
    return undefined;
  }

  return `Blocked outbound network attempts:\n${nextChunk}`;
}

function appendStderr(base: string, extra: string | undefined): string {
  if (extra === undefined || extra.trim().length === 0) {
    return base;
  }
  if (base.trim().length === 0) {
    return extra;
  }
  return `${base.trimEnd()}\n${extra}`;
}

async function copyStagedEntryToOutput(sourcePath: string, destinationPath: string): Promise<void> {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) {
    throw new SandboxConfigurationError(
      `Refusing to copy symbolic link "${sourcePath}" out of the sandbox staging area.`,
    );
  }

  if (info.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const nextSource = path.join(sourcePath, entry.name);
      const nextDestination = path.join(destinationPath, entry.name);
      await copyStagedEntryToOutput(nextSource, nextDestination);
    }
    return;
  }

  if (!info.isFile()) {
    // Skip sockets, FIFOs, etc. Never copy anything we can't statically reason about.
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { dereference: false, force: true, recursive: false });
}

async function copyStagedDirectoryContentsToOutput(
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  const info = await lstat(sourceRoot);
  if (!info.isDirectory()) {
    return;
  }

  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    await copyStagedEntryToOutput(
      path.join(sourceRoot, entry.name),
      path.join(destinationRoot, entry.name),
    );
  }
}

async function copySelectedStagedPathsToOutput(
  stagingRoot: string,
  outputRoot: string,
  relativePaths: readonly string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    const normalizedPath = normalizeRelativeSandboxPath(relativePath);
    if (normalizedPath.length === 0) {
      continue;
    }

    const sourcePath = path.join(stagingRoot, normalizedPath);
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const destinationPath = path.join(outputRoot, normalizedPath);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyStagedEntryToOutput(sourcePath, destinationPath);
  }
}

async function collectArtifacts(root: string): Promise<readonly SandboxArtifact[]> {
  const artifacts: SandboxArtifact[] = [];

  function addArtifact(filePath: string, sizeBytes: number | bigint): void {
    artifacts.push({
      path: path.relative(root, filePath).split(path.sep).join("/"),
      sizeBytes: Number(sizeBytes),
    });
  }

  async function walk(current: string): Promise<void> {
    const currentInfo = await lstat(current);
    if (currentInfo.isFile()) {
      addArtifact(current, currentInfo.size);
      return;
    }
    if (!currentInfo.isDirectory()) {
      return;
    }

    let entries: readonly { readonly name: string }[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (!hasErrorCode(error, "ENOTDIR")) {
        throw error;
      }
      const refreshedInfo = await lstat(current);
      if (refreshedInfo.isFile()) {
        addArtifact(current, refreshedInfo.size);
      }
      return;
    }

    for (const entry of entries) {
      await walk(path.join(current, entry.name));
    }
  }

  await mkdir(root, { recursive: true });
  await walk(root);
  return artifacts;
}

async function resolveCopiedSandboxOutputRoot(stagingRoot: string): Promise<string> {
  const copiedRoot = path.join(stagingRoot, path.basename(SANDBOX_OUTPUT_MOUNT_PATH));
  try {
    const copiedRootInfo = await lstat(copiedRoot);
    if (copiedRootInfo.isDirectory()) {
      return copiedRoot;
    }
    return stagingRoot;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return stagingRoot;
    }
    throw error;
  }
}

async function syncArtifactsFromContainer(
  docker: SandboxDockerOperations,
  containerId: string,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "generic-ai-sandbox-artifacts-"));
  try {
    await docker.copyFromContainer(containerId, SANDBOX_OUTPUT_MOUNT_PATH, stagingRoot);
    const copiedOutputRoot = await resolveCopiedSandboxOutputRoot(stagingRoot);
    await copyStagedDirectoryContentsToOutput(copiedOutputRoot, outputDir);
  } catch (error) {
    if (error instanceof SandboxUnavailableError && isDockerUnavailableMessage(error.message)) {
      return;
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

function isDockerUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to connect to the docker api") ||
    normalized.includes("docker daemon") ||
    normalized.includes("cannot find the file specified") ||
    normalized.includes("is the docker daemon running")
  );
}

function isDockerUnavailable(result: ProcessResult): boolean {
  return isDockerUnavailableMessage(`${result.stderr}\n${result.error?.message ?? ""}`);
}

export function createDockerCliSandboxOperations(binary = "docker"): SandboxDockerOperations {
  return {
    async isAvailable() {
      // Bound the probe so a wedged Docker CLI (e.g. ENOENT, daemon stuck)
      // can never hang session creation indefinitely. runProcess now also
      // resolves on spawn errors instead of never settling.
      const result = await runProcess(binary, ["info", "--format", "{{json .ServerVersion}}"], {
        timeoutMs: 5_000,
      });
      if (result.error !== undefined) {
        return false;
      }
      return result.exitCode === 0;
    },
    async ensureImage(image) {
      const inspectResult = await runProcess(binary, ["image", "inspect", image]);
      if (inspectResult.exitCode === 0) {
        return;
      }

      const pullResult = await runProcess(binary, ["pull", image]);
      if (pullResult.exitCode === 0) {
        return;
      }

      const message =
        pullResult.stderr.trim() || inspectResult.stderr.trim() || "unknown Docker error";
      throw new SandboxUnavailableError(`Failed to ensure Docker image "${image}": ${message}`);
    },
    async createNetwork(request) {
      const args = ["network", "create", "--driver", "bridge"];
      if (request.internal) {
        args.push("--internal");
      }
      args.push("--label", "generic-ai.sandbox=true", request.name);

      const result = await runProcess(binary, args);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to create sandbox network "${request.name}": ${message}`,
        );
      }

      return result.stdout.trim() || request.name;
    },
    async connectContainerToNetwork(containerId, networkName, aliases) {
      const args = ["network", "connect"];
      for (const alias of aliases ?? []) {
        args.push("--alias", alias);
      }
      args.push(networkName, containerId);

      const result = await runProcess(binary, args);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to connect sandbox container "${containerId}" to network "${networkName}": ${message}`,
        );
      }
    },
    async createContainer(request) {
      const args = [
        "create",
        "--init",
        "--label",
        "generic-ai.sandbox=true",
        "--label",
        `generic-ai.sandbox.session=${request.sessionId}`,
      ];
      if (request.networkName !== undefined) {
        args.push("--network", request.networkName);
        for (const alias of request.networkAliases ?? []) {
          args.push("--network-alias", alias);
        }
      } else {
        args.push("--network", request.networkMode ?? "bridge");
      }

      if (request.cpus !== undefined) {
        args.push("--cpus", String(request.cpus));
      }
      if (request.memoryMb !== undefined) {
        args.push("--memory", `${request.memoryMb}m`);
      }
      if (request.readOnlyRootfs === true) {
        args.push("--read-only");
      }
      for (const mount of request.mounts) {
        args.push("--mount", buildMountArg(mount));
      }
      for (const [key, value] of Object.entries(request.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }

      args.push(request.image, ...(request.command ?? SANDBOX_KEEPALIVE_COMMAND));

      const result = await runProcess(binary, args);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(`Failed to create sandbox container: ${message}`);
      }

      return result.stdout.trim();
    },
    async startContainer(containerId) {
      const result = await runProcess(binary, ["start", containerId]);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to start sandbox container "${containerId}": ${message}`,
        );
      }
    },
    async exec(request) {
      const args = ["exec"];
      if (request.cwd !== undefined) {
        args.push("--workdir", request.cwd);
      }
      for (const [key, value] of Object.entries(request.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      args.push(request.containerId, "sh", "-lc", request.command);

      const result = await runProcess(binary, args, request.signal);
      if (isDockerUnavailable(result)) {
        const message = result.stderr.trim() || result.error?.message || "Docker is unavailable.";
        throw new SandboxUnavailableError(`Failed to execute sandbox command: ${message}`);
      }
      if (
        result.error !== undefined &&
        !isDockerUnavailable(result) &&
        result.error.name !== "AbortError"
      ) {
        throw result.error;
      }

      return {
        exitCode: result.error?.name === "AbortError" ? null : result.exitCode,
        stdout: result.stdout,
        stderr:
          result.stderr ||
          (result.error?.name === "AbortError" ? "Sandbox execution aborted." : ""),
      };
    },
    async stopContainer(containerId, graceMs) {
      await runProcess(binary, ["stop", "--time", toDockerStopSeconds(graceMs), containerId]);
    },
    async removeContainer(containerId) {
      await runProcess(binary, ["rm", "--force", containerId]);
    },
    async removeNetwork(networkName) {
      await runProcess(binary, ["network", "rm", networkName]);
    },
    async copyFromContainer(containerId, sourcePath, destinationPath) {
      await mkdir(destinationPath, { recursive: true });
      const nodeArchiveResult = await runProcess(binary, [
        "exec",
        containerId,
        "node",
        "-e",
        NODE_ARTIFACT_ARCHIVE_SCRIPT,
        sourcePath,
      ]);
      if (nodeArchiveResult.exitCode === 0) {
        await extractJsonArtifactArchiveToDirectory(nodeArchiveResult.stdout, destinationPath);
        return;
      }
      if (isDockerUnavailable(nodeArchiveResult)) {
        const message =
          nodeArchiveResult.stderr.trim() ||
          nodeArchiveResult.error?.message ||
          "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to copy sandbox artifacts from "${containerId}": ${message}`,
        );
      }

      const pythonArchiveResult = await runProcess(binary, [
        "exec",
        containerId,
        "python3",
        "-c",
        PYTHON_ARTIFACT_ARCHIVE_SCRIPT,
        sourcePath,
      ]);
      if (pythonArchiveResult.exitCode === 0) {
        await extractJsonArtifactArchiveToDirectory(pythonArchiveResult.stdout, destinationPath);
        return;
      }
      if (isDockerUnavailable(pythonArchiveResult)) {
        const message =
          pythonArchiveResult.stderr.trim() ||
          pythonArchiveResult.error?.message ||
          "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to copy sandbox artifacts from "${containerId}": ${message}`,
        );
      }

      const archiveResult = await runProcess(binary, [
        "exec",
        containerId,
        "sh",
        "-lc",
        buildBase64TarArchiveCommand(sourcePath),
      ]);
      if (archiveResult.exitCode === 0) {
        await extractBase64TarArchiveToDirectory(archiveResult.stdout, destinationPath);
        return;
      }
      if (isDockerUnavailable(archiveResult)) {
        const message =
          archiveResult.stderr.trim() || archiveResult.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(
          `Failed to copy sandbox artifacts from "${containerId}": ${message}`,
        );
      }

      const result = await runProcess(binary, [
        "cp",
        `${containerId}:${sourcePath}`,
        destinationPath,
      ]);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        if (isDockerUnavailable(result)) {
          throw new SandboxUnavailableError(
            `Failed to copy sandbox artifacts from "${containerId}": ${message}`,
          );
        }
        throw new SandboxArtifactSyncError(
          `Failed to copy sandbox artifacts from "${containerId}": ${message}`,
        );
      }
    },
    async inspectContainer(containerId) {
      const result = await runProcess(binary, [
        "inspect",
        "--format",
        "{{json .State}}",
        containerId,
      ]);
      if (result.exitCode !== 0) {
        return undefined;
      }

      return parseContainerState(result.stdout);
    },
    async readUsageSnapshot(containerId) {
      const result = await runProcess(binary, [
        "exec",
        containerId,
        "sh",
        "-lc",
        [
          'cpu_ms=""',
          "if [ -f /sys/fs/cgroup/cpu.stat ]; then",
          "  cpu_ms=$(awk '/usage_usec/ { printf \"%d\", $2 / 1000 }' /sys/fs/cgroup/cpu.stat 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then",
          "  cpu_ms=$(awk '{ printf \"%d\", $1 / 1000000 }' /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null)",
          "fi",
          'mem_cur=""',
          "if [ -f /sys/fs/cgroup/memory.current ]; then",
          "  mem_cur=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory.current 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then",
          "  mem_cur=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)",
          "fi",
          'mem_peak=""',
          "if [ -f /sys/fs/cgroup/memory.peak ]; then",
          "  mem_peak=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory.peak 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then",
          "  mem_peak=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null)",
          "fi",
          'disk_mb=""',
          'if command -v du >/dev/null 2>&1 && [ -d "$GENERIC_AI_SANDBOX_OUTPUT_DIR" ]; then',
          '  disk_mb=$(du -sk "$GENERIC_AI_SANDBOX_OUTPUT_DIR" 2>/dev/null | awk \'{ printf "%d", ($1 + 1023) / 1024 }\')',
          "fi",
          `printf 'cpuTimeMs=%s\\nmemoryCurrentMb=%s\\npeakMemoryMb=%s\\ndiskWrittenMb=%s\\n' "\${cpu_ms:-}" "\${mem_cur:-}" "\${mem_peak:-}" "\${disk_mb:-}"`,
        ].join("\n"),
      ]);
      if (result.exitCode !== 0) {
        return undefined;
      }

      return parseUsageSnapshot(result.stdout);
    },
  };
}

export async function isDockerDaemonReachable(
  operations: SandboxDockerOperations = createDockerCliSandboxOperations(),
): Promise<boolean> {
  return operations.isAvailable();
}

export function createSandboxTerminalPlugin(
  options: SandboxTerminalPluginOptions,
): SandboxTerminalPlugin {
  const layout = createWorkspaceLayout(options.root);
  const config = sandboxTerminalConfigSchema.parse(options.config ?? {});
  const docker = options.dockerOperations ?? createDockerCliSandboxOperations();
  const sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, ActiveSandboxSession>();

  async function prepareWorkspaceMount(
    sessionId: string,
    policy: SandboxPolicy,
    hostCwd: string,
  ): Promise<{
    readonly fileMode: SandboxFileIOMode;
    readonly workspaceMountRoot: string;
    readonly workspaceMountReadOnly: boolean;
    readonly mountsWorkspace: boolean;
    readonly copyOutPaths: readonly string[];
    readonly cleanupRoot: string;
  }> {
    const fileMode = policy.files?.mode ?? SANDBOX_DEFAULT_POLICY.files?.mode ?? "readonly-mount";
    const maxInputBytes =
      policy.files?.maxInputBytes ?? SANDBOX_DEFAULT_POLICY.files?.maxInputBytes;
    const cleanupRoot = await mkdtemp(path.join(os.tmpdir(), `generic-ai-sandbox-${sessionId}-`));
    const workspaceMountRoot = path.join(cleanupRoot, "workspace");
    const tracker: SizeLimitedCopyTracker = { totalBytes: 0 };

    await mkdir(workspaceMountRoot, { recursive: true });

    if (fileMode === "readonly-mount") {
      await stageReadonlyWorkspaceSnapshot(
        layout.root,
        workspaceMountRoot,
        tracker,
        maxInputBytes,
        Object.freeze([resolveOutputBaseRelativePath(policy)]),
      );
    } else if (fileMode === "copy") {
      const copyInPaths = dedupeRelativeSandboxPaths(policy.files?.copyInPaths);
      if (copyInPaths.length === 0) {
        throw new SandboxConfigurationError(
          'Sandbox file mode "copy" requires at least one policy.files.copyInPaths entry.',
        );
      }

      for (const relativePath of copyInPaths) {
        await stageWorkspacePath(
          layout.root,
          workspaceMountRoot,
          relativePath,
          tracker,
          maxInputBytes,
        );
      }
    }

    if (fileMode !== "none") {
      await ensureStagedWorkingDirectory(layout.root, workspaceMountRoot, hostCwd);
    }

    return {
      fileMode,
      workspaceMountRoot,
      workspaceMountReadOnly: fileMode === "readonly-mount",
      mountsWorkspace: fileMode !== "none",
      copyOutPaths:
        fileMode === "copy"
          ? dedupeRelativeSandboxPaths(policy.files?.copyOutPaths)
          : Object.freeze([]),
      cleanupRoot,
    };
  }

  async function resolveOutputDirectory(sessionId: string, policy: SandboxPolicy): Promise<string> {
    const outputDir = policy.files?.outputDir ?? SANDBOX_DEFAULT_POLICY.files?.outputDir;
    const hostPath = await resolveSafeWorkspacePath(
      layout.root,
      outputDir ?? path.join("workspace", "shared"),
    );
    const sessionPath = path.join(hostPath, sessionId);
    await mkdir(sessionPath, { recursive: true });
    return sessionPath;
  }

  async function ensurePluginRoot(requestWorkspaceRoot: string): Promise<void> {
    const resolvedRoot = await resolveSafeWorkspacePath(requestWorkspaceRoot);
    if (resolvedRoot !== layout.root) {
      throw new SandboxConfigurationError(
        `Sandbox session workspaceRoot must match the plugin root. Expected "${layout.root}" but received "${resolvedRoot}".`,
      );
    }
  }

  async function ensureDockerAvailable(action: string): Promise<void> {
    if (await docker.isAvailable()) {
      return;
    }

    throw new SandboxUnavailableError(
      `Docker is unavailable, so sandbox ${action} cannot continue. Start Docker Desktop or the Docker daemon and retry.`,
    );
  }

  async function prepareAllowlistResources(
    sessionId: string,
    cleanupRoot: string,
    allowlist: readonly string[] | undefined,
  ): Promise<AllowlistNetworkResources> {
    const normalizedAllowlist = normalizeNetworkAllowlist(allowlist);
    if (normalizedAllowlist.length === 0) {
      throw new SandboxConfigurationError(
        'Sandbox network mode "allowlist" requires at least one policy.network.allowlist entry.',
      );
    }

    if (config.ensureImages) {
      await docker.ensureImage(SANDBOX_ALLOWLIST_PROXY_IMAGE);
    }

    const networkName = `${SANDBOX_ALLOWLIST_NETWORK_NAME_PREFIX}-${sessionId}`;
    const { blockedLogPath, mounts } = await prepareAllowlistProxyFiles(
      cleanupRoot,
      normalizedAllowlist,
    );
    let proxyContainerId: string | undefined;
    let networkCreated = false;

    try {
      await docker.createNetwork({
        name: networkName,
        internal: true,
      });
      networkCreated = true;

      proxyContainerId = await docker.createContainer({
        image: SANDBOX_ALLOWLIST_PROXY_IMAGE,
        sessionId: `${sessionId}-allowlist-proxy`,
        mounts: [
          ...mounts,
          { type: "tmpfs", target: "/tmp", sizeMb: SANDBOX_WRITABLE_TMPFS_MB },
          { type: "tmpfs", target: "/run", sizeMb: SANDBOX_WRITABLE_TMPFS_MB },
        ],
        env: {
          [SANDBOX_ALLOWLIST_PROXY_CONFIG_ENV_VAR]: path.posix.join(
            SANDBOX_ALLOWLIST_PROXY_MOUNT_PATH,
            SANDBOX_ALLOWLIST_PROXY_CONFIG_NAME,
          ),
        },
        readOnlyRootfs: true,
        networkName,
        networkAliases: [SANDBOX_ALLOWLIST_PROXY_ALIAS],
        command: [
          "node",
          path.posix.join(SANDBOX_ALLOWLIST_PROXY_MOUNT_PATH, SANDBOX_ALLOWLIST_PROXY_SCRIPT_NAME),
        ],
      });
      await docker.connectContainerToNetwork(proxyContainerId, "bridge");
      await docker.startContainer(proxyContainerId);
      await waitForAllowlistProxyReady(docker, proxyContainerId);

      return {
        networkName,
        proxyContainerId,
        blockedLogPath,
        proxyEnv: buildAllowlistProxyEnv(),
      };
    } catch (error) {
      if (proxyContainerId !== undefined) {
        await Promise.allSettled([
          docker.stopContainer(proxyContainerId),
          docker.removeContainer(proxyContainerId),
        ]);
      }
      if (networkCreated) {
        await Promise.allSettled([docker.removeNetwork(networkName)]);
      }
      throw error;
    }
  }

  async function createSession(request: SandboxSessionRequest): Promise<SandboxSession> {
    // Validate caller-supplied sessionId BEFORE any side effects (docker probe,
    // image pulls, etc.) so invalid ids fail fast with a clean error.
    const sessionId =
      request.sessionId === undefined ? sessionIdFactory() : validateSessionId(request.sessionId);

    if (sessions.has(sessionId)) {
      throw new SandboxSessionConflictError(
        `Sandbox session "${sessionId}" already exists. Destroy the existing session before creating a new one with the same id.`,
      );
    }

    await ensurePluginRoot(request.workspaceRoot);
    await ensureDockerAvailable("session creation");

    const policy = mergeSandboxPolicy(config.defaultPolicy, request.policy) ?? config.defaultPolicy;
    const runtimeConfig = request.runtimeConfig ?? {};
    const image = runtimeConfig.image ?? config.images[request.runtime];
    if (config.ensureImages) {
      await docker.ensureImage(image);
    }
    const defaultHostCwd = await resolveHostCwd(layout.root, request.cwd);
    const defaultCwd = await resolveContainerCwd(layout.root, request.cwd);
    const workspaceMount = await prepareWorkspaceMount(sessionId, policy, defaultHostCwd);
    let outputDir: string | undefined;
    let containerId: string | undefined;
    let allowlistResources: AllowlistNetworkResources | undefined;
    try {
      outputDir = await resolveOutputDirectory(sessionId, policy);
      if (policy.network?.mode === "allowlist") {
        allowlistResources = await prepareAllowlistResources(
          sessionId,
          workspaceMount.cleanupRoot,
          policy.network.allowlist,
        );
      }

      const protectedEnv = {
        [SANDBOX_OUTPUT_ENV_VAR]: SANDBOX_OUTPUT_MOUNT_PATH,
        ...(allowlistResources?.proxyEnv ?? {}),
      };
      const env = mergeStringRecord(runtimeConfig.env, protectedEnv);
      const mounts: SandboxDockerMount[] = [];
      if (workspaceMount.mountsWorkspace) {
        mounts.push({
          source: workspaceMount.workspaceMountRoot,
          target: SANDBOX_WORKSPACE_MOUNT_PATH,
          ...(workspaceMount.workspaceMountReadOnly ? { readOnly: true } : {}),
        });
      } else {
        // mode === "none": back /workspace with a writable tmpfs so downstream
        // `docker exec --workdir /workspace` calls still resolve to a real path.
        mounts.push({
          type: "tmpfs",
          target: SANDBOX_WORKSPACE_MOUNT_PATH,
        });
      }
      mounts.push({
        type: "tmpfs",
        target: SANDBOX_OUTPUT_MOUNT_PATH,
        ...(policy.resources?.diskMb === undefined ? {} : { sizeMb: policy.resources.diskMb }),
      });
      mounts.push(
        { type: "tmpfs", target: "/tmp", sizeMb: SANDBOX_WRITABLE_TMPFS_MB },
        { type: "tmpfs", target: "/var/tmp", sizeMb: SANDBOX_WRITABLE_TMPFS_MB },
        { type: "tmpfs", target: "/run", sizeMb: SANDBOX_WRITABLE_TMPFS_MB },
      );

      containerId = await docker.createContainer({
        image,
        sessionId,
        mounts,
        ...(env === undefined ? {} : { env }),
        ...(allowlistResources === undefined
          ? { networkMode: policy.network?.mode === "open" ? "bridge" : "none" }
          : { networkName: allowlistResources.networkName }),
        ...(policy.resources?.cpuCores === undefined ? {} : { cpus: policy.resources.cpuCores }),
        ...(policy.resources?.memoryMb === undefined
          ? {}
          : { memoryMb: policy.resources.memoryMb }),
        readOnlyRootfs: true,
      });
      await docker.startContainer(containerId);

      const session: SandboxSession = Object.freeze({
        sessionId,
        backend: config.backend,
        runtime: request.runtime,
        image,
        containerId,
        workspaceRoot: layout.root,
        outputDir,
        createdAt: new Date(now()).toISOString(),
      });

      sessions.set(sessionId, {
        session,
        policy,
        fileMode: workspaceMount.fileMode,
        workspaceMountRoot: workspaceMount.workspaceMountRoot,
        workspaceMountReadOnly: workspaceMount.workspaceMountReadOnly,
        mountsWorkspace: workspaceMount.mountsWorkspace,
        copyOutPaths: workspaceMount.copyOutPaths,
        cleanupRoot: workspaceMount.cleanupRoot,
        defaultCwd,
        defaultHostCwd,
        env: env ?? {},
        protectedEnv,
        allowlistBlockedLogOffset: 0,
        ...(allowlistResources === undefined
          ? {}
          : {
              allowlistNetworkName: allowlistResources.networkName,
              allowlistProxyContainerId: allowlistResources.proxyContainerId,
              allowlistBlockedLogPath: allowlistResources.blockedLogPath,
            }),
      });

      return session;
    } catch (error) {
      if (containerId !== undefined) {
        await Promise.allSettled([
          docker.stopContainer(containerId),
          docker.removeContainer(containerId),
        ]);
      }
      if (allowlistResources !== undefined) {
        await Promise.allSettled([
          docker.stopContainer(allowlistResources.proxyContainerId),
          docker.removeContainer(allowlistResources.proxyContainerId),
          docker.removeNetwork(allowlistResources.networkName),
        ]);
      }
      await rm(workspaceMount.cleanupRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async function destroy(sessionId: string): Promise<void> {
    const active = sessions.get(sessionId);
    if (active === undefined) {
      return;
    }

    sessions.delete(sessionId);
    await Promise.allSettled([
      docker.stopContainer(active.session.containerId),
      ...(active.allowlistProxyContainerId === undefined
        ? []
        : [docker.stopContainer(active.allowlistProxyContainerId)]),
    ]);
    await Promise.allSettled([
      docker.removeContainer(active.session.containerId),
      ...(active.allowlistProxyContainerId === undefined
        ? []
        : [docker.removeContainer(active.allowlistProxyContainerId)]),
    ]);
    if (active.allowlistNetworkName !== undefined) {
      await Promise.allSettled([docker.removeNetwork(active.allowlistNetworkName)]);
    }
    await rm(active.cleanupRoot, { recursive: true, force: true });
  }

  async function exec(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const active = sessions.get(request.sessionId);
    if (active === undefined) {
      throw new Error(`Unknown sandbox session "${request.sessionId}".`);
    }

    const hostCwd = request.cwd
      ? await resolveHostCwd(layout.root, request.cwd)
      : active.defaultHostCwd;
    const sandboxCwd = request.cwd ? toContainerPath(layout.root, hostCwd) : active.defaultCwd;
    if (active.fileMode === "copy") {
      await ensureStagedWorkingDirectory(layout.root, active.workspaceMountRoot, hostCwd);
    }
    const env = mergeStringRecord(mergeStringRecord(active.env, request.env), active.protectedEnv);
    const startedAt = now();
    const timeoutMs = request.timeoutMs ?? active.policy.resources?.timeoutMs;
    const timeoutGraceMs = active.policy.resources?.timeoutGraceMs;
    const maxOutputBytes = active.policy.resources?.maxOutputBytes;
    let timedOut = false;
    let callerAborted = false;

    // Short-circuit when the caller-supplied signal is already aborted so we
    // never invoke docker.exec against a dead request.
    if (request.signal?.aborted === true) {
      const durationMs = 0;
      const execResult: SandboxDockerExecResult = {
        exitCode: null,
        stdout: "",
        stderr: "Sandbox execution aborted.",
      };
      const stdoutResult = truncateOutput(execResult.stdout, maxOutputBytes);
      const stderrResult = truncateOutput(
        decorateExecutionStderr(execResult.stderr, {
          timedOut: false,
          timeoutMs,
          timeoutGraceMs,
          oomKilled: false,
          memoryMb: active.policy.resources?.memoryMb,
          diskMb: active.policy.resources?.diskMb,
          diskWrittenMb: undefined,
          diskExceeded: false,
        }),
        maxOutputBytes,
      );
      const output = formatCombinedOutput(stdoutResult.text, stderrResult.text);
      return Object.freeze({
        command: request.command,
        runtime: active.session.runtime,
        image: active.session.image,
        cwd: hostCwd,
        sandboxCwd,
        exitCode: null,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        output,
        durationMs,
        timedOut: false,
        truncated: stdoutResult.truncated || stderrResult.truncated,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        status: "signaled" as SandboxExecutionStatus,
        artifacts: Object.freeze([]),
        generatedFiles: Object.freeze([]),
        resourceUsage: buildResourceUsage(undefined, durationMs),
        unrestrictedLocal: false,
      });
    }

    const usageBefore = await safeReadUsageSnapshot(docker, active.session.containerId);

    // Build a combined signal that aborts on caller-abort OR on timeout so we
    // can forward a single, correct AbortSignal into docker.exec.
    const timeoutController = new AbortController();
    const timeoutHandle =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void docker.stopContainer(active.session.containerId, timeoutGraceMs);
            timeoutController.abort();
          }, timeoutMs);

    const signalsToCombine: AbortSignal[] = [timeoutController.signal];
    if (request.signal !== undefined) {
      signalsToCombine.unshift(request.signal);
    }
    const fallbackSignal =
      signalsToCombine[signalsToCombine.length - 1] ?? timeoutController.signal;
    const combinedSignal: AbortSignal =
      typeof (AbortSignal as unknown as { any?: (signals: readonly AbortSignal[]) => AbortSignal })
        .any === "function"
        ? (AbortSignal as unknown as { any: (signals: readonly AbortSignal[]) => AbortSignal }).any(
            signalsToCombine,
          )
        : fallbackSignal;

    const abortListener =
      request.signal === undefined
        ? undefined
        : () => {
            callerAborted = true;
            void docker.stopContainer(active.session.containerId, 0);
          };
    if (abortListener !== undefined) {
      request.signal?.addEventListener("abort", abortListener, { once: true });
    }

    let execResult: SandboxDockerExecResult;
    let unavailable = false;
    try {
      execResult = await docker.exec({
        containerId: active.session.containerId,
        command: request.command,
        cwd: sandboxCwd,
        ...(env === undefined ? {} : { env }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        unavailable = true;
        execResult = {
          exitCode: null,
          stdout: "",
          stderr: error.message,
        };
      } else {
        throw error;
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (abortListener !== undefined) {
        request.signal?.removeEventListener("abort", abortListener);
      }
    }

    const inspectResult = await docker.inspectContainer(active.session.containerId);
    const oomKilled = inspectResult?.oomKilled ?? false;
    const usageAfter = timedOut
      ? undefined
      : await safeReadUsageSnapshot(docker, active.session.containerId);

    await syncArtifactsFromContainer(docker, active.session.containerId, active.session.outputDir);
    if (active.fileMode === "copy" && active.copyOutPaths.length > 0) {
      await copySelectedStagedPathsToOutput(
        active.workspaceMountRoot,
        active.session.outputDir,
        active.copyOutPaths,
      );
    }
    const networkBlockLog = await readAllowlistBlockLog(active);

    if (timedOut || callerAborted || inspectResult?.running === false) {
      await destroy(request.sessionId);
    }

    const artifacts = await collectArtifacts(active.session.outputDir);
    const durationMs = Math.max(0, now() - startedAt);
    const usage = summarizeUsage(
      [usageBefore, usageAfter].filter(
        (snapshot): snapshot is SandboxContainerUsageSnapshot => snapshot !== undefined,
      ),
    );
    const diskMb = active.policy.resources?.diskMb;
    const diskExceeded =
      !timedOut &&
      !callerAborted &&
      !oomKilled &&
      execResult.exitCode === 0 &&
      diskMb !== undefined &&
      usage?.diskWrittenMb !== undefined &&
      usage.diskWrittenMb > diskMb;
    const stderr = decorateExecutionStderr(appendStderr(execResult.stderr, networkBlockLog), {
      timedOut,
      timeoutMs,
      timeoutGraceMs,
      oomKilled,
      memoryMb: active.policy.resources?.memoryMb,
      diskMb,
      diskWrittenMb: usage?.diskWrittenMb,
      diskExceeded,
    });
    const stdoutResult = truncateOutput(execResult.stdout, maxOutputBytes);
    const stderrResult = truncateOutput(stderr, maxOutputBytes);
    const output = formatCombinedOutput(stdoutResult.text, stderrResult.text);

    return Object.freeze({
      command: request.command,
      runtime: active.session.runtime,
      image: active.session.image,
      cwd: hostCwd,
      sandboxCwd,
      exitCode: timedOut || callerAborted ? null : execResult.exitCode,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      output,
      durationMs,
      timedOut,
      truncated: stdoutResult.truncated || stderrResult.truncated,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
      status: diskExceeded ? "failed" : resolveStatus(execResult, timedOut, unavailable, oomKilled),
      artifacts,
      generatedFiles: artifacts,
      resourceUsage: buildResourceUsage(usage, durationMs),
      unrestrictedLocal: false,
    });
  }

  async function run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
    // `run` is always a one-shot helper: create → exec → destroy. When the
    // caller supplies a sessionId we still create a fresh ephemeral session
    // with that id (surfacing SandboxSessionConflictError if it collides) so
    // we never execute against an unrelated, pre-existing session.
    const session = await createSession({
      runtime: request.runtime ?? config.defaultRuntime,
      workspaceRoot: layout.root,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.policy === undefined ? {} : { policy: request.policy }),
      ...(request.runtimeConfig === undefined ? {} : { runtimeConfig: request.runtimeConfig }),
    });

    try {
      return await exec({
        sessionId: session.sessionId,
        command: request.command,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.onOutput === undefined ? {} : { onOutput: request.onOutput }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } finally {
      await destroy(session.sessionId);
    }
  }

  async function destroyAll(): Promise<void> {
    await Promise.allSettled(Array.from(sessions.keys()).map((sessionId) => destroy(sessionId)));
  }

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    config,
    pluginContract: sandboxTerminalPluginContract,
    pluginDefinition: sandboxTerminalPluginDefinition,
    backend: config.backend,
    isAvailable: () => docker.isAvailable(),
    createSession,
    exec,
    destroy,
    run,
    listSessions: () => Array.from(sessions.values()).map((session) => session.session),
    destroyAll,
  });
}
