import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
  type BashSpawnHook,
} from "@generic-ai/sdk";
import {
  createWorkspaceLayout,
  resolveWorkspacePath,
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
}

export interface TerminalToolPlugin {
  readonly name: typeof name;
  readonly kind: typeof kind;
  readonly root: string;
  readonly unrestrictedLocal: boolean;
  readonly tool: ReturnType<typeof createBashTool>;
  run(request: TerminalRunRequest): Promise<TerminalRunResult>;
}

function mergeEnv(
  baseEnv: NodeJS.ProcessEnv | undefined,
  overrideEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(baseEnv ?? {}),
    ...(overrideEnv ?? {}),
  };
}

function buildSpawnHook(
  baseEnv: NodeJS.ProcessEnv | undefined,
  spawnHook: BashSpawnHook | undefined,
): BashSpawnHook | undefined {
  if (baseEnv === undefined && spawnHook === undefined) {
    return undefined;
  }

  return (context) => {
    const mergedContext = {
      ...context,
      env: mergeEnv(baseEnv, context.env),
    };

    return spawnHook ? spawnHook(mergedContext) : mergedContext;
  };
}

function applyCommandPrefix(command: string, commandPrefix: string | undefined): string {
  return commandPrefix && commandPrefix.trim().length > 0
    ? `${commandPrefix} ${command}`
    : command;
}

export function resolveTerminalCwd(root: WorkspaceRootInput, cwd?: string): string {
  const layout = createWorkspaceLayout(root);

  if (cwd === undefined || cwd.trim().length === 0 || cwd === ".") {
    return layout.root;
  }

  return resolveWorkspacePath(layout.root, cwd);
}

export function createTerminalToolPlugin(options: TerminalToolOptions): TerminalToolPlugin {
  const layout = createWorkspaceLayout(options.root);
  const operations = options.operations ?? createLocalBashOperations();
  const commandPrefix = options.commandPrefix;
  const spawnHook = buildSpawnHook(options.env, options.spawnHook);
  const unrestrictedLocal = options.unrestrictedLocal ?? true;
  const tool = createBashTool(layout.root, {
    operations,
    ...(commandPrefix === undefined ? {} : { commandPrefix }),
    ...(spawnHook === undefined ? {} : { spawnHook }),
  });

  return Object.freeze({
    name,
    kind,
    root: layout.root,
    unrestrictedLocal,
    tool,
    async run(request: TerminalRunRequest): Promise<TerminalRunResult> {
      const cwd = resolveTerminalCwd(layout.root, request.cwd);
      const command = applyCommandPrefix(request.command, commandPrefix);
      const outputChunks: string[] = [];
      const startedAt = Date.now();
      const executionOptions = {
        onData: (data: Buffer) => {
          outputChunks.push(data.toString("utf8"));
        },
        env: mergeEnv(options.env, request.env),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...((request.timeoutMs ?? options.defaultTimeoutMs) === undefined
          ? {}
          : { timeout: request.timeoutMs ?? options.defaultTimeoutMs }),
      };
      const result = await operations.exec(command, cwd, executionOptions);

      return Object.freeze({
        command,
        cwd,
        exitCode: result.exitCode,
        output: outputChunks.join(""),
        durationMs: Date.now() - startedAt,
        timedOut:
          (request.timeoutMs ?? options.defaultTimeoutMs) !== undefined &&
          result.exitCode === null,
        unrestrictedLocal,
      });
    },
  });
}
