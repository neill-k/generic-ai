#!/usr/bin/env node
// Lists which public packages have a version that is not on npm yet, and dry-runs their publish.
// The release workflow uses it for its dry run; the real publish goes through `changeset publish`.
//
//   node scripts/release-publish.mjs            list pending packages and run `npm publish --dry-run`
//   node scripts/release-publish.mjs --list     only list them
//
// It never publishes for real.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listOnly = process.argv.includes("--list");

function publicPackages() {
  const dir = path.join(repoRoot, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "package.json")))
    .map((e) => ({
      rel: `packages/${e.name}`,
      json: JSON.parse(readFileSync(path.join(dir, e.name, "package.json"), "utf8")),
    }))
    .filter((p) => p.json.private !== true)
    .sort((a, b) => a.json.name.localeCompare(b.json.name));
}

function isPublished(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
  } catch (error) {
    if (`${error.stderr ?? ""}`.includes("E404")) return false;
    throw error;
  }
}

const pending = publicPackages().filter((p) => !isPublished(p.json.name, p.json.version));
if (pending.length === 0) {
  console.log("release: every public package version is already on npm. Nothing to publish.");
  process.exit(0);
}

console.log(`release: ${pending.length} package version(s) not on npm yet:`);
for (const p of pending) console.log(`  ${p.json.name}@${p.json.version}`);
if (listOnly) process.exit(0);

for (const p of pending) {
  // Provenance needs a trusted CI publish, so the dry run turns it off; the real publish keeps it.
  execFileSync(
    "npm",
    [
      "publish",
      "--dry-run",
      "--provenance=false",
      "--ignore-scripts",
      "--loglevel=warn",
      "--workspace",
      p.rel,
    ],
    {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}
console.log(`release: dry run passed for ${pending.length} package(s). Nothing was published.`);
