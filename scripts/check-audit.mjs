#!/usr/bin/env node
// Production dependency audit gate.
//
// Runs `npm audit --json --omit=dev --omit=optional` and fails when an advisory at or
// above the threshold (moderate) is present that is not listed in
// `security/audit-allowlist.json`. Every allowlist entry needs a reason and an
// expiry date; an expired entry fails the gate so accepted risk is revisited.
// See docs/security.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Collect the direct advisories from an `npm audit --json` report. */
export function collectAdvisories(report) {
  const advisories = new Map();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via.url) ?? String(via.source);
      if (!advisories.has(id)) {
        advisories.set(id, {
          id,
          packageName: via.name ?? name,
          severity: via.severity,
          range: via.range,
          title: via.title,
          url: via.url,
        });
      }
    }
  }
  return [...advisories.values()];
}

function advisoryId(url) {
  const match =
    typeof url === "string" ? url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i) : null;
  return match ? match[0].toUpperCase() : undefined;
}

/**
 * Compare advisories with the allowlist.
 * Returns blocking advisories, allowed advisories, expired entries and unused entries.
 */
export function evaluateAudit(
  advisories,
  allowlist,
  { threshold = "moderate", today = new Date() } = {},
) {
  const minimum = SEVERITY_RANK[threshold];
  const day = today.toISOString().slice(0, 10);
  const entries = new Map(allowlist.map((entry) => [entry.id.toUpperCase(), entry]));
  const blocking = [];
  const allowed = [];
  const expired = [];
  const used = new Set();

  for (const advisory of advisories) {
    if ((SEVERITY_RANK[advisory.severity] ?? 0) < minimum) continue;
    const entry = entries.get(advisory.id);
    if (!entry) {
      blocking.push(advisory);
      continue;
    }
    used.add(advisory.id);
    if (entry.expires < day) {
      expired.push({ advisory, entry });
    } else {
      allowed.push({ advisory, entry });
    }
  }

  const unused = allowlist.filter((entry) => !used.has(entry.id.toUpperCase()));
  return { blocking, allowed, expired, unused };
}

export function validateAllowlist(allowlist) {
  const problems = [];
  for (const entry of allowlist) {
    for (const field of ["id", "package", "reason", "expires"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        problems.push(`allowlist entry ${JSON.stringify(entry.id ?? entry)} is missing "${field}"`);
      }
    }
    if (typeof entry.expires === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      problems.push(
        `allowlist entry ${entry.id} has expires "${entry.expires}", expected YYYY-MM-DD`,
      );
    }
  }
  return problems;
}

function runAudit(cwd) {
  try {
    return execFileSync("npm", ["audit", "--json", "--omit=dev", "--omit=optional"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // npm audit exits non-zero when it finds advisories; the JSON is still on stdout.
    if (typeof error.stdout === "string" && error.stdout.trim().startsWith("{"))
      return error.stdout;
    throw error;
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const allowlistPath = resolve(root, "security/audit-allowlist.json");
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")).advisories ?? [];
  const problems = validateAllowlist(allowlist);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`error: ${problem}`);
    process.exit(1);
  }

  const report = JSON.parse(runAudit(root));
  if (report.error) {
    console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const { blocking, allowed, expired, unused } = evaluateAudit(
    collectAdvisories(report),
    allowlist,
  );

  for (const { advisory, entry } of allowed) {
    console.log(
      `allowed until ${entry.expires}: ${advisory.id} ${advisory.packageName} (${advisory.severity}) ${advisory.title}`,
    );
  }
  for (const entry of unused) {
    console.warn(
      `warning: allowlist entry ${entry.id} (${entry.package}) no longer matches an advisory; remove it`,
    );
  }
  for (const { advisory, entry } of expired) {
    console.error(
      `error: allowlist entry for ${advisory.id} ${advisory.packageName} expired on ${entry.expires}`,
    );
  }
  for (const advisory of blocking) {
    console.error(
      `error: ${advisory.id} ${advisory.packageName} ${advisory.range} (${advisory.severity}) ${advisory.title} ${advisory.url ?? ""}`,
    );
  }

  if (blocking.length > 0 || expired.length > 0) {
    console.error(
      "\nProduction dependency audit failed. Upgrade the dependency, or add a reviewed entry with a reason and an expiry to security/audit-allowlist.json.",
    );
    process.exit(1);
  }
  console.log("Production dependency audit passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
