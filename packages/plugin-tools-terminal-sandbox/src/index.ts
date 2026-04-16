import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  helpers,
  mergeSandboxPolicy,
  parseSandboxPolicy,
  SANDBOX_POLICY_SCHEMA,
  type ConfigSchemaContract,
  type PluginContract,
  type SandboxArtifact,
  type SandboxContract,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxExecutionStatus,
  type SandboxPolicy,
  type SandboxRuntime,
  type SandboxRuntimeConfig,
  type SandboxSession,
  type SandboxSessionRequest,
} from "@generic-ai/sdk";
import {
  createWorkspaceLayout,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

export const name = "@generic-ai/plugin-tools-terminal-sandbox" as const;
export const kind = "tools-terminal-sandbox" as const;

export const SANDBOX_WORKSPACE_MOUNT_PATH = "/workspace";
export const SANDBOX_OUTPUT_MOUNT_PATH = "/workspace-output";
export const SANDBOX_OUTPUT_ENV_VAR = "GENERIC_AI_SANDBOX_OUTPUT_DIR";
export const SANDBOX_KEEPALIVE_COMMAND = Object.freeze([
  "sh",
  "-lc",
  "trap 'exit 0' TERM INT; while :; do sleep 1; done",
]);

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
    outputDir: path.join("workspace", "shared", "sandbox-results"),
  },
} as const satisfies SandboxPolicy);

export interface SandboxTerminalPluginConfig {
  readonly backend: "docker";
  readonly defaultRuntime: SandboxRuntime;
  readonly images: Readonly<Record<SandboxRuntime, string>>;
  readonly defaultPolicy: SandboxPolicy;
  readonly ensureImages: boolean;
}

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
  readonly networkMode: "none" | "bridge";
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly command?: readonly string[];
}

export interface SandboxDockerExecRequest {
  readonly containerId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
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
  createContainer(request: SandboxDockerCreateContainerRequest): Promise<string>;
  startContainer(containerId: string): Promise<void>;
  exec(request: SandboxDockerExecRequest): Promise<SandboxDockerExecResult>;
  stopContainer(containerId: string, graceMs?: number): Promise<void>;
  removeContainer(containerId: string): Promise<void>;
  copyFromContainer(containerId: string, sourcePath: string, destinationPath: string): Promise<void>;
  inspectContainer(containerId: string): Promise<SandboxContainerState | undefined>;
  readUsageSnapshot(containerId: string): Promise<SandboxContainerUsageSnapshot | undefined>;
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface ActiveSandboxSession {
  readonly session: SandboxSession;
  readonly policy: SandboxPolicy;
  readonly defaultCwd: string;
  readonly env: Readonly<Record<string, string>>;
}

interface UsageSummary {
  readonly startCpuTimeMs?: number;
  readonly lastCpuTimeMs?: number;
  readonly peakMemoryMb?: number;
  readonly diskWrittenMb?: number;
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

  const candidate = assertRecord(input, "sandbox terminal config");
  const backend = candidate["backend"];
  if (backend !== undefined && backend !== "docker") {
    throw new Error('sandbox terminal config.backend must be "docker".');
  }

  const defaultRuntime = candidate["defaultRuntime"];
  if (
    defaultRuntime !== undefined &&
    defaultRuntime !== "bash" &&
    defaultRuntime !== "node" &&
    defaultRuntime !== "python"
  ) {
    throw new Error('sandbox terminal config.defaultRuntime must be "bash", "node", or "python".');
  }

  const ensureImages = candidate["ensureImages"];
  if (ensureImages !== undefined && typeof ensureImages !== "boolean") {
    throw new Error("sandbox terminal config.ensureImages must be a boolean.");
  }

  const defaultPolicy =
    candidate["defaultPolicy"] === undefined
      ? DEFAULT_CONFIG.defaultPolicy
      : mergeSandboxPolicy(DEFAULT_CONFIG.defaultPolicy, parseSandboxPolicy(candidate["defaultPolicy"])) ??
        DEFAULT_CONFIG.defaultPolicy;

  return {
    backend: "docker",
    defaultRuntime: (defaultRuntime as SandboxRuntime | undefined) ?? DEFAULT_CONFIG.defaultRuntime,
    images: parseRuntimeImages(candidate["images"]),
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
        defaultPolicy: mergeSandboxPolicy(base.defaultPolicy, next.defaultPolicy) ?? base.defaultPolicy,
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
  if (stderr.includes("out of memory") || stderr.includes("oom")) {
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

  const candidate = JSON.parse(trimmed) as Record<string, unknown>;
  return {
    ...(typeof candidate["Running"] === "boolean" ? { running: candidate["Running"] } : {}),
    ...(typeof candidate["OOMKilled"] === "boolean"
      ? { oomKilled: candidate["OOMKilled"] }
      : {}),
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
    ...(usage?.peakMemoryMb === undefined ? {} : { peakMemoryMb: usage.peakMemoryMb }),
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
  }

  return messages.join(trimmed.length > 0 ? "\n" : "");
}

async function runProcess(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });

    let stdout = "";
    let stderr = "";
    let capturedError: Error | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      capturedError = error;
    });
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        ...(capturedError === undefined ? {} : { error: capturedError }),
      });
    });
  });
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

async function resolveContainerCwd(root: string, cwd?: string): Promise<string> {
  const hostPath = await resolveSafeWorkspacePath(root, cwd ?? ".");
  return toContainerPath(root, hostPath);
}

async function collectArtifacts(root: string): Promise<readonly SandboxArtifact[]> {
  const artifacts: SandboxArtifact[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const info = await stat(entryPath);
      artifacts.push({
        path: path.relative(root, entryPath).split(path.sep).join("/"),
        sizeBytes: info.size,
      });
    }
  }

  await mkdir(root, { recursive: true });
  await walk(root);
  return artifacts;
}

async function syncArtifactsFromContainer(
  docker: SandboxDockerOperations,
  containerId: string,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  try {
    await docker.copyFromContainer(containerId, `${SANDBOX_OUTPUT_MOUNT_PATH}/.`, outputDir);
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return;
    }
    throw error;
  }
}

function isDockerUnavailable(result: ProcessResult): boolean {
  const message = `${result.stderr}\n${result.error?.message ?? ""}`.toLowerCase();
  return (
    message.includes("failed to connect to the docker api") ||
    message.includes("docker daemon") ||
    message.includes("cannot find the file specified") ||
    message.includes("is the docker daemon running")
  );
}

export function createDockerCliSandboxOperations(binary = "docker"): SandboxDockerOperations {
  return {
    async isAvailable() {
      const result = await runProcess(binary, ["info", "--format", "{{json .ServerVersion}}"]);
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

      const message = pullResult.stderr.trim() || inspectResult.stderr.trim() || "unknown Docker error";
      throw new SandboxUnavailableError(`Failed to ensure Docker image "${image}": ${message}`);
    },
    async createContainer(request) {
      const args = [
        "create",
        "--init",
        "--detach",
        "--label",
        "generic-ai.sandbox=true",
        "--label",
        `generic-ai.sandbox.session=${request.sessionId}`,
        "--network",
        request.networkMode,
      ];

      if (request.cpus !== undefined) {
        args.push("--cpus", String(request.cpus));
      }
      if (request.memoryMb !== undefined) {
        args.push("--memory", `${request.memoryMb}m`);
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
        throw new SandboxUnavailableError(`Failed to start sandbox container "${containerId}": ${message}`);
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
      if (result.error !== undefined && !isDockerUnavailable(result) && result.error.name !== "AbortError") {
        throw result.error;
      }

      return {
        exitCode: result.error?.name === "AbortError" ? null : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr || (result.error?.name === "AbortError" ? "Sandbox execution aborted." : ""),
      };
    },
    async stopContainer(containerId, graceMs) {
      await runProcess(binary, ["stop", "--time", toDockerStopSeconds(graceMs), containerId]);
    },
    async removeContainer(containerId) {
      await runProcess(binary, ["rm", "--force", containerId]);
    },
    async copyFromContainer(containerId, sourcePath, destinationPath) {
      const result = await runProcess(binary, ["cp", `${containerId}:${sourcePath}`, destinationPath]);
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.error?.message || "unknown Docker error";
        throw new SandboxUnavailableError(
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
          "cpu_ms=\"\"",
          "if [ -f /sys/fs/cgroup/cpu.stat ]; then",
          "  cpu_ms=$(awk '/usage_usec/ { printf \"%d\", $2 / 1000 }' /sys/fs/cgroup/cpu.stat 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then",
          "  cpu_ms=$(awk '{ printf \"%d\", $1 / 1000000 }' /sys/fs/cgroup/cpuacct/cpuacct.usage 2>/dev/null)",
          "fi",
          "mem_cur=\"\"",
          "if [ -f /sys/fs/cgroup/memory.current ]; then",
          "  mem_cur=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory.current 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then",
          "  mem_cur=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null)",
          "fi",
          "mem_peak=\"\"",
          "if [ -f /sys/fs/cgroup/memory.peak ]; then",
          "  mem_peak=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory.peak 2>/dev/null)",
          "elif [ -f /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then",
          "  mem_peak=$(awk '{ printf \"%d\", $1 / 1048576 }' /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null)",
          "fi",
          "disk_mb=\"\"",
          "if command -v du >/dev/null 2>&1 && [ -d \"$GENERIC_AI_SANDBOX_OUTPUT_DIR\" ]; then",
          "  disk_mb=$(du -sk \"$GENERIC_AI_SANDBOX_OUTPUT_DIR\" 2>/dev/null | awk '{ printf \"%d\", ($1 + 1023) / 1024 }')",
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

  async function resolveOutputDirectory(sessionId: string, policy: SandboxPolicy): Promise<string> {
    const outputDir = policy.files?.outputDir ?? SANDBOX_DEFAULT_POLICY.files?.outputDir;
    const hostPath = await resolveSafeWorkspacePath(layout.root, outputDir ?? path.join("workspace", "shared"));
    const sessionPath = path.join(hostPath, sessionId);
    await mkdir(sessionPath, { recursive: true });
    return sessionPath;
  }

  async function ensurePluginRoot(requestWorkspaceRoot: string): Promise<void> {
    const resolvedRoot = await resolveSafeWorkspacePath(requestWorkspaceRoot);
    if (resolvedRoot !== layout.root) {
      throw new Error(
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

  async function createSession(request: SandboxSessionRequest): Promise<SandboxSession> {
    await ensurePluginRoot(request.workspaceRoot);
    await ensureDockerAvailable("session creation");

    const policy = mergeSandboxPolicy(config.defaultPolicy, request.policy) ?? config.defaultPolicy;
    if (policy.network?.mode === "allowlist") {
      throw new Error(
        'Sandbox network mode "allowlist" is defined in the SDK contract but not implemented by the Docker backend yet.',
      );
    }

    const runtimeConfig = request.runtimeConfig ?? {};
    const image = runtimeConfig.image ?? config.images[request.runtime];
    if (config.ensureImages) {
      await docker.ensureImage(image);
    }

    const sessionId = request.sessionId ?? sessionIdFactory();
    const outputDir = await resolveOutputDirectory(sessionId, policy);
    const defaultCwd = await resolveContainerCwd(layout.root, request.cwd);
    const env = mergeStringRecord(runtimeConfig.env, {
      [SANDBOX_OUTPUT_ENV_VAR]: SANDBOX_OUTPUT_MOUNT_PATH,
    });
    const mounts: SandboxDockerMount[] = [];
    if (policy.files?.mode !== "none") {
      mounts.push({
        source: layout.root,
        target: SANDBOX_WORKSPACE_MOUNT_PATH,
        readOnly: true,
      });
    }
    mounts.push({
      type: "tmpfs",
      target: SANDBOX_OUTPUT_MOUNT_PATH,
      ...(policy.resources?.diskMb === undefined ? {} : { sizeMb: policy.resources.diskMb }),
    });
    const containerId = await docker.createContainer({
      image,
      sessionId,
      mounts,
      ...(env === undefined ? {} : { env }),
      networkMode: policy.network?.mode === "open" ? "bridge" : "none",
      ...(policy.resources?.cpuCores === undefined ? {} : { cpus: policy.resources.cpuCores }),
      ...(policy.resources?.memoryMb === undefined
        ? {}
        : { memoryMb: policy.resources.memoryMb }),
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
      defaultCwd,
      env: env ?? {},
    });

    return session;
  }

  async function destroy(sessionId: string): Promise<void> {
    const active = sessions.get(sessionId);
    if (active === undefined) {
      return;
    }

    sessions.delete(sessionId);
    await docker.stopContainer(active.session.containerId);
    await docker.removeContainer(active.session.containerId);
  }

  async function exec(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const active = sessions.get(request.sessionId);
    if (active === undefined) {
      throw new Error(`Unknown sandbox session "${request.sessionId}".`);
    }

    const cwd = request.cwd
      ? await resolveContainerCwd(layout.root, request.cwd)
      : active.defaultCwd;
    const env = mergeStringRecord(active.env, request.env);
    const startedAt = now();
    const timeoutMs = request.timeoutMs ?? active.policy.resources?.timeoutMs;
    const timeoutGraceMs = active.policy.resources?.timeoutGraceMs;
    let timedOut = false;
    let callerAborted = false;

    const usageBefore = await safeReadUsageSnapshot(docker, active.session.containerId);

    const timeoutHandle =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void docker.stopContainer(active.session.containerId, timeoutGraceMs);
          }, timeoutMs);

    const abortListener =
      request.signal === undefined
        ? undefined
        : () => {
            callerAborted = true;
            void docker.stopContainer(active.session.containerId, 0);
          };
    request.signal?.addEventListener("abort", abortListener ?? (() => {}), { once: true });

    let execResult: SandboxDockerExecResult;
    let unavailable = false;
    try {
      execResult = await docker.exec({
        containerId: active.session.containerId,
        command: request.command,
        cwd,
        ...(env === undefined ? {} : { env }),
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
    const stderr = decorateExecutionStderr(execResult.stderr, {
      timedOut,
      timeoutMs,
      timeoutGraceMs,
      oomKilled,
      memoryMb: active.policy.resources?.memoryMb,
    });
    const output = formatCombinedOutput(execResult.stdout, stderr);

    return Object.freeze({
      command: request.command,
      runtime: active.session.runtime,
      cwd,
      exitCode: timedOut || callerAborted ? null : execResult.exitCode,
      stdout: execResult.stdout,
      stderr,
      output,
      durationMs,
      timedOut,
      status: resolveStatus(execResult, timedOut, unavailable, oomKilled),
      artifacts,
      resourceUsage: buildResourceUsage(usage, durationMs),
    });
  }

  async function run(request: SandboxRunRequest): Promise<SandboxExecutionResult> {
    if (request.sessionId !== undefined) {
      return exec({
        sessionId: request.sessionId,
        command: request.command,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    }

    const session = await createSession({
      runtime: request.runtime ?? config.defaultRuntime,
      workspaceRoot: layout.root,
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
