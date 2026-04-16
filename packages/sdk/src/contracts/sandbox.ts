import type { JsonObject } from "./shared.js";

/**
 * Supported sandbox runtime families.
 *
 * The runtime selects the default container image and the language tooling that
 * is expected to be present inside the sandbox.
 */
export const SANDBOX_RUNTIMES = ["bash", "node", "python"] as const;

/**
 * Network isolation profiles supported by the sandbox contract.
 */
export const SANDBOX_NETWORK_MODES = ["isolated", "allowlist", "open"] as const;

/**
 * Workspace file-mount/copy strategies supported by the sandbox contract.
 */
export const SANDBOX_FILE_IO_MODES = ["readonly-mount", "copy", "none"] as const;

/**
 * High-level execution outcomes surfaced back to the caller.
 */
export const SANDBOX_EXECUTION_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "oom",
  "signaled",
  "unavailable",
] as const;

export type SandboxRuntime = (typeof SANDBOX_RUNTIMES)[number];
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];
export type SandboxFileIOMode = (typeof SANDBOX_FILE_IO_MODES)[number];
export type SandboxExecutionStatus = (typeof SANDBOX_EXECUTION_STATUSES)[number];

/**
 * Generated file metadata returned from a sandboxed run.
 */
export interface SandboxArtifact {
  /** Workspace-relative or output-directory-relative path to the artifact. */
  readonly path: string;
  /** Best-effort size on disk, when known. */
  readonly sizeBytes?: number;
  /** Optional content type hint. */
  readonly contentType?: string;
}

/**
 * Best-effort runtime resource-usage snapshot.
 */
export interface SandboxResourceUsage {
  /** Maximum observed resident memory, in MiB. */
  readonly peakMemoryMb?: number;
  /** Approximate CPU time spent by the sandboxed command, in milliseconds. */
  readonly cpuTimeMs?: number;
  /** Total wall-clock time spent by the sandboxed command, in milliseconds. */
  readonly wallClockMs?: number;
  /** Disk written to the writable sandbox area, in MiB. */
  readonly diskWrittenMb?: number;
}

/**
 * Resource ceilings enforced for a sandbox session or command.
 */
export interface SandboxResourceLimits {
  /** Maximum virtual CPUs made available to the sandbox. */
  readonly cpuCores?: number;
  /** Maximum memory available to the sandbox, in MiB. */
  readonly memoryMb?: number;
  /** Maximum writable disk area available to the sandbox, in MiB. */
  readonly diskMb?: number;
  /** Maximum wall-clock runtime per command, in milliseconds. */
  readonly timeoutMs?: number;
  /** Grace period between timeout SIGTERM and forced SIGKILL, in milliseconds. */
  readonly timeoutGraceMs?: number;
}

/**
 * Network policy applied to sandboxed code.
 */
export interface SandboxNetworkPolicy {
  /** Requested network isolation profile. */
  readonly mode: SandboxNetworkMode;
  /** Explicit allowlist used when `mode` is `allowlist`. */
  readonly allowlist?: readonly string[];
}

/**
 * Workspace I/O policy applied to the sandbox.
 */
export interface SandboxFileIOPolicy {
  /** How workspace files are exposed to the sandbox. */
  readonly mode: SandboxFileIOMode;
  /** Relative paths copied into the sandbox when `mode` is `copy`. */
  readonly copyInPaths?: readonly string[];
  /** Relative paths copied out of the sandbox after execution when `mode` is `copy`. */
  readonly copyOutPaths?: readonly string[];
  /** Relative path under the workspace root used for writable artifacts. */
  readonly outputDir?: string;
}

/**
 * Backend-neutral execution policy combining resource, network, and file rules.
 */
export interface SandboxPolicy {
  /** Resource ceilings applied to the sandbox. */
  readonly resources?: SandboxResourceLimits;
  /** Outbound network restrictions. */
  readonly network?: SandboxNetworkPolicy;
  /** Workspace and artifact exposure rules. */
  readonly files?: SandboxFileIOPolicy;
}

/**
 * Per-session runtime selection and backend-specific configuration.
 */
export interface SandboxRuntimeConfig {
  /** Explicit image override for the selected runtime. */
  readonly image?: string;
  /** Extra environment variables injected into the sandbox container. */
  readonly env?: Readonly<Record<string, string>>;
  /** Optional working directory override inside the container. */
  readonly workdir?: string;
  /** Additional bind mounts exposed to the sandbox. */
  readonly volumes?: readonly string[];
}

/**
 * Parameters used to create a long-lived sandbox session.
 */
export interface SandboxSessionRequest {
  /** Language/runtime family used to select the sandbox image. */
  readonly runtime: SandboxRuntime;
  /** Optional caller-provided stable session id. */
  readonly sessionId?: string;
  /** Host workspace root exposed to the sandbox. */
  readonly workspaceRoot: string;
  /** Optional working directory relative to the workspace root. */
  readonly cwd?: string;
  /** Execution policy applied to the session. */
  readonly policy?: SandboxPolicy;
  /** Backend/runtime configuration overrides. */
  readonly runtimeConfig?: SandboxRuntimeConfig;
}

/**
 * Live sandbox session metadata returned from `createSession()`.
 */
export interface SandboxSession {
  /** Stable session identifier. */
  readonly sessionId: string;
  /** Sandbox backend in use for this session. */
  readonly backend: string;
  /** Runtime family chosen for this session. */
  readonly runtime: SandboxRuntime;
  /** Concrete image used by the backend. */
  readonly image: string;
  /** Backend-native container or VM identifier. */
  readonly containerId: string;
  /** Host workspace root mounted into the sandbox. */
  readonly workspaceRoot: string;
  /** Host output directory used for writable artifacts. */
  readonly outputDir: string;
  /** ISO timestamp describing when the session was created. */
  readonly createdAt: string;
}

/**
 * Per-command execution request routed through an existing sandbox session.
 */
export interface SandboxExecutionRequest {
  /** Target sandbox session. */
  readonly sessionId: string;
  /** Shell command to execute inside the sandbox session. */
  readonly command: string;
  /** Optional working directory relative to the workspace root. */
  readonly cwd?: string;
  /** Command-scoped environment variables. */
  readonly env?: Readonly<Record<string, string>>;
  /** Command-scoped timeout override, in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional abort signal supplied by the caller. */
  readonly signal?: AbortSignal;
}

/**
 * Structured sandbox execution result. This intentionally remains a superset of
 * the existing host-terminal result shape so callers can migrate incrementally.
 */
export interface SandboxExecutionResult {
  /** Command string executed inside the sandbox. */
  readonly command: string;
  /** Runtime family selected for the session. */
  readonly runtime: SandboxRuntime;
  /** Container working directory used for execution. */
  readonly cwd: string;
  /** Exit code returned by the sandboxed command, or `null` on forced termination. */
  readonly exitCode: number | null;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Compatibility field matching the existing terminal-tool shape. */
  readonly output: string;
  /** Total execution duration in milliseconds. */
  readonly durationMs: number;
  /** Whether the command hit the configured timeout. */
  readonly timedOut: boolean;
  /** Backend-neutral structured status. */
  readonly status: SandboxExecutionStatus;
  /** Files produced in the writable sandbox area. */
  readonly artifacts: readonly SandboxArtifact[];
  /** Best-effort runtime resource usage. */
  readonly resourceUsage?: SandboxResourceUsage;
}

/**
 * Backend-neutral contract implemented by sandbox execution plugins.
 */
export interface SandboxContract {
  /** Stable backend identifier such as `docker`. */
  readonly backend: string;
  /** Returns `true` when the backing sandbox runtime is reachable. */
  isAvailable(): Promise<boolean>;
  /** Creates a reusable sandbox session. */
  createSession(request: SandboxSessionRequest): Promise<SandboxSession>;
  /** Executes a command inside an existing session. */
  exec(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  /** Destroys a sandbox session and releases all backend resources. */
  destroy(sessionId: string): Promise<void>;
}

/**
 * JSON Schema fragment describing {@link SandboxResourceLimits}.
 */
export const SANDBOX_RESOURCE_LIMITS_SCHEMA = {
  type: "object",
  properties: {
    cpuCores: { type: "number", minimum: 0 },
    memoryMb: { type: "integer", minimum: 1 },
    diskMb: { type: "integer", minimum: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    timeoutGraceMs: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const satisfies JsonObject;

/**
 * JSON Schema fragment describing {@link SandboxPolicy}.
 */
export const SANDBOX_POLICY_SCHEMA = {
  type: "object",
  properties: {
    resources: SANDBOX_RESOURCE_LIMITS_SCHEMA,
    network: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [...SANDBOX_NETWORK_MODES],
        },
        allowlist: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    files: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: [...SANDBOX_FILE_IO_MODES],
        },
        copyInPaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        copyOutPaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        outputDir: { type: "string", minLength: 1 },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const satisfies JsonObject;

/**
 * JSON Schema fragment describing {@link SandboxRuntimeConfig}.
 */
export const SANDBOX_RUNTIME_CONFIG_SCHEMA = {
  type: "object",
  properties: {
    image: { type: "string", minLength: 1 },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    workdir: { type: "string", minLength: 1 },
    volumes: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
  additionalProperties: false,
} as const satisfies JsonObject;

function assertRecord(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function parseOptionalStringRecord(
  input: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (input === undefined) {
    return undefined;
  }

  const record = assertRecord(input, label);
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    parsed[key] = value;
  }

  return parsed;
}

function parseOptionalStringArray(input: unknown, label: string): readonly string[] | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array of strings.`);
  }

  const parsed = input.map((value, index) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }

    return value;
  });

  return Object.freeze(parsed);
}

function parseNumber(
  input: unknown,
  label: string,
  integer: boolean,
): number | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "number" || Number.isNaN(input) || !Number.isFinite(input)) {
    throw new Error(`${label} must be a finite number.`);
  }

  if (integer && !Number.isInteger(input)) {
    throw new Error(`${label} must be an integer.`);
  }

  if (input <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }

  return input;
}

function parseEnumValue<TValue extends string>(
  input: unknown,
  label: string,
  values: readonly TValue[],
): TValue {
  if (typeof input !== "string" || !values.includes(input as TValue)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}.`);
  }

  return input as TValue;
}

/**
 * Validates and normalizes a partial sandbox policy object.
 */
export function parseSandboxPolicy(input: unknown): SandboxPolicy {
  const candidate = assertRecord(input, "sandbox policy");

  let resources: SandboxResourceLimits | undefined;
  if (candidate["resources"] !== undefined) {
    const source = assertRecord(candidate["resources"], "sandbox policy.resources");
    const cpuCores = parseNumber(source["cpuCores"], "sandbox policy.resources.cpuCores", false);
    const memoryMb = parseNumber(source["memoryMb"], "sandbox policy.resources.memoryMb", true);
    const diskMb = parseNumber(source["diskMb"], "sandbox policy.resources.diskMb", true);
    const timeoutMs = parseNumber(source["timeoutMs"], "sandbox policy.resources.timeoutMs", true);
    const timeoutGraceMs = parseNumber(
      source["timeoutGraceMs"],
      "sandbox policy.resources.timeoutGraceMs",
      true,
    );
    resources = {
      ...(cpuCores === undefined ? {} : { cpuCores }),
      ...(memoryMb === undefined ? {} : { memoryMb }),
      ...(diskMb === undefined ? {} : { diskMb }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(timeoutGraceMs === undefined ? {} : { timeoutGraceMs }),
    };
  }

  let network: SandboxNetworkPolicy | undefined;
  if (candidate["network"] !== undefined) {
    const source = assertRecord(candidate["network"], "sandbox policy.network");
    const allowlist = parseOptionalStringArray(
      source["allowlist"],
      "sandbox policy.network.allowlist",
    );
    network = {
      mode: parseEnumValue(source["mode"], "sandbox policy.network.mode", SANDBOX_NETWORK_MODES),
      ...(allowlist === undefined ? {} : { allowlist }),
    };
  }

  let files: SandboxFileIOPolicy | undefined;
  if (candidate["files"] !== undefined) {
    const source = assertRecord(candidate["files"], "sandbox policy.files");
    const outputDir = source["outputDir"];
    const copyInPaths = parseOptionalStringArray(
      source["copyInPaths"],
      "sandbox policy.files.copyInPaths",
    );
    const copyOutPaths = parseOptionalStringArray(
      source["copyOutPaths"],
      "sandbox policy.files.copyOutPaths",
    );
    if (outputDir !== undefined && (typeof outputDir !== "string" || outputDir.trim().length === 0)) {
      throw new Error("sandbox policy.files.outputDir must be a non-empty string.");
    }

    files = {
      mode: parseEnumValue(source["mode"], "sandbox policy.files.mode", SANDBOX_FILE_IO_MODES),
      ...(copyInPaths === undefined ? {} : { copyInPaths }),
      ...(copyOutPaths === undefined ? {} : { copyOutPaths }),
      ...(typeof outputDir === "string" ? { outputDir } : {}),
    };
  }

  return {
    ...(resources === undefined ? {} : { resources }),
    ...(network === undefined ? {} : { network }),
    ...(files === undefined ? {} : { files }),
  };
}

/**
 * Validates and normalizes a partial runtime-config object.
 */
export function parseSandboxRuntimeConfig(input: unknown): SandboxRuntimeConfig {
  const candidate = assertRecord(input, "sandbox runtime config");

  const image = candidate["image"];
  const env = parseOptionalStringRecord(candidate["env"], "sandbox runtime config.env");
  if (image !== undefined && (typeof image !== "string" || image.trim().length === 0)) {
    throw new Error("sandbox runtime config.image must be a non-empty string.");
  }

  const workdir = candidate["workdir"];
  const volumes = parseOptionalStringArray(candidate["volumes"], "sandbox runtime config.volumes");
  if (workdir !== undefined && (typeof workdir !== "string" || workdir.trim().length === 0)) {
    throw new Error("sandbox runtime config.workdir must be a non-empty string.");
  }

  return {
    ...(typeof image === "string" ? { image } : {}),
    ...(env === undefined ? {} : { env }),
    ...(typeof workdir === "string" ? { workdir } : {}),
    ...(volumes === undefined ? {} : { volumes }),
  };
}

/**
 * Deep-merges two sandbox-policy objects, preferring explicit values from
 * `next`.
 */
export function mergeSandboxPolicy(
  base: SandboxPolicy | undefined,
  next: SandboxPolicy | undefined,
): SandboxPolicy | undefined {
  if (base === undefined) {
    return next;
  }

  if (next === undefined) {
    return base;
  }

  const resources =
    base.resources === undefined
      ? next.resources
      : next.resources === undefined
        ? base.resources
        : {
            ...base.resources,
            ...next.resources,
          };

  const network =
    base.network === undefined
      ? next.network
      : next.network === undefined
        ? base.network
        : {
            ...base.network,
            ...next.network,
          };

  const files =
    base.files === undefined
      ? next.files
      : next.files === undefined
        ? base.files
        : {
            ...base.files,
            ...next.files,
          };

  return {
    ...(resources === undefined ? {} : { resources }),
    ...(network === undefined ? {} : { network }),
    ...(files === undefined ? {} : { files }),
  };
}
