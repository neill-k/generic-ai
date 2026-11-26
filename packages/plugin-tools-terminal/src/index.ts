import {
  GenericAIToolError,
  normalizeToolError,
  withAgentHarnessToolEffects,
  type ToolErrorEnvelope,
} from "@generic-ai/sdk";
import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
  type BashSpawnHook,
} from "@generic-ai/tools";
import {
  createWorkspaceLayout,
  resolveSafeWorkspacePath,
  type WorkspaceRootInput,
} from "@generic-ai/plugin-workspace-fs";

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

function buildSpawnHook(
  baseEnv: NodeJS.ProcessEnv | undefined,
  spawnHook: BashSpawnHook | undefined,
  inheritProcessEnv: boolean,
): BashSpawnHook | undefined {
  if (baseEnv === undefined && spawnHook === undefined && inheritProcessEnv) {
    return undefined;
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
  const spawnHook = buildSpawnHook(options.env, options.spawnHook, inheritProcessEnv);
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
        env: mergeEnv(options.env, request.env, inheritProcessEnv),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(timeoutSeconds === undefined ? {} : { timeout: timeoutSeconds }),
      };
      let result: Awaited<ReturnType<BashOperations["exec"]>>;
      try {
        result = await operations.exec(command, cwd, executionOptions);
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
