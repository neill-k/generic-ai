import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const audit = await import(pathToFileURL(resolve(__dirname, "check-audit.mjs")).href);

const report = {
  vulnerabilities: {
    "extract-zip": {
      via: [
        {
          source: 1,
          name: "extract-zip",
          severity: "high",
          range: "<=2.0.1",
          title: "symlink path traversal",
          url: "https://github.com/advisories/GHSA-jmr9-qjv8-65gv",
        },
      ],
    },
    "@mariozechner/pi-coding-agent": {
      // Transitive entries are strings and must not be counted twice.
      via: [
        "extract-zip",
        {
          source: 2,
          name: "@mariozechner/pi-coding-agent",
          severity: "low",
          range: "<=0.73.1",
          title: "auth.json race",
          url: "https://github.com/advisories/GHSA-r95r-rj6r-c39x",
        },
      ],
    },
    undici: {
      via: [
        {
          source: 3,
          name: "undici",
          severity: "moderate",
          range: "<7.31.0",
          title: "header injection",
          url: "https://github.com/advisories/GHSA-p88m-4jfj-68fv",
        },
      ],
    },
  },
};

const entry = (id: string, expires: string) => ({ id, package: "x", reason: "r", expires });

describe("check-audit", () => {
  it("collects direct advisories by GHSA id", () => {
    const ids = audit.collectAdvisories(report).map((advisory: { id: string }) => advisory.id);
    expect(ids).toEqual(["GHSA-JMR9-QJV8-65GV", "GHSA-R95R-RJ6R-C39X", "GHSA-P88M-4JFJ-68FV"]);
  });

  it("blocks moderate-or-higher advisories that are not allowlisted and ignores low ones", () => {
    const result = audit.evaluateAudit(
      audit.collectAdvisories(report),
      [entry("GHSA-jmr9-qjv8-65gv", "2099-01-01")],
      {
        today: new Date("2026-11-26T00:00:00Z"),
      },
    );
    expect(result.blocking.map((advisory: { id: string }) => advisory.id)).toEqual([
      "GHSA-P88M-4JFJ-68FV",
    ]);
    expect(result.allowed).toHaveLength(1);
    expect(result.expired).toHaveLength(0);
  });

  it("fails expired allowlist entries and reports unused ones", () => {
    const result = audit.evaluateAudit(
      audit.collectAdvisories(report),
      [entry("GHSA-JMR9-QJV8-65GV", "2026-11-25"), entry("GHSA-AAAA-BBBB-CCCC", "2099-01-01")],
      { today: new Date("2026-11-26T00:00:00Z") },
    );
    expect(result.expired.map(({ advisory }: { advisory: { id: string } }) => advisory.id)).toEqual(
      ["GHSA-JMR9-QJV8-65GV"],
    );
    expect(result.unused.map((unused: { id: string }) => unused.id)).toEqual([
      "GHSA-AAAA-BBBB-CCCC",
    ]);
  });

  it("keeps the checked-in allowlist well formed", () => {
    const allowlist = JSON.parse(
      readFileSync(resolve(__dirname, "../security/audit-allowlist.json"), "utf8"),
    );
    expect(audit.validateAllowlist(allowlist.advisories)).toEqual([]);
    expect(
      audit.validateAllowlist([{ id: "GHSA-1", package: "p", reason: "", expires: "soon" }]),
    ).toHaveLength(2);
  });
});
