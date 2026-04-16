#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const requiredNodeMajor = 24;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function readRepoFile(relativePath) {
  try {
    return readFileSync(join(repoRoot, relativePath), "utf8").trim();
  } catch {
    return undefined;
  }
}

function readPackageJson() {
  const packageJson = readRepoFile("package.json");
  return packageJson ? JSON.parse(packageJson) : {};
}

export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedNodeVersion(version, requiredMajor = requiredNodeMajor) {
  const parsed = parseNodeVersion(version);
  return parsed ? parsed.major >= requiredMajor : false;
}

export function formatNodeVersionError(version = process.version) {
  const packageJson = readPackageJson();
  const engineRange = packageJson.engines?.node ?? `>=${requiredNodeMajor}.0.0`;
  const nodePin = readRepoFile(".nvmrc") ?? String(requiredNodeMajor);
  const packageManager = packageJson.packageManager ?? "npm 11";

  return [
    `Unsupported Node.js version: ${version}.`,
    `Generic AI requires Node.js ${engineRange}; the repository .nvmrc pin is ${nodePin}.`,
    `Use "nvm use" from the repository root, or install Node ${requiredNodeMajor} LTS before running npm install, CI, or the starter example.`,
    `The npm workspace is pinned with packageManager: ${packageManager}.`,
  ].join("\n");
}

export function assertSupportedNodeVersion(version = process.version) {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(formatNodeVersionError(version));
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
