import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BashOperations } from "@generic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTerminalToolPlugin,
  kind,
  name,
  resolveTerminalCwd,
} from "../src/index.js";

const tempRoots: string[] = [];

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-tools-terminal-"));
  tempRoots.push(root);

  try {
    return await run(root);
  } finally {
    tempRoots.splice(tempRoots.indexOf(root), 1);
    await rm(root, { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("@generic-ai/plugin-tools-terminal", () => {
  it("creates a terminal plugin with a pi bash tool anchored to the workspace root", async () => {
    await withTempRoot(async (root) => {
      const plugin = createTerminalToolPlugin({ root });

      expect(plugin.name).toBe(name);
      expect(plugin.kind).toBe(kind);
      expect(plugin.root).toBe(root);
      expect(plugin.unrestrictedLocal).toBe(true);
      expect(plugin.tool).toMatchObject({
        name: "bash",
      });
    });
  });

  it("runs configured commands and captures streamed output", async () => {
    await withTempRoot(async (root) => {
      const operations: BashOperations = {
        exec: async (command, cwd, options) => {
          options.onData(Buffer.from(`${command}\n${cwd}`));
          return { exitCode: 0 };
        },
      };
      const plugin = createTerminalToolPlugin({ root, operations });
      const result = await plugin.run({
        command: "pwd",
      });

      expect(result.exitCode).toBe(0);
      expect(result.cwd).toBe(root);
      expect(result.command).toBe("pwd");
      expect(result.output).toContain("pwd");
      expect(result.output).toContain(root);
    });
  });

  it("resolves explicit working directories inside the workspace", async () => {
    await withTempRoot(async (root) => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "workspace", "shared"), { recursive: true });
      await expect(resolveTerminalCwd(root, "workspace/shared")).resolves.toBe(
        path.join(root, "workspace", "shared"),
      );
      await expect(resolveTerminalCwd(root, "..")).rejects.toThrow(/escapes the workspace root/i);
    });
  });
});
