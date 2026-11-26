// Ported from pi (badlogic/pi-mono, packages/coding-agent/test/find-abort-before-spawn.test.ts).
// Copyright (c) 2026 Earendil Inc. MIT License; see THIRD_PARTY_NOTICES.md.

import type * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controller: new AbortController(),
  spawn: vi.fn(),
}));

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: mocks.spawn,
}));

vi.mock("../src/tools-manager.js", () => ({
  ensureTool: async () => "fd",
}));

// Abort while find looks for a .git directory above the search path.
vi.mock("../src/path-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof pathUtils>()),
  pathExists: async (filePath: string) => {
    if (!filePath.endsWith(".git")) return true;
    mocks.controller.abort();
    return false;
  },
}));

import { createFindToolDefinition } from "../src/find.js";
import type * as pathUtils from "../src/path-utils.js";

describe("find abort before fd starts", () => {
  beforeEach(() => {
    mocks.controller = new AbortController();
    mocks.spawn.mockClear();
  });

  it("does not start fd after an abort during the .git lookup", async () => {
    const def = createFindToolDefinition(tmpdir());
    const ctx = {} as Parameters<typeof def.execute>[4];
    await expect(
      def.execute("call-1", { pattern: "*.ts" }, mocks.controller.signal, undefined, ctx),
    ).rejects.toThrow("Operation aborted");
    // Let the rest of execute() run after the rejection.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
