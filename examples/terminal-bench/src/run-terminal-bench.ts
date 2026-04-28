#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type TerminalBenchProfile = "smoke" | "quick" | "calibration" | "validation" | "full";

export interface HarborCommandPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface TerminalBenchRunOptions {
  readonly profile?: TerminalBenchProfile;
  readonly configPath?: string;
  readonly harborBin?: string;
  readonly model?: string;
  readonly adapter?: string;
  readonly dryRun?: boolean;
  readonly extraArgs?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const EXAMPLE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(EXAMPLE_ROOT, "..", "..");
const HARBOR_AGENT_PATH = resolve(EXAMPLE_ROOT, "harbor");
const DOCKER_COMPOSE_SHIM_DIR = resolve(EXAMPLE_ROOT, ".tmp", "docker-compose-shim");
const PYTHON_SITECUSTOMIZE_SHIM_DIR = resolve(EXAMPLE_ROOT, ".tmp", "python-sitecustomize");
const CONFIGS: Readonly<Record<TerminalBenchProfile, string>> = Object.freeze({
  smoke: resolve(EXAMPLE_ROOT, "configs", "smoke.job.yaml"),
  quick: resolve(EXAMPLE_ROOT, "configs", "quick.job.yaml"),
  calibration: resolve(EXAMPLE_ROOT, "configs", "calibration.job.yaml"),
  validation: resolve(EXAMPLE_ROOT, "configs", "validation.job.yaml"),
  full: resolve(EXAMPLE_ROOT, "configs", "full.job.yaml"),
});

function profileFromString(value: string): TerminalBenchProfile {
  if (
    value === "smoke" ||
    value === "quick" ||
    value === "calibration" ||
    value === "validation" ||
    value === "full"
  ) {
    return value;
  }

  throw new Error("--profile must be smoke, quick, calibration, validation, or full.");
}

function ensureWindowsHarborPythonShims(): readonly string[] {
  if (process.platform !== "win32") {
    return [];
  }

  if (commandSucceeds("docker", ["compose", "version"])) {
    return [];
  }

  if (!commandSucceeds("docker-compose", ["version"])) {
    return [];
  }

  mkdirSync(PYTHON_SITECUSTOMIZE_SHIM_DIR, { recursive: true });
  writeFileSync(
    resolve(PYTHON_SITECUSTOMIZE_SHIM_DIR, "sitecustomize.py"),
    [
      "import asyncio",
      "import os",
      "import shutil",
      "import sys",
      "",
      "_generic_ai_original_create_subprocess_exec = asyncio.create_subprocess_exec",
      "",
      "async def _generic_ai_create_subprocess_exec(*cmd, **kwargs):",
      "    if (",
      "        sys.platform == 'win32'",
      "        and len(cmd) >= 2",
      "        and cmd[0] == 'docker'",
      "        and cmd[1] == 'compose'",
      "        and os.environ.get('GENERIC_AI_HARBOR_DOCKER_COMPOSE_SHIM', '1') != '0'",
      "        and shutil.which('docker-compose') is not None",
      "    ):",
      "        cmd = ('docker-compose', *cmd[2:])",
      "    return await _generic_ai_original_create_subprocess_exec(*cmd, **kwargs)",
      "",
      "asyncio.create_subprocess_exec = _generic_ai_create_subprocess_exec",
      "",
    ].join("\n"),
    "utf-8",
  );

  return [PYTHON_SITECUSTOMIZE_SHIM_DIR];
}

function withPythonPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const existing = env["PYTHONPATH"];
  const pythonPaths = [...ensureWindowsHarborPythonShims(), HARBOR_AGENT_PATH];
  return {
    ...env,
    PYTHONPATH:
      existing === undefined || existing.length === 0
        ? pythonPaths.join(delimiter)
        : `${pythonPaths.join(delimiter)}${delimiter}${existing}`,
  };
}

function commandSucceeds(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, {
    shell: process.platform === "win32",
    stdio: "ignore",
  });
  return result.status === 0;
}

function withPathPrefix(env: NodeJS.ProcessEnv, prefix: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = env[pathKey];
  return {
    ...env,
    [pathKey]:
      current === undefined || current.length === 0 ? prefix : `${prefix}${delimiter}${current}`,
  };
}

function ensureWindowsDockerComposeShim(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return env;
  }

  if (commandSucceeds("docker", ["compose", "version"])) {
    return env;
  }

  if (!commandSucceeds("docker-compose", ["version"])) {
    return env;
  }

  mkdirSync(DOCKER_COMPOSE_SHIM_DIR, { recursive: true });
  writeFileSync(
    resolve(DOCKER_COMPOSE_SHIM_DIR, "docker.cmd"),
    [
      "@echo off",
      'if /I "%~1"=="compose" (',
      "  setlocal EnableDelayedExpansion",
      '  set "args=%*"',
      '  set "args=!args:~8!"',
      "  docker-compose.exe !args!",
      "  exit /b !ERRORLEVEL!",
      ")",
      "docker.exe %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
    "utf-8",
  );

  return withPathPrefix(env, DOCKER_COMPOSE_SHIM_DIR);
}

export function buildHarborCommandPlan(options: TerminalBenchRunOptions = {}): HarborCommandPlan {
  const env = withPythonPath(options.env ?? process.env);
  const profile = options.profile ?? "smoke";
  const configPath = resolve(options.configPath ?? CONFIGS[profile]);
  const command = options.harborBin ?? "harbor";
  const nextEnv: NodeJS.ProcessEnv = ensureWindowsDockerComposeShim({
    ...env,
    GENERIC_AI_REPO_ROOT: REPO_ROOT,
    GENERIC_AI_RUNTIME_ADAPTER:
      options.adapter ?? env["GENERIC_AI_RUNTIME_ADAPTER"] ?? "openai-codex",
    PYTHONIOENCODING: env["PYTHONIOENCODING"] ?? "utf-8",
    PYTHONUTF8: env["PYTHONUTF8"] ?? "1",
    TERM: env["TERM"] ?? "dumb",
    GENERIC_AI_HARBOR_DOCKER_COMPOSE_SHIM: env["GENERIC_AI_HARBOR_DOCKER_COMPOSE_SHIM"] ?? "1",
  });

  if (options.model !== undefined) {
    nextEnv["GENERIC_AI_MODEL"] = options.model;
  }

  return Object.freeze({
    command,
    args: Object.freeze(["run", "-c", configPath, ...(options.extraArgs ?? [])]),
    cwd: resolve(options.cwd ?? REPO_ROOT),
    env: nextEnv,
  });
}

function redactEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const redacted: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    redacted[key] = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) ? "<redacted>" : value;
  }

  return redacted;
}

function parseArgs(argv: readonly string[]): TerminalBenchRunOptions {
  const options: {
    profile?: TerminalBenchProfile;
    configPath?: string;
    harborBin?: string;
    model?: string;
    adapter?: string;
    dryRun?: boolean;
    extraArgs?: string[];
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--") {
      options.extraArgs = argv.slice(index + 1);
      break;
    }

    switch (arg) {
      case "--profile":
        if (next === undefined) {
          throw new Error("--profile requires a value.");
        }
        options.profile = profileFromString(next);
        index += 1;
        break;
      case "--config":
        if (next === undefined) {
          throw new Error("--config requires a value.");
        }
        options.configPath = next;
        index += 1;
        break;
      case "--harbor-bin":
        if (next === undefined) {
          throw new Error("--harbor-bin requires a value.");
        }
        options.harborBin = next;
        index += 1;
        break;
      case "--model":
        if (next === undefined) {
          throw new Error("--model requires a value.");
        }
        options.model = next;
        index += 1;
        break;
      case "--adapter":
        if (next === undefined) {
          throw new Error("--adapter requires a value.");
        }
        options.adapter = next;
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function runTerminalBench(options: TerminalBenchRunOptions = {}): Promise<number> {
  const plan = buildHarborCommandPlan(options);
  if (options.dryRun === true) {
    console.log(
      JSON.stringify(
        {
          command: plan.command,
          args: plan.args,
          cwd: plan.cwd,
          env: redactEnv(plan.env),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

const isCli =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const options = parseArgs(process.argv.slice(2));
  runTerminalBench(options)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
