import type { PiCapabilityBindings } from "@generic-ai/core";
import type {
  AgentTaskExecutionInput,
  AgentTaskExecutionResult,
  AgentTaskExecutor,
} from "@generic-ai/sdk";

/**
 * The no-progress check that replaces the fixed 20-minute turn limit (decision 31). A turn may run
 * as long as it keeps making progress. It is stopped, and retried from the queue, when either:
 *
 * - it stalls: no tool call starts or finishes for `idleMs` while no tool is running (a model
 *   request or the harness hanging); a tool that is still running counts as progress, because
 *   every tool carries its own timeout; or
 * - it loops: the agent makes the same tool call with the same arguments `maxRepeats` times in a
 *   row, which never moves the work forward.
 *
 * A stopped turn fails as retryable, so the queue gives it another attempt.
 */
export interface NoProgressOptions {
  /** Longest quiet stretch with no tool activity. Defaults to 15 minutes. */
  readonly idleMs?: number;
  /** Identical consecutive tool calls that count as a loop. Defaults to 8. */
  readonly maxRepeats?: number;
  /** How often the stall check runs. Defaults to a tenth of `idleMs`, at most 30 seconds. */
  readonly checkEveryMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_NO_PROGRESS_IDLE_MS = 15 * 60_000;
export const DEFAULT_NO_PROGRESS_REPEATS = 8;

export class NoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProgressError";
  }
}

interface ToolLike {
  readonly name?: string;
  readonly execute: (...args: never[]) => unknown;
}

/** Tracks tool activity for one turn and aborts it when it stops making progress. */
export class TurnProgressMonitor {
  readonly controller = new AbortController();
  private lastActivity: number;
  private running = 0;
  private lastCall: string | undefined;
  private repeats = 0;
  private stopped: NoProgressError | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly idleMs: number;
  private readonly maxRepeats: number;
  private readonly now: () => number;

  constructor(options: NoProgressOptions = {}, parent?: AbortSignal) {
    this.idleMs = options.idleMs ?? DEFAULT_NO_PROGRESS_IDLE_MS;
    this.maxRepeats = options.maxRepeats ?? DEFAULT_NO_PROGRESS_REPEATS;
    this.now = options.now ?? Date.now;
    this.lastActivity = this.now();
    const every = options.checkEveryMs ?? Math.min(30_000, Math.max(10, this.idleMs / 10));
    this.timer = setInterval(() => this.check(), every);
    this.timer.unref?.();
    if (parent !== undefined) {
      if (parent.aborted) {
        this.controller.abort(parent.reason);
      } else {
        parent.addEventListener("abort", () => this.controller.abort(parent.reason), {
          once: true,
        });
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Why the turn was stopped for lack of progress, if it was. */
  get reason(): NoProgressError | undefined {
    return this.stopped;
  }

  check(): void {
    if (this.stopped !== undefined || this.running > 0) {
      return;
    }
    const quietMs = this.now() - this.lastActivity;
    if (quietMs >= this.idleMs) {
      this.stop(
        `The turn made no progress for ${Math.round(quietMs / 60_000)} minutes (no tool activity), so it was stopped and will be retried.`,
      );
    }
  }

  wrap<T extends ToolLike>(tool: T): T {
    const execute = tool.execute as unknown as (...args: unknown[]) => unknown;
    const name = tool.name ?? "tool";
    const wrapped = async (...args: unknown[]) => {
      this.started(name, args[1]);
      try {
        return await execute.apply(tool, args);
      } finally {
        this.finished();
      }
    };
    return { ...tool, execute: wrapped } as T;
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  private started(name: string, params: unknown): void {
    this.running += 1;
    this.lastActivity = this.now();
    let key: string;
    try {
      key = `${name}:${JSON.stringify(params ?? null)}`;
    } catch {
      key = `${name}:?`;
    }
    this.repeats = key === this.lastCall ? this.repeats + 1 : 1;
    this.lastCall = key;
    if (this.repeats >= this.maxRepeats) {
      this.stop(
        `The turn repeated the same ${name} call ${this.repeats} times in a row without moving forward, so it was stopped and will be retried.`,
      );
    }
  }

  private finished(): void {
    this.running = Math.max(0, this.running - 1);
    this.lastActivity = this.now();
  }

  private stop(message: string): void {
    if (this.stopped !== undefined) {
      return;
    }
    this.stopped = new NoProgressError(message);
    this.controller.abort(this.stopped);
  }
}

/** Wraps every tool in a turn's bindings so the monitor sees each call. */
export function monitorCapabilities(
  bindings: PiCapabilityBindings,
  monitor: TurnProgressMonitor,
): PiCapabilityBindings {
  const record = bindings as unknown as {
    readonly fileTools?: { readonly piTools: readonly ToolLike[] };
    readonly terminalTools?: { readonly tool: ToolLike };
    readonly customTools?: readonly ToolLike[];
  };
  return {
    ...bindings,
    ...(record.fileTools === undefined
      ? {}
      : {
          fileTools: {
            ...record.fileTools,
            piTools: record.fileTools.piTools.map((tool) => monitor.wrap(tool)),
          },
        }),
    ...(record.terminalTools === undefined
      ? {}
      : {
          terminalTools: {
            ...record.terminalTools,
            tool: monitor.wrap(record.terminalTools.tool),
          },
        }),
    ...(record.customTools === undefined
      ? {}
      : { customTools: record.customTools.map((tool) => monitor.wrap(tool)) }),
  } as PiCapabilityBindings;
}

/**
 * Runs `execute` under a progress monitor. `run` receives the monitor so the caller can wrap the
 * turn's tools and pass `monitor.signal` to the harness.
 */
export async function runWithProgressCheck(
  input: AgentTaskExecutionInput,
  options: NoProgressOptions,
  run: (
    input: AgentTaskExecutionInput,
    monitor: TurnProgressMonitor,
  ) => ReturnType<AgentTaskExecutor>,
): Promise<AgentTaskExecutionResult> {
  const monitor = new TurnProgressMonitor(options, input.signal);
  try {
    const result = await run({ ...input, signal: monitor.signal }, monitor);
    const reason = monitor.reason;
    if (reason === undefined) {
      return result;
    }
    // A cancelled harness run is normally final; a turn stopped for lack of progress is retried.
    const { retryable: _retryable, ...rest } = result;
    return { ...rest, status: "failed", failureMessage: reason.message };
  } finally {
    monitor.dispose();
  }
}
