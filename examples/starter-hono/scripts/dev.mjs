#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const tscBin = resolve(repoRoot, "node_modules", "typescript", "bin", "tsc");
const children = new Set();
let shuttingDown = false;

function spawnManaged(command, args) {
  const child = spawn(command, args, {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) {
      shutdown(code ?? (signal === null ? 1 : 0));
    }
  });
  return child;
}

function runOnce(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("exit", (code) => resolveRun(code ?? 1));
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = code;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const buildCode = await runOnce(process.execPath, [tscBin, "-b"]);
if (buildCode !== 0) {
  process.exitCode = buildCode;
} else {
  spawnManaged(process.execPath, [
    tscBin,
    "-b",
    "--watch",
    "--preserveWatchOutput",
    "false",
  ]);
  spawnManaged(process.execPath, ["--watch", "dist/run.js"]);
}
