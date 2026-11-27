import {
  createWorkspaceLayout,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";
import {
  GenericAIToolError,
  normalizeToolError,
  type ToolErrorEnvelope,
  withAgentHarnessToolEffects,
} from "@generic-ai/sdk";
import {
  type BashOperations,
  type BashSpawnHook,
  createBashTool,
  createLocalBashOperations,
} from "@generic-ai/tools";

export const name = "@generic-ai/plugin-tools-terminal" as const;
export const kind = "tools-terminal" as const;

export interface TerminalToolOptions {
  readonly root: WorkspaceRootInput;
  readonly operations?: BashOperations;
  readonly commandPrefix?: string;
  readonly spawnHook?: BashSpawnHook;
  readonly env?: NodeJS.ProcessEnv;
  readonly inheritProcessEnv?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly unrestrictedLocal?: boolean;
  /**
   * Run every command as another OS user instead of the server's. See {@link TerminalRunAsUser}.
   * Cannot be combined with `inheritProcessEnv`.
   */
  readonly runAs?: TerminalRunAsUser;
}

/**
 * Runs agent commands as a separate, unprivileged OS user, so they cannot read or change what the
 * server's user owns: its files, its `/proc/<pid>/environ` and that of every process it starts
 * (MCP servers included), or signal those processes.
 *
 * Each command becomes `sudo -n -u <user> --preserve-env=<allowlisted names> -- setpriv
 * --pdeathsig TERM -- <shell> -c <supervisor> <command>`. The host must let the server's user run
 * commands as `user` without a password, and allow it to set the environment
 * (`server ALL=(agent) NOPASSWD:SETENV: ALL` in sudoers). Values travel in the environment of the
 * sudo process, never on its command line. The supervisor sets the umask, runs the command and,
 * when sudo dies (the tool killed the command's process group on a timeout or abort, which the
 * server's user may only do to sudo itself), kills every process of the command as `user`.
 */
export interface TerminalRunAsUser {
  readonly user: string;
  /** `HOME` for commands. Defaults to the workspace root, which `user` can write. */
  readonly home?: string;
  /** Default `0007`: files a command creates stay readable by the group the server shares. */
  readonly umask?: string;
  readonly sudoPath?: string;
  readonly setprivPath?: string;
  readonly shellPath?: string;
  /**
   * Resource limits for each command, so one heavy script cannot starve the server or the other
   * agents. Defaults to {@link DEFAULT_TERMINAL_COMMAND_LIMITS}; `false` turns them off. Limits are
   * set as both soft and hard limits, so a command cannot raise them again.
   */
  readonly limits?: TerminalCommandLimits | false;
}

/**
 * Per-command resource limits, applied with the shell's `ulimit` and `nice` before the command
 * starts. Every process the command starts inherits them. A field left out keeps its default; a
 * field set to `null` leaves that resource unlimited.
 *
 * `maxProcesses` counts every process of the OS user, so with one agent user it is shared by all
 * agents' commands. It still keeps a fork bomb from reaching the server, which runs as another user.
 */
export interface TerminalCommandLimits {
  /** Heap and other private writable memory per process, in MiB (`ulimit -d`). */
  readonly memoryMiB?: number | null;
  /** CPU seconds per process (`ulimit -t`). */
  readonly cpuSeconds?: number | null;
  /** Largest file a command may write, in MiB (`ulimit -f`). */
  readonly fileSizeMiB?: number | null;
  /** Open files per process (`ulimit -n`). */
  readonly openFiles?: number | null;
  /** Processes the OS user may have at once (`ulimit -u`). */
  readonly maxProcesses?: number | null;
  /** Scheduling niceness, 0 to 19, so the server stays responsive under load (`nice -n`). */
  readonly niceness?: number | null;
}

export const DEFAULT_TERMINAL_COMMAND_LIMITS = Object.freeze({
  memoryMiB: 4096,
  cpuSeconds: 3600,
  fileSizeMiB: 4096,
  openFiles: 4096,
  maxProcesses: 1024,
  niceness: 10,
}) satisfies Required<TerminalCommandLimits>;

function limitValue(name: string, value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid command limit ${name}: ${String(value)}.`);
  }
  return value;
}

/**
 * Shell lines that apply `limits` to everything started after them, and the `nice` prefix for the
 * command itself. Exported so other shell tools that run as the agent user apply the same limits.
 */
export function commandLimitScript(limits: TerminalCommandLimits | false | undefined): {
  readonly setup: readonly string[];
  readonly prefix: string;
} {
  if (limits === false) {
    return { setup: [], prefix: "" };
  }
  const merged = { ...DEFAULT_TERMINAL_COMMAND_LIMITS, ...limits };
  const flags: string[] = ["-c 0"];
  const memory = limitValue("memoryMiB", merged.memoryMiB);
  if (memory !== undefined) flags.push(`-d ${memory * 1024}`);
  const cpu = limitValue("cpuSeconds", merged.cpuSeconds);
  if (cpu !== undefined) flags.push(`-t ${cpu}`);
  const fileSize = limitValue("fileSizeMiB", merged.fileSizeMiB);
  if (fileSize !== undefined) flags.push(`-f ${fileSize * 1024}`);
  const openFiles = limitValue("openFiles", merged.openFiles);
  if (openFiles !== undefined) flags.push(`-n ${openFiles}`);
  const processes = limitValue("maxProcesses", merged.maxProcesses);
  if (processes !== undefined) flags.push(`-u ${processes}`);
  const niceness = limitValue("niceness", merged.niceness);
  if (niceness !== undefined && niceness > 19) {
    throw new Error(`Invalid command limit niceness: ${niceness}.`);
  }
  return {
    // One `ulimit` per resource: bash stops at the first flag it cannot set, and a host whose
    // hard limit is already lower than ours must still get the others.
    setup: flags.map((flag) => `ulimit ${flag} 2>/dev/null`),
    prefix: niceness === undefined || niceness === 0 ? "" : `nice -n ${niceness} `,
  };
}

export interface TerminalRunRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

export interface TerminalRunResult {
  readonly command: string;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly output: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly unrestrictedLocal: boolean;
  readonly error?: ToolErrorEnvelope;
}

export interface TerminalToolPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly unrestrictedLocal: boolean;
  readonly tool: ReturnType<typeof createBashTool>;
  run(request: TerminalRunRequest): Promise<TerminalRunResult>;
}

export class TerminalToolError extends GenericAIToolError {
  constructor(envelope: ToolErrorEnvelope, options: { readonly cause?: unknown } = {}) {
    super(envelope, options);
    this.name = "TerminalToolError";
  }
}

const MINIMAL_PROCESS_ENV_KEYS = new Set([
  "CI",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "Path",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "windir",
]);

function processEnvSnapshot(inheritProcessEnv: boolean): NodeJS.ProcessEnv {
  if (inheritProcessEnv) {
    return { ...process.env };
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

/** Session variables the bash tool sets for each command; safe to pass on. */
const BASH_SESSION_ENV_KEYS = new Set([
  "GENERIC_AI_SESSION_ID",
  "GENERIC_AI_PROVIDER",
  "GENERIC_AI_MODEL_ID",
  "GENERIC_AI_REASONING_LEVEL",
]);

function allowlistedEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (
      value !== undefined &&
      (MINIMAL_PROCESS_ENV_KEYS.has(key) || BASH_SESSION_ENV_KEYS.has(key) || key.startsWith("LC_"))
    ) {
      result[key] = value;
    }
  }
  return result;
}

function mergeEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  overrideEnv: NodeJS.ProcessEnv | undefined,
  inheritProcessEnv: boolean,
): NodeJS.ProcessEnv {
  return {
    ...processEnvSnapshot(inheritProcessEnv),
    ...(baseEnv ?? {}),
    ...(overrideEnv ?? {}),
  };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WrapCommandForUserOptions {
  /**
   * Hand the command the caller's stdin. By default a command gets no stdin (the supervisor runs
   * it in the background, which gives it `/dev/null`); a long-lived process that talks over stdin,
   * such as the Python workspace kernel, needs this.
   */
  readonly keepStdin?: boolean;
}

/** Rewrites a command and its environment so it runs as `runAs.user`. */
export function wrapCommandForUser(
  command: string,
  env: NodeJS.ProcessEnv,
  runAs: TerminalRunAsUser,
  workspaceRoot: string,
  options: WrapCommandForUserOptions = {},
): { readonly command: string; readonly env: NodeJS.ProcessEnv } {
  if (!/^[a-z_][a-z0-9_-]*$/i.test(runAs.user)) {
    throw new Error(`Invalid runAs user "${runAs.user}".`);
  }
  const umask = runAs.umask ?? "0007";
  if (!/^[0-7]{3,4}$/.test(umask)) {
    throw new Error(`Invalid runAs umask "${umask}".`);
  }
  const shell = runAs.shellPath ?? "/bin/bash";
  const outerEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && ENV_NAME.test(key)) {
      outerEnv[key] = value;
    }
  }
  outerEnv["HOME"] = runAs.home ?? workspaceRoot;
  outerEnv["USER"] = runAs.user;
  outerEnv["LOGNAME"] = runAs.user;
  const limits = commandLimitScript(runAs.limits);
  const supervisor = [
    ...(options.keepStdin === true ? ["exec 3<&0"] : []),
    `umask ${umask}`,
    ...limits.setup,
    'trap "kill -KILL 0" TERM HUP INT',
    options.keepStdin === true
      ? `${limits.prefix}${shellQuote(shell)} -c "$1" <&3 3<&- & wait "$!"`
      : `${limits.prefix}${shellQuote(shell)} -c "$1" & wait "$!"`,
  ].join("; ");
  const wrapped = [
    "exec",
    shellQuote(runAs.sudoPath ?? "sudo"),
    "-n",
    "-u",
    runAs.user,
    `--preserve-env=${Object.keys(outerEnv).sort().join(",")}`,
    "--",
    shellQuote(runAs.setprivPath ?? "setpriv"),
    "--pdeathsig",
    "TERM",
    "--",
    shellQuote(shell),
    "-c",
    shellQuote(supervisor),
    "generic-ai-agent-command",
    shellQuote(command),
  ].join(" ");
  return { command: wrapped, env: outerEnv };
}

/**
 * Runs a long-lived process (argv, not a shell command) as `runAs.user` with the same limits as
 * agent commands, keeping its stdin: for example the Python workspace kernel's `launch` hook.
 */
export function wrapProcessForUser(
  launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
  },
  runAs: TerminalRunAsUser,
  workspaceRoot: string,
): { readonly command: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv } {
  const command = ["exec", ...[launch.command, ...launch.args].map(shellQuote)].join(" ");
  const wrapped = wrapCommandForUser(command, launch.env, runAs, workspaceRoot, {
    keepStdin: true,
  });
  return {
    command: runAs.shellPath ?? "/bin/bash",
    args: ["-c", wrapped.command],
    env: wrapped.env,
  };
}

function buildSpawnHook(
  baseEnv: NodeJS.ProcessEnv | undefined,
  spawnHook: BashSpawnHook | undefined,
  inheritProcessEnv: boolean,
  runAs?: { readonly user: TerminalRunAsUser; readonly root: string },
): BashSpawnHook | undefined {
  if (baseEnv === undefined && spawnHook === undefined && inheritProcessEnv) {
    return undefined;
  }
  if (runAs !== undefined) {
    const inner = buildSpawnHook(baseEnv, spawnHook, inheritProcessEnv);
    return (context) => {
      const prepared = inner ? inner(context) : context;
      return {
        ...prepared,
        ...wrapCommandForUser(prepared.command, prepared.env, runAs.user, runAs.root),
      };
    };
  }

  return (context) => {
    // The bash tool hands the hook the server's whole environment (plus its
    // own session variables). Unless the caller opted in, keep only the
    // allowlisted keys, so provider keys, DATABASE_URL and the like never
    // reach agent commands.
    const ambientEnv = inheritProcessEnv ? context.env : allowlistedEnv(context.env);
    const mergedContext = {
      ...context,
      env: mergeEnv(baseEnv, ambientEnv, inheritProcessEnv),
    };

    return spawnHook ? spawnHook(mergedContext) : mergedContext;
  };
}

function applyCommandPrefix(command: string, commandPrefix: string | undefined): string {
  // Join with a newline so prefix commands like `export FOO=bar` or `source
  // setup.sh` still execute their own setup before the caller's command, which
  // matches how pi's `createBashTool` treats commandPrefix.
  return commandPrefix && commandPrefix.trim().length > 0
    ? `${commandPrefix}\n${command}`
    : command;
}

export async function resolveTerminalCwd(root: WorkspaceRootInput, cwd?: string): Promise<string> {
  const layout = createWorkspaceLayout(root);

  if (cwd === undefined || cwd.trim().length === 0 || cwd === ".") {
    return resolveSafeWorkspacePath(layout.root);
  }

  return resolveSafeWorkspacePath(layout.root, cwd);
}

export function createTerminalToolPlugin(options: TerminalToolOptions): TerminalToolPlugin {
  const layout = createWorkspaceLayout(options.root);
  const operations = options.operations ?? createLocalBashOperations();
  const commandPrefix = options.commandPrefix;
  const inheritProcessEnv = options.inheritProcessEnv ?? false;
  if (options.runAs !== undefined && inheritProcessEnv) {
    throw new Error("runAs cannot be combined with inheritProcessEnv.");
  }
  const runAs =
    options.runAs === undefined ? undefined : { user: options.runAs, root: layout.root };
  const spawnHook = buildSpawnHook(options.env, options.spawnHook, inheritProcessEnv, runAs);
  const unrestrictedLocal = options.unrestrictedLocal ?? true;
  const tool = withAgentHarnessToolEffects(
    createBashTool(layout.root, {
      operations,
      inheritProcessEnv,
      ...(commandPrefix === undefined ? {} : { commandPrefix }),
      ...(spawnHook === undefined ? {} : { spawnHook }),
    }),
    {
      id: "terminal.bash",
      label: "Local bash",
      description: "Executes local workspace commands through the configured pi bash backend.",
      effects: ["process.spawn", "fs.read", "fs.write", "network.egress"],
      reversibility: "irreversible",
      retrySemantics: "retry-may-duplicate",
    },
  );

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    unrestrictedLocal,
    tool,
    async run(request: TerminalRunRequest): Promise<TerminalRunResult> {
      const cwd = await resolveTerminalCwd(layout.root, request.cwd);
      const command = applyCommandPrefix(request.command, commandPrefix);
      const env = mergeEnv(options.env, request.env, inheritProcessEnv);
      const prepared =
        runAs === undefined
          ? { command, env }
          : wrapCommandForUser(command, env, runAs.user, runAs.root);
      const outputChunks: string[] = [];
      const startedAt = Date.now();
      // BashOperations.exec expects `timeout` in seconds (pi's default
      // backend schedules `setTimeout(..., timeout * 1000)`), but our public
      // API is specified in milliseconds. Convert here so a caller passing
      // `timeoutMs: 1000` actually times out after one second rather than
      // ~16 minutes.
      const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs;
      const timeoutSeconds =
        timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(timeoutMs / 1000));
      const executionOptions = {
        onData: (data: Buffer) => {
          outputChunks.push(data.toString("utf8"));
        },
        env: prepared.env,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
      };
      let result: Awaited<ReturnType<BashOperations["exec"]>>;
      try {
        result = await operations.exec(prepared.command, cwd, executionOptions);
      } catch (error) {
        throw new TerminalToolError(
          normalizeToolError({
            error,
            metadata: {
              toolRef: "terminal.bash",
            },
          }),
          { cause: error },
        );
      }
      const durationMs = Date.now() - startedAt;
      const timedOut = timeoutMs !== undefined && result.exitCode === null;
      const structuredError =
        timedOut && timeoutMs !== undefined
          ? normalizeToolError({
              error: new Error(`Command timed out after ${timeoutMs}ms.`),
              kind: "timeout",
              safeMessage: `Command timed out after ${timeoutMs}ms.`,
              timeoutBudget: {
                totalMs: timeoutMs,
                spentMs: durationMs,
                remainingMs: 0,
                exhausted: true,
              },
              metadata: {
                toolRef: "terminal.bash",
              },
            })
          : undefined;

      return Object.freeze({
        command,
        cwd,
        exitCode: result.exitCode,
        output: outputChunks.join(""),
        durationMs,
        timedOut,
        unrestrictedLocal,
        ...(structuredError === undefined ? {} : { error: structuredError }),
      });
    },
  });
}
