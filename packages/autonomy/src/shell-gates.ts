// Shell gate runner and git working-tree snapshot. Adapted from Prime Agent's `autonomous/gates.rs`
// (PrimeIntellect-ai/prime-agent). Unlike Prime Agent, gate commands get a clean environment built
// from an allowlist, so a gate cannot read the server's secrets.
// Copyright (c) 2025-2026 Prime Intellect Ltd. MIT License; see THIRD_PARTY_NOTICES.md.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

import { getAgentCommandEnv, getShellConfig, killProcessTree } from "@generic-ai/tools";

import type { WorktreeSnapshot } from "./autonomous.js";
import type { GateCommandResult, GateRunner } from "./gates.js";

const MAX_CHILD_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 10_000;

const SNAPSHOT_EXCLUDES = ["node_modules", "dist", "coverage", ".turbo", "*.tsbuildinfo"];
const SNAPSHOT_GIT_OVERRIDES = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
  "--no-optional-locks",
];
const SNAPSHOT_STATUS_ARGS = [
  "status",
  "--porcelain=v1",
  "-z",
  "-uall",
  "--no-renames",
  "--ignore-submodules=none",
];
const SNAPSHOT_DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  "--binary",
  "HEAD",
  "--ignore-submodules=none",
];

export interface ShellGateRunnerOptions {
  readonly cwd: string;
  /** Environment for gate commands. Defaults to the clean agent-command environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Run gates with the server's whole environment. Off by default. */
  readonly inheritProcessEnv?: boolean | undefined;
  readonly shellPath?: string | undefined;
  /** Fingerprint the git working tree so a failed gate is not rerun on unchanged files. Default true. */
  readonly snapshots?: boolean | undefined;
}

export function createShellGateRunner(options: ShellGateRunnerOptions): GateRunner {
  const env =
    options.env ??
    getAgentCommandEnv(process.env, { inheritProcessEnv: options.inheritProcessEnv === true });
  return {
    runGate: (command, timeoutMs) =>
      runGateCommand(command, { cwd: options.cwd, env, timeoutMs, shellPath: options.shellPath }),
    ...(options.snapshots === false
      ? {}
      : { captureSnapshot: () => captureGitWorktreeSnapshot(options.cwd, env) }),
  };
}

export async function runGateCommand(
  command: string,
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly shellPath?: string | undefined;
  },
): Promise<GateCommandResult> {
  const shell = getShellConfig(options.shellPath);
  const viaStdin = shell.commandTransport === "stdin";
  return runChildProcess(
    shell.shell,
    viaStdin ? shell.args : [...shell.args, command],
    options.cwd,
    options.timeoutMs,
    options.env,
    viaStdin ? command : undefined,
  );
}

export async function captureGitWorktreeSnapshot(
  cwd: string,
  env: NodeJS.ProcessEnv = getAgentCommandEnv(),
): Promise<WorktreeSnapshot | undefined> {
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const pathspec = ["--", ".", ...SNAPSHOT_EXCLUDES.map((exclude) => `:(exclude)${exclude}`)];
  const gitEnv = { ...env, GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" };
  const status = await runGit([...SNAPSHOT_STATUS_ARGS, ...pathspec], cwd, gitEnv);
  if (status === undefined) {
    return undefined;
  }
  const diff = await runGit([...SNAPSHOT_DIFF_ARGS, ...pathspec], cwd, gitEnv);
  if (diff === undefined) {
    return undefined;
  }
  return { status, diff, untrackedHash: await hashUntrackedFiles(cwd, status) };
}

async function runGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const result = await runChildProcess(
      "git",
      [...SNAPSHOT_GIT_OVERRIDES, ...args],
      cwd,
      SNAPSHOT_TIMEOUT_MS,
      env,
    );
    if (
      result.status !== 0 ||
      result.error !== undefined ||
      result.timedOut ||
      result.outputTruncated
    ) {
      return undefined;
    }
    return result.stdout;
  } catch {
    return undefined;
  }
}

async function hashUntrackedFiles(cwd: string, status: string): Promise<string> {
  const aggregate = createHash("sha256");
  const paths = status
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .sort();
  for (const path of paths) {
    aggregate.update(path);
    aggregate.update("\0");
    aggregate.update(await hashUntrackedPath(join(cwd, path)));
    aggregate.update("\0");
  }
  return aggregate.digest("hex");
}

async function hashUntrackedPath(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return `symlink:${await readlink(path).catch((error: Error) => error.message)}`;
    }
    if (!info.isFile()) {
      return `other:${info.size}:${Math.floor(info.mtimeMs)}`;
    }
    return `file:${createHash("sha256")
      .update(await readFile(path))
      .digest("hex")}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : `error:${(error as Error).message}`;
  }
}

function runChildProcess(
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<GateCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd,
      env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        if (child.pid !== undefined) {
          killProcessTree(child.pid);
        }
      },
      Math.max(1, timeoutMs),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: code ?? undefined,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        outputTruncated: stdout.truncated() || stderr.truncated(),
      });
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function capture(stream: NodeJS.ReadableStream | null): {
  text(): string;
  truncated(): boolean;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream?.on("data", (chunk: Buffer) => {
    const room = MAX_CHILD_PROCESS_OUTPUT_BYTES - size;
    if (chunk.length > room) {
      truncated = true;
    }
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      chunks.push(kept);
      size += kept.length;
    }
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => truncated,
  };
}
