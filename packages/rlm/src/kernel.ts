// The host side of the Python workspace kernel (`kernel.py`): starts the process, speaks its JSON
// line protocol, runs cells, answers the kernel's host requests and interrupts runaway cells.
// The protocol follows Prime Agent's REPL runtime (prime-agent-runtime/src/rlm/repl.md), MIT.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getAgentCommandEnv, killProcessTree } from "@generic-ai/tools";

/** The kernel source file, shipped next to `dist` in the package. */
export const KERNEL_SCRIPT_PATH = fileURLToPath(new URL("../python/kernel.py", import.meta.url));

export interface KernelLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export interface PythonKernelOptions {
  readonly cwd: string;
  /** Python executable. Defaults to `GENERIC_AI_PYTHON` or `python3`. */
  readonly python?: string | undefined;
  /** Environment for the kernel. Defaults to the agent command allowlist (`getAgentCommandEnv`). */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Rewrite the launch, for example to run the kernel as another OS user. */
  readonly launch?: ((input: KernelLaunch) => KernelLaunch) | undefined;
  /** Answer a request the kernel's code made (`rlm.llm`, `rlm.tool`...). */
  readonly onHostRequest?:
    | ((request: KernelHostRequest, signal: AbortSignal) => Promise<unknown>)
    | undefined;
  /** How long to wait for the kernel to start. Defaults to 15 seconds. */
  readonly startTimeoutMs?: number | undefined;
}

export interface KernelHostRequest {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type KernelOutputPart =
  | { readonly kind: "stdout" | "stderr"; readonly text: string }
  | { readonly kind: "result"; readonly text: string };

export interface KernelError {
  readonly ename: string;
  readonly evalue: string;
  readonly traceback: readonly string[];
}

export interface KernelExecution {
  readonly status: "ok" | "error";
  /** Output in the order it arrived. Raw process output during the cell is included as stderr. */
  readonly output: readonly KernelOutputPart[];
  readonly error?: KernelError;
  /** The cell ran past its timeout and was interrupted. */
  readonly timedOut?: boolean;
  /** The kernel had to be restarted, so the workspace's variables are gone. */
  readonly restarted?: boolean;
}

export interface KernelVariable {
  readonly type: string;
  readonly length?: number;
  readonly preview: string;
}

export interface ExecuteOptions {
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface PendingRequest {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly output?: KernelOutputPart[];
  error?: KernelError;
}

/** After an interrupt, how long a cell may take to stop before the kernel is restarted. */
const INTERRUPT_GRACE_MS = 3_000;

export class PythonKernelError extends Error {}

export class PythonKernel {
  readonly #options: PythonKernelOptions;
  #process: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #pending = new Map<string, PendingRequest>();
  #hostAborts = new Map<string, AbortController>();
  #nextId = 0;
  #buffer = "";
  #activeId: string | undefined;
  #exitError: Error | undefined;
  #pythonVersion: string | undefined;
  #stderrTail = "";

  constructor(options: PythonKernelOptions) {
    this.#options = options;
  }

  /** The kernel's Python version, once started. */
  get pythonVersion(): string | undefined {
    return this.#pythonVersion;
  }

  get running(): boolean {
    return this.#process !== undefined && this.#exitError === undefined;
  }

  /** Start the kernel if it is not running. */
  start(): Promise<void> {
    if (this.running && this.#starting !== undefined) return this.#starting;
    this.#starting = this.#spawn();
    return this.#starting;
  }

  #spawn(): Promise<void> {
    const python = this.#options.python ?? process.env["GENERIC_AI_PYTHON"] ?? "python3";
    if (!existsSync(KERNEL_SCRIPT_PATH)) {
      return Promise.reject(new PythonKernelError(`Kernel script missing: ${KERNEL_SCRIPT_PATH}`));
    }
    let launch: KernelLaunch = {
      command: python,
      args: ["-u", KERNEL_SCRIPT_PATH],
      env: { ...(this.#options.env ?? getAgentCommandEnv()), PYTHONIOENCODING: "utf-8" },
      cwd: this.#options.cwd,
    };
    if (this.#options.launch !== undefined) launch = this.#options.launch(launch);
    this.#exitError = undefined;
    this.#buffer = "";
    this.#stderrTail = "";
    const child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.#process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {});

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new PythonKernelError("The Python kernel did not start in time"));
        this.#kill();
      }, this.#options.startTimeoutMs ?? 15_000);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const ready = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      child.stdout.on("data", (chunk: string) => this.#onStdout(chunk, ready));
      child.stderr.on("data", (chunk: string) => this.#onRawOutput(chunk));
      child.once("error", (error) => {
        const message =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `Python not found ("${launch.command}"). Install Python 3 or set GENERIC_AI_PYTHON.`
            : `The Python kernel failed: ${error.message}`;
        this.#onExit(new PythonKernelError(message));
        fail(new PythonKernelError(message));
      });
      child.once("exit", (code, signal) => {
        const tail = this.#stderrTail.trim();
        const error = new PythonKernelError(
          `The Python kernel exited (code ${code ?? "none"}, signal ${signal ?? "none"})${
            tail.length > 0 ? `: ${tail.slice(-500)}` : ""
          }`,
        );
        this.#onExit(error);
        fail(error);
      });
    });
  }

  #onExit(error: Error): void {
    if (this.#exitError !== undefined) return;
    this.#exitError = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const controller of this.#hostAborts.values()) controller.abort();
    this.#hostAborts.clear();
    this.#activeId = undefined;
  }

  #onStdout(chunk: string, ready: () => void): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length > 0) {
        try {
          this.#onFrame(JSON.parse(line) as Record<string, unknown>, ready);
        } catch {
          // A malformed frame is dropped rather than failing the kernel.
        }
      }
      index = this.#buffer.indexOf("\n");
    }
  }

  #onRawOutput(chunk: string): void {
    this.#stderrTail = (this.#stderrTail + chunk).slice(-4_000);
    const active = this.#activeId === undefined ? undefined : this.#pending.get(this.#activeId);
    active?.output?.push({ kind: "stderr", text: chunk });
  }

  #onFrame(frame: Record<string, unknown>, ready: () => void): void {
    const id = typeof frame["id"] === "string" ? frame["id"] : undefined;
    switch (frame["event"]) {
      case "ready":
        this.#pythonVersion = typeof frame["python"] === "string" ? frame["python"] : undefined;
        ready();
        return;
      case "stdout":
      case "stderr": {
        const target = this.#pending.get(id ?? this.#activeId ?? "");
        target?.output?.push({ kind: frame["event"], text: String(frame["text"] ?? "") });
        return;
      }
      case "result":
        this.#pending
          .get(id ?? "")
          ?.output?.push({ kind: "result", text: String(frame["text"] ?? "") });
        return;
      case "error": {
        const pending = this.#pending.get(id ?? "");
        if (pending !== undefined) {
          pending.error = {
            ename: String(frame["ename"] ?? "Error"),
            evalue: String(frame["evalue"] ?? ""),
            traceback: Array.isArray(frame["traceback"]) ? frame["traceback"].map(String) : [],
          };
        }
        return;
      }
      case "host_request":
        if (id !== undefined) void this.#answerHostRequest(id, frame["data"]);
        return;
      case "done": {
        const pending = this.#pending.get(id ?? "");
        if (pending !== undefined) {
          this.#pending.delete(id ?? "");
          pending.resolve(frame);
        }
        return;
      }
      default:
        return;
    }
  }

  async #answerHostRequest(id: string, data: unknown): Promise<void> {
    const controller = new AbortController();
    this.#hostAborts.set(id, controller);
    let reply: { status: "ok"; result: unknown } | { status: "error"; error: string };
    try {
      const handler = this.#options.onHostRequest;
      if (handler === undefined) throw new Error("This workspace has no host helpers");
      if (
        typeof data !== "object" ||
        data === null ||
        typeof (data as { type?: unknown }).type !== "string"
      ) {
        throw new Error("Malformed host request");
      }
      reply = {
        status: "ok",
        result: (await handler(data as KernelHostRequest, controller.signal)) ?? {},
      };
    } catch (error) {
      reply = { status: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#hostAborts.delete(id);
    }
    if (!controller.signal.aborted) this.#write({ type: "host_reply", id, data: reply });
  }

  #write(request: Record<string, unknown>): void {
    this.#process?.stdin.write(`${JSON.stringify(request)}\n`);
  }

  async #request(
    request: Record<string, unknown>,
    output?: KernelOutputPart[],
  ): Promise<{ frame: Record<string, unknown>; error?: KernelError }> {
    await this.start();
    if (this.#exitError !== undefined) throw this.#exitError;
    const id = `r${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (frame) =>
          resolve(pending.error === undefined ? { frame } : { frame, error: pending.error }),
        reject,
        ...(output === undefined ? {} : { output }),
      };
      this.#pending.set(id, pending);
      if (request["type"] === "execute") this.#activeId = id;
      this.#write({ ...request, id });
    });
  }

  /** Run one cell. A cell past its timeout, or whose signal aborts, is interrupted. */
  async execute(code: string, options: ExecuteOptions = {}): Promise<KernelExecution> {
    const output: KernelOutputPart[] = [];
    let timedOut = false;
    let restarted = false;
    let stopTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const interrupt = () => {
      this.#write({ type: "interrupt" });
      graceTimer ??= setTimeout(() => {
        // The cell ignored the interrupt (a C call that never returns): restart the kernel.
        restarted = true;
        this.#kill();
      }, INTERRUPT_GRACE_MS);
    };
    const onAbort = () => interrupt();
    if (options.signal?.aborted) {
      return {
        status: "error",
        output,
        error: { ename: "KeyboardInterrupt", evalue: "aborted", traceback: [] },
      };
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      stopTimer = setTimeout(() => {
        timedOut = true;
        interrupt();
      }, options.timeoutMs);
    }
    try {
      const { frame, error } = await this.#request({ type: "execute", code }, output);
      return {
        status: frame["status"] === "ok" ? "ok" : "error",
        output,
        ...(error === undefined ? {} : { error }),
        ...(timedOut ? { timedOut } : {}),
      };
    } catch (error) {
      if (!restarted) throw error;
      return {
        status: "error",
        output,
        error: {
          ename: "KernelRestarted",
          evalue: "The cell did not stop when interrupted, so the kernel was restarted",
          traceback: [],
        },
        ...(timedOut ? { timedOut } : {}),
        restarted,
      };
    } finally {
      clearTimeout(stopTimer);
      clearTimeout(graceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      this.#activeId = undefined;
    }
  }

  /** Put JSON values into the workspace as variables. */
  async setVariables(values: Readonly<Record<string, unknown>>): Promise<void> {
    const { frame } = await this.#request({ type: "set_vars", vars: values });
    if (frame["status"] !== "ok") throw new PythonKernelError(String(frame["reason"]));
  }

  /** The workspace's variables: type, length and a short preview of each. */
  async describe(): Promise<Record<string, KernelVariable>> {
    const { frame } = await this.#request({ type: "describe" });
    if (frame["status"] !== "ok") throw new PythonKernelError(String(frame["reason"]));
    return (frame["variables"] ?? {}) as Record<string, KernelVariable>;
  }

  /** Pickle the workspace's variables to `path`. Values that cannot be pickled are skipped. */
  async snapshot(path: string): Promise<{ saved: string[]; skipped: string[] }> {
    const { frame } = await this.#request({ type: "snapshot", path });
    if (frame["status"] !== "ok") throw new PythonKernelError(String(frame["reason"]));
    return { saved: frame["saved"] as string[], skipped: frame["skipped"] as string[] };
  }

  /** Load variables saved by `snapshot`. A missing file restores nothing. */
  async restore(path: string): Promise<{ restored: string[]; failed: string[] }> {
    const { frame } = await this.#request({ type: "restore", path });
    if (frame["status"] !== "ok") throw new PythonKernelError(String(frame["reason"]));
    return { restored: frame["restored"] as string[], failed: frame["failed"] as string[] };
  }

  #kill(): void {
    const child = this.#process;
    if (child?.pid !== undefined && child.exitCode === null) {
      if (process.platform === "win32") child.kill();
      else killProcessTree(child.pid);
    }
  }

  /** Stop the kernel. The next request starts a fresh one. */
  async dispose(): Promise<void> {
    const child = this.#process;
    if (child === undefined) return;
    this.#process = undefined;
    this.#starting = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid !== undefined) killProcessTree(child.pid);
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end(`${JSON.stringify({ type: "shutdown" })}\n`);
    });
  }
}
