#!/usr/bin/env node
// Keeps the npm metadata of every public package in packages/* consistent, so a package can be
// published without hand-editing its package.json first.
//
//   node scripts/package-metadata.mjs          report drift and exit 1 if any (used by lint)
//   node scripts/package-metadata.mjs --write  fix the drift in place
//
// It owns only publishing metadata (repository, homepage, bugs, license, keywords, engines,
// publishConfig, exports for packages that had none) and the per-package LICENSE copy. It never touches
// dependencies, scripts or source, and it keeps existing keys where they are (new keys go at the
// end) so it does not fight with other changes to the same files.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(repoRoot, "packages");
const write = process.argv.includes("--write");

const REPO_URL = "https://github.com/neill-k/generic-ai";
const ENGINES_NODE = ">=24.0.0";
const LICENSE_TEXT = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

function expectedMetadata(pkg, dirName) {
  const next = structuredClone(pkg);
  const directory = `packages/${dirName}`;

  next.repository = { type: "git", url: `git+${REPO_URL}.git`, directory };
  next.homepage = `${REPO_URL}/tree/main/${directory}#readme`;
  next.bugs = { url: `${REPO_URL}/issues` };
  next.license = "MIT";
  if (!Array.isArray(next.keywords) || next.keywords.length === 0) {
    next.keywords = ["generic-ai", "ai-agents", "multi-agent"];
  }
  next.engines = { ...(next.engines ?? {}), node: ENGINES_NODE };
  next.private = false;
  next.publishConfig = { ...(next.publishConfig ?? {}), access: "public", provenance: true };

  // npm always packs LICENSE and README, so "files" only needs the build output; it is left as is.
  if (!Array.isArray(next.files)) next.files = ["dist", "README.md"];

  // A package with no exports map lets consumers reach into any file. Give it the same single
  // entry point that main/types already describe, plus package.json for tooling.
  if (!next.exports && next.main) {
    const main = `./${next.main.replace(/^\.\//, "")}`;
    const types = next.types ? `./${next.types.replace(/^\.\//, "")}` : undefined;
    next.exports = {
      ".": types ? { types, default: main } : main,
      "./package.json": "./package.json",
    };
  }

  return next;
}

function publicPackageDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(packagesDir, entry.name, "package.json")),
    )
    .map((entry) => entry.name)
    .filter((dirName) => readJson(path.join(packagesDir, dirName, "package.json")).private !== true)
    .sort();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function main() {
  const drift = [];
  for (const dirName of publicPackageDirs()) {
    const pkgPath = path.join(packagesDir, dirName, "package.json");
    const current = readFileSync(pkgPath, "utf8");
    const expected = `${JSON.stringify(expectedMetadata(JSON.parse(current), dirName), null, 2)}\n`;
    if (current !== expected) {
      drift.push(`${dirName}/package.json`);
      if (write) writeFileSync(pkgPath, expected);
    }

    const licensePath = path.join(packagesDir, dirName, "LICENSE");
    if (!existsSync(licensePath) || readFileSync(licensePath, "utf8") !== LICENSE_TEXT) {
      drift.push(`${dirName}/LICENSE`);
      if (write) writeFileSync(licensePath, LICENSE_TEXT);
    }
  }

  if (drift.length === 0) {
    console.log("package metadata: all public packages are consistent.");
    return;
  }
  if (write) {
    console.log(`package metadata: updated ${drift.length} file(s):\n  ${drift.join("\n  ")}`);
    return;
  }
  console.error(
    `package metadata: ${drift.length} file(s) drifted. Run \`npm run package:metadata\` to fix:\n  ${drift.join("\n  ")}`,
  );
  process.exitCode = 1;
}

main();
