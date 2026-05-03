import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BashOperations } from "@generic-ai/sdk/pi";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTerminalToolPlugin,
  kind,
  name,
  resolveTerminalCwd,
  TerminalToolError,
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

  it("does not forward ambient process secrets unless explicitly requested", async () => {
    await withTempRoot(async (root) => {
      const secretKey = "GENERIC_AI_TERMINAL_SECRET_FOR_TEST";
      process.env[secretKey] = "do-not-forward";
      try {
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const operations: BashOperations = {
          exec: async (_command, _cwd, options) => {
            capturedEnv = options.env;
            return { exitCode: 0 };
          },
        };

        await createTerminalToolPlugin({ root, operations }).run({ command: "env" });
        expect(capturedEnv?.[secretKey]).toBeUndefined();
        expect(capturedEnv?.["PATH"] ?? capturedEnv?.["Path"]).toBeDefined();

        await createTerminalToolPlugin({
          root,
          operations,
          inheritProcessEnv: true,
        }).run({ command: "env" });
        expect(capturedEnv?.[secretKey]).toBe("do-not-forward");
      } finally {
        delete process.env[secretKey];
      }
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

  it("emits structured timeout and native error envelopes", async () => {
    await withTempRoot(async (root) => {
      const timeoutOperations: BashOperations = {
        exec: async () => ({ exitCode: null }),
      };
      const timeoutResult = await createTerminalToolPlugin({
        root,
        operations: timeoutOperations,
      }).run({
        command: "sleep 10",
        timeoutMs: 1000,
      });

      expect(timeoutResult.timedOut).toBe(true);
      expect(timeoutResult.error).toMatchObject({
        kind: "timeout",
        retryable: true,
        timeoutBudget: {
          totalMs: 1000,
          remainingMs: 0,
          exhausted: true,
        },
      });

      const failingOperations: BashOperations = {
        exec: async () => {
          throw new Error("spawn ENOENT");
        },
      };
      await expect(
        createTerminalToolPlugin({ root, operations: failingOperations }).run({
          command: "missing-binary",
        }),
      ).rejects.toBeInstanceOf(TerminalToolError);
    });
  });
});
