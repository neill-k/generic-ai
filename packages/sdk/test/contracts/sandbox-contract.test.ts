import { describe, expect, it } from "vitest";

import {
  SANDBOX_EXECUTION_STATUSES,
  SANDBOX_FILE_IO_MODES,
  SANDBOX_NETWORK_MODES,
  SANDBOX_RUNTIMES,
  mergeSandboxPolicy,
  parseSandboxPolicy,
  parseSandboxRuntimeConfig,
} from "../../src/contracts/sandbox.js";

describe("@generic-ai/sdk sandbox contract", () => {
  it("exposes the supported runtime and policy enums", () => {
    expect(SANDBOX_RUNTIMES).toEqual(["bash", "node", "python"]);
    expect(SANDBOX_NETWORK_MODES).toEqual(["isolated", "allowlist", "open"]);
    expect(SANDBOX_FILE_IO_MODES).toEqual(["readonly-mount", "copy", "none"]);
    expect(SANDBOX_EXECUTION_STATUSES).toContain("timed_out");
    expect(SANDBOX_EXECUTION_STATUSES).toContain("unavailable");
  });

  it("parses nested sandbox policy objects", () => {
    const policy = parseSandboxPolicy({
      resources: {
        cpuCores: 1.5,
        memoryMb: 1024,
        diskMb: 256,
        timeoutMs: 30_000,
        timeoutGraceMs: 5_000,
      },
      network: {
        mode: "allowlist",
        allowlist: ["registry.npmjs.org", "pypi.org"],
      },
      files: {
        mode: "copy",
        copyInPaths: ["package.json"],
        copyOutPaths: ["workspace/shared/results"],
        outputDir: "workspace/shared/results",
      },
    });

    expect(policy).toEqual({
      resources: {
        cpuCores: 1.5,
        memoryMb: 1024,
        diskMb: 256,
        timeoutMs: 30_000,
        timeoutGraceMs: 5_000,
      },
      network: {
        mode: "allowlist",
        allowlist: ["registry.npmjs.org", "pypi.org"],
      },
      files: {
        mode: "copy",
        copyInPaths: ["package.json"],
        copyOutPaths: ["workspace/shared/results"],
        outputDir: "workspace/shared/results",
      },
    });
  });

  it("rejects invalid sandbox policy values", () => {
    expect(() =>
      parseSandboxPolicy({
        resources: {
          timeoutMs: 0,
        },
      }),
    ).toThrow(/timeoutMs must be greater than zero/i);
    expect(() =>
      parseSandboxPolicy({
        resources: {
          timeoutGraceMs: 0,
        },
      }),
    ).toThrow(/timeoutGraceMs must be greater than zero/i);
    expect(() =>
      parseSandboxPolicy({
        network: {
          mode: "offline",
        },
      }),
    ).toThrow(/must be one of/i);
  });

  it("parses runtime config objects", () => {
    expect(
      parseSandboxRuntimeConfig({
        image: "node:24-bookworm-slim",
        workdir: "/workspace",
        env: {
          NODE_ENV: "test",
        },
        volumes: ["/cache/npm:/cache/npm"],
      }),
    ).toEqual({
      image: "node:24-bookworm-slim",
      workdir: "/workspace",
      env: {
        NODE_ENV: "test",
      },
      volumes: ["/cache/npm:/cache/npm"],
    });
  });

  it("merges policy overrides without discarding sibling sections", () => {
    expect(
      mergeSandboxPolicy(
        {
          resources: { timeoutMs: 30_000, memoryMb: 512 },
          network: { mode: "isolated" },
        },
        {
          resources: { memoryMb: 2048 },
          files: { mode: "readonly-mount", outputDir: "workspace/shared/results" },
        },
      ),
    ).toEqual({
      resources: { timeoutMs: 30_000, memoryMb: 2048 },
      network: { mode: "isolated" },
      files: { mode: "readonly-mount", outputDir: "workspace/shared/results" },
    });
  });
});
